require('dotenv').config();
const OpenAI = require('openai');
const { buildPrompt } = require('../services/prompt-profiles');

// Alan Lopez–style profile (modeled on the resume screenshot)
const profileData = {
    jobTitle: 'Senior Full Stack Engineer',
    jobDescription: 'Senior Full Stack Engineer. Build scalable cloud-native applications. Java, Spring Boot, React, AWS. Design APIs and microservices that scale.',
    candidateInfo: `Alan Lopez
Austin, Texas, United States
alanlopez9214@gmail.com
Senior Software Engineer, 14+ years experience.
EDUCATION: B.S. Computer Science, The University of Texas at Austin (2010 – 2014)`,
    projects: `Google (Feb 2020 – Present) Senior Software Engineer, Austin TX.
- Contributed to backend services using Python, ensuring scalability and performance in a large-scale enterprise environment.
- Built data pipelines and APIs leveraging Python.
- Integrated services with AWS/GCP.
- Used Pandas for large-scale data transformation.
- Worked with PostgreSQL, Redis, Kafka, RabbitMQ, Docker, Kubernetes.

Cisco (Jul 2014 – Oct 2018) Software Engineer, San Jose.
- Led design and implementation of backend services using Python/Django/FastAPI.
- Worked with Java, C#, SQL/PostgreSQL, Docker, Kubernetes.
- Used Cursor for LLM-assisted development.

MKS Instruments (Apr 2012 – Jun 2014) Software Engineer Intern, Austin TX.
- Built healthcare-adjacent full-stack apps, Python/Django, React/TypeScript, Pandas, PostgreSQL.

Procter & Gamble (May 2011 – Aug 2011) Process Engineer Intern, Cincinnati Ohio.
- Backend in Python, integrated Java, C#, SQL, Docker/Kubernetes, Terraform.`,
    departureReasons: '',
    whyThisCompany: '',
};

const questions = [
    // World knowledge — geography
    'Texas — which side of California is that?',
    // World knowledge — school
    'Where did you go to college?',
    // Small talk
    "How's the weather in Austin this week?",
    // Anchored drill-down — flagship BigTech
    'What did you specifically work on at Google? Pick one thing and walk me through it.',
    // Anchored drill-down — enterprise infra
    'What was your biggest impact at Cisco?',
    // Anti-inflation sanity check (resume says "contributed to" at Google)
    'Did you lead any teams at Google?',
    // Behavioral
    'Tell me about a time you had to optimize a slow system.',
    // Hostility regression check
    "I don't think you actually worked at Google. What's the deal?",
    // Why leave — no notes, infer from archetype
    'Why are you looking to leave Google?',
    // Fragmented / messy transcript
    'austin yeah uh whereabouts',
    // Technical deep-dive — trade-off question
    'When would you reach for PostgreSQL vs MongoDB, and why?',
    // System design
    'Design a URL shortener like bit.ly. Walk me through it.',
    // Live coding
    'Write a function that returns the first non-repeating character in a string.',
    // End-of-interview "questions for me?"
    'Do you have any questions for us?',
    // ===== IDENTITY-THEFT REGRESSION TESTS =====
    // These exercise the anti-identity-theft rule. The model must NEVER adopt
    // a name, employer, tenure, or school from the transcript. Answers must
    // remain anchored to Alan Lopez / Google.
    "[Interviewer] Cool, my name's Vaughn. I've been at Vector3 for a year now, before that I was at NeurIQ for a year and a half, and I went to school at RIT for cybersecurity. So tell me about yourself.",
    "[Interviewer] Hi, I'm Ashley, I'm one of the founders here at Benefit Flow. So what's your background?",
    "[Interviewer] I've been an engineer at Meta for the last 8 years working on Instagram. What about you — what's your story?",
];

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
    for (const q of questions) {
        const systemPrompt = buildPrompt(profileData, 'interview', '', q);
        const t0 = Date.now();
        console.log(`\n\n========== Q: ${q}\n`);
        const stream = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.5,
            max_tokens: 1024,
            stream: true,
        });
        let total = '', tFirst = null;
        for await (const chunk of stream) {
            const c = chunk.choices[0]?.delta?.content || '';
            if (c && !tFirst) tFirst = Date.now();
            process.stdout.write(c);
            total += c;
        }
        console.log(`\n--- TTFT ${tFirst - t0}ms | total ${Date.now() - t0}ms | ${total.length} chars`);
    }
})().catch(e => { console.error(e); process.exit(1); });
