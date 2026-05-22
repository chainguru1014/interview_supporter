# Claude Dev Onboarding

This repository is an Electron + Node.js interview practice companion.

## Workspace Map
- `main.js` — Electron main process (IPC, audio capture, screen capture).
- `preload.js` — IPC bridge to renderer.
- `index.html` — Renderer UI (chat, coding mode, settings).
- `config.json` — Local config (DO NOT store secrets; see `.env.example`).
- `docs/` — Developer docs & usage guidelines.
- `services/openai.js` — OpenAI client with retry & rate-limit handling.
- `main/hotkeys.js` — Centralized globalShortcut registration.
- `logs/` — Created at runtime in app data path for transcripts and AI responses.

## Guardrails
- **Ethical use only.** This tool is for practice or transparent assistance. Do not use to misrepresent your abilities in an assessment.
- All network keys must come from environment variables, not hard-coded files.

## Task Board (execute top-to-bottom)
1. **Sanity check & run**: `npm start` (Windows).
2. **Live Coding Assist (MVP)**: on `Ctrl+Alt+C`, capture selected screen, OCR code snippets, call `services/openai.js` for review, display suggestions in the Assistance Panel.
3. **Transcription flow**: ensure audio chunking uses WAV header + exponential backoff on API 429/ECONNRESET errors.
4. **UI polish**: Assistance Panel toggles, resize, scrollback, code blocks.
5. **Logging**: write prompts/responses to `interview_logs/` with timestamps (already partly implemented).
6. **Tests**: smoke tests for screenshot capture, OCR, and backoff logic.

## Prompt Contract (for coding suggestions)
```
You are a senior full‑stack interviewer coach. Given a code screenshot or snippet,
return: (1) brief diagnosis, (2) 1–3 specific improvements, (3) a minimal diff-style patch if applicable.
Be concise, use TypeScript/Node idioms when appropriate.
```