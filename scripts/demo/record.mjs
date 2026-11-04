// Usage (from repo root, after npm run seed): npm i --no-save playwright && npx playwright install chromium && node scripts/demo/record.mjs && node scripts/demo/edit.mjs
// Records the live demo: trader chat → Paystack test charge → trader chat → Sheet → owner chat → Sheet.
// Every page is recorded by Playwright; a timeline of "show" vs "wait" segments drives the ffmpeg edit.
import { chromium } from 'playwright';
import fs from 'node:fs';

const CHAT = 'https://chat.tsglabs.dev/c/zk4DR6lKuO34yNs1YgQ6Qjp-';
const SHEET = 'https://docs.google.com/spreadsheets/d/1xXocK9G8peAppsfXiITEcHeBKtRKEtIJhwk7B8Bqfn4/edit?hl=en';
const OUT = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(process.env.ENV_FILE ?? '.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const size = { width: 1280, height: 800 };
const browser = await chromium.launch();
const plan = []; // [{video, segments:[{a,b,mode}]}]
const transcript = [];

async function newRecordedPage(label) {
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: OUT, size }, locale: 'en-GB' });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const entry = { label, ctx, page, t0, segments: [], cur: { a: 0, mode: 'wait' } };
  entry.mark = (mode) => {
    const t = (Date.now() - t0) / 1000;
    if (entry.cur.mode !== mode) { entry.segments.push({ a: entry.cur.a, b: t, mode: entry.cur.mode }); entry.cur = { a: t, mode }; }
  };
  plan.push(entry);
  return entry;
}

async function finish(entry) {
  entry.mark(entry.cur.mode === 'show' ? 'wait' : 'show');
  entry.segments.push({ a: entry.cur.a, b: (Date.now() - entry.t0) / 1000, mode: entry.cur.mode });
  await entry.ctx.close();
  entry.video = await entry.page.video().path();
}

/** Caption panel in the left margin (shadow DOM so it never pollutes page text). */
async function caption(page, title, body, side = 'left') {
  await page.evaluate(({ title, body, side }) => {
    // Built with DOM calls only: Google Sheets enforces Trusted Types, so innerHTML is blocked.
    let host = document.getElementById('__cap');
    if (!host) { host = document.createElement('div'); host.id = '__cap'; document.documentElement.appendChild(host); host.attachShadow({ mode: 'open' }); }
    const root = host.shadowRoot; while (root.firstChild) root.removeChild(root.firstChild);
    const pos = side === 'left' ? 'left:16px;top:90px;width:228px' : side === 'right' ? 'right:16px;top:90px;width:228px' : 'right:24px;bottom:56px;width:440px';
    const box = document.createElement('div');
    box.setAttribute('style', `position:fixed;${pos};z-index:2147483647;background:#111b21;color:#e9edef;border-radius:12px;padding:14px 16px;font:14px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)`);
    const h = document.createElement('div'); h.setAttribute('style', 'font-weight:700;font-size:15px;color:#25d366;margin-bottom:6px'); h.textContent = title; box.appendChild(h);
    const d = document.createElement('div');
    for (const part of body.split(/(<br>|<code>.*?<\/code>|<b>.*?<\/b>)/)) {
      if (!part) continue;
      if (part === '<br>') d.appendChild(document.createElement('br'));
      else if (part.startsWith('<code>')) { const c = document.createElement('code'); c.setAttribute('style', 'color:#53bdeb;font-size:13px'); c.textContent = part.slice(6, -7); d.appendChild(c); }
      else if (part.startsWith('<b>')) { const c = document.createElement('b'); c.textContent = part.slice(3, -4); d.appendChild(c); }
      else d.appendChild(document.createTextNode(part));
    }
    box.appendChild(d); root.appendChild(box);
  }, { title, body, side });
}

const chatText = (page) => page.evaluate(() => document.body.innerText);

