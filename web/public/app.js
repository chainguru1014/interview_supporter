/* Interview Assistant — web client
 *
 * The OpenAI key never touches this file; everything goes through /api/* with
 * the access password header.
 *
 * Context + scheduled interviews are stored ON THE SERVER (shared workspace),
 * so everyone using the same password sees the same data. Clients poll for
 * changes so a save on one device shows up on the others automatically.
 *
 * Reminder "already fired" flags are kept per-browser (localStorage) so each
 * device shows its own notifications independently.
 */

// ---- State ----------------------------------------------------------------
const SEGMENT_MS = 5000;
let password = localStorage.getItem('ia_password') || '';
let meetingTypes = [];
let listening = false;
let mediaStream = null;
let audioStream = null;
let recorder = null;
let history = [];
let answering = false;

// Shared, server-backed data
let DATA = { rev: -1, profile: {}, interviews: [] };
let pushing = false;

let calYear, calMonth;
let editingInterviewId = null;
let detailInterviewId = null;
let activeInterviewId = localStorage.getItem('ia_activeInterview') || null;

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const uid = () => 'iv_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ===========================================================================
// Auth
// ===========================================================================
async function api(path, opts = {}) {
    const headers = Object.assign({ 'x-access-password': password }, opts.headers || {});
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
    return res;
}

async function doLogin() {
    const pw = $('loginPassword').value;
    const errEl = $('loginError');
    errEl.classList.add('hidden');
    try {
        const res = await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
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

async function init() {
    const meta = await fetch('/api/meta').then((r) => r.json()).catch(() => ({}));
    if (!meta.passwordRequired) { password = ''; await startApp(); return; }
    if (password) {
        const res = await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        }).catch(() => null);
        if (res && res.ok) { await startApp(); return; }
        password = ''; localStorage.removeItem('ia_password');
    }
    $('login').classList.remove('hidden');
}

async function startApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    await loadMeetingTypes();
    populateTimezones();
    populateScheduleMeetingTypes();
    // hydrate quickly from cache, then pull authoritative data from the server
    hydrateCache();
    await loadData();
    buildSettingsFields();
    const now = new Date();
    calYear = now.getFullYear(); calMonth = now.getMonth();
    refreshActiveBanner();
    updateNotifyButton();
    checkReminders();
    setInterval(checkReminders, 20000);
    setInterval(loadData, 12000);     // sync shared data across clients
}

// ===========================================================================
// Server-backed shared store
// ===========================================================================
function hydrateCache() {
    try {
        const c = JSON.parse(localStorage.getItem('ia_cache') || 'null');
        if (c && typeof c === 'object') DATA = Object.assign({ rev: -1, profile: {}, interviews: [] }, c);
    } catch (e) { /* ignore */ }
}

async function loadData() {
    if (pushing) return;
    try {
        const res = await api('/api/data');
        const d = await res.json();
        if (d.rev === DATA.rev) return;     // no change
        DATA = { rev: d.rev, profile: d.profile || {}, interviews: d.interviews || [] };
        localStorage.setItem('ia_cache', JSON.stringify(DATA));
        // Refresh visible views (don't clobber a Context form being edited)
        if ($('settings').classList.contains('hidden')) buildSettingsFields();
        if (!$('calendar').classList.contains('hidden')) renderCalendar();
        refreshActiveBanner();
        checkReminders();
    } catch (e) { /* offline / auth — keep cached data */ }
}

async function pushData() {
    pushing = true;
    localStorage.setItem('ia_cache', JSON.stringify(DATA));   // optimistic cache
    try {
        const res = await api('/api/data', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile: DATA.profile, interviews: DATA.interviews }),
        });
        const d = await res.json();
        DATA.rev = d.rev;
        localStorage.setItem('ia_cache', JSON.stringify(DATA));
    } catch (e) {
        console.warn('save to server failed:', e.message);
    } finally { pushing = false; }
}

