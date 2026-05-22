const axios = require('axios');
const https = require('https');

// Persistent keep-alive agent eliminates most ECONNRESETs caused by axios
// reusing idle/dead TLS sockets between rapid-fire transcription calls.
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 12,
  maxFreeSockets: 6,
  timeout: 60000,
});

// API key can be set dynamically via setApiKey() or from env
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// Log initial state
if (OPENAI_API_KEY) {
  console.log('[openai] API key loaded from environment variable');
} else {
  console.log('[openai] No API key in environment - must be set via Settings or setApiKey()');
}

function setApiKey(key) {
  if (!key) {
    console.warn('[openai] setApiKey called with empty/null key');
    return false;
  }
  OPENAI_API_KEY = key;
  console.log('[openai] API key configured successfully (length: ' + key.length + ')');
  return true;
}

function getApiKey() {
  return OPENAI_API_KEY;
}

function isConfigured() {
  return !!OPENAI_API_KEY;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withBackoff(fn, {retries=5, base=500} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const retriable = status === 429 || status >= 500 || err.code === 'ECONNRESET';
      if (!retriable || attempt >= retries) throw err;
      const wait = Math.min(8000, base * Math.pow(2, attempt)) + Math.floor(Math.random()*200);
      console.warn(`[openai] Retry ${attempt+1}/${retries} after ${wait}ms … (${status||err.code})`);
      await sleep(wait);
      attempt++;
    }
  }
}

async function chat({model="gpt-4o-mini", messages=[], temperature=0.2}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  return withBackoff(async () => {
    const res = await axios.post("https://api.openai.com/v1/chat/completions",
      { model, messages, temperature, stream: false },
      {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
        httpsAgent: keepAliveAgent,
      }
    );
    return res.data;
  });
}

async function vision({model="gpt-4o-mini", messages=[]}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  return withBackoff(async () => {
    const res = await axios.post("https://api.openai.com/v1/chat/completions",
      { model, messages },
      {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
        httpsAgent: keepAliveAgent,
      }
    );
    return res.data;
  });
}

async function transcribe({fileStream, model="whisper-1", language="en"}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  // Tight budget for live audio: 2 retries × small backoff, 8s per request.
  // Stale audio is useless — fail fast and let the next chunk through.
  return withBackoff(async () => {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fileStream);
    form.append('model', model);
    if (language) form.append('language', language);

    const res = await axios.post("https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders()
        },
        timeout: 8000,
        httpsAgent: keepAliveAgent,
      }
    );
    return res.data;
  }, { retries: 2, base: 400 });
}

module.exports = { chat, vision, transcribe, setApiKey, getApiKey, isConfigured };