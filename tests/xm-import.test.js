'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = {};
vm.createContext(context);
for (const [name, expose] of [['mod.js', 'MOD'], ['xm.js', 'XM']]) {
  const code = fs.readFileSync(path.join(root, 'js', name), 'utf8');
  vm.runInContext(`${code}\nthis.${expose} = ${expose};`, context, { filename: `js/${name}` });
}
const { MOD, XM } = context;

function cell(song, pattern, row, channel) {
  return Array.from(MOD.cellGet(song, pattern, row, channel));
}

// ---- build a synthetic FastTracker II module ------------------------------

function buildXm() {
  const chunks = [];

  // module header
  const head = new Uint8Array(60 + 276);
  const hd = new DataView(head.buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) head[o + i] = s.charCodeAt(i); };
  ws(0, 'Extended Module: ');
  ws(17, 'xm test song');
  head[37] = 0x1A;
  ws(38, 'WebTracker test');
  hd.setUint16(58, 0x0104, true);   // version
  hd.setUint32(60, 276, true);      // header size (from offset 60)
  hd.setUint16(64, 2, true);        // song length
  hd.setUint16(66, 0, true);        // restart
  hd.setUint16(68, 4, true);        // channels
  hd.setUint16(70, 2, true);        // patterns
  hd.setUint16(72, 2, true);        // instruments
  hd.setUint16(74, 1, true);        // flags: linear
  hd.setUint16(76, 6, true);        // default speed
  hd.setUint16(78, 140, true);      // default BPM
  head[80] = 0; head[81] = 1;       // order table
  chunks.push(head);

  // pattern packer
  const packPattern = (rows, cells) => {
    const data = [];
    for (let idx = 0; idx < rows * 4; idx++) {
      const c = cells[idx];
      if (!c) { data.push(0x80); continue; }
      let flags = 0x80;
      const fields = [];
      if (c.note) { flags |= 1; fields.push(c.note); }
      if (c.ins) { flags |= 2; fields.push(c.ins); }
      if (c.vol) { flags |= 4; fields.push(c.vol); }
      if (c.fx) { flags |= 8; fields.push(c.fx); }
      if (c.pm) { flags |= 16; fields.push(c.pm); }
      data.push(flags, ...fields);
    }
    const out = new Uint8Array(9 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 9, true);          // pattern header length
    dv.setUint16(5, rows, true);       // rows
    dv.setUint16(7, data.length, true);
    out.set(data, 9);
    return out;
  };

  // pattern 0: 64 rows, one feature per row
  const p0 = {};
  p0[0 * 4 + 0] = { note: 49, ins: 1, vol: 0x40 };          // C-4 + volume column 48
  p0[1 * 4 + 1] = { note: 61, ins: 2, fx: 0xA, pm: 0x23 };  // C-5 ins2 (relNote +12)
  p0[2 * 4 + 2] = { note: 97 };                             // key off
  p0[4 * 4 + 0] = { fx: 27, pm: 0x23 };                     // Rxy multi retrig
  p0[5 * 4 + 0] = { fx: 33, pm: 0x15 };                     // X1y extra fine porta up
  chunks.push(packPattern(64, p0));

  // pattern 1: 80 rows (forces a 64+16 split), note at row 70
  const p1 = {};
  p1[70 * 4 + 0] = { note: 49, ins: 1 };
  chunks.push(packPattern(80, p1));

  // instrument builder
  const instrument = (name, sample) => {
    const ih = new Uint8Array(263);
    const dv = new DataView(ih.buffer);
    dv.setUint32(0, 263, true);
    for (let i = 0; i < name.length; i++) ih[4 + i] = name.charCodeAt(i);
    dv.setUint16(27, 1, true);         // one sample
    dv.setUint32(29, 40, true);        // sample header size
    const sh = new Uint8Array(40);
    const sd = new DataView(sh.buffer);
    sd.setUint32(0, sample.bytes.length, true);
    sd.setUint32(4, sample.loopStart || 0, true);
    sd.setUint32(8, sample.loopLen || 0, true);
    sh[12] = sample.volume;
    sd.setInt8(13, sample.finetune || 0);
    sh[14] = sample.type || 0;
    sd.setInt8(16, sample.relNote || 0);
    return [ih, sh, sample.bytes];
  };

  // 8-bit square, forward loop; delta-encode 32 bytes of ±100
  const sq = new Int8Array(32);
  let prev = 0;
  for (let i = 0; i < 32; i++) {
    const v = i < 16 ? 100 : -100;
    sq[i] = (v - prev) << 24 >> 24;
    prev = v;
  }
  chunks.push(...instrument('test square', {
    bytes: new Uint8Array(sq.buffer), volume: 48, finetune: 16, type: 1,
    loopStart: 0, loopLen: 32
  }));

  // 16-bit ping-pong, 8 words; delta-encoded words
  const words = [8000, 16000, 24000, 16000, 0, -16000, -24000, -8000];
  const w16 = new Uint8Array(16);
  const wd = new DataView(w16.buffer);
  let prev16 = 0;
  for (let i = 0; i < 8; i++) {
    wd.setInt16(i * 2, (words[i] - prev16) << 16 >> 16, true);
    prev16 = words[i];
  }
  chunks.push(...instrument('sixteen', {
    bytes: w16, volume: 64, type: 2 | 0x10, relNote: 12,
    loopStart: 0, loopLen: 16
  }));

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ---- assertions -----------------------------------------------------------