// ===========================================================================
// Meeting types
// ===========================================================================
async function loadMeetingTypes() {
    meetingTypes = await api('/api/meeting-types').then((r) => r.json());
    const sel = $('meetingType');
    sel.innerHTML = '';
    meetingTypes.forEach((t) => {
        const o = document.createElement('option');
        o.value = t.key; o.textContent = `${t.icon} ${t.label}`;
        sel.appendChild(o);
    });
    sel.value = localStorage.getItem('ia_meetingType') || 'interview';
    sel.onchange = () => { localStorage.setItem('ia_meetingType', sel.value); buildSettingsFields(); };
}

function populateScheduleMeetingTypes() {
    const sel = $('f_meetingType');
    if (!sel) return;
    sel.innerHTML = meetingTypes.map((t) => `<option value="${t.key}">${t.icon} ${t.label}</option>`).join('');
}

function currentType() {
    return meetingTypes.find((t) => t.key === $('meetingType').value) || meetingTypes[0];
}

// ===========================================================================
// Context (global candidate info) — stored on the server
// ===========================================================================
const FIELD_META = {
    fullName: { label: 'Full name' },
    dob: { label: 'Date of birth', type: 'date' },
    gender: { label: 'Gender' },
    nationality: { label: 'Nationality / citizenship' },
    workAuth: { label: 'Work authorization / visa' },
    maritalStatus: { label: 'Marital status' },
    phone: { label: 'Phone' },
    email: { label: 'Email' },
    address: { label: 'Home address', type: 'textarea', full: true },
    fatherInfo: { label: "Father (name / occupation)" },
    motherInfo: { label: "Mother (name / occupation)" },
    siblings: { label: 'Siblings' },
    spouseChildren: { label: 'Spouse / children' },
    languages: { label: 'Languages' },
    education: { label: 'Education', type: 'textarea', full: true },
    links: { label: 'Links (LinkedIn / portfolio / GitHub)', type: 'textarea', full: true },
    hobbies: { label: 'Hobbies / interests', type: 'textarea', full: true },
    candidateInfo: { label: 'Resume / background', type: 'textarea', full: true },
    projects: { label: 'Projects', type: 'textarea', full: true },
    jobTitle: { label: 'Default target job title' },
    jobDescription: { label: 'Default job description', type: 'textarea', full: true },
    whyThisCompany: { label: 'Default: why this company', type: 'textarea', full: true },
    departureReasons: { label: 'Default: reasons for leaving', type: 'textarea', full: true },
    meetingAgenda: { label: 'Meeting agenda', type: 'textarea', full: true },
    teamContext: { label: 'Team context', type: 'textarea', full: true },
    previousNotes: { label: 'Previous notes', type: 'textarea', full: true },
    clientContext: { label: 'Client context', type: 'textarea', full: true },
    courseNotes: { label: 'Course notes', type: 'textarea', full: true },
    contextNotes: { label: 'Context notes', type: 'textarea', full: true },
};

const INTERVIEW_GROUPS = [
    { title: 'Personal & background', fields: ['fullName', 'dob', 'gender', 'nationality', 'workAuth', 'maritalStatus', 'phone', 'email', 'address', 'fatherInfo', 'motherInfo', 'siblings', 'spouseChildren', 'languages', 'education', 'links', 'hobbies'] },
    { title: 'Resume / experience', fields: ['candidateInfo', 'projects'] },
    { title: 'Default role (optional — a scheduled interview overrides these)', fields: ['jobTitle', 'jobDescription', 'whyThisCompany', 'departureReasons'] },
];

function getGlobalProfile() { return DATA.profile || {}; }
function getInterviews() { return DATA.interviews || []; }

function fieldHTML(key) {
    const m = FIELD_META[key] || { label: key };
    const cls = m.full ? 'field full' : 'field';
    const input = m.type === 'textarea'
        ? `<textarea data-field="${key}"></textarea>`
        : `<input type="${m.type || 'text'}" data-field="${key}" />`;
    return `<div class="${cls}"><label>${m.label}</label>${input}</div>`;
}

