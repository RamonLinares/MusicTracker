/* Browser smoke test: boots the real app in Chromium and checks that the demo
 * song loads, playback advances, keyboard editing and undo work, and the
 * console stays clean. Run with `npm run test:browser` (needs Playwright;
 * falls back to the system Chrome if no Playwright browser is installed). */
'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const launchOpts = { args: ['--autoplay-policy=no-user-gesture-required'] };
let browser;
try {
  browser = await chromium.launch(launchOpts);
} catch {
  browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
}

let failed = null;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.tracker && window.tracker.state, { timeout: 10000 });

  // demo song loads
  assert.equal(await page.evaluate(() => window.tracker.state.song.title), 'web chiptune');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.smp-row').length), 31);

  // playback starts and rows advance
  await page.click('#btnPlayPat');
  await page.waitForFunction(() => window.tracker.state.playing, { timeout: 5000 });
  await page.waitForFunction(() => window.tracker.state.playRow >= 3, { timeout: 5000 });
  const rowA = await page.evaluate(() => window.tracker.state.playRow);
  await page.waitForFunction(
    prev => window.tracker.state.playRow !== prev, rowA, { timeout: 5000 }
  );
  await page.click('#btnStop');
  await page.waitForFunction(() => !window.tracker.state.playing, { timeout: 5000 });

  // keyboard note entry writes to the pattern...
  await page.evaluate(() => {
    const t = window.tracker;
    t.state.cursor = { row: 50, ch: 0, col: 0 };
    t.state.editMode = true;
  });
  await page.keyboard.press('q'); // C-3 at the default octave
  const cell = await page.evaluate(() =>
    Array.from(window.tracker.MOD.cellGet(window.tracker.state.song, 0, 50, 0)));
  assert.equal(cell[0], 25, 'note entry should write C-3');
  assert.equal(cell[1], 1, 'note entry should write the current instrument');

  // ...and undo removes it
  await page.keyboard.press('Control+z');
  const cellAfter = await page.evaluate(() =>
    Array.from(window.tracker.MOD.cellGet(window.tracker.state.song, 0, 50, 0)));
  assert.equal(cellAfter[0], 0, 'undo should clear the recorded note');

  // module import path: round-trip the demo through a .mod file load
  const loaded = await page.evaluate(async () => {
    const t = window.tracker;
    const bytes = t.MOD.save(t.MOD.demoSong());
    const file = new File([bytes], 'smoke.mod');
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 300));
    return document.getElementById('statusMsg').textContent;
  });
  assert.match(loaded, /Loaded "web chiptune"/);

  assert.deepEqual(errors, [], 'console should stay clean');
  console.log('Browser smoke test passed');
} catch (err) {
  failed = err;
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error(failed);
  process.exit(1);
}
