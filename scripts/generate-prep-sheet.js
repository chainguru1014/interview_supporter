/**
 * Pre-call cheat sheet generator.
 *
 * Reads the user's profile.json (from %APPDATA%/my-electron-app/) and emits
 * a 1–2 page printable Markdown cheat sheet covering:
 *   - 30-second resume self-recall
 *   - 6–8 likely questions with 3-line answer outlines
 *   - Your own resume bullets paraphrased (so you can glance during the call)
 *   - 2–3 strongest STAR-lite stories
 *   - 3 sharp questions to ask them
 *   - Last-mile reminders
 *
 * Run:  node scripts/generate-prep-sheet.js
 * Output: prep-sheets/cheat-sheet-{YYYY-MM-DD}.md  (overwrites if same day)
 */
require('dotenv').config();
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(process.env.APPDATA, 'my-electron-app', 'profile.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'prep-sheets');

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));

const ctx = `**Target Role:** ${profile.jobTitle || '(not set)'}

**Job Description:**
${profile.jobDescription || '(none)'}

**Candidate Background:**
${profile.candidateInfo || '(none)'}

**Projects / Experience:**
${profile.projects || '(none)'}

**Departure Reasons:**
${profile.departureReasons || '(none)'}

**Why This Company:**
${profile.whyThisCompany || '(none)'}`;

const PROMPT_PART_A = `You generate a candidate's pre-interview cheat sheet. The candidate will read this ONCE before a live call, so it must be skim-friendly: bullets and bolded keywords, NOT prose paragraphs.

Using the context below, produce these Markdown sections in order:

## Your 30-Second Pitch
A first-person 2–3 sentence "tell me about yourself" the candidate can deliver verbatim. Lead with years + role, name the most relevant 2–3 technologies from the JD, close with one sentence on why this role.

## Your Resume At-a-Glance
For each company on the resume, ONE bolded company line and 2–4 short bullet paraphrases of what was done there — written in plain English so the candidate can glance and remember. Mirror the resume's role verbs (do NOT inflate "contributed to" into "led"). Most recent company first.

## Strongest Stories (STAR-lite)
Pick the 3 strongest story-able experiences from the resume. For each:
- **Title** (one line: the situation in 5 words)
- **Situation:** one sentence
- **Action:** one or two sentences naming the tech used
- **Result:** one sentence with a modest plausible metric (15–40%, ~2x, never 10x)
- **Best for:** which interview questions this answers ("describe a tough bug", "time you optimized", "disagreed with manager", etc.)

Output ONLY Markdown. No preamble, no closing.

**Context:**
${ctx}`;

const PROMPT_PART_B = `You generate a candidate's pre-interview cheat sheet. The candidate will read this ONCE before a live call, so it must be skim-friendly: bullets and bolded keywords, NOT prose paragraphs.

Using the context below, produce these Markdown sections in order:

## Likely Questions & 3-Line Outlines
Anticipate the 7 most likely questions for this specific role and seniority. Cover a mix of: opener ("tell me about yourself"), motivation ("why this company / why leaving"), technical depth (one trade-off question tied to the JD stack), system design (one likely from the JD), behavioral (one tough), curveball (one).
For each question:
- **Q: "{verbatim question}"**
  - Line 1 — opener / your position
  - Line 2 — supporting evidence / war story or framework
  - Line 3 — close / trade-off / link to the role

## Questions to Ask Them
Exactly 3 numbered, one-sentence questions. Mix: role/success metric, team/tech, trajectory/signal. Tie at least 2 to specific items in the Job Description. No generic "what's the culture like?".

## Last-Mile Reminders
A bullet list of 5–7 short reminders specific to THIS interview based on the context. Each reminder must be ACTIONABLE during the call. Cover at least these themes:
- **Verb-mirroring discipline:** if the resume uses "contributed to" or "worked on" for a company, the candidate MUST use those exact verbs during the interview — do NOT inflate to "led" or "owned" on follow-up. Reserve leadership verbs strictly for work the resume calls out as led/owned/built/designed. (This rule is critical — phrase it as "Mirror resume verbs exactly", NOT as "avoid contributed to".)
- Specific JD tech worth weaving in naturally (name 2–3 from the JD)
- Geography / address / school details from the resume the interviewer might probe
- One thing about the target company to drop into a "why us" answer
- Tone reminder: short (1–2 sentences) for personal/small-talk questions, structured for design/behavioral
- One forbidden phrase the candidate should NOT say (e.g. "feel free to ask", "I appreciate your candor", "great area")

Output ONLY Markdown. No preamble, no closing.

**Context:**
${ctx}`;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function call(prompt) {
    const r = await openai.chat.completions.create({
        model: 'gpt-4o',  // use the larger model for synthesis quality on this one-off
        messages: [{ role: 'system', content: prompt }],
        temperature: 0.4,
        max_tokens: 2200,
    });
    return r.choices[0].message.content.trim();
}

(async () => {
    const t0 = Date.now();
    console.log(`Generating cheat sheet for: ${profile.jobTitle || '(no role set)'}`);
    console.log('Calling OpenAI (2 parallel requests)...');

    const [partA, partB] = await Promise.all([call(PROMPT_PART_A), call(PROMPT_PART_B)]);

    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const header = `# Pre-Call Cheat Sheet
**Role:** ${profile.jobTitle || '(not set)'}
**Generated:** ${date.toISOString()}

---

`;

    const sheet = header + partA + '\n\n---\n\n' + partB + '\n';

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outPath = path.join(OUTPUT_DIR, `cheat-sheet-${dateStr}.md`);
    fs.writeFileSync(outPath, sheet, 'utf-8');

    console.log(`Done in ${Date.now() - t0}ms.`);
    console.log(`Output: ${outPath}`);
    console.log(`Size:   ${sheet.length} chars (~${Math.ceil(sheet.length / 3500)} pages printed)`);
})().catch(e => { console.error(e); process.exit(1); });