function buildSettingsFields() {
    const type = currentType();
    if (!type) return;
    const data = getGlobalProfile();
    const wrap = $('settingsFields');
    wrap.innerHTML = '';

    if (type.key === 'interview') {
        INTERVIEW_GROUPS.forEach((g) => {
            const group = document.createElement('div');
            group.className = 'field-group';
            group.innerHTML = `<h3>${g.title}</h3><div class="group-grid">${g.fields.map((f) => fieldHTML(f)).join('')}</div>`;
            wrap.appendChild(group);
        });
    } else {
        const grid = document.createElement('div');
        grid.className = 'group-grid';
        grid.innerHTML = (type.contextFields || []).map((f) => fieldHTML(f)).join('');
        wrap.appendChild(grid);
    }
    wrap.querySelectorAll('[data-field]').forEach((el) => { el.value = data[el.dataset.field] || ''; });
}

function saveSettings() {
    const data = Object.assign({}, getGlobalProfile());
    document.querySelectorAll('#settingsFields [data-field]').forEach((el) => { data[el.dataset.field] = el.value; });
    DATA.profile = data;
    pushData();
    $('settings').classList.add('hidden');
}

// The profile sent to the AI: global info, overridden by the active interview.
function getProfileData() {
    const global = getGlobalProfile();
    if (!activeInterviewId) return global;
    const iv = getInterviews().find((x) => x.id === activeInterviewId);
    if (!iv) return global;
    const merged = { ...global };
    ['jobTitle', 'jobDescription', 'whyThisCompany', 'departureReasons', 'company'].forEach((k) => {
        if (iv[k]) merged[k] = iv[k];
    });
    merged.interviewers = iv.interviewers || [];
    return merged;
}

// ===========================================================================
// Scheduling — timezones
// ===========================================================================
const LOCAL_TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
const TZ_LIST = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
    'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
    'Australia/Sydney', 'Pacific/Auckland'];

function populateTimezones() {
    const sel = $('f_tz');
    const list = [LOCAL_TZ, ...TZ_LIST.filter((t) => t !== LOCAL_TZ)];
    sel.innerHTML = list.map((t) => `<option value="${t}">${t}${t === LOCAL_TZ ? ' (your timezone)' : ''}</option>`).join('');
}

function tzOffsetMs(tz, date) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
    return asUTC - date.getTime();
}

function interviewEpoch(iv) {
    if (!iv.date || !iv.time) return NaN;
    const [y, mo, d] = iv.date.split('-').map(Number);
    const [h, mi] = iv.time.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const off = tzOffsetMs(iv.tz || LOCAL_TZ, new Date(guess));
    return guess - off;
}

function fmtInTz(epoch, tz) {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(epoch));
}

function relTime(epoch) {
    const diff = epoch - Date.now();
    const past = diff < 0;
    let s = Math.abs(diff) / 1000;
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (!d) parts.push(`${m}m`);
    const txt = parts.join(' ');
    return past ? `${txt} ago` : `in ${txt}`;
}

// ===========================================================================
// Calendar
// ===========================================================================
function renderCalendar() {
    const grid = $('calGrid');
    $('calMonth').textContent = new Date(calYear, calMonth, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = dows.map((d) => `<div class="cal-dow">${d}</div>`).join('');

    const first = new Date(calYear, calMonth, 1);
    const start = new Date(calYear, calMonth, 1 - first.getDay());
    const todayStr = `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`;
    const interviews = getInterviews();

    for (let i = 0; i < 42; i++) {
        const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const ds = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
        const other = cur.getMonth() !== calMonth ? ' other' : '';
        const today = ds === todayStr ? ' today' : '';
        const dayEvents = interviews.filter((iv) => iv.date === ds).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
        const evHtml = dayEvents.map((iv) => {
            const past = interviewEpoch(iv) < Date.now() ? ' past' : '';
            return `<div class="cal-event${past}" data-iv="${iv.id}" title="${escapeHtml(iv.title)}">${iv.time || ''} ${escapeHtml(iv.title)}</div>`;
        }).join('');
        html += `<div class="cal-cell${other}${today}" data-date="${ds}"><div class="daynum">${cur.getDate()}</div>${evHtml}</div>`;
    }
    grid.innerHTML = html;

    grid.querySelectorAll('.cal-event').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); openDetail(el.dataset.iv); }; });
    grid.querySelectorAll('.cal-cell').forEach((el) => { el.onclick = () => openScheduleForm(null, el.dataset.date); });
    renderUpcoming();
}

