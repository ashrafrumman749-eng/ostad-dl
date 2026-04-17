# Ostad → Telegram Bulk Downloader

m3u8 links bulk করে paste করো → Railway server auto download করে TG channel এ পাঠাবে।

## File Structure

```
ostad-tg/
├── server.js          ← Node.js Express (queue + SSE + frontend serve)
├── worker.py          ← Python (ffmpeg download + Telegram upload)
├── public/
│   └── index.html     ← Frontend UI
├── package.json
├── requirements.txt
└── nixpacks.toml      ← Railway build config
```

## Railway Deploy

1. GitHub এ repo বানাও, এই files push করো
2. Railway → New Project → Deploy from GitHub
3. Environment Variables set করো:

```
BOT_TOKEN    = your_bot_token
CHAT_ID      = -1001234567890   (channel ID, negative number)
TG_API_ID    = 12345678
TG_API_HASH  = abcdef1234567890abcdef
```

> **Bot কে channel এ admin করো** (send messages permission লাগবে)

## How It Works

- **Small files (≤49MB)** → Bot API দিয়ে upload
- **Large files (>49MB, ~1GB)** → Pyrogram (MTProto) দিয়ে upload
- **Referer** সব request এ automatically `https://ostad.app` যাবে
- **Real-time logs** → SSE দিয়ে browser এ live দেখা যাবে
- **Bulk input** → 40-50 links একসাথে paste করো, titles optional

## Usage

1. Railway URL open করো
2. Left box → m3u8 links (one per line)
3. Right box → titles (optional, same line number = same link)
4. "Add to Queue" click করো
5. Log panel এ real-time progress দেখো
