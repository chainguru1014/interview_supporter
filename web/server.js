/**
 * Interview Assistant — Web server
 *
 * A thin Node/Express backend that lets the existing Electron app run as a
 * hosted web app. It does three jobs:
 *   1. Serves the static web UI in web/public/
 *   2. Keeps the OpenAI API key SERVER-SIDE (never sent to the browser) and
 *      proxies all OpenAI calls (chat streaming, transcription, vision)
 *   3. Gates every /api/* route behind a shared password so only people you
 *      give the password to can spend your API credits.
 *
 * It reuses the project's existing service modules so behavior matches the
 * desktop app:
 *   - ../services/openai.js        (axios wrapper: transcribe)
 *   - ../services/prompt-profiles.js (meeting-type system prompts)
 *
 * Streaming chat uses the official `openai` SDK directly (same as main.js).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Load env from the PROJECT ROOT .env (one level up from /web), so you keep a
// single .env with OPENAI_API_KEY. A web/.env (if present) is loaded too and
// can override (e.g. to add ACCESS_PASSWORD).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');

const openaiService = require('../services/openai');
const { buildPrompt, getVisionPrompt, getMeetingTypeList } = require('../services/prompt-profiles');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3002;
const API_KEY = process.env.OPENAI_API_KEY || null;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || null;

// Models (mirror the desktop app)
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o';
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4o';
const TRANSCRIBE_MODEL = 'whisper-1';

if (!API_KEY) {
    console.error('\n[FATAL] OPENAI_API_KEY is not set. Add it to the project-root .env file.\n');
    process.exit(1);
}

// Configure both clients with the key
openaiService.setApiKey(API_KEY);
const openai = new OpenAI({ apiKey: API_KEY });

if (!ACCESS_PASSWORD) {
    console.warn(
        '\n[WARNING] ACCESS_PASSWORD is not set — the app is OPEN to anyone with the URL.\n' +
        '          Set ACCESS_PASSWORD in .env before deploying publicly.\n'
    );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '20mb' })); // vision sends base64 images

// Uploaded audio segments -> temp files (cleaned up after transcription)
const upload = multer({
    storage: multer.diskStorage({
        destination: os.tmpdir(),
        filename: (req, file, cb) => {
            const id = crypto.randomBytes(8).toString('hex');
            cb(null, `ia-audio-${id}.webm`);
        },
    }),
    limits: { fileSize: 25 * 1024 * 1024 }, // Whisper's 25MB limit
});

// --- Shared data store (Context + interviews), synced across all clients -----
// Everyone using the same access password shares one workspace, so we keep a
// single JSON store on disk. `rev` lets clients detect changes and refetch.
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
let store = { rev: 0, profile: {}, persons: [], activePersonId: null, interviews: [], timeSlots: [] };
try {
    if (fs.existsSync(STORE_FILE)) {
        store = Object.assign(store, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
    }
} catch (err) {
    console.error('[store] could not read store.json, starting empty:', err.message);
}
function persistStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STORE_FILE, JSON.stringify(store));
    } catch (err) {
        console.error('[store] write failed:', err.message);
    }
}

// --- Auth gate for all API routes -----------------------------------------
// Uses a constant-time comparison to avoid leaking the password via timing.
function checkPassword(provided) {
    if (!ACCESS_PASSWORD) return true; // no password configured = open (dev)
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(ACCESS_PASSWORD);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
    const provided = req.get('x-access-password') || '';
    if (!checkPassword(provided)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// --- Public meta endpoint (no auth) so the login screen can detect config ---
app.get('/api/meta', (req, res) => {
    res.json({
        passwordRequired: !!ACCESS_PASSWORD,
        configured: openaiService.isConfigured(),
    });
});

// Login check: verify the password, return ok so the client can store it
app.post('/api/login', (req, res) => {
    const provided = (req.body && req.body.password) || '';
    if (!checkPassword(provided)) {
        return res.status(401).json({ ok: false, error: 'Wrong password' });
    }
    res.json({ ok: true });
});

// Everything below requires the password header
app.use('/api', requireAuth);

// --- Meeting types --------------------------------------------------------
app.get('/api/meeting-types', (req, res) => {
    res.json(getMeetingTypeList());
});

// --- Shared workspace data (Context profile + scheduled interviews) ---------
app.get('/api/data', (req, res) => {
    res.json({
        rev: store.rev || 0,
        profile: store.profile || {},
        persons: store.persons || [],
        activePersonId: store.activePersonId || null,
        interviews: store.interviews || [],
        timeSlots: store.timeSlots || [],
    });
});

app.put('/api/data', (req, res) => {
    const { profile, persons, activePersonId, interviews, timeSlots } = req.body || {};
    if (profile && typeof profile === 'object') store.profile = profile;
    if (Array.isArray(persons)) store.persons = persons;
    if (activePersonId !== undefined) store.activePersonId = activePersonId;
    if (Array.isArray(interviews)) store.interviews = interviews;
    if (Array.isArray(timeSlots)) store.timeSlots = timeSlots;
    store.rev = (store.rev || 0) + 1;
    persistStore();
    res.json({ rev: store.rev });
});

// --- Transcription (Whisper) ----------------------------------------------
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });
    const filePath = req.file.path;
    try {
        const result = await openaiService.transcribe({
            fileStream: fs.createReadStream(filePath),
            model: TRANSCRIBE_MODEL,
            language: req.body.language || 'en',
        });
        res.json({ text: (result.text || '').trim() });
    } catch (err) {
        const status = err.response?.status;
        console.error('[transcribe] error:', status || '', err.message);
        res.status(502).json({ error: 'Transcription failed', detail: err.message });
    } finally {
        fs.unlink(filePath, () => {}); // best-effort cleanup
    }
});

// --- Chat (streaming via SSE) ---------------------------------------------
// Body: { meetingType, profileData, question, history: [{role, content}] }
app.post('/api/chat', async (req, res) => {
    const {
        meetingType = 'general',
        profileData = {},
        question = '',
        history = [],
    } = req.body || {};

    if (!question.trim()) {
        return res.status(400).json({ error: 'Empty question' });
    }

    // Build the system prompt server-side (matches the desktop app)
    const systemPrompt = buildPrompt(profileData, meetingType, '', question);

    // Keep the recent history bounded (simple cap; system prompt carries context)
    const recent = Array.isArray(history) ? history.slice(-10) : [];
    const messages = [
        { role: 'system', content: systemPrompt },
        ...recent,
        { role: 'user', content: question },
    ];

    // Server-Sent Events stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
        const stream = await openai.chat.completions.create({
            model: CHAT_MODEL,
            messages,
            temperature: 0.4,
            stream: true,
        });

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) send({ delta });
        }
        send({ done: true });
    } catch (err) {
        console.error('[chat] error:', err.message);
        send({ error: err.message || 'Chat failed' });
    } finally {
        res.end();
    }
});

// --- Vision (analyze a screenshot) ----------------------------------------
// Body: { image: "data:image/png;base64,....", meetingType }
app.post('/api/vision', async (req, res) => {
    const { image, meetingType = 'general' } = req.body || {};
    if (!image || !image.startsWith('data:image')) {
        return res.status(400).json({ error: 'No image provided' });
    }
    try {
        const result = await openaiService.vision({
            model: VISION_MODEL,
            messages: [
                { role: 'system', content: getVisionPrompt(meetingType) },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Analyze this screen.' },
                        { type: 'image_url', image_url: { url: image } },
                    ],
                },
            ],
        });
        const text = result.choices?.[0]?.message?.content || '';
        res.json({ text });
    } catch (err) {
        console.error('[vision] error:', err.message);
        res.status(502).json({ error: 'Vision failed', detail: err.message });
    }
});

// --- Static files ----------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`\n  Interview Assistant (web) running on http://localhost:${PORT}`);
    console.log(`  Chat model: ${CHAT_MODEL} | Vision: ${VISION_MODEL} | Transcribe: ${TRANSCRIBE_MODEL}`);
    console.log(`  Password protection: ${ACCESS_PASSWORD ? 'ON' : 'OFF (dev)'}\n`);
});