function renderUpcoming() {
    const box = $('calUpcoming');
    const now = Date.now();
    const up = getInterviews().map((iv) => ({ iv, ep: interviewEpoch(iv) }))
        .filter((x) => x.ep >= now).sort((a, b) => a.ep - b.ep).slice(0, 5);
    if (!up.length) { box.innerHTML = '<h3>Upcoming</h3><p class="muted">No upcoming interviews.</p>'; return; }
    box.innerHTML = '<h3>Upcoming</h3>' + up.map(({ iv, ep }) => `
        <div class="upcoming-item" data-iv="${iv.id}">
            <span><strong>${escapeHtml(iv.title)}</strong>${iv.company ? ' · ' + escapeHtml(iv.company) : ''}</span>
            <span class="upcoming-when">${fmtInTz(ep, iv.tz || LOCAL_TZ)} · ${relTime(ep)}</span>
        </div>`).join('');
    box.querySelectorAll('.upcoming-item').forEach((el) => { el.onclick = () => openDetail(el.dataset.iv); });
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===========================================================================
// Schedule form (add / edit)
// ===========================================================================
function addInterviewerRow(data = {}) {
    const row = document.createElement('div');
    row.className = 'iv-row';
    row.innerHTML = `
        <input placeholder="Name" data-iv-field="name" />
        <input placeholder="Role / title" data-iv-field="role" />
        <input placeholder="Company" data-iv-field="company" />
        <button class="iv-remove" title="Remove">×</button>`;
    row.querySelector('[data-iv-field="name"]').value = data.name || '';
    row.querySelector('[data-iv-field="role"]').value = data.role || '';
    row.querySelector('[data-iv-field="company"]').value = data.company || '';
    row.querySelector('.iv-remove').onclick = () => row.remove();
    $('interviewerList').appendChild(row);
}

function openScheduleForm(id, presetDate) {
    editingInterviewId = id;
    const iv = id ? getInterviews().find((x) => x.id === id) : null;
    $('scheduleFormTitle').textContent = iv ? 'Edit interview' : 'New interview';
    $('f_title').value = iv?.title || '';
    $('f_company').value = iv?.company || '';
    $('f_meetingType').value = iv?.meetingType || 'interview';
    $('f_date').value = iv?.date || presetDate || '';
    $('f_time').value = iv?.time || '';
    $('f_tz').value = iv?.tz || LOCAL_TZ;
    $('f_round').value = iv?.round || '';
    $('f_jobTitle').value = iv?.jobTitle || '';
    $('f_jobDescription').value = iv?.jobDescription || '';
    $('f_whyThisCompany').value = iv?.whyThisCompany || '';
    $('f_departureReasons').value = iv?.departureReasons || '';
    $('f_notes').value = iv?.notes || '';
    $('interviewerList').innerHTML = '';
    (iv?.interviewers && iv.interviewers.length ? iv.interviewers : [{}]).forEach(addInterviewerRow);
    $('deleteInterview').classList.toggle('hidden', !iv);
    $('calendar').classList.add('hidden');
    $('interviewDetail').classList.add('hidden');
    $('scheduleForm').classList.remove('hidden');
}

function collectInterviewers() {
    return Array.from($('interviewerList').querySelectorAll('.iv-row')).map((row) => ({
        name: row.querySelector('[data-iv-field="name"]').value.trim(),
        role: row.querySelector('[data-iv-field="role"]').value.trim(),
        company: row.querySelector('[data-iv-field="company"]').value.trim(),
    })).filter((i) => i.name || i.role || i.company);
}

function saveInterview() {
    const title = $('f_title').value.trim();
    const date = $('f_date').value;
    const time = $('f_time').value;
    if (!title || !date || !time) { alert('Title, date and time are required.'); return; }

    const list = getInterviews().slice();
    const existing = editingInterviewId ? list.find((x) => x.id === editingInterviewId) : null;
    const iv = existing || { id: uid() };
    Object.assign(iv, {
        title, company: $('f_company').value.trim(),
        meetingType: $('f_meetingType').value || 'interview',
        date, time, tz: $('f_tz').value,
        round: $('f_round').value.trim(),
        jobTitle: $('f_jobTitle').value.trim(),
        jobDescription: $('f_jobDescription').value.trim(),
        whyThisCompany: $('f_whyThisCompany').value.trim(),
        departureReasons: $('f_departureReasons').value.trim(),
        interviewers: collectInterviewers(),
        notes: $('f_notes').value.trim(),
    });
    if (!existing) list.push(iv);
    DATA.interviews = list;
    pushData();
    resetFired(iv.id);   // reschedule this device's reminders

    if ('Notification' in window && Notification.permission === 'default') requestNotifyPermission();

    $('scheduleForm').classList.add('hidden');
    $('calendar').classList.remove('hidden');
    renderCalendar();
    checkReminders();
}

function deleteInterview() {
    if (!editingInterviewId) return;
    if (!confirm('Delete this interview?')) return;
    DATA.interviews = getInterviews().filter((x) => x.id !== editingInterviewId);
    pushData();
    if (activeInterviewId === editingInterviewId) { activeInterviewId = null; localStorage.removeItem('ia_activeInterview'); refreshActiveBanner(); }
    $('scheduleForm').classList.add('hidden');
    $('calendar').classList.remove('hidden');
    renderCalendar();
}

// ===========================================================================
// Interview detail
// ===========================================================================
function detailRow(k, v) { return v ? `<div class="detail-row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>` : ''; }

function openDetail(id) {
    const iv = getInterviews().find((x) => x.id === id);
    if (!iv) return;
    detailInterviewId = id;
    const ep = interviewEpoch(iv);
    const mt = meetingTypes.find((t) => t.key === (iv.meetingType || 'interview'));
    $('detailTitle').textContent = iv.title;
    $('detailCountdown').textContent = isNaN(ep) ? '' : relTime(ep);
    const ivText = (iv.interviewers || []).map((i) => [i.name, i.role, i.company ? 'at ' + i.company : ''].filter(Boolean).join(', ')).join('\n');
    $('detailBody').innerHTML =
        detailRow('When', `${fmtInTz(ep, iv.tz || LOCAL_TZ)}  (${iv.tz || LOCAL_TZ})`) +
        detailRow('Meeting type', mt ? `${mt.icon} ${mt.label}` : (iv.meetingType || '')) +
        detailRow('Company', iv.company) +
        detailRow('Round / stage', iv.round) +
        detailRow('Target job title', iv.jobTitle) +
        detailRow('Job description', iv.jobDescription) +
        detailRow('Why this company', iv.whyThisCompany) +
        detailRow('Reasons for leaving', iv.departureReasons) +
        detailRow('Interviewer(s)', ivText) +
        detailRow('Notes', iv.notes);
    $('calendar').classList.add('hidden');
    $('interviewDetail').classList.remove('hidden');
}

function useForInterview() {
    if (!detailInterviewId) return;
    const iv = getInterviews().find((x) => x.id === detailInterviewId);
    activeInterviewId = detailInterviewId;
    localStorage.setItem('ia_activeInterview', activeInterviewId);
    const mt = (iv && iv.meetingType) || 'interview';
    $('meetingType').value = mt;
    localStorage.setItem('ia_meetingType', mt);
    buildSettingsFields();
    refreshActiveBanner();
    $('interviewDetail').classList.add('hidden');
}

function refreshActiveBanner() {
    const banner = $('activeBanner');
    if (!activeInterviewId) { banner.classList.add('hidden'); return; }
    const iv = getInterviews().find((x) => x.id === activeInterviewId);
    if (!iv) { banner.classList.add('hidden'); activeInterviewId = null; localStorage.removeItem('ia_activeInterview'); return; }
    $('activeTitle').textContent = iv.title + (iv.company ? ' · ' + iv.company : '');
    $('activeWhen').textContent = '— ' + fmtInTz(interviewEpoch(iv), iv.tz || LOCAL_TZ);
    banner.classList.remove('hidden');
}

// ===========================================================================
// Reminders (per-browser fired tracking; fire while the tab is open)
// ===========================================================================
const MARKS = [
    { key: 'd1440', mins: 1440, label: '1 day' },
    { key: 'd60', mins: 60, label: '1 hour' },
    { key: 'd10', mins: 10, label: '10 minutes' },
];
function getFiredMap() { try { return JSON.parse(localStorage.getItem('ia_fired') || '{}'); } catch (e) { return {}; } }
function setFiredMap(m) { localStorage.setItem('ia_fired', JSON.stringify(m)); }
function resetFired(id) { const m = getFiredMap(); delete m[id]; setFiredMap(m); }

function updateNotifyButton() {
    const btn = $('notifyBtn');
    if (!('Notification' in window)) { btn.textContent = '🔕'; btn.title = 'Notifications not supported'; return; }
    btn.textContent = Notification.permission === 'granted' ? '🔔' : '🔕';
    btn.title = Notification.permission === 'granted' ? 'Reminders on' : 'Click to enable reminders';
}

async function requestNotifyPermission() {
    if (!('Notification' in window)) { alert('This browser does not support notifications.'); return; }
    await Notification.requestPermission();
    updateNotifyButton();
}

function checkReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    const fired = getFiredMap();
    let changed = false;
    getInterviews().forEach((iv) => {
        const ep = interviewEpoch(iv);
        if (isNaN(ep) || ep < now) return;
        fired[iv.id] = fired[iv.id] || {};
        MARKS.forEach((mk) => {
            if (now >= ep - mk.mins * 60000 && !fired[iv.id][mk.key]) {
                fireReminder(iv, mk.label, ep);
                fired[iv.id][mk.key] = true;
                changed = true;
            }
        });
    });
    if (changed) setFiredMap(fired);
}

