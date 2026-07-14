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
let identity = localStorage.getItem('ia_identity') || '';   // 'chris' | 'amrit' — which of the two of you this browser is
let pwRequired = true;   // set from /api/meta on init(); the login card hides the password field when false
let meetingTypes = [];
let listening = false;
let mediaStream = null;   // screen/tab capture (video + interviewer audio) — also reused for screenshot analysis
let micStream = null;     // raw mic capture (kept for track cleanup)
const audioStreams = { me: null, interviewer: null };
const recorders = { me: null, interviewer: null };
let history = [];
let answering = false;          // manual/immediate answer in flight (Get answer / Analyze screen)
let interviewerBuffer = [];     // interviewer transcript chunks accumulated since the last "Get answer" click
let meRecentLines = [];         // last few things *I* said (mic) — passed as context so answers stay consistent
let lastSpeaker = null;         // speaker of the most recent transcript bubble — same speaker merges into one paragraph
let lastBubbleTextEl = null;    // the <span class="bubble-text"> currently being appended to

// Pure filler/pleasantries that add no content on their own (greetings, thanks,
// closings, acknowledgements) — dropped so they don't clutter the transcript.
// Anything with actual content alongside them (e.g. "Thanks, and what stack
// did you use?") does NOT match and is kept in full.
// Matches exactly ONE filler phrase, nothing more.
const FILLER_PHRASE_RE = /^(thanks?( you)?( very much| so much| a lot| a ton| a bunch)?|no,? thank you|bye+([\s-]?bye)?|goodbye|good\s?bye|great|nice|cool|perfect|awesome|sounds good|got it|okay|ok|alright|all right|have a (good|nice|great) (one|day)|take care|see you( soon| later| around)?|no problem|you'?re welcome|welcome|you|yeah|yep|mm-?hmm|uh-?huh)$/i;

// A segment is filler only if EVERY sentence in it is pure filler — e.g.
// "Thank you. Bye." is two chained filler phrases and must also be dropped,
// not just a single "Great." Anything with even one real sentence survives
// in full (never partially edited).
function isFiller(text) {
    const sentences = text.split(/[.!?,]+/).map((s) => s.trim()).filter(Boolean);
    if (!sentences.length) return true;
    return sentences.every((s) => FILLER_PHRASE_RE.test(s));
}

// Real flow: microphone = you, shared tab/screen audio (e.g. the Google Meet
// window) = the interviewer. Flip back to true only if you need to test the
// transcript + Get-answer flow solo, without a real second audio source.
const TEST_MIC_AS_INTERVIEWER = false;

// Shared, server-backed data
let DATA = { rev: -1, persons: [], activePersonId: null, interviews: [], timeSlots: [] };
let pushing = false;

let calYear, calMonth, calDay;
let calView = localStorage.getItem('ia_calView') || 'month';
const CAL_TZ_LEFT_DEFAULT = 'Europe/Berlin';
const CAL_TZ_RIGHT_DEFAULT = 'America/Chicago';
let calTzLeft  = localStorage.getItem('ia_calTzLeft')  || CAL_TZ_LEFT_DEFAULT;
let calTzRight = localStorage.getItem('ia_calTzRight') || CAL_TZ_RIGHT_DEFAULT;
let calTz = calTzLeft; // kept for any legacy helper calls
let editingInterviewId = null;
let detailInterviewId  = null;
let activeInterviewId  = localStorage.getItem('ia_activeInterview') || null;
let ctxMenuSlotId    = null;
let ctxMenuPresetDate = null;
let ctxMenuPresetTime = null;

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
    const chosenIdentity = $('loginIdentity').value;
    const pw = $('loginPassword').value;
    const errEl = $('loginError');
    errEl.classList.add('hidden');
    try {
        if (pwRequired) {
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
        }
        identity = chosenIdentity;
        localStorage.setItem('ia_identity', identity);
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
    pwRequired = !!meta.passwordRequired;
    $('loginPwField').classList.toggle('hidden', !pwRequired);
    if ($('loginIdentity') && identity) $('loginIdentity').value = identity;
    if (!pwRequired) {
        password = '';
        if (identity) { await startApp(); return; }
        $('login').classList.remove('hidden');
        return;
    }
    if (password && identity) {
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
    updateChatPeerLabel();
    await loadMeetingTypes();
    populateTimezones();
    populateScheduleMeetingTypes();
    // hydrate quickly from cache, then pull authoritative data from the server
    hydrateCache();
    await loadData();
    buildSettingsFields();
    const now = new Date();
    calYear = now.getFullYear(); calMonth = now.getMonth(); calDay = now.getDate();
    refreshActiveBanner();
    updateNotifyButton();
    checkReminders();
    await loadChatMessages();
    setInterval(checkReminders, 20000);
    setInterval(loadData, 12000);     // sync shared data across clients
    setInterval(loadChatMessages, 3000);  // chat feels live without a websocket
}

// ===========================================================================
// Server-backed shared store
// ===========================================================================
function hydrateCache() {
    try {
        const c = JSON.parse(localStorage.getItem('ia_cache') || 'null');
        if (c && typeof c === 'object') DATA = Object.assign({ rev: -1, persons: [], activePersonId: null, interviews: [], timeSlots: [] }, c);
    } catch (e) { /* ignore */ }
}

async function loadData() {
    if (pushing) return;
    try {
        const res = await api('/api/data');
        const d = await res.json();
        if (d.rev === DATA.rev) return;     // no change
        const incomingPersons = Array.isArray(d.persons) ? d.persons : [];
        // One-time migration: if server has old single-profile but no persons array yet
        if (incomingPersons.length === 0 && d.profile && Object.keys(d.profile).length > 0) {
            const id = 'p_' + Math.random().toString(36).slice(2, 10);
            DATA = { rev: d.rev, persons: [{ id, name: d.profile.fullName || 'Default', ...d.profile }], activePersonId: id, interviews: d.interviews || [], timeSlots: d.timeSlots || [] };
            localStorage.setItem('ia_cache', JSON.stringify(DATA));
            pushData();
            return;
        }
        DATA = { rev: d.rev, persons: incomingPersons, activePersonId: d.activePersonId || incomingPersons[0]?.id || null, interviews: d.interviews || [], timeSlots: d.timeSlots || [] };
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
            body: JSON.stringify({ persons: DATA.persons, activePersonId: DATA.activePersonId, interviews: DATA.interviews, timeSlots: DATA.timeSlots }),
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

function getPersons() { return DATA.persons || []; }
function getActivePersonId() { return DATA.activePersonId || getPersons()[0]?.id || null; }
function getGlobalProfile() {
    const id = getActivePersonId();
    return (id ? getPersons().find((p) => p.id === id) : getPersons()[0]) || {};
}
function getInterviews() { return DATA.interviews || []; }
function getTimeSlots() { return DATA.timeSlots || []; }

// ===========================================================================
// Person colors
// ===========================================================================
const PERSON_COLORS = [
    '#6366f1', // indigo
    '#22c55e', // green
    '#f59e0b', // amber
    '#ef4444', // red
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#14b8a6', // teal
    '#f97316', // orange
];
function getPersonColor(personId) {
    if (!personId) return null;
    const idx = getPersons().findIndex((p) => p.id === personId);
    return idx >= 0 ? PERSON_COLORS[idx % PERSON_COLORS.length] : null;
}

// ===========================================================================
// Time slot availability (independent of individual interviews)
// ===========================================================================
function getUsTzInfo(dateStr, timeStr, slotTz) {
    if (!dateStr || !timeStr) return null;
    const ep = tsEpoch({ date: dateStr, startTime: timeStr, tz: slotTz || LOCAL_TZ });
    if (isNaN(ep)) return null;
    const fmtTz = (targetTz) => {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: targetTz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ep));
        const h = parseInt(parts.find((p) => p.type === 'hour')?.value || 0);
        const pm = /pm/i.test(parts.find((p) => p.type === 'dayperiod')?.value || '');
        const h24 = pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
        const str = parts.filter((p) => ['hour', 'literal', 'minute', 'dayperiod'].includes(p.type)).map((p) => p.value).join('');
        return { str, h24, inBiz: h24 >= 9 && h24 < 18 };
    };
    const et = fmtTz('America/New_York');
    const pt = fmtTz('America/Los_Angeles');
    return { et, pt, anyInBiz: et.inBiz || pt.inBiz };
}

function slotConflictsWithInterviews(dateStr, startTime, endTime, slotTz) {
    if (!dateStr || !startTime) return [];
    const tz = slotTz || LOCAL_TZ;
    const s0 = tsEpoch({ date: dateStr, startTime, tz });
    const s1 = endTime ? tsEpoch({ date: dateStr, startTime: endTime, tz }) : s0 + 3600000;
    if (isNaN(s0)) return [];
    return getInterviews().filter((iv) => {
        const i0 = interviewEpoch(iv);
        if (isNaN(i0)) return false;
        const endEp = interviewEndEpoch(iv);
        const i1 = !isNaN(endEp) ? endEp : i0 + 3600000;
        return s0 < i1 && s1 > i0;
    }).map((iv) => iv.title);
}

function updateTsRowInfo(row) {
    const dateStr = row.querySelector('.ts-date').value;
    const startTime = row.querySelector('.ts-start').value;
    const endTime = row.querySelector('.ts-end').value;
    const slotTz = row.querySelector('.ts-tz')?.value || LOCAL_TZ;
    const infoEl = row.querySelector('.ts-info');
    const usTimes = row.querySelector('.ts-us-times');
    const bizWarn = row.querySelector('.ts-biz-warn');
    const ivConflict = row.querySelector('.ts-iv-conflict');
    if (!dateStr || !startTime) { infoEl.classList.add('hidden'); return; }
    infoEl.classList.remove('hidden');
    const tzInfo = getUsTzInfo(dateStr, startTime, slotTz);
    if (tzInfo) {
        usTimes.textContent = `🌎 ET: ${tzInfo.et.str}  ·  PT: ${tzInfo.pt.str}`;
        bizWarn.classList.toggle('hidden', tzInfo.anyInBiz);
    }
    const conflicts = slotConflictsWithInterviews(dateStr, startTime, endTime || null, slotTz);
    ivConflict.classList.toggle('hidden', !conflicts.length);
    if (conflicts.length) ivConflict.textContent = `⚠ Conflicts: ${conflicts.slice(0, 2).join(', ')}${conflicts.length > 2 ? '…' : ''}`;
}

function addTsRow(data = {}) {
    const row = document.createElement('div');
    row.className = 'ts-row';
    row.dataset.tsid = data.id || uid();
    row.innerHTML = `
        <div class="ts-fields">
            <input type="date" class="ts-date" />
            <input type="time" class="ts-start" />
            <span class="ts-sep">–</span>
            <input type="time" class="ts-end" />
            <select class="ts-tz"></select>
            <button class="ts-remove" title="Remove slot">×</button>
        </div>
        <div class="ts-info hidden">
            <span class="ts-us-times"></span>
            <span class="ts-biz-warn">⚠ Outside US business hours (9 AM–6 PM ET/PT)</span>
            <span class="ts-iv-conflict hidden"></span>
        </div>`;
    row.querySelector('.ts-date').value = data.date || '';
    row.querySelector('.ts-start').value = data.startTime || '';
    row.querySelector('.ts-end').value = data.endTime || '';
    populateTzSelect(row.querySelector('.ts-tz'), data.tz || LOCAL_TZ);
    const refresh = () => updateTsRowInfo(row);
    row.querySelector('.ts-date').addEventListener('input', refresh);
    row.querySelector('.ts-start').addEventListener('input', refresh);
    row.querySelector('.ts-end').addEventListener('input', refresh);
    row.querySelector('.ts-tz').addEventListener('change', refresh);
    row.querySelector('.ts-remove').onclick = () => row.remove();
    $('tsSlotList').appendChild(row);
    if (data.date && data.startTime) updateTsRowInfo(row);
}

function openTimeSlotForm() {
    $('tsSlotList').innerHTML = '';
    const slots = getTimeSlots();
    if (slots.length === 0) addTsRow();
    else slots.forEach((s) => addTsRow(s));
    $('timeSlotForm').classList.remove('hidden');
}

function saveTimeSlots() {
    const slots = Array.from($('tsSlotList').querySelectorAll('.ts-row')).map((row) => ({
        id: row.dataset.tsid,
        date: row.querySelector('.ts-date').value,
        startTime: row.querySelector('.ts-start').value,
        endTime: row.querySelector('.ts-end').value,
        tz: row.querySelector('.ts-tz')?.value || LOCAL_TZ,
    })).filter((s) => s.date && s.startTime);
    DATA.timeSlots = slots;
    pushData();
    $('timeSlotForm').classList.add('hidden');
    renderCalendar();
}

function fieldHTML(key) {
    const m = FIELD_META[key] || { label: key };
    const cls = m.full ? 'field full' : 'field';
    const input = m.type === 'textarea'
        ? `<textarea data-field="${key}"></textarea>`
        : `<input type="${m.type || 'text'}" data-field="${key}" />`;
    return `<div class="${cls}"><label>${m.label}</label>${input}</div>`;
}

function buildPersonBar() {
    const persons = getPersons();
    const activeId = getActivePersonId();
    const chips = $('personChips');
    if (!chips) return;
    chips.innerHTML = '';
    if (persons.length === 0) {
        chips.innerHTML = '<span class="person-empty">No accounts yet — click ＋ Add</span>';
        return;
    }
    persons.forEach((p) => {
        const chip = document.createElement('button');
        chip.className = 'person-chip' + (p.id === activeId ? ' active' : '');
        chip.textContent = p.name || '(unnamed)';
        chip.onclick = () => setActivePerson(p.id);
        chips.appendChild(chip);
    });
}

function setActivePerson(id) {
    DATA.activePersonId = id;
    buildPersonBar();
    buildSettingsFields();
}

function addPerson() {
    const name = prompt('Name for new account:');
    if (!name || !name.trim()) return;
    const id = 'p_' + Math.random().toString(36).slice(2, 10);
    const persons = getPersons().slice();
    persons.push({ id, name: name.trim() });
    DATA.persons = persons;
    DATA.activePersonId = id;
    buildPersonBar();
    buildSettingsFields();
}

function renamePerson() {
    const id = getActivePersonId();
    if (!id) { alert('No account selected.'); return; }
    const persons = getPersons().slice();
    const p = persons.find((x) => x.id === id);
    if (!p) return;
    const name = prompt('New name for this account:', p.name || '');
    if (!name || !name.trim()) return;
    p.name = name.trim();
    DATA.persons = persons;
    buildPersonBar();
}

function deletePerson() {
    const persons = getPersons().slice();
    if (persons.length <= 1) { alert('Cannot delete the last account.'); return; }
    const id = getActivePersonId();
    if (!id) return;
    const p = persons.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`Delete account "${p.name}"? This cannot be undone.`)) return;
    const filtered = persons.filter((x) => x.id !== id);
    DATA.persons = filtered;
    DATA.activePersonId = filtered[0]?.id || null;
    buildPersonBar();
    buildSettingsFields();
}

