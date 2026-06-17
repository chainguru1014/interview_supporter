/* Interview Assistant — web client
 *
 * Talks to the Node backend (server.js). The OpenAI key never touches this
 * file; everything goes through /api/* with the access password header.
 */

// ---- State ----------------------------------------------------------------
const SEGMENT_MS = 5000; // length of each audio segment sent to Whisper
let password = localStorage.getItem('ia_password') || '';
let meetingTypes = [];
let listening = false;
let mediaStream = null;     // raw stream (may include video for screen capture)
let audioStream = null;     // audio-only stream used by MediaRecorder
let recorder = null;
let history = [];           // [{role, content}] conversation memory
let answering = false;

const $ = (id) => document.getElementById(id);

// ---- Auth flow ------------------------------------------------------------
async function api(path, opts = {}) {
    const headers = Object.assign({ 'x-access-password': password }, opts.headers || {});
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
        logout();
        throw new Error('Unauthorized');
    }
    return res;
}

async function doLogin() {
    const pw = $('loginPassword').value;
    const errEl = $('loginError');
    errEl.classList.add('hidden');
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
            errEl.textContent = data.error || 'Login failed';
            errEl.classList.remove('hidden');
            return;
        }
        password = pw;
        localStorage.setItem('ia_password', pw);
        await startApp();
    } catch (e) {
        errEl.textContent = 'Could not reach the server.';
        errEl.classList.remove('hidden');
    }
}

function logout() {
    password = '';
    localStorage.removeItem('ia_password');
    if (listening) stopListening();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
}

// On load: if a password is stored, try to skip the login screen
async function init() {
    const meta = await fetch('/api/meta').then((r) => r.json()).catch(() => ({}));
    if (!meta.passwordRequired) {
        // No password configured on server — go straight in
        password = '';
        await startApp();
        return;
    }
    if (password) {
        // Validate stored password silently
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        }).catch(() => null);
        if (res && res.ok) {
            await startApp();
            return;
        }
        password = '';
        localStorage.removeItem('ia_password');
    }
    $('login').classList.remove('hidden');
}

async function startApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    await loadMeetingTypes();
    buildSettingsFields();
}

// ---- Meeting types --------------------------------------------------------
async function loadMeetingTypes() {
    meetingTypes = await api('/api/meeting-types').then((r) => r.json());
    const sel = $('meetingType');
    sel.innerHTML = '';
    meetingTypes.forEach((t) => {
        const o = document.createElement('option');
        o.value = t.key;
        o.textContent = `${t.icon} ${t.label}`;
        sel.appendChild(o);
    });
    sel.value = localStorage.getItem('ia_meetingType') || 'interview';
    sel.onchange = () => {
        localStorage.setItem('ia_meetingType', sel.value);
        buildSettingsFields();
    };
}

// ---- Context / settings ---------------------------------------------------
const FIELD_LABELS = {
    candidateInfo: 'Candidate background / resume',
    projects: 'Projects',
    jobTitle: 'Target job title',
    jobDescription: 'Job description',
    departureReasons: 'Reasons for leaving (per company)',
    whyThisCompany: 'Why this company',
    meetingAgenda: 'Meeting agenda',
    teamContext: 'Team context',
    previousNotes: 'Previous notes',
    clientContext: 'Client context',
    courseNotes: 'Course notes',
    contextNotes: 'Context notes',
};

function currentType() {
    return meetingTypes.find((t) => t.key === $('meetingType').value) || meetingTypes[0];
}

function getProfileData() {
    return JSON.parse(localStorage.getItem('ia_profile') || '{}');
}

function buildSettingsFields() {
    const type = currentType();
    if (!type) return;
    const data = getProfileData();
    const wrap = $('settingsFields');
    wrap.innerHTML = '';
    (type.contextFields || []).forEach((f) => {
        const div = document.createElement('div');
        div.className = 'field';
        const isShort = f === 'jobTitle';
        div.innerHTML = `<label>${FIELD_LABELS[f] || f}</label>` +
            (isShort
                ? `<input data-field="${f}" />`
                : `<textarea data-field="${f}"></textarea>`);
        const input = div.querySelector('[data-field]');
        input.value = data[f] || '';
        wrap.appendChild(div);
    });
}

function saveSettings() {
    const data = getProfileData();
    document.querySelectorAll('#settingsFields [data-field]').forEach((el) => {
        data[el.dataset.field] = el.value;
    });
    localStorage.setItem('ia_profile', JSON.stringify(data));
    $('settings').classList.add('hidden');
}

// ---- Audio capture + transcription ---------------------------------------
function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const c of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
}

function setStatus(text, cls) {
    const el = $('status');
    el.textContent = text;
    el.className = 'status ' + cls;
}

async function startListening() {
    const source = $('audioSource').value;
    try {
        if (source === 'screen') {
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true,
            });
        } else {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
    } catch (e) {
        setStatus('Permission denied', 'error');
        return;
    }

    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
        setStatus('No audio track — re-share and tick "Share audio"', 'error');
        stopTracks();
        return;
    }

    // If the user stops sharing via the browser UI, reflect it
    audioTracks[0].addEventListener('ended', () => { if (listening) stopListening(); });

    audioStream = new MediaStream(audioTracks);
    listening = true;
    $('listenBtn').textContent = '■ Stop';
    $('listenBtn').classList.add('active');
    setStatus('Listening…', 'listening');
    recordSegment();
}

