# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Electron-based meeting assistant with real-time audio transcription and AI-powered responses. Supports multiple meeting types (interview, team meeting, 1:1, client call, lecture, general) via pluggable prompt profiles. Two core modes: **Interview Mode** (audio transcription → GPT chat) and **Coding Mode** (screen capture → GPT vision → RAG pipeline).

**Prerequisites:** Node.js 20+, VB-Audio Virtual Cable (or another loopback audio device), OpenAI API key in `.env`.

## Development Commands

```bash
npm install           # Install dependencies
npm start             # Start the app (via scripts/start-electron.js)
npm test              # Run tests (Node.js native test runner)
npm run lint          # ESLint check
npm run lint:fix      # Auto-fix lint issues
npm run build         # Protected build (obfuscate → build-temp/)
npm run package       # Full pipeline: build + electron-builder Windows installer
npm run package:quick # Skip obfuscation, just run electron-builder
npm run build:win:dir # Portable build (no installer, output to dist/)
npm run generate-keys # Generate license keys with SHA-256 hashes
npm run create-icon   # Convert SVG to ICO (sharp + png-to-ico)
```

### Testing
Uses Node.js native `node:test` framework (no external test library). Test files in `tests/`:
- `tests/token-utils.test.js` — token counting, message trimming
- `tests/rag-utils.test.js` — RAG normalization, state merging

Run a single test: `node --test tests/token-utils.test.js`

## Architecture

### Startup Flow
1. License check — `createLicenseWindow()` blocks until activation
2. Load profile, config, and knowledge base metadata
3. Create main window (auto-positioned to secondary display if available)
4. Register global hotkeys

### Main Process (main.js ~1565 lines)
- Electron main process entry point — the orchestrator for all IPC, audio capture, screen capture, and OpenAI calls
- Uses `openai` SDK directly for streaming responses (`openai.chat.completions.create({ stream: true })`)
- Conversation history maintained with token-based pruning (12,000 token limit)
- Session logs auto-saved every 5 messages; logs older than 30 days cleaned up on startup

### Key Modules
- **main/hotkeys.js**: Global hotkey registration (Ctrl+Alt+S/W/L/A, Alt+Shift+C)
- **services/openai.js**: Lightweight OpenAI wrapper using **axios** with exponential backoff/retry. Used for non-streaming calls and transcription. Exports: `chat()`, `vision()`, `transcribe()`, `setApiKey()`, `getApiKey()`, `isConfigured()`
- **services/prompt-profiles.js**: Pluggable meeting-type prompt system. Each profile (interview, teamMeeting, oneOnOne, clientCall, lecture, general) defines `buildSystemPrompt()` and `visionPrompt`. Exports: `buildPrompt()`, `getVisionPrompt()`, `getMeetingTypeList()`
- **services/token-utils.js**: Token counting via `gpt-3-encoder`, message trimming
- **services/rag-utils.js**: RAG state normalization and merging utilities
- **services/document-processor.js**: Multi-format document extraction (PDF via `pdf-parse`, DOCX via `mammoth`, markdown, plain text)
- **services/license-service.js**: License activation with SHA-256 hashing and AES-256-CBC encryption
- **preload.js**: Context bridge exposing IPC handlers to renderer process
- **index.html**: Single-page UI (~280KB) with chat interface, settings modal, and assistance panel
- **license.html**: Separate license activation window

### License System
- 30 pre-generated valid license key hashes (format: `XXXX-XXXX-XXXX-XXXX`)
- License file stored encrypted (AES-256-CBC) at `userData/license.dat`
- Machine ID generated from hostname, platform, arch, CPU model
- License window is a separate BrowserWindow that blocks the app on startup

### Knowledge Base System
- Upload documents (PDF, DOCX, MD, TXT) → text extraction → token counting → optional summarization (GPT-4o-mini for large docs)
- Storage: `userData/knowledge_base/` (files) + `userData/knowledgebase.json` (metadata)
- Documents can be toggled active/inactive without deletion

### RAG Pipeline
- In-memory state with 4 buckets: `requirements`, `outline`, `tests`, `insights`
- Screenshot analysis via GPT-4o vision extracts structured JSON into buckets
- Smart normalization handles strings, arrays, objects, newline-separated text
- Set-based deduplication on merge via `mergeRagState()`
- Solution synthesis: `generate-rag-solution` creates Markdown plan from all buckets (gpt-4o, max 900 tokens)
- **State is in-memory only** — resets on app restart

### Audio Pipeline
1. FFmpeg spawns with `dshow` audio device (Virtual Audio Cable) via `fluent-ffmpeg` + `ffmpeg-static`
2. PCM 16-bit, 16kHz mono with custom `addWavHeader()`
3. RMS amplitude detection triggers recording; silence detection (1.5s) finalizes segments
4. Chunks buffered (~2s) before Whisper API call
5. Transcription → conversation history → GPT-4o streaming response → Marked.js rendering

### Screen Capture → RAG Flow
1. `desktopCapturer.getSources()` → user selects screen → capture to `userData/capture-{uuid}.png`
2. Base64 → GPT-4o vision → structured JSON extracted into RAG buckets
3. Temporary screenshot deleted after processing

### Build Pipeline
1. `npm run build` → `scripts/build-protected.js`: copies to `build-temp/`, obfuscates JS with `javascript-obfuscator` (control flow flattening, dead code injection, debug protection, string array encoding)
2. `npm run package` → electron-builder: ASAR archive, Windows x64 NSIS installer, no code signing, output to `dist/`

## Configuration & Secrets
- **.env**: Must contain `OPENAI_API_KEY` (required). Loaded via `dotenv` at startup.
- **config.json**: Audio device, export format (json/txt), export path, auto-export flag
- API key can also be set via Settings UI at runtime (`setApiKey()`)

## OpenAI API Details
- **Dual client pattern**: `main.js` uses the `openai` SDK (`new OpenAI()`) for streaming chat and vision calls. `services/openai.js` uses **axios** for non-streaming calls (KB summarization, transcription) with its own retry logic.
- Both clients share the same API key, set via `initializeOpenAI()` in main.js which also calls `openaiService.setApiKey()`.
- Retry (services/openai.js): exponential backoff with jitter, max 8s wait, 5 retries. Retriable errors: 429, 5xx, ECONNRESET.
- Models: `gpt-4o` (streaming chat, vision/screen analysis, RAG synthesis), `gpt-4o-mini` (services/openai.js defaults for non-streaming chat, KB summarization), `whisper-1` (transcription)

## Electron Security
- Context isolation enabled, Node integration disabled in renderer
- All Node.js APIs accessed via IPC through preload script
- CSP allows only marked.js from CDN

## Window Management
- Two-window system: license window (modal, blocking) → main window
- Auto-positions to secondary display if multiple monitors detected (50% width, full height)
- Always-on-top toggle via IPC

## File Locations at Runtime
- **Profile**: `%AppData%/my-electron-app/profile.json`
- **Config**: `<project-root>/config.json`
- **License**: `%AppData%/my-electron-app/license.dat` (encrypted)
- **Knowledge Base**: `%AppData%/my-electron-app/knowledge_base/` + `knowledgebase.json`
- **Logs**: `%AppData%/my-electron-app/interview_logs/`
- **Screenshots**: `%AppData%/my-electron-app/capture-*.png` (temporary)

## Ethical Usage Notice

This tool is designed for **transparent interview practice and preparation**. The assistance panel is intentionally visible and should only be used in scenarios where all parties are aware. See `docs/ETHICS_AND_USE.md` for full guidelines.
