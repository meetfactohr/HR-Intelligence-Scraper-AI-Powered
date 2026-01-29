const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
const { OpenAI } = require('openai');

puppeteer.use(StealthPlugin());
const app = express();
const upload = multer({ dest: 'uploads/' });

// --- CONFIGURATION ---
// ⚠️ PASTE YOUR OPENAI API KEY HERE
const openai = new OpenAI({
    apiKey: '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' 
});

app.use(express.static('public'));
app.use(express.json());

// --- REAL-TIME STATUS (SSE) ---
let clients = [];
app.get('/status', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const clientId = Date.now();
    clients.push({ id: clientId, res });
    req.on('close', () => clients = clients.filter(c => c.id !== clientId));
});

function sendUpdate(msg, type = 'progress') {
    clients.forEach(c => c.res.write(`data: ${JSON.stringify({ type, message: msg })}\n\n`));
}

// --- GPT ANALYSIS ---
async function analyzeWithGPT(company, searchResults) {
    if (!searchResults || searchResults.length === 0) return null;

    const prompt = `
    I am looking for the Head of HR, HR Manager, CHRO, or Talent Acquisition Lead for the company: "${company}".
    
    Here are the Google Search results:
    ${JSON.stringify(searchResults, null, 2)}

    TASK:
    1. Analyze the 'title' and 'snippet'.
    2. Select the ONE person who most likely holds a senior HR role AT "${company}" (or parent company).
    3. Verify the person works at the company based on the text.
    4. Prioritize: CHRO > VP People > Director HR > Manager > Talent Acquisition.

    OUTPUT JSON:
    {
        "name": "Full Name",
        "title": "Job Title",
        "link": "LinkedIn URL",
        "confidence": "High/Medium/Low",
        "reasoning": "Brief reason why"
    }
    `;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [
                { role: "system", content: "You are an expert executive recruiter. Output JSON only." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        console.error("GPT Error:", error);
        return null;
    }
}

// --- HELPER: CAPTCHA HANDLER ---
async function handleCaptcha(page) {
    if (page.url().includes("sorry/index")) {
        sendUpdate("⚠️ CAPTCHA DETECTED! Please solve it in the browser window...", "captcha");
        // Wait INDEFINITELY until the URL is no longer the captcha page
        await page.waitForFunction(() => !window.location.href.includes("sorry/index"), { timeout: 0 });
        sendUpdate("Captcha solved! Resuming...", "progress");
        await new Promise(r => setTimeout(r, 2000)); // Cool down
    }
}

// --- SCRAPER ENGINE ---
async function runScraper(companies) {
    const browser = await puppeteer.launch({ 
        headless: false, 
        args: [
            '--start-maximized', 
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1920,1080'
        ] 
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // User Agent to look exactly like a real Desktop Chrome
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const finalResults = [];

    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        sendUpdate(`Processing (${i + 1}/${companies.length}): ${company}`);

        try {
            // --- STEP 1: FIND DOMAIN ---
            // sendUpdate(`Looking for domain: ${company}`); // Optional: Keep logs cleaner
            await page.goto(`https://www.google.com/search?q=${encodeURIComponent(company + " official site")}`, { waitUntil: 'domcontentloaded' });
            
            await handleCaptcha(page); // Check for Captcha

            // Extract Domain
            let foundDomain = await page.evaluate(() => {
                const link = document.querySelector('.g a'); // First organic result
                return link ? link.href : null;
            });

            if (foundDomain) {
                try {
                    foundDomain = new URL(foundDomain).hostname.replace('www.', '');
                } catch (e) { foundDomain = "N/A"; }
            } else {
                foundDomain = "N/A";
            }

            // --- STEP 2: FIND HR LEADS ---
            const query = `site:linkedin.com/in/ "${company}" ("HR" OR "Human Resources" OR "People" OR "Talent" OR "CHRO")`;
            await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });

            await handleCaptcha(page); // Check for Captcha again

            // Handle Cookie Popup if present
            try {
                const btn = await page.$x("//button[contains(., 'Reject all') or contains(., 'Accept all')]");
                if (btn.length > 0) {
                    await btn[0].click();
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (e) {}

            // Extract Candidates (Hybrid Logic)
            const rawCandidates = await page.evaluate(() => {
                const data = [];
                // Method A: Standard Google Results
                const cardItems = document.querySelectorAll('.g');
                cardItems.forEach(item => {
                    const titleEl = item.querySelector('h3');
                    const linkEl = item.querySelector('a');
                    const snippetEl = item.querySelector('div[style*="-webkit-line-clamp"]') || item.querySelector('.VwiC3b');
                    
                    if (titleEl && linkEl && linkEl.href.includes('linkedin.com/in/')) {
                        data.push({
                            title: titleEl.innerText,
                            link: linkEl.href,
                            snippet: snippetEl ? snippetEl.innerText : ""
                        });
                    }
                });

                // Method B: Direct Link Search (Backup)
                if (data.length === 0) {
                    const links = document.querySelectorAll('a[href*="linkedin.com/in/"]');
                    links.forEach(link => {
                        const h3 = link.querySelector('h3');
                        if (h3) {
                            data.push({
                                title: h3.innerText,
                                link: link.href,
                                snippet: link.closest('div') ? link.closest('div').innerText : ""
                            });
                        }
                    });
                }

                // Deduplicate
                const unique = [];
                const seen = new Set();
                for(const item of data) {
                    if(!seen.has(item.link)) {
                        seen.add(item.link);
                        unique.push(item);
                    }
                }
                return unique.slice(0, 6);
            });

            // --- STEP 3: AI ANALYSIS ---
            if (rawCandidates.length > 0) {
                const bestMatch = await analyzeWithGPT(company, rawCandidates);

                if (bestMatch && bestMatch.name) {
                    finalResults.push({
                        company: company,
                        domain: foundDomain, // Now populating correctly
                        name: bestMatch.name,
                        title: bestMatch.title,
                        link: bestMatch.link,
                        accuracy: bestMatch.confidence, 
                        reasoning: bestMatch.reasoning
                    });
                    sendUpdate(`✅ Found: ${bestMatch.name} | ${foundDomain}`);
                } else {
                    finalResults.push({ company, domain: foundDomain, name: "Not Found", title: "-", link: "-", accuracy: "Low", reasoning: "AI Mismatch" });
                }
            } else {
                finalResults.push({ company, domain: foundDomain, name: "No Results", title: "-", link: "-", accuracy: "Low", reasoning: "No Google Results" });
            }

            // Human Delay (Random 2-4 seconds)
            await new Promise(r => setTimeout(r, Math.random() * 2000 + 2000));

        } catch (e) { 
            console.error(e);
            sendUpdate(`Error on ${company}: ${e.message}`);
            finalResults.push({ company, domain: "Error", name: "Error", title: "-", link: "-", accuracy: "Low" });
        }
    }

    await browser.close();
    return finalResults;
}

// --- ROUTES ---
app.post('/upload', upload.single('csvfile'), (req, res) => {
    const companies = [];
    fs.createReadStream(req.file.path).pipe(csv())
        .on('data', (row) => { 
            const name = Object.values(row)[0];
            if(name) companies.push(name); 
        })
        .on('end', async () => {
            const results = await runScraper(companies);
            const fileName = `results_${Date.now()}.csv`;
            const filePath = path.join(__dirname, 'results', fileName);

            if (!fs.existsSync(path.join(__dirname, 'results'))) fs.mkdirSync(path.join(__dirname, 'results'));

            const writer = createObjectCsvWriter({
                path: filePath,
                header: [
                    {id: 'company', title: 'Company'},
                    {id: 'domain', title: 'Domain'},
                    {id: 'name', title: 'Name'},
                    {id: 'title', title: 'Job Title'},
                    {id: 'link', title: 'LinkedIn Profile'},
                    {id: 'accuracy', title: 'AI Confidence'},
                    {id: 'reasoning', title: 'AI Reasoning'}
                ]
            });

            await writer.writeRecords(results);
            res.json({ success: true, data: results, downloadUrl: `/download/${fileName}` });
        });
});

app.get('/download/:file', (req, res) => res.download(path.join(__dirname, 'results', req.params.file)));

app.listen(3000, () => console.log('Server running: http://localhost:3000'));