function buildSettingsFields() {
    buildPersonBar();
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
    const persons = getPersons().slice();
    const id = getActivePersonId();
    let idx = persons.findIndex((p) => p.id === id);
    if (idx < 0) {
        // No persons yet — create a default one
        const newId = 'p_' + Math.random().toString(36).slice(2, 10);
        const newPerson = { id: newId, name: 'Default' };
        persons.push(newPerson);
        idx = persons.length - 1;
        DATA.activePersonId = newId;
    }
    const updated = Object.assign({}, persons[idx]);
    document.querySelectorAll('#settingsFields [data-field]').forEach((el) => { updated[el.dataset.field] = el.value; });
    persons[idx] = updated;
    DATA.persons = persons;
    pushData();
    $('settings').classList.add('hidden');
}

// The profile sent to the AI: person info (from interview's linked person or active person),
// overridden by interview-specific fields, plus a rolling window of what the
// candidate has actually said out loud so far in this live interview.
function getProfileData() {
    const iv = activeInterviewId ? getInterviews().find((x) => x.id === activeInterviewId) : null;
    const linkedPerson = iv?.personId ? getPersons().find((p) => p.id === iv.personId) : null;
    const global = linkedPerson || getGlobalProfile();
    const merged = { ...global };
    if (iv) {
        ['jobTitle', 'jobDescription', 'whyThisCompany', 'departureReasons', 'company', 'introduction', 'round', 'notes'].forEach((k) => {
            if (iv[k]) merged[k] = iv[k];
        });
        if (iv.resume) merged.candidateInfo = iv.resume;
        merged.interviewers = iv.interviewers || [];
    }
    if (meRecentLines.length) merged.recentOwnStatements = meRecentLines.join('\n');
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

function populateTzSelect(el, selectedTz) {
    const list = [LOCAL_TZ, ...TZ_LIST.filter((t) => t !== LOCAL_TZ)];
    el.innerHTML = list.map((t) => `<option value="${t}"${t === selectedTz ? ' selected' : ''}>${t}${t === LOCAL_TZ ? ' (local)' : ''}</option>`).join('');
}

function populateTimezones() {
    populateTzSelect($('f_tz'), LOCAL_TZ);
    if ($('calTzLeft'))  populateTzSelect($('calTzLeft'),  calTzLeft);
    if ($('calTzRight')) populateTzSelect($('calTzRight'), calTzRight);
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

function tsEpoch(slot) {
    if (!slot.date || !slot.startTime) return NaN;
    const [y, mo, d] = slot.date.split('-').map(Number);
    const [h, mi] = slot.startTime.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const off = tzOffsetMs(slot.tz || LOCAL_TZ, new Date(guess));
    return guess - off;
}

function tsEndEpoch(slot) {
    if (!slot.date || !slot.endTime) return NaN;
    const [y, mo, d] = slot.date.split('-').map(Number);
    const [h, mi] = slot.endTime.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const off = tzOffsetMs(slot.tz || LOCAL_TZ, new Date(guess));
    return guess - off;
}

// Timezone-parameterized display helpers
function epochToTzDate(epoch, tz) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short' }).format(new Date(epoch));
}
function epochToTzHour(epoch, tz) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(new Date(epoch));
    const h = parseInt(p.find((x) => x.type === 'hour')?.value || 0);
    return h === 24 ? 0 : h;
}
function epochToTzTime(epoch, tz) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(epoch));
    const hv = p.find((x) => x.type === 'hour')?.value || '00';
    const mv = p.find((x) => x.type === 'minute')?.value || '00';
    return `${parseInt(hv) === 24 ? '00' : hv}:${mv}`;
}

