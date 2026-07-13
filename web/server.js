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

// Telegram bridge (optional) — mirrors the Chris/Amrit chat into a Telegram
// group so messages sent on either side show up on both. See web/README.md
// for the one-time BotFather / group setup.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const TELEGRAM_USER_IDS = {
    chris: process.env.TELEGRAM_CHRIS_USER_ID || null,
    amrit: process.env.TELEGRAM_AMRIT_USER_ID || null,
};
const TELEGRAM_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : null;

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
let store = { rev: 0, profile: {}, persons: [], activePersonId: null, interviews: [], timeSlots: [], chatMessages: [] };
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

// --- Chat between the two users (Chris / Amrit) -----------------------------
// Simple polled chat, shared on the same disk store as everything else.
// History is capped so the store file and the poll payload stay small.
// Optionally bridged to a Telegram group — see the Telegram section below.
app.get('/api/chat-messages', (req, res) => {
    res.json({ messages: store.chatMessages || [] });
});

app.post('/api/chat-messages', (req, res) => {
    const { sender, text } = req.body || {};
    if (!sender || !text || !text.trim()) return res.status(400).json({ error: 'sender and text are required' });
    const msg = { id: crypto.randomBytes(6).toString('hex'), sender, text: text.trim(), ts: Date.now() };
    store.chatMessages = [...(store.chatMessages || []), msg].slice(-500);
    persistStore();
    res.json({ message: msg });
    relayToTelegram(msg);
});

// --- Telegram bridge (optional) --------------------------------------------
// A bot can only see messages in chats it's a member of — not a private 1:1
// DM between two humans — so the synced thread is a small Telegram group
// with Chris, Amrit, and the bot. Long-polls getUpdates (no public webhook
// needed) and relays each side into the other. Entirely inert if
// TELEGRAM_BOT_TOKEN isn't set.
let telegramBotId = null;

async function telegramCall(method, params) {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
    return data.result;
}

function identityFromTelegramUserId(userId) {
    if (TELEGRAM_USER_IDS.chris && String(userId) === String(TELEGRAM_USER_IDS.chris)) return 'chris';
    if (TELEGRAM_USER_IDS.amrit && String(userId) === String(TELEGRAM_USER_IDS.amrit)) return 'amrit';
    return null;
}

async function relayToTelegram(msg) {
    if (!TELEGRAM_API || !TELEGRAM_CHAT_ID) return;
    const label = msg.sender === 'chris' ? 'Chris' : msg.sender === 'amrit' ? 'Amrit' : msg.sender;
    try {
        await telegramCall('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: `${label}: ${msg.text}` });
    } catch (err) { console.error('[telegram] relay to Telegram failed:', err.message); }
}

async function handleTelegramUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;
    if (msg.from?.is_bot) return; // our own relayed messages coming back — ignore

    if (!TELEGRAM_CHAT_ID) {
        console.log(`[telegram] saw a message in chat_id=${msg.chat.id} ("${msg.chat.title || msg.chat.type}") — set TELEGRAM_CHAT_ID=${msg.chat.id} in .env to enable the bridge.`);
        return;
    }
    if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return; // a different chat than the configured group

    let sender = identityFromTelegramUserId(msg.from.id);
    if (!sender) {
        console.log(`[telegram] message from unmapped Telegram user_id=${msg.from.id} (${msg.from.first_name}) — set TELEGRAM_CHRIS_USER_ID or TELEGRAM_AMRIT_USER_ID in .env to map them.`);
        sender = msg.from.first_name || 'Telegram';
    }
    const chatMsg = { id: crypto.randomBytes(6).toString('hex'), sender, text: msg.text.trim(), ts: Date.now(), viaTelegram: true };
    store.chatMessages = [...(store.chatMessages || []), chatMsg].slice(-500);
    persistStore();
}

async function pollTelegramUpdates(startOffset) {
    let offset = startOffset;
    while (true) {
        try {
            const updates = await telegramCall('getUpdates', { offset, timeout: 25 });
            for (const update of updates) {
                offset = update.update_id + 1;
                await handleTelegramUpdate(update);
            }
        } catch (err) {
            console.error('[telegram] poll error (retrying in 5s):', err.message);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

async function startTelegramBridge() {
    if (!TELEGRAM_API) return;
    let me;
    try {
        me = await telegramCall('getMe');
        telegramBotId = me.id;
    } catch (err) {
        console.error('[telegram] could not start — check TELEGRAM_BOT_TOKEN:', err.message);
        return;
    }
    console.log(`[telegram] bridge active as @${me.username}${TELEGRAM_CHAT_ID ? '' : ' — send a message in your group to discover its chat_id (see server logs)'}`);
    // Skip any backlog from before this boot so a restart doesn't replay old messages.
    let offset;
    try {
        const backlog = await telegramCall('getUpdates', { timeout: 0 });
        if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
    } catch (err) { /* start from whatever Telegram gives us next */ }
    pollTelegramUpdates(offset);
}

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

    // Keep the recent history bounded — wide enough to cover a full interview's
    // worth of prior questions/answers, not just the last couple of exchanges.
    const recent = Array.isArray(history) ? history.slice(-60) : [];
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
    startTelegramBridge();
});
