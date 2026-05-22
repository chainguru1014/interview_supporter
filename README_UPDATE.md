# Updates Included

- ✅ Added `services/openai.js` with retry/backoff and streaming helpers.
- ✅ Centralized global hotkeys in `main/hotkeys.js` (Ctrl+Alt+C capture, Ctrl+Alt+A toggle panel).
- ✅ Added developer docs: `docs/CLAUDE_DEV.md`, `docs/ETHICS_AND_USE.md`.
- ✅ Sanitized `config.json` to remove hard-coded keys; added `.env.example`.
- ✅ Light UI: Assistance Panel that shows suggestions and diffs (non-stealth).

## Quick Start
1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. `npm i` (installs `dotenv`, `axios`).
3. `npm start`.

## Keys & Config
- `process.env.OPENAI_API_KEY` is required. Fallback to `config.json` is disabled for safety.