// Legacy aliases (used in renderUpcoming / reminders)
function epochToCalTzDate(epoch) { return epochToTzDate(epoch, calTzLeft); }
function epochToCalTzHour(epoch) { return epochToTzHour(epoch, calTzLeft); }
function epochToCalTzTime(epoch) { return epochToTzTime(epoch, calTzLeft); }

// Compute the UTC epoch range for a calendar cell [ds, h] in a given timezone
function cellEpochRange(ds, h, tz) {
    const [y, mo, d] = ds.split('-').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, 0, 0);
    const off = tzOffsetMs(tz, new Date(guess));
    const start = guess - off;
    return { start, end: start + 3600000 };
}

// Does a time slot START within the given cell (ds, h) in timezone tz?
function slotStartsInCell(slot, ds, h, tz) {
    const ep = tsEpoch(slot);
    if (isNaN(ep)) return false;
    const { start, end } = cellEpochRange(ds, h, tz);
    return ep >= start && ep < end;
}

// Does a time slot CONTINUE (overlap but not start) through the cell (ds, h) in timezone tz?
function slotSpansCell(slot, ds, h, tz) {
    const ep = tsEpoch(slot);
    if (isNaN(ep)) return false;
    const endEp = tsEndEpoch(slot);
    const effectiveEnd = !isNaN(endEp) ? endEp : ep + 3600000;
    const { start } = cellEpochRange(ds, h, tz);
    return ep < start && effectiveEnd > start;
}

// ===========================================================================
// Interview duration helpers
// ===========================================================================
function interviewEndEpoch(iv) {
    if (!iv.endTime || !iv.date) return NaN;
    const [y, mo, d] = iv.date.split('-').map(Number);
    const [h, mi] = iv.endTime.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    const off = tzOffsetMs(iv.tz || LOCAL_TZ, new Date(guess));
    return guess - off;
}

function epochToTzMinute(epoch, tz) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: 'numeric' }).formatToParts(new Date(epoch));
    return parseInt(p.find((x) => x.type === 'minute')?.value || 0);
}

// Does interview ep START in cell (ds, h)?
function ivStartsInCell(ep, ds, h, tz) {
    const { start, end } = cellEpochRange(ds, h, tz);
    return ep >= start && ep < end;
}

// Does interview CONTINUE THROUGH cell (ds, h) — i.e. started earlier and runs past cell start?
function ivSpansCell(ep, endEp, ds, h, tz) {
    const effectiveEnd = !isNaN(endEp) ? endEp : ep + 3600000;
    const { start } = cellEpochRange(ds, h, tz);
    return ep < start && effectiveEnd > start;
}

function renderIvBlock(iv, ep, endEp, ds, h, tz) {
    const past = ep < Date.now() ? ' past' : '';
    const color = iv.personId ? getPersonColor(iv.personId) : null;
    const bg = past ? '#444b57' : (color || '#3a6fd8');
    const startM = epochToTzMinute(ep, tz);
    const topPct = (startM / 60) * 100;
    const spansNext = ivSpansCell(ep, endEp, ds, h + 1, tz);
    let st = `top:${topPct.toFixed(1)}%;background:${bg};`;
    if (spansNext) {
        st += 'bottom:-1px;border-radius:4px 4px 0 0;';
    } else if (!isNaN(endEp)) {
        const durMin = (endEp - ep) / 60000;
        st += `height:${Math.max((durMin / 60) * 100, 20).toFixed(1)}%;border-radius:4px;`;
    } else {
        st += 'min-height:18px;border-radius:4px;';
    }
    const endLabel = !isNaN(endEp) ? `–${epochToTzTime(endEp, tz)}` : '';
    return `<div class="iv-block${past}" data-iv="${iv.id}" title="${escapeHtml(iv.title)}" style="${st}">${epochToTzTime(ep, tz)}${endLabel} ${escapeHtml(iv.title)}</div>`;
}

