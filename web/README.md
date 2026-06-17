# Interview Assistant — Web Version

A hosted, browser-based version of the desktop app. It keeps your OpenAI API key
on the server and gives access to anyone who has the password you set.

## What works on the web

- **Live transcription** — share a browser tab / screen (with audio) or use the
  mic. Audio is recorded in ~5s segments, sent to Whisper, and shown live.
- **Streaming AI answers** — uses the same meeting-type prompt profiles as the
  desktop app (Interview, Team Meeting, 1:1, Client Call, Lecture, General).
- **Context panel** — fill in resume / job description / etc. (stored in the
  browser, sent with each request).
- **Screen analysis** — capture a frame of a shared screen and analyze it (vision).

## What's different from desktop (and why)

| Desktop | Web | Reason |
|---|---|---|
| API key in `.env`, used on-device | Key stays on the **server**, proxied | Browsers can't hold secrets safely |
| FFmpeg + VB-Audio Virtual Cable | `getDisplayMedia` / mic | Browsers have no system-audio loopback |
| License key activation | **Shared password** | Local files don't exist on a server |
| In-memory RAG buckets, KB upload | Single-shot screen analysis | Trimmed for v1 simplicity |

> To capture the **other person's** voice on a call (e.g. Zoom/Meet in a browser
> tab), pick **"Share tab/screen audio"** and tick **"Share tab audio"** in the
> browser's share dialog. Microphone mode captures *your* voice instead.

## Requirements

- **Node.js hosting** (a VPS, Render, Railway, Fly.io, etc.). Static-only hosting
  will NOT work — the server is required to hide the key.
- **HTTPS** in production. Browsers only allow microphone/screen capture on
  `https://` (or `http://localhost`). Most hosts give you HTTPS automatically.

## Setup

1. From the project root, install deps (once):
   ```bash
   npm install
   ```

2. Create a `.env` in the **project root** (same file the desktop app uses):
   ```
   OPENAI_API_KEY=sk-your-key-here
   ACCESS_PASSWORD=pick-a-strong-password
   PORT=3002
   ```
   - `OPENAI_API_KEY` — required.
   - `ACCESS_PASSWORD` — required for public hosting. Without it the app is open
     to anyone with the URL (and will spend your credits).
   - `PORT` — optional (defaults to 3002).

3. Run it:
   ```bash
   npm run web
   ```
   Open http://localhost:3002, enter the password, and you're in.

   With pm2 (keeps it running across reboots/crashes):
   ```bash
   pm2 start npm --name interview-supporter -- run web
   pm2 save
   ```

## Deploying

Any Node host works. General steps:

1. Push the whole repo (it needs `services/` and `node_modules` deps).
2. Set the environment variables `OPENAI_API_KEY` and `ACCESS_PASSWORD` in your
   host's dashboard (don't commit `.env`).
3. Set the start command to `npm run web`.
4. Make sure the host serves over **HTTPS** (required for mic/screen capture).

### Example: Render / Railway
- Build command: `npm install`
- Start command: `npm run web`
- Add env vars: `OPENAI_API_KEY`, `ACCESS_PASSWORD`
- HTTPS is automatic.

### Example: bare VPS (Ubuntu) with pm2
```bash
git clone <your-repo> && cd interview_supporter
npm install
# create .env with OPENAI_API_KEY, ACCESS_PASSWORD, PORT=3002
npm install -g pm2
pm2 start npm --name interview-supporter -- run web
pm2 save
# put nginx + certbot in front for HTTPS (mic/screen capture needs HTTPS)
```

## Cost note

Every transcription segment and every answer spends **your** OpenAI credits.
The password is your only spending control — keep it private and rotate it if it
leaks. Whisper is ~$0.006/min of audio; gpt-4o answers cost per token.

## Environment variables reference

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | — | OpenAI key (server-side only) |
| `ACCESS_PASSWORD` | for public | — | Shared password gate |
| `PORT` | no | 3002 | HTTP port |
| `CHAT_MODEL` | no | gpt-4o | Streaming chat model |
| `VISION_MODEL` | no | gpt-4o | Screen-analysis model |
