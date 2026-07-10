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

  // 3D interface boots and renders a nonblank WebGL frame
  await page.click('#tab3d');
  await page.waitForFunction(() => window.WebTracker3D?.ready && document.querySelector('#threePanel canvas'), { timeout: 10000 });
  await page.waitForTimeout(600);
  const frame3dA = await page.evaluate(() => {
    const canvas = document.querySelector('#threePanel canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const size = 48;
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(Math.max(0, (w - size) >> 1), Math.max(0, (h - size) >> 1), size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0, sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const v = pixels[i] + pixels[i + 1] + pixels[i + 2];
      if (v > 18) lit++;
      sum = (sum + v * (i + 1)) >>> 0;
    }
    return { w, h, lit, sum };
  });
  assert.ok(frame3dA.w > 300 && frame3dA.h > 200, '3D canvas should fill the editor area');
  assert.ok(frame3dA.lit > 120, '3D canvas should render nonblack pixels');
  assert.match(await page.textContent('.three-axis-key'), /X CHANNEL Y PITCH Z ROW COLOR INSTRUMENT WIDTH VOLUME/);
  assert.match(await page.textContent('#threeDetail'), /ROW 00\s+CH 1\s+C-2\s+03 KICK/);

  // The scene is a spatial score, not arbitrary decoration: X is channel,
  // higher notes rise on Y, and later rows move away on Z.
  const spatialMapping = await page.evaluate(() => {
    const events = [];
    for (const mesh of window.WebTracker3D.noteMeshes) {
      const matrices = mesh.instanceMatrix.array;
      mesh.userData.cells.forEach((cell, index) => events.push({
        ...cell,
        x: matrices[index * 16 + 12],
        y: matrices[index * 16 + 13],
        z: matrices[index * 16 + 14]
      }));
    }
    const sameChannel = events.filter(event => event.ch === 1);
    const low = sameChannel.reduce((best, event) => !best || event.note < best.note ? event : best, null);
    const high = sameChannel.reduce((best, event) => !best || event.note > best.note ? event : best, null);
    const early = sameChannel.reduce((best, event) => !best || event.row < best.row ? event : best, null);
    const late = sameChannel.reduce((best, event) => !best || event.row > best.row ? event : best, null);
    return { low, high, early, late };
  });
  assert.equal(spatialMapping.low.x, spatialMapping.high.x, 'same-channel notes should share an X lane');
  assert.ok(spatialMapping.high.y > spatialMapping.low.y, 'higher notes should rise on Y');
  assert.ok(spatialMapping.late.z < spatialMapping.early.z, 'later rows should recede on Z');

  // Click a projected visible note and confirm it selects the matching tracker cell.
  const pickTarget = await page.evaluate(() => {
    const app = window.WebTracker3D;
    const bounds = app.renderer.domElement.getBoundingClientRect();
    for (const mesh of app.noteMeshes) {
      for (let index = 0; index < mesh.userData.cells.length; index++) {
        const matrix = mesh.matrixWorld.clone();
        mesh.getMatrixAt(index, matrix);
        const point = app.camera.position.clone().set(0, 0, 0)
          .applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld).project(app.camera);
        if (Math.abs(point.x) < 0.72 && Math.abs(point.y) < 0.64) {
          return {
            x: bounds.left + (point.x * 0.5 + 0.5) * bounds.width,
            y: bounds.top + (-point.y * 0.5 + 0.5) * bounds.height,
            row: mesh.userData.cells[index].row,
            ch: mesh.userData.cells[index].ch
          };
        }
      }
    }
    return null;
  });
  assert.ok(pickTarget, '3D overview should contain a visible selectable note');
  await page.mouse.click(pickTarget.x, pickTarget.y);
  assert.deepEqual(
    await page.evaluate(() => ({ row: window.tracker.state.cursor.row, ch: window.tracker.state.cursor.ch })),
    { row: pickTarget.row, ch: pickTarget.ch },
    'clicking a 3D note should select its tracker cell'
  );

  const diagnostics = await page.evaluate(() => window.WebTracker3D.diagnostics());
  assert.ok(diagnostics.calls < 40, `3D view should stay under 40 draw calls (got ${diagnostics.calls})`);
  assert.ok(diagnostics.triangles < 100000, `3D view should stay under 100k triangles (got ${diagnostics.triangles})`);
  await page.waitForTimeout(500);
  const frame3dB = await page.evaluate(() => {
    const canvas = document.querySelector('#threePanel canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const size = 48;
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(Math.max(0, (gl.drawingBufferWidth - size) >> 1), Math.max(0, (gl.drawingBufferHeight - size) >> 1), size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum = (sum + (pixels[i] + pixels[i + 1] + pixels[i + 2]) * (i + 1)) >>> 0;
    return sum;
  });
  assert.notEqual(frame3dA.sum, frame3dB, '3D scene should animate between frames');

  await page.click('#threeFollow');
  assert.equal(await page.evaluate(() => window.WebTracker3D.cameraMode), 'follow');
  const cameraBeforePlayback = await page.evaluate(() => window.WebTracker3D.camera.position.z);
  await page.click('#btnPlayPat');
  await page.waitForFunction(() => window.tracker.state.playRow >= 4, { timeout: 5000 });
  await page.waitForTimeout(250);
  const cameraDuringPlayback = await page.evaluate(() => window.WebTracker3D.camera.position.z);
  assert.notEqual(cameraDuringPlayback, cameraBeforePlayback, 'follow camera should move with playback');
  await page.click('#btnStop');
  await page.waitForFunction(() => !window.tracker.state.playing, { timeout: 5000 });
  await page.click('#tabPattern');

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

  // pattern PNG export produces a real download
  const [pngDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('#btnExportPng')
  ]);
  assert.match(pngDownload.suggestedFilename(), /-pattern00\.png$/);

  // pattern clip export renders one pass of the pattern to WAV
  const [wavDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btnExportClip')
  ]);
  assert.match(wavDownload.suggestedFilename(), /-pattern00\.wav$/);
  const wavPath = await wavDownload.path();
  const wavBytes = fs.readFileSync(wavPath);
  assert.equal(wavBytes.subarray(0, 4).toString(), 'RIFF');
  assert.ok(wavBytes.length > 8 * 44100, 'clip should be roughly one pattern long (~8s of stereo audio)');

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