const xm = buildXm();
const song = XM.parse(xm.buffer);

assert.equal(song.title, 'xm test song');
assert.equal(song.channels, 4);
assert.equal(song.initSpeed, 6);
assert.equal(song.initBPM, 140);
assert.match(song.xmInfo, /XM v1\.04/);

// pattern 1 (80 rows) split into two -> three internal patterns, order expanded
assert.equal(song.patterns.length, 3);
assert.deepEqual(Array.from(song.order), [0, 1, 2]);

// C-4 -> internal note 13 (C-2), volume column 0x40 -> C30
assert.deepEqual(cell(song, 0, 0, 0), [13, 1, 0xC, 0x30]);
// C-5 with relNote +12 folds back into range: 61+12-36=37 -> 25 (C-3)
assert.deepEqual(cell(song, 0, 1, 1), [25, 2, 0xA, 0x23]);
// key off -> note cut
assert.deepEqual(cell(song, 0, 2, 2), [0, 0, 0xE, 0xC0]);
// Rxy multi retrig -> E9y, X1y -> E1y
assert.deepEqual(cell(song, 0, 4, 0), [0, 0, 0xE, 0x93]);
assert.deepEqual(cell(song, 0, 5, 0), [0, 0, 0xE, 0x15]);

// split pattern: row 70 lands in segment 2 at row 6; short segment gets a break
assert.deepEqual(cell(song, 2, 6, 0), [13, 1, 0, 0]);
assert.equal(cell(song, 2, 15, 0)[2], 0xD);

// 8-bit sample: delta decoded square, loop preserved, finetune 16/16 -> +1
const s0 = song.samples[0];
assert.equal(s0.name, 'test square');
assert.equal(s0.volume, 48);
assert.equal(s0.finetune, 1);
assert.equal(s0.data.length, 32);
assert.equal(s0.loopLen, 32);
assert.equal(s0.data[0], 100);
assert.equal(s0.data[20], -100);

// 16-bit ping-pong: reduced to 8-bit, unfolded to a 16-frame forward loop
const s1 = song.samples[1];
assert.equal(s1.name, 'sixteen');
assert.equal(s1.data.length, 16);
assert.equal(s1.loopLen, 16);
assert.equal(s1.data[0], 8000 >> 8);
assert.equal(s1.data[15], s1.data[0]); // mirrored tail

// converted song still saves as a valid MOD
const bytes = MOD.save(song);
const back = MOD.parse(bytes.buffer);
assert.equal(back.channels, 4);
assert.deepEqual(cell(back, 0, 0, 0), [13, 1, 0xC, 0x30]);

console.log('XM import tests passed');
