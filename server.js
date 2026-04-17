import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch';
import FormData from 'form-data';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const REFERER = 'https://ostad.app';
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const WORK_DIR = path.join(os.homedir(), 'ostad_work');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// Job queue
const queue = [];
let processing = false;
const jobs = {}; // id -> status

function jobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function downloadM3u8(m3u8, outPath, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-user_agent', 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
      '-headers', `Accept: */*\r\nReferer: ${REFERER}\r\nOrigin: ${REFERER}\r\n`,
      '-i', m3u8,
      '-c', 'copy',
      '-threads', '4',
      '-movflags', '+faststart',
      outPath,
    ];
    const ff = spawn('ffmpeg', args);
    let duration = null;
    ff.stderr.on('data', (d) => {
      const line = d.toString();
      const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      if (durMatch && !duration) {
        duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
      }
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
      if (timeMatch && duration) {
        const cur = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
        const pct = Math.min(99, Math.floor(cur / duration * 100));
        onProgress(pct);
      }
    });
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        resolve();
      } else {
        reject(new Error('FFmpeg failed'));
      }
    });
  });
}

async function uploadTelegram(filePath, title) {
  const sizeMB = fs.statSync(filePath).size / 1048576;

  if (sizeMB <= 49) {
    // Bot API
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', `**${title}**`);
    form.append('supports_streaming', 'true');
    form.append('video', fs.createReadStream(filePath));
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      body: form,
      timeout: 600000,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
    const msgId = data.result.message_id;
    const chatUsername = CHAT_ID.startsWith('-100')
      ? CHAT_ID.replace('-100', '')
      : CHAT_ID;
    return `https://t.me/c/${chatUsername}/${msgId}`;
  } else {
    // Large file — Bot API with sendVideo via multipart (up to 2GB via local bot api not available)
    // Use tg-uploader workaround: compress to under 50MB or use python pyrogram
    // For now use python script
    return await uploadViaPython(filePath, title);
  }
}

async function uploadViaPython(filePath, title) {
  return new Promise((resolve, reject) => {
    const script = `
import asyncio, os, sys
from pyrogram import Client

async def main():
    async with Client(
        "ostad_bot",
        api_id=int(os.environ["API_ID"]),
        api_hash=os.environ["API_HASH"],
        bot_token=os.environ["BOT_TOKEN"],
        in_memory=True,
    ) as app:
        msg = await app.send_video(
            chat_id="@torkisomossa",
            video=sys.argv[1],
            caption=f"**{sys.argv[2]}**",
            supports_streaming=True,
        )
        print(msg.link)

asyncio.run(main())
`;
    const tmpScript = path.join(WORK_DIR, 'upload_tmp.py');
    fs.writeFileSync(tmpScript, script);
    const proc = spawn('python3', [tmpScript, filePath, title], {
      env: {
        ...process.env,
        API_ID: process.env.API_ID,
        API_HASH: process.env.API_HASH,
        BOT_TOKEN: process.env.BOT_TOKEN,
      },
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error('Python upload failed'));
    });
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  const job = queue.shift();
  jobs[job.id] = { ...job, status: 'downloading', progress: 0 };

  const jobDir = path.join(WORK_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const outPath = path.join(jobDir, 'video.mp4');

  try {
    // Download
    await downloadM3u8(job.m3u8, outPath, (pct) => {
      jobs[job.id].progress = pct;
      jobs[job.id].status = 'downloading';
    });

    const sizeMB = Math.round(fs.statSync(outPath).size / 1048576 * 10) / 10;
    jobs[job.id].status = 'uploading';
    jobs[job.id].sizeMB = sizeMB;

    // Upload
    const link = await uploadTelegram(outPath, job.title);
    jobs[job.id].status = 'done';
    jobs[job.id].link = link;

  } catch (e) {
    jobs[job.id].status = 'error';
    jobs[job.id].error = e.message;
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
    processing = false;
    processQueue();
  }
}

// Routes
app.post('/add', (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.json({ ok: false, error: 'No items' });
  }
  const added = [];
  for (const item of items) {
    const m3u8 = (item.m3u8 || '').trim();
    const title = (item.title || '').trim() || `Video_${Date.now()}`;
    if (!m3u8 || !m3u8.includes('.m3u8')) continue;
    const id = jobId();
    queue.push({ id, m3u8, title });
    jobs[id] = { id, m3u8, title, status: 'queued', progress: 0 };
    added.push({ id, title });
  }
  processQueue();
  res.json({ ok: true, added, queued: queue.length });
});

app.get('/status', (req, res) => {
  const list = Object.values(jobs).slice(-100);
  res.json({ ok: true, queue: queue.length, jobs: list });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ostad DL running on port ${PORT}`));