function recordSegment() {
    if (!listening || !audioStream) return;
    const chunks = [];
    const mimeType = pickMime();
    let rec;
    try {
        rec = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
    } catch (e) {
        setStatus('Recording not supported', 'error');
        return;
    }
    recorder = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 2500) transcribeBlob(blob);
        if (listening) recordSegment(); // immediately start the next segment
    };
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, SEGMENT_MS);
}

async function transcribeBlob(blob) {
    const fd = new FormData();
    fd.append('audio', blob, 'segment.webm');
    try {
        const res = await api('/api/transcribe', { method: 'POST', body: fd });
        const data = await res.json();
        const text = (data.text || '').trim();
        if (text) appendTranscript(text);
    } catch (e) {
        // Non-fatal: skip this segment
        console.warn('transcribe failed', e.message);
    }
}

function appendTranscript(text) {
    const t = $('transcript');
    t.textContent = (t.textContent ? t.textContent + ' ' : '') + text;
    t.scrollTop = t.scrollHeight;
    $('questionInput').value = text; // prime the ask box with the latest line
    if ($('autoRespond').checked && !answering) {
        getAnswer(text);
    }
}

function stopTracks() {
    if (mediaStream) mediaStream.getTracks().forEach((tr) => tr.stop());
    mediaStream = null;
    audioStream = null;
}

function stopListening() {
    listening = false;
    if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (e) { /* ignore */ }
    }
    stopTracks();
    $('listenBtn').textContent = '▶ Start';
    $('listenBtn').classList.remove('active');
    setStatus('Idle', 'idle');
}

// ---- AI answer (SSE streaming) -------------------------------------------
async function getAnswer(questionArg) {
    if (answering) return;
    const question = (questionArg || $('questionInput').value || '').trim();
    if (!question) return;

    answering = true;
    setStatus('Thinking…', 'working');
    const answerEl = $('answer');
    answerEl.innerHTML = '<span class="cursor">▍</span>';
    let full = '';

    try {
        const res = await api('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                meetingType: $('meetingType').value,
                profileData: getProfileData(),
                question,
                history,
            }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop(); // keep incomplete event
            for (const part of parts) {
                const line = part.trim();
                if (!line.startsWith('data:')) continue;
                const payload = JSON.parse(line.slice(5).trim());
                if (payload.delta) {
                    full += payload.delta;
                    answerEl.innerHTML = marked.parse(full) + '<span class="cursor">▍</span>';
                    answerEl.scrollTop = answerEl.scrollHeight;
                } else if (payload.error) {
                    answerEl.innerHTML = `<p class="error">Error: ${payload.error}</p>`;
                }
            }
        }
        answerEl.innerHTML = marked.parse(full || '*(no response)*');

        // Save to conversation memory
        if (full) {
            history.push({ role: 'user', content: question });
            history.push({ role: 'assistant', content: full });
            if (history.length > 20) history = history.slice(-20);
        }
        setStatus(listening ? 'Listening…' : 'Idle', listening ? 'listening' : 'idle');
    } catch (e) {
        answerEl.innerHTML = `<p class="error">Request failed: ${e.message}</p>`;
        setStatus('Error', 'error');
    } finally {
        answering = false;
    }
}

// ---- Screen analysis (vision) --------------------------------------------
async function analyzeScreen() {
    let stream = mediaStream;
    let temporary = false;
    // If we don't already have a screen stream with video, request one
    if (!stream || stream.getVideoTracks().length === 0) {
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            temporary = true;
        } catch (e) {
            setStatus('Screen share cancelled', 'idle');
            return;
        }
    }
    setStatus('Analyzing screen…', 'working');
    try {
        const track = stream.getVideoTracks()[0];
        const video = document.createElement('video');
        video.srcObject = new MediaStream([track]);
        await video.play();
        await new Promise((r) => setTimeout(r, 300)); // let a frame render
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        video.pause();
        if (temporary) track.stop();

        const res = await api('/api/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataUrl, meetingType: $('meetingType').value }),
        });
        const data = await res.json();
        const answerEl = $('answer');
        // Vision prompt returns JSON; show it readably
        let pretty = data.text || '';
        try { pretty = '```json\n' + JSON.stringify(JSON.parse(pretty), null, 2) + '\n```'; } catch (e) { /* leave as-is */ }
        answerEl.innerHTML = marked.parse('### Screen analysis\n\n' + pretty);
        setStatus(listening ? 'Listening…' : 'Idle', listening ? 'listening' : 'idle');
    } catch (e) {
        setStatus('Analysis failed', 'error');
        console.error(e);
    }
}

// ---- Wire up UI -----------------------------------------------------------
$('loginBtn').onclick = doLogin;
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logoutBtn').onclick = logout;
$('settingsBtn').onclick = () => { buildSettingsFields(); $('settings').classList.remove('hidden'); };
$('closeSettings').onclick = () => $('settings').classList.add('hidden');
$('saveSettings').onclick = saveSettings;
$('listenBtn').onclick = () => (listening ? stopListening() : startListening());
$('askBtn').onclick = () => getAnswer();
$('captureBtn').onclick = analyzeScreen;
$('clearBtn').onclick = () => {
    $('transcript').textContent = '';
    $('questionInput').value = '';
    $('answer').innerHTML = '<p class="muted">Answers will stream here.</p>';
    history = [];
};
$('questionInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) getAnswer();
});

init();