function fireReminder(iv, label, ep) {
    try {
        const n = new Notification(`Interview in ${label}: ${iv.title}`, {
            body: `${iv.company ? iv.company + ' · ' : ''}${fmtInTz(ep, iv.tz || LOCAL_TZ)}`,
            tag: iv.id + label,
        });
        n.onclick = () => { window.focus(); $('calendar').classList.remove('hidden'); renderCalendar(); openDetail(iv.id); n.close(); };
    } catch (e) { /* ignore */ }
}

// ===========================================================================
// Audio capture + transcription
// ===========================================================================
function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    return '';
}
function setStatus(text, cls) { const el = $('status'); el.textContent = text; el.className = 'status ' + cls; }

async function startListening() {
    const source = $('audioSource').value;
    try {
        mediaStream = source === 'screen'
            ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
            : await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { setStatus('Permission denied', 'error'); return; }

    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) { setStatus('No audio track — re-share and tick "Share audio"', 'error'); stopTracks(); return; }
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
    try { rec = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined); }
    catch (e) { setStatus('Recording not supported', 'error'); return; }
    recorder = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 2500) transcribeBlob(blob);
        if (listening) recordSegment();
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
    } catch (e) { console.warn('transcribe failed', e.message); }
}

function appendTranscript(text) {
    const t = $('transcript');
    t.textContent = (t.textContent ? t.textContent + ' ' : '') + text;
    t.scrollTop = t.scrollHeight;
    $('questionInput').value = text;
    if ($('autoRespond').checked && !answering) getAnswer(text);
}

