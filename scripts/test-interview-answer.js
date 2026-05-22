require('dotenv').config();
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { buildPrompt } = require('../services/prompt-profiles');

const PROFILE_PATH = path.join(process.env.APPDATA, 'my-electron-app', 'profile.json');
const profileData = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));

const question = process.argv.slice(2).join(' ') || 'Why are you looking to leave Wrike?';
const systemPrompt = buildPrompt(profileData, 'interview', '', question);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
    const t0 = Date.now();
    console.log(`\n=== Q: ${question}\n`);
    const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }],
        temperature: 0.5,
        max_tokens: 1024,
        stream: true,
    });
    let tFirst = null, total = '';
    for await (const chunk of stream) {
        const c = chunk.choices[0]?.delta?.content || '';
        if (c && !tFirst) tFirst = Date.now();
        process.stdout.write(c);
        total += c;
    }
    const tEnd = Date.now();
    console.log(`\n\n--- TTFT: ${tFirst - t0}ms | total: ${tEnd - t0}ms | chars: ${total.length}`);
})().catch(e => { console.error(e); process.exit(1); });
