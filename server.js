const express  = require("express");
const { spawn } = require("child_process");
const path      = require("path");
const app       = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── State ────────────────────────────────────────────────────────
const jobQueue   = [];   // [{id, m3u8, title, status, logs[]}]
let   current    = null;
let   working    = false;
let   sseClients = [];
let   jobCounter = 0;

// ── SSE broadcast ────────────────────────────────────────────────
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(payload); return true; }
    catch { return false; }
  });
}

// ── Helpers ──────────────────────────────────────────────────────
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function getQueueState() {
  return {
    jobs: jobQueue.map(j => ({
      id:      j.id,
      title:   j.title || `Video_${j.id}`,
      m3u8:    j.m3u8.slice(0, 60) + (j.m3u8.length > 60 ? "…" : ""),
      status:  j.status,
      started: j.started || null,
      ended:   j.ended   || null,
    })),
    current: current ? current.id : null,
    pending: jobQueue.filter(j => j.status === "pending").length,
    done:    jobQueue.filter(j => j.status === "done").length,
    failed:  jobQueue.filter(j => j.status === "failed").length,
  };
}

// ── Queue processor ──────────────────────────────────────────────
function processNext() {
  if (working || jobQueue.length === 0) return;
  const job = jobQueue.find(j => j.status === "pending");
  if (!job) return;

  working     = true;
  current     = job;
  job.status  = "running";
  job.started = Date.now();

  broadcast("queue", getQueueState());
  broadcast("log",   { id: job.id, line: `[SERVER] ▶ Starting: ${job.title || `Video_${job.id}`}` });

  const input = JSON.stringify({
    m3u8:    job.m3u8,
    title:   job.title,
    referer: "https://ostad.app",
  });

  const proc = spawn("python3", [path.join(__dirname, "worker.py")], {
    env: { ...process.env },
    cwd: __dirname,
  });

  proc.stdin.write(input);
  proc.stdin.end();

  const handleLines = (prefix) => (chunk) => {
    chunk.toString().split("\n").forEach(line => {
      line = line.trim();
      if (!line) return;
      const tagged = prefix ? `[PY-ERR] ${line}` : line;
      job.logs.push(tagged);
      broadcast("log", { id: job.id, line: tagged });
    });
  };

  proc.stdout.on("data", handleLines(false));
  proc.stderr.on("data", handleLines(true));

  proc.on("close", code => {
    job.ended  = Date.now();
    job.status = code === 0 ? "done" : "failed";
    job.code   = code;

    const elapsed = Math.round((job.ended - job.started) / 1000);
    const summary = code === 0
      ? `[SERVER] ✓ Done in ${fmtTime(elapsed)}`
      : `[SERVER] ✗ Failed (exit ${code}) after ${fmtTime(elapsed)}`;

    job.logs.push(summary);
    broadcast("log",   { id: job.id, line: summary });
    broadcast("queue", getQueueState());

    current = null;
    working = false;
    processNext();
  });
}

// ── Routes ───────────────────────────────────────────────────────

// SSE stream
app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  // Send current state on connect
  res.write(`event: queue\ndata: ${JSON.stringify(getQueueState())}\n\n`);

  // Replay running job logs so page refresh doesn't lose history
  if (current) {
    current.logs.forEach(line => {
      res.write(`event: log\ndata: ${JSON.stringify({ id: current.id, line })}\n\n`);
    });
  }

  sseClients.push(res);

  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 20000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients = sseClients.filter(r => r !== res);
  });
});

// Add bulk jobs
// POST { links: ["url1",...], titles: ["t1",...] }
app.post("/add", (req, res) => {
  const { links, titles } = req.body;

  if (!Array.isArray(links) || links.length === 0)
    return res.json({ ok: false, error: "links array required" });

  const added = [];
  links.forEach((rawLink, i) => {
    const m3u8 = (rawLink || "").trim();
    if (!m3u8 || !m3u8.includes(".m3u8")) return;

    jobCounter++;
    const title = Array.isArray(titles) && titles[i] ? titles[i].trim() : "";
    const job = {
      id: jobCounter, m3u8, title,
      status: "pending", logs: [],
      started: null, ended: null,
    };
    jobQueue.push(job);
    added.push({ id: job.id, title: title || `Video_${job.id}` });
  });

  broadcast("queue", getQueueState());
  res.json({ ok: true, added, queued: jobQueue.filter(j => j.status === "pending").length });
  processNext();
});

// Full logs for one job
app.get("/logs/:id", (req, res) => {
  const job = jobQueue.find(j => j.id === parseInt(req.params.id));
  if (!job) return res.json({ ok: false, error: "not found" });
  res.json({ ok: true, id: job.id, status: job.status, logs: job.logs });
});

// Queue state
app.get("/queue", (req, res) => res.json(getQueueState()));

// Clear finished jobs
app.post("/clear", (req, res) => {
  let removed = 0;
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    if (jobQueue[i].status === "done" || jobQueue[i].status === "failed") {
      jobQueue.splice(i, 1);
      removed++;
    }
  }
  broadcast("queue", getQueueState());
  res.json({ ok: true, removed });
});

// Health
app.get("/health", (req, res) => res.json({ ok: true, ...getQueueState() }));

// ── Boot ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Ostad→TG on port ${PORT}`);
  console.log(`[SERVER] BOT_TOKEN  : ${process.env.BOT_TOKEN  ? "✓" : "✗ MISSING"}`);
  console.log(`[SERVER] CHAT_ID    : ${process.env.CHAT_ID    ? "✓" : "✗ MISSING"}`);
  console.log(`[SERVER] TG_API_ID  : ${process.env.TG_API_ID  ? "✓" : "✗ MISSING"}`);
  console.log(`[SERVER] TG_API_HASH: ${process.env.TG_API_HASH ? "✓" : "✗ MISSING"}`);
});