function stopTracks() {
    if (mediaStream) mediaStream.getTracks().forEach((tr) => tr.stop());
    mediaStream = null; audioStream = null;
}
function stopListening() {
    listening = false;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (e) {} }
    stopTracks();
    $('listenBtn').textContent = '▶ Start';
    $('listenBtn').classList.remove('active');
    setStatus('Idle', 'idle');
}

// ===========================================================================
// AI answer (SSE streaming)
// ===========================================================================
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
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                meetingType: $('meetingType').value,
                profileData: getProfileData(),
                question, history,
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
            buffer = parts.pop();
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
        if (full) {
            history.push({ role: 'user', content: question });
            history.push({ role: 'assistant', content: full });
            if (history.length > 20) history = history.slice(-20);
        }
        setStatus(listening ? 'Listening…' : 'Idle', listening ? 'listening' : 'idle');
    } catch (e) {
        answerEl.innerHTML = `<p class="error">Request failed: ${e.message}</p>`;
        setStatus('Error', 'error');
    } finally { answering = false; }
}

// ===========================================================================
// Screen analysis (vision)
// ===========================================================================
async function analyzeScreen() {
    let stream = mediaStream;
    let temporary = false;
    if (!stream || stream.getVideoTracks().length === 0) {
        try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); temporary = true; }
        catch (e) { setStatus('Screen share cancelled', 'idle'); return; }
    }
    setStatus('Analyzing screen…', 'working');
    try {
        const track = stream.getVideoTracks()[0];
        const video = document.createElement('video');
        video.srcObject = new MediaStream([track]);
        await video.play();
        await new Promise((r) => setTimeout(r, 300));
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        video.pause();
        if (temporary) track.stop();

        const res = await api('/api/vision', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: dataUrl, meetingType: $('meetingType').value }),
        });
        const data = await res.json();
        let pretty = data.text || '';
        try { pretty = '```json\n' + JSON.stringify(JSON.parse(pretty), null, 2) + '\n```'; } catch (e) {}
        $('answer').innerHTML = marked.parse('### Screen analysis\n\n' + pretty);
        setStatus(listening ? 'Listening…' : 'Idle', listening ? 'listening' : 'idle');
    } catch (e) { setStatus('Analysis failed', 'error'); console.error(e); }
}

