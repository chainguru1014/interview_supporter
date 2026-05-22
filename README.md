# Interview Assistant

A focused Electron copilot for hybrid interview prep and live coding sessions. Dock it on a secondary display or split-screen beside the shared IDE and let it handle transcription, screen captures, requirement tracking, and plan synthesis in real time.

## Prerequisites
- Node.js 20+
- npm
- VB-Audio Virtual Cable (or another loopback device) for microphone pass-through
- OpenAI API key in `.env` (`OPENAI_API_KEY=...`)

## Install & Run
```bash
npm install
npm start
```
The window will auto-size to half of the secondary monitor when one is available. Use `Ctrl+Alt+A` any time to toggle the compact assistance overlay.

## Everyday Workflow
1. **Warm-up**: Load role-specific context via **Settings → Profile & Job Information**. Select the loopback device and export preferences.
2. **Theory interview**: Hit **Start Listening** and respond naturally. Transcripts stream to GPT-4o with your CV prompt for grounded answers.
3. **Live coding**: Capture requirements or code snapshots with:
   - `Ctrl+Alt+S` (current screen)
   - `Ctrl+Alt+W` (current window)
   - Capture button if you prefer the dropdown picker
4. **Tracker review**: The RAG sidebar auto-groups captured insights into Requirements, Outline, Tests, and Insights. Add manual notes with the quick input.
5. **Plan on command**: When you are ready to pitch the solution, press `Ctrl+Alt+L` or **Generate Plan**. A concise Markdown blueprint appears in chat and the “Latest Plan” card.
6. **Reset**: Use **Reset Tracker** between interview rounds; it also clears the stored RAG state in the main process.

## Keyboard Shortcuts
| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+S` | Capture selected screen |
| `Ctrl+Alt+W` | Capture selected window |
| `Ctrl+Alt+L` | Generate combined plan from tracked snippets |
| `Ctrl+Alt+A` | Toggle assistance overlay |
| `Alt+Shift+C` | Legacy capture trigger (mapped to assistance hint) |

## Live Coding Pipeline
1. Desktop capture is streamed to OpenAI Vision with a structured JSON prompt.
2. Parsed requirements are normalised (`services/rag-utils.js`) and merged server-side to prevent duplicates.
3. Renderer updates the sidebar lists and notifies you of the originating source.
4. On synthesis, `main.js` composes a tailored plan prompt and logs both user and assistant traces for post-interview review.

## Exporting & Logging
- Session logs (text + JSON) live under `%APPDATA%/interview_logs`.
- Use the 💾 button to export the current conversation to the configured path.
- Auto cleanup keeps logs from growing beyond 7 days.

## Testing
Execute the Node test suite:
```bash
npm test
```
This covers token utilities and the new RAG normalisation helpers. Add further unit tests under `tests/` following the Node `--test` convention.

## Troubleshooting
- **No audio device**: Reopen the Settings modal after `npm start`; the device list is fetched on demand.
- **Capture dropdown empty**: Use the refresh icon ↻ after attaching a new monitor or swapping browser tabs.
- **Plan generation fails**: Ensure at least one requirement is captured or added manually before pressing `Ctrl+Alt+L`.
- **API errors**: Confirm `OPENAI_API_KEY` is valid and your network allows outbound HTTPS.

## Roadmap Ideas
- Optional transcript summary card in the sidebar
- Configurable hotkey set per operating system
- Automated Puppeteer regression covering the capture → plan flow

Stay calm, keep the assistant on the second screen, and let the plan generator handle the storytelling while you code.