function renderIvCont(iv, ep, endEp, ds, h, tz) {
    const past = ep < Date.now() ? ' past' : '';
    const color = iv.personId ? getPersonColor(iv.personId) : null;
    const bg = past ? '#444b57' : (color || '#3a6fd8');
    const isLast = !ivSpansCell(ep, endEp, ds, h + 1, tz);
    let st = `background:${bg}55;border-left:3px solid ${bg};`;
    if (isLast && !isNaN(endEp)) {
        const { start } = cellEpochRange(ds, h, tz);
        const inCellMs = Math.max(endEp - start, 0);
        st += `top:-1px;height:${Math.max((inCellMs / 3600000) * 100, 15).toFixed(1)}%;border-radius:0 0 4px 4px;`;
    } else {
        st += 'top:-1px;bottom:-1px;';
    }
    return `<div class="iv-cont${past}" data-iv="${iv.id}" style="${st}"></div>`;
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
const CAL_HOURS = Array.from({ length: 15 }, (_, i) => i + 8); // 8 AM – 10 PM

function dsStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function weekStart(year, month, day) {
    const d = new Date(year, month, day);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
}

function shiftDate(n) {
    const d = new Date(calYear, calMonth, calDay + n);
    calYear = d.getFullYear(); calMonth = d.getMonth(); calDay = d.getDate();
}

function calHeaderLabel() {
    if (calView === 'month') {
        return new Date(calYear, calMonth, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    }
    if (calView === 'week') {
        const ws = weekStart(calYear, calMonth, calDay);
        const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6);
        if (ws.getMonth() === we.getMonth()) {
            return `${ws.toLocaleString('en-US', { month: 'short' })} ${ws.getDate()}–${we.getDate()}, ${we.getFullYear()}`;
        }
        return `${ws.toLocaleString('en-US', { month: 'short', day: 'numeric' })} – ${we.toLocaleString('en-US', { month: 'short', day: 'numeric' })}, ${we.getFullYear()}`;
    }
    return new Date(calYear, calMonth, calDay).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function updateCalViewButtons() {
    ['Day', 'Week', 'Month'].forEach((v) => {
        const btn = $('calView' + v);
        if (btn) btn.classList.toggle('active', calView === v.toLowerCase());
    });
}

function openTimeSlotFormWithDate(date, defaultTz) {
    $('tsSlotList').innerHTML = '';
    getTimeSlots().forEach((s) => addTsRow(s));
    addTsRow({ date, startTime: '09:00', endTime: '17:00', tz: defaultTz || LOCAL_TZ });
    $('timeSlotForm').classList.remove('hidden');
}

function openTimeSlotFormWithDateTime(date, startTime, endTime, defaultTz) {
    $('tsSlotList').innerHTML = '';
    getTimeSlots().forEach((s) => addTsRow(s));
    addTsRow({ date, startTime, endTime, tz: defaultTz || LOCAL_TZ });
    $('timeSlotForm').classList.remove('hidden');
}

function setupCalDrag(grid, view, tz) {
    let dragStart = null;
    let dragEnd = null;
    let isDragging = false;

    const cellSel = view === 'month' ? '.cal-cell' : '.wg-cell';

    function getCell(e) { return e.target.closest(cellSel); }

    function clearHighlights() {
        grid.querySelectorAll('.cal-selecting, .wg-selecting').forEach((el) => el.classList.remove('cal-selecting', 'wg-selecting'));
    }

    function highlightRange(a, b) {
        clearHighlights();
        if (view === 'month') {
            const [lo, hi] = [a.dataset.date, b.dataset.date].sort();
            grid.querySelectorAll('.cal-cell[data-date]').forEach((c) => {
                if (c.dataset.date >= lo && c.dataset.date <= hi) c.classList.add('cal-selecting');
            });
        } else {
            if (a.dataset.date !== b.dataset.date) return;
            const [lo, hi] = [a.dataset.time, b.dataset.time].sort();
            const date = a.dataset.date;
            grid.querySelectorAll('.wg-cell[data-date]').forEach((c) => {
                if (c.dataset.date !== date) return;
                if (c.dataset.time >= lo && c.dataset.time <= hi) c.classList.add('wg-selecting');
            });
        }
    }

    grid.addEventListener('mousedown', (e) => {
        const cell = getCell(e);
        if (!cell || e.button !== 0) return;
        if (e.target.classList.contains('cal-event') || e.target.classList.contains('wg-event') ||
            e.target.classList.contains('iv-block') || e.target.classList.contains('iv-cont') ||
            e.target.classList.contains('cal-ts') || e.target.classList.contains('wg-ts') ||
            e.target.classList.contains('wg-ts-cont')) return;
        dragStart = cell;
        dragEnd = cell;
        isDragging = false;
        e.preventDefault();
    });

    grid.addEventListener('mousemove', (e) => {
        if (!dragStart) return;
        const cell = getCell(e);
        if (!cell || cell === dragEnd) return;
        if (view !== 'month' && cell.dataset.date !== dragStart.dataset.date) return;
        dragEnd = cell;
        isDragging = true;
        highlightRange(dragStart, dragEnd);
    });

    grid.addEventListener('mouseup', (e) => {
        if (!dragStart) return;
        clearHighlights();
        const start = dragStart;
        const end = dragEnd || dragStart;
        const wasDrag = isDragging;
        dragStart = null;
        dragEnd = null;
        isDragging = false;

        if (!wasDrag) {
            // Single click on an empty cell
            if (view === 'month') {
                // If day has time slots, open schedule form; else open slot form
                const date = start.dataset.date;
                const dayHasSlot = getTimeSlots().some((s) => {
                    const ep = tsEpoch(s);
                    return !isNaN(ep) && epochToTzDate(ep, tz) === date;
                });
                if (dayHasSlot) openScheduleForm(null, date);
                else openTimeSlotFormWithDate(date, tz);
            } else {
                openScheduleForm(null, start.dataset.date, start.dataset.time);
            }
            return;
        }

        if (view === 'month') {
            const [lo] = [start.dataset.date, end.dataset.date].sort();
            openTimeSlotFormWithDate(lo, tz);
        } else {
            const date = start.dataset.date;
            const [lo, hi] = [start.dataset.time, end.dataset.time].sort();
            const endH = Math.min(parseInt(hi.split(':')[0]) + 1, 23);
            const endTime = `${pad(endH)}:00`;
            const loH = parseInt(lo.split(':')[0]);
            const hiH = parseInt(hi.split(':')[0]);
            const hasTs = getTimeSlots().some((s) => {
                const ep = tsEpoch(s);
                const endEp = tsEndEpoch(s);
                if (isNaN(ep)) return false;
                if (epochToTzDate(ep, tz) !== date) return false;
                const slotStartH = epochToTzHour(ep, tz);
                const slotEndH = !isNaN(endEp) ? epochToTzHour(endEp, tz) : slotStartH + 1;
                return slotStartH <= hiH && slotEndH > loH;
            });
            if (hasTs) openScheduleForm(null, date, lo);
            else openTimeSlotFormWithDateTime(date, lo, endTime, tz);
        }
    });

    document.addEventListener('mouseup', () => {
        if (!dragStart) return;
        clearHighlights();
        dragStart = null; dragEnd = null; isDragging = false;
    });
}

function renderCalendar() {
    updateCalViewButtons();
    $('calMonth').textContent = calHeaderLabel();
    calTz = calTzLeft; // keep legacy alias in sync
    if (calView === 'week') {
        renderWeekView(calTzLeft,  $('calGridLeft'));
        renderWeekView(calTzRight, $('calGridRight'));
        syncGridScrollToNow();
    } else if (calView === 'day') {
        renderDayView(calTzLeft,  $('calGridLeft'));
        renderDayView(calTzRight, $('calGridRight'));
        syncGridScrollToNow();
    } else {
        renderMonthView(calTzLeft,  $('calGridLeft'));
        renderMonthView(calTzRight, $('calGridRight'));
    }
    renderUpcoming();
}

function renderMonthView(tz, gridEl) {
    gridEl.className = 'cal-grid';
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = dows.map((d) => `<div class="cal-dow">${d}</div>`).join('');
    const first = new Date(calYear, calMonth, 1);
    const start = new Date(calYear, calMonth, 1 - first.getDay());
    const todayStr = epochToTzDate(Date.now(), tz);
    const ivEps = getInterviews().map((iv) => ({ iv, ep: interviewEpoch(iv), endEp: interviewEndEpoch(iv) })).filter((x) => !isNaN(x.ep));
    const tsEps = getTimeSlots().map((s) => ({ s, ep: tsEpoch(s) })).filter((x) => !isNaN(x.ep));
    for (let i = 0; i < 42; i++) {
        const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const ds = dsStr(cur);
        const other = cur.getMonth() !== calMonth ? ' other' : '';
        const today = ds === todayStr ? ' today' : '';
        const dayEps = ivEps.filter(({ ep }) => epochToTzDate(ep, tz) === ds).sort((a, b) => a.ep - b.ep);
        const evHtml = dayEps.map(({ iv, ep, endEp }) => {
            const past = ep < Date.now() ? ' past' : '';
            const color = !past && iv.personId ? getPersonColor(iv.personId) : null;
            const style = color ? ` style="background:${color}"` : '';
            const endLabel = !isNaN(endEp) ? `–${epochToTzTime(endEp, tz)}` : '';
            return `<div class="cal-event${past}" data-iv="${iv.id}" title="${escapeHtml(iv.title)}"${style}>${epochToTzTime(ep, tz)}${endLabel} ${escapeHtml(iv.title)}</div>`;
        }).join('');
        const tsDayEps = tsEps.filter(({ ep }) => epochToTzDate(ep, tz) === ds);
        const tsHtml = tsDayEps.map(({ s, ep }) => {
            const endEp = tsEndEpoch(s);
            const endLabel = !isNaN(endEp) ? epochToTzTime(endEp, tz) : '';
            const label = endLabel ? `${epochToTzTime(ep, tz)}–${endLabel}` : epochToTzTime(ep, tz);
            return `<div class="cal-ts" data-tsid="${escapeHtml(s.id)}" data-date="${ds}" data-time="${epochToTzTime(ep, tz)}" title="${label}">${label}</div>`;
        }).join('');
        html += `<div class="cal-cell${other}${today}" data-date="${ds}"><div class="daynum">${cur.getDate()}</div>${evHtml}${tsHtml}</div>`;
    }
    gridEl.innerHTML = html;
    gridEl.querySelectorAll('.cal-event').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); openDetail(el.dataset.iv); }; });
    gridEl.querySelectorAll('.cal-ts').forEach((el) => {
        el.onclick = (e) => { e.stopPropagation(); showTsContextMenu(e, el.dataset.tsid, el.dataset.date, el.dataset.time); };
    });
    setupCalDrag(gridEl, 'month', tz);
}

function renderWeekView(tz, gridEl) {
    const ws = weekStart(calYear, calMonth, calDay);
    const days = Array.from({ length: 7 }, (_, i) => new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i));
    const todayStr = epochToTzDate(Date.now(), tz);
    const ivEps = getInterviews().map((iv) => ({ iv, ep: interviewEpoch(iv), endEp: interviewEndEpoch(iv) })).filter((x) => !isNaN(x.ep));
    const tsEps = getTimeSlots().map((s) => ({ s, ep: tsEpoch(s) })).filter((x) => !isNaN(x.ep));
    const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = `<div class="wg-inner week"><div class="wg-corner"></div>`;
    days.forEach((d, i) => {
        const isToday = dsStr(d) === todayStr ? ' today' : '';
        html += `<div class="wg-col-head${isToday}">${dows[i]}<span class="wg-daynum">${d.getDate()}</span></div>`;
    });
    CAL_HOURS.forEach((h) => {
        const hLabel = h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
        html += `<div class="wg-time">${hLabel}</div>`;
        days.forEach((d) => {
            const ds = dsStr(d);
            const isToday = ds === todayStr ? ' today-col' : '';
            const timeStr = `${pad(h)}:00`;
            const ivStarts = ivEps.filter(({ ep }) => ivStartsInCell(ep, ds, h, tz));
            const ivConts  = ivEps.filter(({ ep, endEp }) => ivSpansCell(ep, endEp, ds, h, tz));
            const evHtml = [
                ...ivStarts.map(({ iv, ep, endEp }) => renderIvBlock(iv, ep, endEp, ds, h, tz)),
                ...ivConts.map(({ iv, ep, endEp }) => renderIvCont(iv, ep, endEp, ds, h, tz)),
            ].join('');
            const slotsStart = tsEps.filter(({ s }) => slotStartsInCell(s, ds, h, tz));
            const slotsCont  = tsEps.filter(({ s }) => slotSpansCell(s, ds, h, tz));
            const hasCont = slotsCont.length > 0;
            const tsStartHtml = slotsStart.map(({ s, ep }) => {
                const endEp = tsEndEpoch(s);
                const endLabel = !isNaN(endEp) ? epochToTzTime(endEp, tz) : '';
                const label = endLabel ? `${epochToTzTime(ep, tz)}–${endLabel}` : epochToTzTime(ep, tz);
                const hasContinuation = slotSpansCell(s, ds, h + 1, tz);
                return `<div class="wg-ts${hasContinuation ? ' wg-ts-cont-start' : ''}" data-tsid="${escapeHtml(s.id)}" data-date="${ds}" data-time="${epochToTzTime(ep, tz)}">${label}</div>`;
            }).join('');
            const tsContHtml = slotsCont.map(({ s }) => {
                const isLast = !slotSpansCell(s, ds, h + 1, tz);
                return `<div class="wg-ts-cont${isLast ? ' wg-ts-cont-last' : ''}" data-tsid="${escapeHtml(s.id)}" data-date="${ds}" data-time="${timeStr}"></div>`;
            }).join('');
            html += `<div class="wg-cell${isToday}${hasCont ? ' ts-cont-cell' : ''}" data-date="${ds}" data-time="${timeStr}">${evHtml}${tsStartHtml}${tsContHtml}</div>`;
        });
    });
    html += `</div>`;

    gridEl.className = 'cal-week-day-grid';
    gridEl.innerHTML = html;
    insertNowLine(gridEl, tz);
    gridEl.querySelectorAll('.wg-event, .iv-block, .iv-cont').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); openDetail(el.dataset.iv); }; });
    gridEl.querySelectorAll('.wg-ts, .wg-ts-cont').forEach((el) => {
        el.onclick = (e) => { e.stopPropagation(); showTsContextMenu(e, el.dataset.tsid, el.dataset.date, el.dataset.time); };
    });
    setupCalDrag(gridEl, 'week', tz);
}