// ===========================================================================
// Wire up UI
// ===========================================================================
$('loginBtn').onclick = doLogin;
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logoutBtn').onclick = logout;

$('settingsBtn').onclick = () => { buildSettingsFields(); $('settings').classList.remove('hidden'); };
$('saveSettings').onclick = saveSettings;

$('scheduleBtn').onclick = () => { $('calendar').classList.remove('hidden'); renderCalendar(); };
$('closeCalendar').onclick = () => { $('calendar').classList.add('hidden'); };
$('calPrev').onclick = () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); };
$('calNext').onclick = () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); };
$('calToday').onclick = () => { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); renderCalendar(); };
$('addInterviewBtn').onclick = () => openScheduleForm(null, null);

$('addInterviewerBtn').onclick = () => addInterviewerRow();
$('saveInterview').onclick = saveInterview;
$('deleteInterview').onclick = deleteInterview;
$('closeScheduleForm').onclick = () => { $('scheduleForm').classList.add('hidden'); $('calendar').classList.remove('hidden'); };

$('useForInterview').onclick = useForInterview;
$('editInterview').onclick = () => openScheduleForm(detailInterviewId, null);
$('closeDetail').onclick = () => { $('interviewDetail').classList.add('hidden'); $('calendar').classList.remove('hidden'); };

$('clearActive').onclick = () => { activeInterviewId = null; localStorage.removeItem('ia_activeInterview'); refreshActiveBanner(); };
$('notifyBtn').onclick = requestNotifyPermission;

$('listenBtn').onclick = () => (listening ? stopListening() : startListening());
$('askBtn').onclick = () => getAnswer();
$('captureBtn').onclick = analyzeScreen;
$('clearBtn').onclick = () => {
    $('transcript').textContent = '';
    $('questionInput').value = '';
    $('answer').innerHTML = '<p class="muted">Answers will stream here.</p>';
    history = [];
};
$('questionInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) getAnswer(); });

// ✕ close buttons on any modal card
document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.onclick = () => { const ov = btn.closest('.overlay'); if (ov) ov.classList.add('hidden'); };
});

init();
