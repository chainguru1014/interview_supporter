require('dotenv').config();
const OpenAI = require('openai');
const { buildPrompt } = require('../services/prompt-profiles');

// Karl Arnold profile from the failed call log
const profileData = {
    jobTitle: 'Full Stack Engineer',
    jobDescription: 'Senior Full Stack Java Engineer. Build and own full stack applications using Java, Spring Boot, and Angular. Design APIs and microservices that scale under real production load.',
    candidateInfo: `Karl Douglas Arnold
19 Arrowfeather Pl, Spring, TX 77389
karlarnold9565@gmail.com
Senior Software/Platform Engineer with 15+ years experience.
EDUCATION: Bachelor of Science in Computer Science, Brigham Young University, Jun 2005 – May 2009`,
    projects: 'Nearform (Jan 2021 – Apr 2026) Senior Platform Engineer. Acadia Healthcare (Feb 2016 – Dec 2020) Senior Software Engineer. Airbnb (Jul 2011 – Jan 2016) Full Stack Developer. Health Net (Jul 2009 – Jun 2011) Full Stack Developer.',
    departureReasons: '',
    whyThisCompany: '',
};

const questions = [
    'Whereabouts in Spring?',
    'Where did you go to college?',
    "I don't think you live in Texas. What's the hustle?",
];

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
    for (const q of questions) {
        const systemPrompt = buildPrompt(profileData, 'interview', '', q);
        const t0 = Date.now();
        console.log(`\n\n=== Q: ${q}\n`);
        const stream = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.5,
            max_tokens: 1024,
            stream: true,
        });
        let total = '';
        for await (const chunk of stream) {
            const c = chunk.choices[0]?.delta?.content || '';
            process.stdout.write(c);
            total += c;
        }
        console.log(`\n--- ${Date.now() - t0}ms | ${total.length} chars`);
    }
})().catch(e => { console.error(e); process.exit(1); });