function renderDayView(tz, gridEl) {
    const d = new Date(calYear, calMonth, calDay);
    const ds = dsStr(d);
    const todayStr = epochToTzDate(Date.now(), tz);
    const ivEps = getInterviews().map((iv) => ({ iv, ep: interviewEpoch(iv), endEp: interviewEndEpoch(iv) })).filter((x) => !isNaN(x.ep));
    const tsEps = getTimeSlots().map((s) => ({ s, ep: tsEpoch(s) })).filter((x) => !isNaN(x.ep));
    const isToday = ds === todayStr;

    let html = `<div class="wg-inner day"><div class="wg-corner"></div>`;
    html += `<div class="wg-col-head${isToday ? ' today' : ''}">${d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</div>`;
    CAL_HOURS.forEach((h) => {
        const hLabel = h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
        const timeStr = `${pad(h)}:00`;
        const ivStarts = ivEps.filter(({ ep }) => ivStartsInCell(ep, ds, h, tz));
        const ivConts  = ivEps.filter(({ ep, endEp }) => ivSpansCell(ep, endEp, ds, h, tz));
        const evHtml = [
            ...ivStarts.map(({ iv, ep, endEp }) => renderIvBlock(iv, ep, endEp, ds, h, tz)),
            ...ivConts.map(({ iv, ep, endEp }) => renderIvCont(iv, ep, endEp, ds, h, tz)),
        ].join('');
        const slotsStart = tsEps.filter(({ s }) => slotStartsInCell(s, ds, h, tz));
        const slotsCont  = tsEps.filter(({ s }) => slotSpansCell(s, ds, h, tz));
        const hasCont = slotsCont.length > 0;
        const tsStartHtml = slotsStart.map(({ s, ep }) => {
            const endEp = tsEndEpoch(s);
            const endLabel = !isNaN(endEp) ? epochToTzTime(endEp, tz) : '';
            const label = endLabel ? `${epochToTzTime(ep, tz)}–${endLabel}` : epochToTzTime(ep, tz);
            const hasContinuation = slotSpansCell(s, ds, h + 1, tz);
            return `<div class="wg-ts${hasContinuation ? ' wg-ts-cont-start' : ''}" data-tsid="${escapeHtml(s.id)}" data-date="${ds}" data-time="${epochToTzTime(ep, tz)}">${label}</div>`;
        }).join('');
        const tsContHtml = slotsCont.map(({ s }) => {
            const isLast = !slotSpansCell(s, ds, h + 1, tz);
            return `<div class="wg-ts-cont${isLast ? ' wg-ts-cont-last' : ''}" data-tsid="${escapeHtml(s.id)}" data-date="${ds}" data-time="${timeStr}"></div>`;
        }).join('');
        html += `<div class="wg-time">${hLabel}</div><div class="wg-cell${isToday ? ' today-col' : ''}${hasCont ? ' ts-cont-cell' : ''}" data-date="${ds}" data-time="${timeStr}">${evHtml}${tsStartHtml}${tsContHtml}</div>`;
    });
    html += `</div>`;

    gridEl.className = 'cal-week-day-grid';
    gridEl.innerHTML = html;
    insertNowLine(gridEl, tz);
    gridEl.querySelectorAll('.wg-event, .iv-block, .iv-cont').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); openDetail(el.dataset.iv); }; });
    gridEl.querySelectorAll('.wg-ts, .wg-ts-cont').forEach((el) => {
        el.onclick = (e) => { e.stopPropagation(); showTsContextMenu(e, el.dataset.tsid, el.dataset.date, el.dataset.time); };
    });
    setupCalDrag(gridEl, 'day', tz);
}

function renderUpcoming() {
    const box = $('calUpcoming');
    const now = Date.now();
    const up = getInterviews().map((iv) => ({ iv, ep: interviewEpoch(iv) }))
        .filter((x) => x.ep >= now).sort((a, b) => a.ep - b.ep).slice(0, 5);
    if (!up.length) { box.innerHTML = '<h3>Upcoming</h3><p class="muted">No upcoming interviews.</p>'; return; }
    box.innerHTML = '<h3>Upcoming</h3>' + up.map(({ iv, ep }) => {
        const color = iv.personId ? getPersonColor(iv.personId) : null;
        const dot = color ? `<span class="upcoming-dot" style="background:${color}"></span>` : '';
        return `
        <div class="upcoming-item" data-iv="${iv.id}">
            <span>${dot}<strong>${escapeHtml(iv.title)}</strong>${iv.company ? ' · ' + escapeHtml(iv.company) : ''}</span>
            <span class="upcoming-when">${fmtInTz(ep, iv.tz || LOCAL_TZ)} · ${relTime(ep)}</span>
        </div>`;
    }).join('');
    box.querySelectorAll('.upcoming-item').forEach((el) => { el.onclick = () => openDetail(el.dataset.iv); });
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getNowInTz(tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date());
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0');
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0');
    return { h: h === 24 ? 0 : h, m };
}

function insertNowLine(gridEl, tz) {
    const todayDs = epochToTzDate(Date.now(), tz);
    const { h, m } = getNowInTz(tz);
    const cell = gridEl.querySelector(`.wg-cell[data-date="${todayDs}"][data-time="${pad(h)}:00"]`);
    if (!cell) return;
    const line = document.createElement('div');
    line.className = 'now-line';
    line.style.top = `${(m / 60) * 100}%`;
    cell.appendChild(line);
}

