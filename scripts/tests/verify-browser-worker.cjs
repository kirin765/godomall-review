/* eslint-disable @typescript-eslint/no-require-imports -- Optional local browser regression harness. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

(async () => {
  const chunkDir = '.next/static/chunks';
  const entries = fs.readdirSync(chunkDir).filter((p) => p.endsWith('.js'));
  const parent = entries.map((p) => fs.readFileSync(`${chunkDir}/${p}`, 'utf8')).find((code) => code.includes('reviewFile.worker.') && code.includes('turbopack-worker-'));
  assert.ok(parent, 'production build must emit a separate review worker');
  const config = parent.match(/"(static\/chunks\/turbopack-worker-[^"]+)",(\[[^\]]+\])/);
  assert.ok(config, 'production worker bootstrap should include its chunk dependencies');
  const workerUrl = `/_next/${config[1]}?params=${encodeURIComponent(JSON.stringify([JSON.parse(config[2]).map((p) => `/_next/${p}`), '', '', '']))}`;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['리뷰내용', '평점', '작성일', '작성자'],
    ...Array.from({ length: 50000 }, (_, i) => [`review ${i}`, 4, '2026-09-01T13:45:12+09:00', 'author']),
  ]), 'Reviews');
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(process.env.TEST_APP_URL || 'http://127.0.0.1:3187/support');
    const result = await page.evaluate(async ({ workerUrl, base64 }) => {
      const worker = new Worker(workerUrl);
      const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
      let heartbeats = 0;
      const timer = setInterval(() => heartbeats++, 10);
      const start = performance.now();
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker timeout')), 30000);
        worker.onmessage = (event) => { clearTimeout(timeout); resolve(event.data); };
        worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)); };
        worker.postMessage(buffer, [buffer]);
      });
      clearInterval(timer);
      worker.terminate();
      return { count: result.reviews?.length, first: result.reviews?.[0], last: result.reviews?.at(-1), fileHash: result.fileHash, error: result.error, heartbeats, elapsedMs: performance.now() - start, transferred: buffer.byteLength === 0 };
    }, { workerUrl, base64: bytes.toString('base64') });
    assert.equal(result.error, undefined);
    assert.equal(result.count, 50000);
    assert.equal(result.first.content, 'review 0');
    assert.equal(result.last.content, 'review 49999');
    assert.equal(result.first.createdAt, '2026-09-01T13:45:12+09:00');
    assert.equal(result.fileHash, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.ok(result.heartbeats > 0, 'main thread must remain responsive while the worker runs');
    assert.equal(result.transferred, true);
    console.log(JSON.stringify({ rows: result.count, mainThreadHeartbeats: result.heartbeats, elapsedMs: Math.round(result.elapsedMs), fileHashVerified: true, bufferTransferred: true }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