async function startChat(entry, name) {
  const { page } = entry;
  await page.goto(CHAT, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  entry.mark('show');
  await page.waitForTimeout(800);
  await page.getByPlaceholder('e.g. Ada').click();
  await page.keyboard.type(name, { delay: 60 });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Start chatting' }).click();
  await page.getByPlaceholder('Message').waitFor();
  await page.waitForTimeout(1200);
}

async function say(entry, text, minHold = 3) {
  const { page } = entry;
  const before = await chatText(page);
  const box = page.getByPlaceholder('Message');
  await box.click();
  await page.keyboard.type(text, { delay: 35 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const afterSend = await chatText(page);
  entry.mark('wait');
  // Agent reply: text grows past what we sent, then stays unchanged for 5 s.
  const start = Date.now();
  let last = afterSend, stableSince = Date.now(), grew = false;
  while (Date.now() - start < 120_000) {
    await page.waitForTimeout(500);
    const now = await chatText(page);
    if (now !== last) { last = now; stableSince = Date.now(); if (now.length > afterSend.length + 15) grew = true; }
    if (grew && Date.now() - stableSince > 5000 && !/typing/i.test(now.slice(-200))) break;
  }
  // Rewind the "wait" mark to when the reply finished arriving.
  const t = (stableSince - entry.t0) / 1000;
  entry.segments.push({ a: entry.cur.a, b: t, mode: 'wait' });
  entry.cur = { a: t, mode: 'wait' }; // the 5 s stability window is dead time too
  entry.mark('show');
  const reply = last.slice(before.length).replace(text, '').trim();
  transcript.push({ who: entry.label, you: text, agent: reply });
  console.log(`\n[${entry.label}] > ${text}\n${reply}\n`);
  await page.evaluate(() => { const els = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY.match(/auto|scroll/)); els.forEach(e => e.scrollTop = e.scrollHeight); });
  await page.waitForTimeout(Math.min(9, Math.max(minHold, 2.5 + reply.length / 55)) * 1000);
  return reply;
}

async function sheetScene(label, tabTitle, body, rowHint) {
  const e = await newRecordedPage(label);
  const { page } = e;
  e.mark('wait');
  await page.goto(SHEET, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.docs-sheet-tab-name', { timeout: 60000 });
  await page.waitForTimeout(5000);
  e.mark('show');
  await caption(page, tabTitle, body, 'bottom');
  await page.waitForTimeout(800);
  if (rowHint) {
    // Click the trader's name cell so the row is highlighted.
    const box = await page.locator('#waffle-grid-container, .grid-container').first().boundingBox().catch(() => null);
    if (box) { await page.mouse.click(box.x + rowHint.x, box.y + rowHint.y); }
  }
  await page.waitForTimeout(7000);
  await finish(e);
}

async function card(file, html, seconds) {
  const p = await browser.newPage({ viewport: size });
  await p.setContent(html);
  await p.screenshot({ path: OUT + file });
  await p.close();
  plan.push({ label: file, image: OUT + file, seconds });
}

const cardHtml = (title, lines, foot = '') => `<!doctype html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b141a;color:#e9edef;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:980px;padding:0 40px"><div style="color:#25d366;font-weight:700;letter-spacing:.08em;font-size:15px;text-transform:uppercase;margin-bottom:14px">Ibinabo Distribution · Chord WhatsApp agent</div>
<h1 style="font-size:44px;line-height:1.15;margin:0 0 24px">${title}</h1>
<div style="font-size:21px;line-height:1.6;color:#aebac1">${lines.join('<br>')}</div>
<div style="margin-top:28px;font-size:15px;color:#8696a0">${foot}</div></div></body>`;

// ---------------- Scenes ----------------

await card('00_title.png', cardHtml('Credit &amp; stock desk on WhatsApp', [
  'Petty traders reorder, pay and get their balance on WhatsApp.',
  'The owner gets live insight on who pays, who sells, who to cut.',
  '',
  'Live: TSG WhatsApp simulator → Chord teammate (3 skills) → MCP server on Vercel → Google Sheet + Paystack test mode',
], 'Recorded headless from the live chat link, ' + new Date().toUTCString().slice(0, 22) + ' UTC'), 6);

// 1. Trader
const tr = await newRecordedPage('trader');
await startChat(tr, 'Mama Tobi');
await caption(tr.page, 'Trader: Mama Tobi', 'Petty trader, Mile 1 Market.<br><br>Balance ₦305,500 · limit ₦380,000.<br>She wants to reorder on credit.');
await say(tr, 'Good morning. Abeg send me 5 cartons Indomie and 2 cartons Peak milk.');
await caption(tr.page, 'Identity first', 'The simulator gives an opaque sender id, so the agent asks for the registered number before touching any account.');
await say(tr, '08030000001');
await caption(tr.page, 'Credit check in code', '<code>place_reorder</code> prices the order and checks the limit on the server. The model never does the maths.');
await say(tr, 'Yes o', 6);
await caption(tr.page, 'Pay to unlock', '<code>get_payment_details</code> creates a Paystack checkout for exactly the unlock amount.');
await say(tr, 'I go pay the 49k', 5);
tr.mark('skip'); // payment happens off-screen; this gap is cut and the payment card goes here
tr.splitAt = (Date.now() - tr.t0) / 1000;

// 2. Payment (Paystack test mode, Charge API with the official test card)
const ref = `IBN-R001-DEMO-${Date.now()}`;
const charge = await fetch('https://api.paystack.co/charge', {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'r001.ibinabo@example.com', amount: 4900000, reference: ref, metadata: { retailer_id: 'R001' }, card: { number: '4084084084084081', cvv: '408', expiry_month: '12', expiry_year: '2030' }, pin: '0000' }),
}).then((r) => r.json());
console.log('charge', charge.status, charge.data?.status, ref);
await card('02_payment.png', cardHtml('Mama Tobi pays ₦49,000', [
  `Paystack <b>test mode</b> charge, test card 4084 •••• 4081 → <b style="color:#25d366">${charge.data?.status ?? charge.message}</b>`,
  `reference <code>${ref}</code>`,
  'Paystack → <code>POST /webhooks/paystack</code> · <code>charge.success</code>',
  'Signature checked (HMAC-SHA512 of the raw body) → payment recorded once, applied to the oldest invoice',
], 'Paystack’s hosted checkout sits behind a Cloudflare bot check that a headless browser can’t pass, so the test card is charged through Paystack’s Charge API. Same test-mode account, same signed webhook.'), 9);
await new Promise((r) => setTimeout(r, 8000)); // let the webhook land
tr.mark('show');

await caption(tr.page, '“I don pay”', 'No screenshots. <code>check_payments</code> only believes Paystack: the signed webhook has already recorded the ₦49,000.');
await say(tr, 'I don pay', 7);
if (!/placed|approved|INV-[0-9]/i.test(transcript.at(-1).agent)) {
  await caption(tr.page, 'Order goes through', 'With the limit unlocked, <code>place_reorder</code> approves: invoice, due date, stock reduced.');
  await say(tr, 'Yes, place the order', 7);
}
await finish(tr);

// 4. Sheet: trader side
await sheetScene('sheet1', 'Owner’s live dashboard (Google Sheet)', 'Same data the agent used. Mama Tobi: balance now ₦380,000 (₦305,500 − ₦49,000 + ₦123,500 new order) = her limit. Tier, cash-return, days-to-pay and suggested limit are computed by the server.');

// 5. Owner
const ow = await newRecordedPage('owner');
await startChat(ow, 'Mr Ibinabo');
await caption(ow.page, 'Owner: Mr Ibinabo Briggs', 'Same WhatsApp number, different role. The server recognises the owner’s phone and unlocks the owner tools.', 'left');
await say(ow, 'Good evening. How business dey this week?');
await caption(ow.page, 'Insight, not raw data', '<code>get_portfolio_report</code>: cash collected vs outstanding, lagging traders, low stock, open issues.', 'left');
await say(ow, '08030000000', 7);
await caption(ow.page, 'Trader scorecard', '<code>get_retailer_scorecard</code>: cash-return rate, days to pay, sell-through, promise reliability, suggested limit with the reason.', 'left');
await say(ow, 'How Iya Basira dey do?', 8);
await caption(ow.page, 'Owner approves, code applies', 'The agent never changes a limit on its own. <code>update_credit_limit</code> needs the owner’s explicit YES.', 'left');
await say(ow, 'Cut her limit to the suggested amount', 5);
await say(ow, 'YES', 6);
await finish(ow);

// 6. Sheet: owner side
await sheetScene('sheet2', 'Change is live on the dashboard', 'Iya Basira’s limit now shows the new value. Every action from WhatsApp lands in the same sheet the owner already uses.');

await card('99_end.png', cardHtml('What you just saw', [
  '• Credit limit enforced in code: blocked order, exact unlock amount',
  '• Payment trusted only from a signed Paystack webhook, never a screenshot',
  '• Owner insight on WhatsApp: portfolio, scorecard, approve a limit change',
  '• One Google Sheet as database and live dashboard',
], 'github repo: README · docs/TEST_RESULTS.md · FIELD_NOTES.md'), 6);

await browser.close();
fs.writeFileSync(OUT + 'plan.json', JSON.stringify(plan.map(({ label, video, image, seconds, segments, splitAt }) => ({ label, video, image, seconds, segments, splitAt })), null, 2));
fs.writeFileSync(OUT + 'transcript.json', JSON.stringify(transcript, null, 2));
console.log('done');