// Both panes share the same row layout (same hours, same day columns), so
// centering both on the left pane's "now" row keeps them showing the same
// row range — an event visible on one side stays visible on the other.
function syncGridScrollToNow() {
    const leftGrid = $('calGridLeft');
    const rightGrid = $('calGridRight');
    const nowLine = leftGrid.querySelector('.now-line');
    const cell = nowLine ? nowLine.parentElement : null;
    if (!cell) return;
    const target = Math.max(0, cell.offsetTop - leftGrid.clientHeight / 2 + 26);
    leftGrid.scrollTop = target;
    rightGrid.scrollTop = target;
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


function populatePersonSelect() {
    const sel = $('f_personId');
    if (!sel) return;
    const persons = getPersons();
    sel.innerHTML = '<option value="">(no specific account)</option>' +
        persons.map((p) => `<option value="${p.id}">${escapeHtml(p.name || '(unnamed)')}</option>`).join('');
}

function openScheduleForm(id, presetDate, presetTime) {
    editingInterviewId = id;
    const iv = id ? getInterviews().find((x) => x.id === id) : null;
    $('scheduleFormTitle').textContent = iv ? 'Edit interview' : 'New interview';
    populatePersonSelect();
    $('f_personId').value = iv?.personId || getActivePersonId() || '';
    $('f_title').value = iv?.title || '';
    $('f_company').value = iv?.company || '';
    $('f_meetingUrl').value = iv?.meetingUrl || '';
    $('f_meetingType').value = iv?.meetingType || 'interview';
    $('f_date').value = iv?.date || presetDate || '';
    $('f_time').value = iv?.time || presetTime || '';
    $('f_endTime').value = iv?.endTime || '';
    $('f_tz').value = iv?.tz || LOCAL_TZ;
    $('f_hiringStep').value = iv?.hiringStep || '';
    $('f_round').value = iv?.round || '';
    $('f_jobTitle').value = iv?.jobTitle || '';
    $('f_status').value = iv?.status || 'scheduled';
    $('f_isNextStep').checked = !!iv?.previousInterviewId;
    $('nextStepFields').classList.toggle('hidden', !iv?.previousInterviewId);
    populatePrevCompanySelect(iv);
    $('f_introduction').value = iv?.introduction || '';
    $('f_resume').value = iv?.resume || '';
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
        personId: $('f_personId').value || null,
        title, company: $('f_company').value.trim(),
        meetingUrl: $('f_meetingUrl').value.trim(),
        meetingType: $('f_meetingType').value || 'interview',
        date, time, endTime: $('f_endTime').value || null, tz: $('f_tz').value,
        hiringStep: $('f_hiringStep').value || '',
        round: $('f_round').value.trim(),
        status: $('f_status').value || 'scheduled',
        previousInterviewId: $('f_isNextStep').checked ? ($('f_prevInterviewId').value || null) : null,
        jobTitle: $('f_jobTitle').value.trim(),
        introduction: $('f_introduction').value.trim(),
        resume: $('f_resume').value.trim(),
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
// Hiring process tracking — status + "next round of" linking
// ===========================================================================
function getInterviewStatus(iv) { return iv.status || 'scheduled'; }
function statusLabel(s) { return s === 'done' ? '✅ Done' : s === 'not_done' ? '❌ Not done' : '🕓 Scheduled'; }
function statusClass(s) { return s === 'done' ? 'done' : s === 'not_done' ? 'not-done' : 'scheduled'; }

function setInterviewStatus(id, status) {
    const list = getInterviews().slice();
    const iv = list.find((x) => x.id === id);
    if (!iv) return;
    iv.status = status;
    DATA.interviews = list;
    pushData();
}

// Distinct company names across all interviews (optionally excluding one interview's own entry).
function getCompanyList(excludeId) {
    const set = new Set();
    getInterviews().forEach((iv) => {
        if (iv.id !== excludeId && iv.company && iv.company.trim()) set.add(iv.company.trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// "Original company" dropdown in the schedule form's next-step section.
function populatePrevCompanySelect(iv) {
    const sel = $('f_prevCompany');
    if (!sel) return;
    const companies = getCompanyList(iv?.id);
    sel.innerHTML = '<option value="">(select company)</option>' +
        companies.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    const linkedPrev = iv?.previousInterviewId ? getInterviews().find((x) => x.id === iv.previousInterviewId) : null;
    sel.value = linkedPrev?.company || '';
    populatePrevInterviewSelect(sel.value, iv);
}

// "Original interview / round" dropdown, filtered to the chosen company.
function populatePrevInterviewSelect(company, iv) {
    const sel = $('f_prevInterviewId');
    if (!sel) return;
    const options = getInterviews()
        .filter((x) => x.id !== iv?.id && (!company || (x.company || '').trim() === company))
        .sort((a, b) => (interviewEpoch(a) || 0) - (interviewEpoch(b) || 0));
    sel.innerHTML = '<option value="">(select interview)</option>' + options.map((x) => {
        const ep = interviewEpoch(x);
        const when = !isNaN(ep) ? fmtInTz(ep, x.tz || LOCAL_TZ) : '';
        const label = [x.title, x.hiringStep, x.round, when].filter(Boolean).join(' · ');
        return `<option value="${x.id}"${x.id === iv?.previousInterviewId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
}

// Groups every interview into hiring-process "chains" by walking previousInterviewId
// links back to a root, then re-orders each chain forward from that root.
function buildHiringChains() {
    const list = getInterviews();
    const byId = new Map(list.map((iv) => [iv.id, iv]));
    function findRoot(iv) {
        const seen = new Set();
        let cur = iv;
        while (cur.previousInterviewId && byId.has(cur.previousInterviewId) && !seen.has(cur.id)) {
            seen.add(cur.id);
            cur = byId.get(cur.previousInterviewId);
        }
        return cur;
    }
    const chains = new Map(); // rootId -> interviews[]
    list.forEach((iv) => {
        const root = findRoot(iv);
        if (!chains.has(root.id)) chains.set(root.id, []);
        chains.get(root.id).push(iv);
    });
    const result = [];
    chains.forEach((items, rootId) => {
        const root = byId.get(rootId);
        const ordered = [];
        const remaining = new Set(items.map((x) => x.id));
        let current = root;
        while (current && remaining.has(current.id)) {
            ordered.push(current);
            remaining.delete(current.id);
            current = items.find((x) => x.previousInterviewId === current.id) || null;
        }
        Array.from(remaining).map((id) => byId.get(id))
            .sort((a, b) => (interviewEpoch(a) || 0) - (interviewEpoch(b) || 0))
            .forEach((x) => ordered.push(x));
        result.push({ root, rounds: ordered });
    });
    result.sort((a, b) => {
        const latest = (chain) => Math.max(...chain.rounds.map((r) => interviewEpoch(r) || 0));
        return latest(b) - latest(a);
    });
    return result;
}

function renderTrack() {
    const chains = buildHiringChains();
    const box = $('trackList');
    if (!chains.length) { box.innerHTML = '<p class="muted">No interviews scheduled yet.</p>'; return; }
    box.innerHTML = chains.map(({ root, rounds }) => {
        const person = root.personId ? getPersons().find((p) => p.id === root.personId) : null;
        const doneCount = rounds.filter((r) => getInterviewStatus(r) === 'done').length;
        const roundsHtml = rounds.map((r) => {
            const ep = interviewEpoch(r);
            const when = !isNaN(ep) ? fmtInTz(ep, r.tz || LOCAL_TZ) : '(no date)';
            return `
            <div class="track-round">
                <div>
                    <strong>${escapeHtml(r.title)}</strong>${[r.hiringStep, r.round].filter(Boolean).length ? ' · ' + escapeHtml([r.hiringStep, r.round].filter(Boolean).join(' · ')) : ''}
                    <div class="muted track-round-when">${when}</div>
                </div>
                <select class="track-status-sel status-${statusClass(getInterviewStatus(r))}" data-iv="${r.id}">
                    <option value="scheduled"${getInterviewStatus(r) === 'scheduled' ? ' selected' : ''}>🕓 Scheduled</option>
                    <option value="done"${getInterviewStatus(r) === 'done' ? ' selected' : ''}>✅ Done</option>
                    <option value="not_done"${getInterviewStatus(r) === 'not_done' ? ' selected' : ''}>❌ Not done</option>
                </select>
            </div>`;
        }).join('');
        return `
        <div class="track-chain">
            <div class="track-chain-head">
                <span><strong>${escapeHtml(root.company || '(no company)')}</strong>${person ? ' · ' + escapeHtml(person.name || '') : ''}</span>
                <span class="muted track-chain-count">${doneCount}/${rounds.length} done</span>
            </div>
            ${roundsHtml}
        </div>`;
    }).join('');
    box.querySelectorAll('.track-status-sel').forEach((sel) => {
        sel.onchange = () => { setInterviewStatus(sel.dataset.iv, sel.value); sel.className = 'track-status-sel status-' + statusClass(sel.value); };
    });
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
    const meetingUrlHtml = iv.meetingUrl
        ? `<div class="detail-row"><span class="k">Meeting URL</span><span class="v"><a href="${escapeHtml(iv.meetingUrl)}" target="_blank" rel="noopener">${escapeHtml(iv.meetingUrl)}</a></span></div>`
        : '';
    const linkedPerson = iv.personId ? getPersons().find((p) => p.id === iv.personId) : null;
    const accountFieldsHtml = linkedPerson
        ? Object.keys(FIELD_META).map((f) => detailRow(FIELD_META[f].label, linkedPerson[f])).join('')
        : '';
    $('detailBody').innerHTML =
        (linkedPerson ? detailRow('Account', linkedPerson.name || '(unnamed)') : '') +
        (accountFieldsHtml ? `<div class="field-group"><h3>Account details</h3>${accountFieldsHtml}</div>` : '') +
        detailRow('When', (() => { const eEp = interviewEndEpoch(iv); return `${fmtInTz(ep, iv.tz || LOCAL_TZ)}${!isNaN(eEp) ? ' – ' + fmtInTz(eEp, iv.tz || LOCAL_TZ) : ''}  (${iv.tz || LOCAL_TZ})`; })()) +
        meetingUrlHtml +
        detailRow('Meeting type', mt ? `${mt.icon} ${mt.label}` : (iv.meetingType || '')) +
        detailRow('Company', iv.company) +
        detailRow('Hiring step', iv.hiringStep) +
        detailRow('Round / stage', iv.round) +
        detailRow('Status', statusLabel(getInterviewStatus(iv))) +
        (iv.previousInterviewId ? detailRow('Next step of', (() => {
            const prev = getInterviews().find((x) => x.id === iv.previousInterviewId);
            return prev ? [prev.title, prev.round, prev.company].filter(Boolean).join(' · ') : '(interview no longer exists)';
        })()) : '') +
        detailRow('Target job title', iv.jobTitle) +
        detailRow('Introduction', iv.introduction) +
        detailRow('Resume', iv.resume) +
        detailRow('Job description', iv.jobDescription) +
        detailRow('Why this company', iv.whyThisCompany) +
        detailRow('Reasons for leaving', iv.departureReasons) +
        detailRow('Interviewer(s)', ivText) +
        detailRow('Notes', iv.notes);
    $('viewAccountBtn').classList.toggle('hidden', !linkedPerson);
    $('calendar').classList.add('hidden');
    $('interviewDetail').classList.remove('hidden');
}

function viewAccountFromDetail() {
    const iv = detailInterviewId ? getInterviews().find((x) => x.id === detailInterviewId) : null;
    if (!iv || !iv.personId) return;
    setActivePerson(iv.personId);
    buildSettingsFields();
    $('interviewDetail').classList.add('hidden');
    $('settings').classList.remove('hidden');
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
// Chat between Chris and Amrit — polled every few seconds (no websocket),
// Telegram-style: mine on the right, theirs on the left. History lives on
// the server so both of you see the same thread from any device.
// ===========================================================================
let chatMessages = [];

// Normally 'chris'/'amrit', but a Telegram message from someone the server
// hasn't mapped yet (TELEGRAM_CHRIS_USER_ID / TELEGRAM_AMRIT_USER_ID) shows
// up with their raw Telegram first name instead — surfaced rather than dropped.
function identityLabel(who) { return who === 'chris' ? 'Chris' : who === 'amrit' ? 'Amrit' : who; }
function otherIdentity() { return identity === 'chris' ? 'amrit' : 'chris'; }
function updateChatPeerLabel() { $('chatPeerLabel').textContent = `You are ${identityLabel(identity)} — chatting with ${identityLabel(otherIdentity())}`; }

async function loadChatMessages() {
    try {
        const res = await api('/api/chat-messages');
        const data = await res.json();
        const incoming = data.messages || [];
        if (incoming.length === chatMessages.length &&
            incoming[incoming.length - 1]?.id === chatMessages[chatMessages.length - 1]?.id) return;
        chatMessages = incoming;
        renderChat();
    } catch (e) { /* offline — keep showing what we already have */ }
}

function renderChat() {
    const box = $('chatMessages');
    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = chatMessages.map((m) => {
        const mine = m.sender === identity;
        const via = m.viaTelegram ? ' · via Telegram' : '';
        return `<div class="chat-row ${mine ? 'me' : 'other'}"><div class="chat-bubble"><span class="bubble-label">${identityLabel(m.sender)}${via}</span>${escapeHtml(m.text)}</div></div>`;
    }).join('') || '<p class="muted chat-empty">No messages yet — say hi 👋</p>';
    if (wasNearBottom) box.scrollTop = box.scrollHeight;
}

async function sendChatMessage() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
        await api('/api/chat-messages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender: identity, text }),
        });
        await loadChatMessages();
    } catch (e) { input.value = text; /* leave it so nothing is lost */ }
}

// Wipes the shared chat for both of you — only called when "Start" begins a
// fresh session (not by the transcript's "Clear" button, which leaves chat alone).
async function clearChatMessages() {
    try { await api('/api/chat-messages', { method: 'DELETE' }); } catch (e) { /* best effort */ }
    chatMessages = [];
    renderChat();
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

// Resets the transcript, the pending question, the AI answer, and every
// buffer that feeds context into it — used by both the "Clear" button and
// automatically whenever "Start" begins a new listening session, so a new
// session never mixes in transcript/context left over from a previous one.
function resetTranscriptAndAnswer() {
    $('transcript').innerHTML = '';
    $('questionInput').value = '';
    $('answer').innerHTML = '<p class="muted">Answers will stream here.</p>';
    history = [];
    interviewerBuffer = [];
    meRecentLines = [];
    lastSpeaker = null;
    lastBubbleTextEl = null;
}

async function startListening() {
    resetTranscriptAndAnswer();
    clearChatMessages();
    if (TEST_MIC_AS_INTERVIEWER) {
        // Test mode: capture only the mic and treat it as the interviewer's
        // voice, so the transcript + Get-answer flow can be exercised solo.
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) { setStatus('Microphone permission denied', 'error'); return; }
        audioStreams.interviewer = new MediaStream(micStream.getAudioTracks());
        audioStreams.interviewer.getAudioTracks()[0].addEventListener('ended', () => { if (listening) stopListening(); });
        listening = true;
        $('listenBtn').textContent = '■ Stop';
        $('listenBtn').classList.add('active');
        setStatus('Listening… (test mode: mic = interviewer)', 'listening');
        recordSegment('interviewer');
        return;
    }

    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { setStatus('Microphone permission denied', 'error'); return; }
    try {
        // systemAudio: 'include' is a Chromium-only hint that makes the "Share
        // system audio" checkbox available when the user picks "Entire Screen"
        // — sharing an individual Window never carries audio in Chromium, no
        // matter what's requested here (see the error message below).
        mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' });
    } catch (e) {
        stopTracks();
        setStatus('Screen/tab share permission denied', 'error');
        return;
    }

    const interviewerTracks = mediaStream.getAudioTracks();
    if (interviewerTracks.length === 0) {
        setStatus('No audio captured — sharing a "Window" never carries audio; pick the Meet TAB + tick "Share tab audio", or "Entire screen" + tick "Share system audio"', 'error');
        stopTracks();
        return;
    }
    interviewerTracks[0].addEventListener('ended', () => { if (listening) stopListening(); });

    audioStreams.me = new MediaStream(micStream.getAudioTracks());
    audioStreams.interviewer = new MediaStream(interviewerTracks);
    listening = true;
    $('listenBtn').textContent = '■ Stop';
    $('listenBtn').classList.add('active');
    setStatus('Listening…', 'listening');
    recordSegment('me');
    recordSegment('interviewer');
}

function recordSegment(speaker) {
    if (!listening || !audioStreams[speaker]) return;
    const chunks = [];
    const mimeType = pickMime();
    let rec;
    try { rec = new MediaRecorder(audioStreams[speaker], mimeType ? { mimeType } : undefined); }
    catch (e) { setStatus('Recording not supported', 'error'); return; }
    recorders[speaker] = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 2500) transcribeBlob(blob, speaker);
        if (listening) recordSegment(speaker);
    };
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, SEGMENT_MS);
}

async function transcribeBlob(blob, speaker) {
    const fd = new FormData();
    fd.append('audio', blob, 'segment.webm');
    try {
        const res = await api('/api/transcribe', { method: 'POST', body: fd });
        const data = await res.json();
        const text = (data.text || '').trim();
        if (text && !isFiller(text)) appendTranscript(text, speaker);
    } catch (e) { console.warn('transcribe failed', e.message); }
}

// Each 5s segment is transcribed independently, but a real speaking turn
// usually spans several segments — so consecutive segments from the SAME
// speaker are merged into one running paragraph instead of separate bubbles.
// A new bubble only starts when the other speaker's turn interrupts.
function appendTranscript(text, speaker) {
    const t = $('transcript');
    if (speaker === lastSpeaker && lastBubbleTextEl) {
        lastBubbleTextEl.textContent += ' ' + text;
    } else {
        const row = document.createElement('div');
        row.className = `transcript-row ${speaker}`;
        row.innerHTML = `<div class="bubble"><span class="bubble-label">${speaker === 'me' ? 'You' : 'Interviewer'}</span><span class="bubble-text"></span></div>`;
        lastBubbleTextEl = row.querySelector('.bubble-text');
        lastBubbleTextEl.textContent = text;
        t.appendChild(row);
    }
    lastSpeaker = speaker;
    t.scrollTop = t.scrollHeight;
    if (speaker === 'interviewer') {
        // Accumulate until "Get answer" is clicked — a question can span
        // more than one 5s segment before the interviewer finishes asking it.
        interviewerBuffer.push(text);
        $('questionInput').value = interviewerBuffer.join(' ');
    } else {
        meRecentLines.push(text);
        if (meRecentLines.length > 24) meRecentLines = meRecentLines.slice(-24);
    }
}

function stopTracks() {
    if (mediaStream) mediaStream.getTracks().forEach((tr) => tr.stop());
    if (micStream) micStream.getTracks().forEach((tr) => tr.stop());
    mediaStream = null; micStream = null;
    audioStreams.me = null; audioStreams.interviewer = null;
}
function stopListening() {
    listening = false;
    Object.keys(recorders).forEach((speaker) => {
        const rec = recorders[speaker];
        if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) {} }
        recorders[speaker] = null;
    });
    stopTracks();
    lastSpeaker = null;
    lastBubbleTextEl = null;
    $('listenBtn').textContent = '▶ Start';
    $('listenBtn').classList.remove('active');
    setStatus('Idle', 'idle');
}

// ===========================================================================
// AI answer (SSE streaming) — history of paired question/answer rows
// ===========================================================================
function appendQaRow(questionLabel, questionText) {
    const box = $('answer');
    if (box.querySelector('p.muted')) box.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'qa-row';
    row.innerHTML =
        `<div class="qa-question"><span class="bubble-label">${escapeHtml(questionLabel)}</span>${escapeHtml(questionText)}</div>` +
        `<div class="qa-answer"><span class="cursor">▍</span></div>`;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
    return row.querySelector('.qa-answer');
}

// Streams a chat completion for `question` into `answerEl`. Shared by the
// visible (immediate) flow and the silent background-prepared flow.
async function streamAnswerInto(question, answerEl, answerBox) {
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
                    if (answerBox) answerBox.scrollTop = answerBox.scrollHeight;
                } else if (payload.error) {
                    answerEl.innerHTML = `<p class="error">Error: ${payload.error}</p>`;
                }
            }
        }
        answerEl.innerHTML = marked.parse(full || '*(no response)*');
        if (full) {
            history.push({ role: 'user', content: question });
            history.push({ role: 'assistant', content: full });
            if (history.length > 60) history = history.slice(-60);
        }
        return true;
    } catch (e) {
        answerEl.innerHTML = `<p class="error">Request failed: ${e.message}</p>`;
        return false;
    }
}

// "Get answer" — takes whatever the interviewer has said since the last
// click (accumulated into the question box, editable before sending),
// clears the previous AI answer, and streams a fresh one for the current
// question only. Context (resume, JD, introduction, why-this-company,
// departure reasons, and the candidate's own recent statements) comes from
// getProfileData().
async function getAnswer() {
    if (answering) return;
    const question = ($('questionInput').value || '').trim();
    if (!question) return;
    interviewerBuffer = [];   // consumed — next interviewer speech starts a fresh question
    // Force the next transcript segment to start a brand-new bubble instead of
    // merging into the one just answered — the click is a hard cut point, even
    // if the same speaker (e.g. mic-as-interviewer test mode) keeps talking.
    lastSpeaker = null;
    lastBubbleTextEl = null;

    answering = true;
    setStatus('Thinking…', 'working');
    const answerBox = $('answer');
    answerBox.innerHTML = '';   // remove the old answer before showing the new one
    const answerEl = appendQaRow('Interviewer', question);
    const ok = await streamAnswerInto(question, answerEl, answerBox);
    setStatus(ok ? (listening ? 'Listening…' : 'Idle') : 'Error', ok ? (listening ? 'listening' : 'idle') : 'error');
    answering = false;
    $('questionInput').value = '';
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
    const answerEl = appendQaRow('Screen', 'Analyze current screen');
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
        answerEl.innerHTML = marked.parse(pretty);
        setStatus(listening ? 'Listening…' : 'Idle', listening ? 'listening' : 'idle');
    } catch (e) {
        answerEl.innerHTML = `<p class="error">Analysis failed: ${e.message}</p>`;
        setStatus('Analysis failed', 'error'); console.error(e);
    }
}

// ===========================================================================
// Wire up UI
// ===========================================================================
$('loginBtn').onclick = doLogin;
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('logoutBtn').onclick = logout;

$('chatSendBtn').onclick = sendChatMessage;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });

$('settingsBtn').onclick = () => { buildSettingsFields(); $('settings').classList.remove('hidden'); };
$('saveSettings').onclick = saveSettings;
$('addPersonBtn').onclick = addPerson;
$('renamePersonBtn').onclick = renamePerson;
$('deletePersonBtn').onclick = deletePerson;

$('scheduleBtn').onclick = () => { $('calendar').classList.remove('hidden'); renderCalendar(); };
$('trackBtn').onclick = () => { renderTrack(); $('trackModal').classList.remove('hidden'); };
$('f_isNextStep').addEventListener('change', () => {
    $('nextStepFields').classList.toggle('hidden', !$('f_isNextStep').checked);
});
$('f_prevCompany').addEventListener('change', () => {
    const iv = editingInterviewId ? getInterviews().find((x) => x.id === editingInterviewId) : null;
    populatePrevInterviewSelect($('f_prevCompany').value, iv);
});
$('calPrev').onclick = () => {
    if (calView === 'day') { shiftDate(-1); }
    else if (calView === 'week') { shiftDate(-7); }
    else { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } }
    renderCalendar();
};
$('calNext').onclick = () => {
    if (calView === 'day') { shiftDate(1); }
    else if (calView === 'week') { shiftDate(7); }
    else { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } }
    renderCalendar();
};
$('calToday').onclick = () => { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); calDay = n.getDate(); renderCalendar(); };
$('calViewDay').onclick   = () => { calView = 'day';   localStorage.setItem('ia_calView', calView); renderCalendar(); };
$('calViewWeek').onclick  = () => { calView = 'week';  localStorage.setItem('ia_calView', calView); renderCalendar(); };
$('calViewMonth').onclick = () => { calView = 'month'; localStorage.setItem('ia_calView', calView); renderCalendar(); };
$('calTzLeft').addEventListener('change', () => {
    calTzLeft = $('calTzLeft').value;
    calTz = calTzLeft;
    localStorage.setItem('ia_calTzLeft', calTzLeft);
    renderCalendar();
});
$('calTzRight').addEventListener('change', () => {
    calTzRight = $('calTzRight').value;
    localStorage.setItem('ia_calTzRight', calTzRight);
    renderCalendar();
});
$('addInterviewBtn').onclick = () => openScheduleForm(null, null);
$('addTimeSlotBtn').onclick = openTimeSlotForm;

$('tsAddBtn').onclick = () => addTsRow();
$('tsSave').onclick = saveTimeSlots;
$('tsCancel').onclick = () => $('timeSlotForm').classList.add('hidden');

$('addInterviewerBtn').onclick = () => addInterviewerRow();
$('saveInterview').onclick = saveInterview;
$('deleteInterview').onclick = deleteInterview;
$('closeScheduleForm').onclick = () => { $('scheduleForm').classList.add('hidden'); $('calendar').classList.remove('hidden'); };

$('useForInterview').onclick = useForInterview;
$('viewAccountBtn').onclick = viewAccountFromDetail;
$('editInterview').onclick = () => openScheduleForm(detailInterviewId, null);
$('closeDetail').onclick = () => { $('interviewDetail').classList.add('hidden'); $('calendar').classList.remove('hidden'); };

$('clearActive').onclick = () => { activeInterviewId = null; localStorage.removeItem('ia_activeInterview'); refreshActiveBanner(); };
$('notifyBtn').onclick = requestNotifyPermission;

$('listenBtn').onclick = () => (listening ? stopListening() : startListening());
$('askBtn').onclick = () => getAnswer();
$('captureBtn').onclick = analyzeScreen;
$('clearBtn').onclick = resetTranscriptAndAnswer;
$('questionInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) getAnswer(); });

// ✕ close buttons on any modal card
document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.onclick = () => {
        const ov = btn.closest('.overlay');
        if (!ov) return;
        ov.classList.add('hidden');
        // These two are opened from the calendar view, so ✕ should return to it
        // (same as their explicit Close/Cancel buttons) instead of leaving nothing visible.
        if (ov.id === 'interviewDetail' || ov.id === 'scheduleForm') $('calendar').classList.remove('hidden');
    };
});

// Keep the two timezone calendar panes scrolled together — scrolling either
// one mirrors the same row range to the other, so an event visible on one
// side stays visible on the other.
(function setupCalScrollSync() {
    const left = $('calGridLeft');
    const right = $('calGridRight');
    let syncing = false;
    left.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true; right.scrollTop = left.scrollTop; syncing = false;
    });
    right.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true; left.scrollTop = right.scrollTop; syncing = false;
    });
})();

// ===========================================================================
// Time slot context menu (click on a slot chip → edit or schedule interview)
// ===========================================================================
function showTsContextMenu(e, slotId, presetDate, presetTime) {
    ctxMenuSlotId    = slotId;
    ctxMenuPresetDate = presetDate || '';
    ctxMenuPresetTime = presetTime || '';
    const menu = $('tsContextMenu');
    menu.classList.remove('hidden');
    const x = Math.min(e.clientX + 4, window.innerWidth  - 185);
    const y = Math.min(e.clientY + 4, window.innerHeight - 90);
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
}

$('tsCtxEdit').onclick = () => {
    $('tsContextMenu').classList.add('hidden');
    openTimeSlotForm();
};
$('tsCtxNewIv').onclick = () => {
    $('tsContextMenu').classList.add('hidden');
    $('calendar').classList.add('hidden');
    openScheduleForm(null, ctxMenuPresetDate || null, ctxMenuPresetTime || null);
};
document.addEventListener('click', (e) => {
    const menu = $('tsContextMenu');
    if (menu && !menu.classList.contains('hidden') &&
        !e.target.closest('#tsContextMenu') &&
        !e.target.classList.contains('cal-ts') &&
        !e.target.classList.contains('wg-ts') &&
        !e.target.classList.contains('wg-ts-cont')) {
        menu.classList.add('hidden');
    }
});

init();
