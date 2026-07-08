'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = {};
vm.createContext(context);
{
  const code = fs.readFileSync(path.join(root, 'js', 'pitch.js'), 'utf8');
  vm.runInContext(`${code}\nthis.Pitch = Pitch;`, context, { filename: 'js/pitch.js' });
}
const { Pitch } = context;

const SR = 12000;

function tone(freq, seconds, amp = 0.5) {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    // add a couple of harmonics so it resembles a hummed vowel, not a pure sine
    const t = i / SR;
    out[i] = amp * (Math.sin(2 * Math.PI * freq * t) +
                    0.4 * Math.sin(2 * Math.PI * freq * 2 * t) +
                    0.2 * Math.sin(2 * Math.PI * freq * 3 * t));
  }
  return out;
}

function silence(seconds) {
  return new Float32Array(Math.floor(seconds * SR));
}

function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- single-frame detection --------------------------------------------------

const a3 = tone(220, 0.2);
const r = Pitch.yin(a3.subarray(0, 1024), SR);
assert.ok(Math.abs(r.freq - 220) < 2, `220 Hz detected as ${r.freq.toFixed(1)}`);
assert.ok(r.clarity > 0.8, `clarity high for a clean tone (${r.clarity.toFixed(2)})`);

// silence and noise are rejected
assert.equal(Pitch.yin(silence(0.2).subarray(0, 1024), SR).freq, 0);
let seed = 1234;
const noise = new Float32Array(1024).map(() => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x40000000) - 1;
});
const nr = Pitch.yin(noise, SR);
assert.ok(nr.clarity < 0.6, `noise clarity stays low (${nr.clarity.toFixed(2)})`);

// freqToMidi: A4 = 69, A3 = 57
assert.equal(Math.round(Pitch.freqToMidi(440)), 69);
assert.equal(Math.round(Pitch.freqToMidi(220)), 57);

// ---- tracking + segmentation ---------------------------------------------------

// three "hummed" notes with breaths between: A3, C#4, E4
const melody = concat([
  silence(0.10),
  tone(220.0, 0.45), silence(0.08),
  tone(277.2, 0.45), silence(0.08),
  tone(329.6, 0.45), silence(0.10)
]);
const frames = Pitch.track(melody, SR, { hop: 256, size: 1024 });
const hopTime = 256 / SR;
const events = Pitch.segment(frames, hopTime);

assert.equal(events.length, 3, `three notes segmented (got ${events.length})`);
assert.deepEqual(Array.from(events, e => e.midi), [57, 61, 64], 'A3 C#4 E4');
// starts roughly at 0.10s, 0.63s, 1.16s
assert.ok(Math.abs(events[0].start - 0.10) < 0.08, `first onset ~0.10s (${events[0].start.toFixed(2)})`);
assert.ok(Math.abs(events[1].start - 0.63) < 0.10, `second onset ~0.63s (${events[1].start.toFixed(2)})`);
assert.ok(events.every(e => e.dur > 0.3), 'durations near the sung length');

// a glide between two held pitches splits into two notes
const glide = concat([tone(220, 0.4), tone(261.6, 0.4)]);
const gEvents = Pitch.segment(Pitch.track(glide, SR, { hop: 256, size: 1024 }), hopTime);
assert.equal(gEvents.length, 2, 'pitch step splits into two events');
assert.deepEqual(Array.from(gEvents, e => e.midi), [57, 60]);

// pure noise produces no events
const noiseBuf = new Float32Array(SR).map(() => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return ((seed / 0x40000000) - 1) * 0.5;
});
assert.equal(Pitch.segment(Pitch.track(noiseBuf, SR), hopTime).length, 0, 'noise yields nothing');

// downsample keeps pitch intact
const hi = new Float32Array(48000);
for (let i = 0; i < hi.length; i++) hi[i] = Math.sin(2 * Math.PI * 220 * i / 48000) * 0.5;
const ds = Pitch.downsample(hi, 4);
const dr = Pitch.yin(ds.subarray(2048, 2048 + 1024), 12000);
assert.ok(Math.abs(dr.freq - 220) < 2, `pitch survives downsampling (${dr.freq.toFixed(1)})`);

console.log('Pitch tests passed');
