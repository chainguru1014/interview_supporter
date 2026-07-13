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

## Telegram chat bridge (optional)

The **Chat** panel (Chris ⟷ Amrit, left of the transcript) works standalone —
messages are stored on the server and polled by both browsers every few
seconds. You can optionally bridge it to a Telegram group so messages sent
from either side show up on both the website and in Telegram.

**Why a group, not a DM:** a Telegram bot can only see messages in chats it's
a member of — it cannot read a private 1:1 DM between two humans. So the
synced thread has to be a small group containing Chris, Amrit, and the bot.

1. **Create the bot.** In Telegram, message **@BotFather** → `/newbot` →
   follow the prompts → it gives you a token like `123456:ABC-...`.
2. **Create a group** with Chris and Amrit in it, then add the bot to that
   group (search its @username and add as a member — not just a channel admin).
3. **Add the token to `.env`** (project root, next to `OPENAI_API_KEY`):
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here
   ```
4. **Restart the server**, then send any message in the group. The server
   log will print the group's `chat_id`:
   ```
   [telegram] saw a message in chat_id=-1001234567890 ("Your Group Name") — set TELEGRAM_CHAT_ID=-1001234567890 in .env to enable the bridge.
   ```
   Copy that into `.env`:
   ```
   TELEGRAM_CHAT_ID=-1001234567890
   ```
5. **(Optional) Map Telegram accounts to Chris/Amrit.** Without this, incoming
   Telegram messages still show up on the website, just labeled with the
   sender's raw Telegram first name instead of "Chris"/"Amrit". Send another
   message after adding `TELEGRAM_CHAT_ID` and the log will show the mapping
   to add:
   ```
   [telegram] message from unmapped Telegram user_id=987654321 (Chris) — set TELEGRAM_CHRIS_USER_ID or TELEGRAM_AMRIT_USER_ID in .env to map them.
   ```
   ```
   TELEGRAM_CHRIS_USER_ID=987654321
   TELEGRAM_AMRIT_USER_ID=123123123
   ```
6. **Restart the server once more.** From then on:
   - A message sent on the website is relayed into the Telegram group as
     `Chris: ...` / `Amrit: ...`.
   - A message sent by either of you in the Telegram group appears in the
     website chat panel, tagged "· via Telegram".

No public webhook or extra deploy config is needed — the server long-polls
Telegram's `getUpdates` in the background. This is entirely optional: leave
`TELEGRAM_BOT_TOKEN` unset and the website chat keeps working on its own.

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
| `TELEGRAM_BOT_TOKEN` | no | — | Enables the Telegram chat bridge (from @BotFather) |
| `TELEGRAM_CHAT_ID` | no | — | The Telegram group id to sync (see server log after sending a message) |
| `TELEGRAM_CHRIS_USER_ID` | no | — | Maps a Telegram account to "Chris" in the chat panel |
| `TELEGRAM_AMRIT_USER_ID` | no | — | Maps a Telegram account to "Amrit" in the chat panel |
