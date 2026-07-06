/* mod.js — ProTracker/NoiseTracker MOD file format: parse, save, note tables, demo song.
 *
 * Song model:
 *   { title, channels, order:[patNums], patterns:[Uint8Array(64*channels*4)], samples:[31 x sample] }
 *   pattern cell at (row,ch): offset (row*channels+ch)*4 -> [noteIndex(0..36), sampleNum(0..31), fx(0..15), param]
 *   sample: { name, volume(0..64), finetune(-8..7), loopStart(bytes), loopLen(bytes, 0 = no loop), data:Int8Array }
 */
'use strict';

const MOD = (() => {

  // ProTracker period table, finetune 0, notes C-1 .. B-3
  const PERIODS = [
    856,808,762,720,678,640,604,570,538,508,480,453,
    428,404,381,360,339,320,302,285,269,254,240,226,
    214,202,190,180,170,160,151,143,135,127,120,113
  ];
  const NAMES = ['C-','C#','D-','D#','E-','F-','F#','G-','G#','A-','A#','B-'];

  function noteName(n) {
    if (!n) return '···';
    return NAMES[(n - 1) % 12] + (((n - 1) / 12 | 0) + 1);
  }

  function noteFromName(str) {
    const i = NAMES.indexOf(str.slice(0, 2));
    if (i < 0) return 0;
    return (parseInt(str[2], 10) - 1) * 12 + i + 1;
  }

  function periodToNote(p) {
    if (!p) return 0;
    let bi = 0, bd = 1e9;
    for (let i = 0; i < 36; i++) {
      const d = Math.abs(PERIODS[i] - p);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi + 1;
  }

  function emptySample() {
    return { name: '', volume: 64, finetune: 0, loopStart: 0, loopLen: 0, data: new Int8Array(0) };
  }

  function newPattern(channels) { return new Uint8Array(64 * channels * 4); }

  function newSong(channels) {
    channels = channels || 4;
    const s = { title: 'untitled', channels, order: [0], patterns: [newPattern(channels)], samples: [] };
    for (let i = 0; i < 31; i++) s.samples.push(emptySample());
    return s;
  }

  function cellGet(song, pat, row, ch) {
    const pd = song.patterns[pat];
    const o = (row * song.channels + ch) * 4;
    return [pd[o], pd[o + 1], pd[o + 2], pd[o + 3]];
  }

  function cellSet(song, pat, row, ch, note, smp, fx, pm) {
    const pd = song.patterns[pat];
    const o = (row * song.channels + ch) * 4;
    pd[o] = note; pd[o + 1] = smp; pd[o + 2] = fx; pd[o + 3] = pm;
  }

  function readStr(b, off, len) {
    let r = '';
    for (let i = 0; i < len; i++) {
      const c = b[off + i];
      if (c >= 32 && c < 127) r += String.fromCharCode(c);
      else r += ' ';
    }
    return r.replace(/\s+$/, '');
  }

  function parse(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 600) throw new Error('File too small to be a MOD');

    let channels = 0, nSamples = 31;
    let tag = '';
    if (b.length >= 1084) tag = String.fromCharCode(b[1080], b[1081], b[1082], b[1083]);

    if (['M.K.', 'M!K!', 'FLT4', '4CHN'].includes(tag)) channels = 4;
    else if (tag === '6CHN') channels = 6;
    else if (tag === '8CHN' || tag === 'CD81' || tag === 'OKTA') channels = 8;
    else if (/^[1-9][0-9]CH$/.test(tag)) channels = parseInt(tag, 10);
    else if (/^[1-9]CHN$/.test(tag)) channels = parseInt(tag, 10);
    else { channels = 4; nSamples = 15; } // original Ultimate SoundTracker, 15 samples, no tag

    const song = newSong(channels);
    song.title = readStr(b, 0, 20);

    let off = 20;
    const smpLens = [];
    for (let i = 0; i < nSamples; i++) {
      const s = song.samples[i];
      s.name = readStr(b, off, 22);
      const len = ((b[off + 22] << 8) | b[off + 23]) * 2;
      const ft = b[off + 24] & 15;
      s.finetune = ft < 8 ? ft : ft - 16;
      s.volume = Math.min(64, b[off + 25]);
      s.loopStart = ((b[off + 26] << 8) | b[off + 27]) * 2;
      const ll = ((b[off + 28] << 8) | b[off + 29]) * 2;
      s.loopLen = ll > 2 ? ll : 0;
      smpLens.push(len);
      off += 30;
    }

    let songLen = b[off]; off += 1;
    if (songLen < 1 || songLen > 128) songLen = Math.max(1, Math.min(128, songLen));
    off += 1; // restart byte (unused)
    const orderTable = b.slice(off, off + 128); off += 128;
    if (nSamples === 31) off += 4; // format tag

    let maxPat = 0;
    for (let i = 0; i < 128; i++) if (orderTable[i] < 128) maxPat = Math.max(maxPat, orderTable[i]);
    song.order = Array.from(orderTable.slice(0, songLen));

    const nPat = maxPat + 1;
    song.patterns = [];
    for (let p = 0; p < nPat; p++) {
      const pd = newPattern(channels);
      for (let r = 0; r < 64; r++) {
        for (let c = 0; c < channels; c++) {
          const i = off + (p * 64 * channels + r * channels + c) * 4;
          const b0 = b[i] || 0, b1 = b[i + 1] || 0, b2 = b[i + 2] || 0, b3 = b[i + 3] || 0;
          const period = ((b0 & 15) << 8) | b1;
          const o = (r * channels + c) * 4;
          pd[o] = periodToNote(period);
          pd[o + 1] = (b0 & 0xF0) | (b2 >> 4);
          pd[o + 2] = b2 & 15;
          pd[o + 3] = b3;
        }
      }
      song.patterns.push(pd);
    }
    off += nPat * 64 * channels * 4;

    for (let i = 0; i < nSamples; i++) {
      const s = song.samples[i];
      const len = Math.min(smpLens[i], Math.max(0, b.length - off));
      s.data = new Int8Array(buf.slice(off, off + len));
      if (s.loopStart >= s.data.length) { s.loopStart = 0; s.loopLen = 0; }
      if (s.loopLen && s.loopStart + s.loopLen > s.data.length) s.loopLen = s.data.length - s.loopStart;
      off += smpLens[i];
    }
    return song;
  }

  function writeStr(b, off, str, len) {
    for (let i = 0; i < len; i++) b[off + i] = i < str.length ? str.charCodeAt(i) & 0x7F : 0;
  }

  function save(song) {
    const ch = song.channels;
    const nPat = song.patterns.length;
    const smpBytes = song.samples.map(s => (s.data.length >> 1) * 2);
    const total = 20 + 31 * 30 + 2 + 128 + 4 + nPat * 64 * ch * 4 + smpBytes.reduce((a, v) => a + v, 0);
    const b = new Uint8Array(total);

    writeStr(b, 0, song.title, 20);
    let off = 20;
    for (let i = 0; i < 31; i++) {
      const s = song.samples[i];
      writeStr(b, off, s.name, 22);
      const words = smpBytes[i] >> 1;
      b[off + 22] = words >> 8; b[off + 23] = words & 255;
      b[off + 24] = s.finetune & 15;
      b[off + 25] = Math.min(64, s.volume);
      const ls = s.loopLen > 2 ? s.loopStart >> 1 : 0;
      const ll = s.loopLen > 2 ? s.loopLen >> 1 : 1;
      b[off + 26] = ls >> 8; b[off + 27] = ls & 255;
      b[off + 28] = ll >> 8; b[off + 29] = ll & 255;
      off += 30;
    }
    b[off++] = Math.min(128, song.order.length);
    b[off++] = 127; // restart (unused, ProTracker convention)
    for (let i = 0; i < 128; i++) b[off + i] = song.order[i] || 0;
    off += 128;
    const tag = ch === 4 ? 'M.K.' : (ch < 10 ? ch + 'CHN' : ch + 'CH');
    writeStr(b, off, tag, 4); off += 4;

    for (let p = 0; p < nPat; p++) {
      const pd = song.patterns[p];
      for (let r = 0; r < 64; r++) {
        for (let c = 0; c < ch; c++) {
          const o = (r * ch + c) * 4;
          const note = pd[o], smp = pd[o + 1], fx = pd[o + 2], pm = pd[o + 3];
          const period = note ? PERIODS[note - 1] : 0;
          b[off]     = (smp & 0xF0) | ((period >> 8) & 15);
          b[off + 1] = period & 255;
          b[off + 2] = ((smp & 15) << 4) | (fx & 15);
          b[off + 3] = pm;
          off += 4;
        }
      }
    }
    for (let i = 0; i < 31; i++) {
      b.set(new Uint8Array(song.samples[i].data.buffer, 0, smpBytes[i]), off);
      off += smpBytes[i];
    }
    return b;
  }

  // ---- built-in demo tune ------------------------------------------------

  function demoSong() {
    const song = newSong(4);
    song.title = 'web chiptune';

    const mk = (name, len, gen, loopStart, loopLen, vol) => {
      const d = new Int8Array(len);
      for (let i = 0; i < len; i++) d[i] = Math.max(-127, Math.min(127, Math.round(gen(i))));
      return { name, volume: vol, finetune: 0, loopStart: loopStart || 0, loopLen: loopLen || 0, data: d };
    };
    let seed = 0x1234;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x40000000) - 1; };

    song.samples[0] = mk('chip lead', 32, i => (i < 16 ? 85 : -85), 0, 32, 44);
    song.samples[1] = mk('deep bass', 64, i =>
      Math.sin(2 * Math.PI * i / 64) * 70 + ((i / 64) * 2 - 1) * 35, 0, 64, 58);
    let kf = 1300, kp = 0;
    song.samples[2] = mk('kick', 700, i => {
      kp += kf / 8287; kf = Math.max(45, kf * 0.994);
      return Math.sin(2 * Math.PI * kp) * 110 * Math.max(0, 1 - i / 700);
    }, 0, 0, 64);
    song.samples[3] = mk('hihat', 350, i => rnd() * 70 * Math.pow(1 - i / 350, 2), 0, 0, 40);
    song.samples[4] = mk('snare', 800, i =>
      (rnd() * 0.75 + Math.sin(2 * Math.PI * i * 185 / 8287) * 0.35) * 100 * Math.pow(1 - i / 800, 1.5), 0, 0, 56);
    song.samples[5] = mk('chip pad', 32, i => (i < 16 ? 60 : -60), 0, 32, 22);

    song.patterns = [newPattern(4), newPattern(4)];
    song.order = [0, 1];
    const N = noteFromName;
    const put = (p, row, ch, note, smp, fx, pm) => cellSet(song, p, row, ch, note, smp, fx || 0, pm || 0);

    for (const p of [0, 1]) {
      // ch0: drums — kick / hat / snare
      for (let bar = 0; bar < 4; bar++) {
        const b0 = bar * 16;
        put(p, b0, 0, N('C-2'), 3);
        put(p, b0 + 4, 0, N('C-3'), 4);
        put(p, b0 + 8, 0, N('C-2'), 5);
        put(p, b0 + 12, 0, N('C-3'), 4);
        put(p, b0 + 14, 0, N('C-3'), 4, 0xC, 0x18);
      }
      // ch1: bass — Am / F / C / G roots
      const roots = ['A-1', 'F-1', 'C-2', 'G-1'];
      const octUp = ['A-2', 'F-2', 'C-3', 'G-2'];
      for (let bar = 0; bar < 4; bar++) {
        const b0 = bar * 16;
        put(p, b0, 1, N(roots[bar]), 2);
        put(p, b0 + 4, 1, N(roots[bar]), 2);
        put(p, b0 + 8, 1, N(octUp[bar]), 2);
        put(p, b0 + 10, 1, N(roots[bar]), 2, 0xA, 0x02);
        put(p, b0 + 12, 1, N(roots[bar]), 2);
      }
      // ch3: chord stabs with arpeggio (Am, F, C, G)
      const arps = [0x37, 0x47, 0x47, 0x47];
      const chordRoot = ['A-2', 'F-2', 'C-3', 'G-2'];
      for (let bar = 0; bar < 4; bar++) {
        const b0 = bar * 16;
        for (const r of [2, 6, 10]) put(p, b0 + r, 3, N(chordRoot[bar]), 6, 0, arps[bar]);
      }
    }
    // ch2: lead melody, two variations
    const mel0 = [
      [0, 'A-2'], [4, 'C-3'], [6, 'E-3'], [8, 'D-3'], [12, 'C-3'], [14, 'E-3'],
      [16, 'F-2'], [20, 'A-2'], [22, 'C-3'], [24, 'A-2'], [28, 'G-2'], [30, 'A-2'],
      [32, 'C-3'], [36, 'E-3'], [38, 'G-3'], [40, 'E-3'], [44, 'D-3'], [46, 'C-3'],
      [48, 'B-2'], [52, 'D-3'], [54, 'G-3'], [56, 'D-3'], [60, 'B-2'], [62, 'D-3'],
    ];
    const mel1 = [
      [0, 'E-3'], [4, 'C-3'], [6, 'A-2'], [8, 'C-3'], [12, 'E-3'], [14, 'G-3'],
      [16, 'A-3'], [20, 'G-3'], [22, 'F-3'], [24, 'E-3'], [28, 'C-3'], [30, 'A-2'],
      [32, 'G-3'], [36, 'E-3'], [38, 'C-3'], [40, 'E-3'], [44, 'G-3'], [46, 'A-3'],
      [48, 'B-3'], [50, 'A-3'], [52, 'G-3'], [54, 'D-3'], [56, 'B-2'], [58, 'D-3'],
    ];
    for (const [r, n] of mel0) put(0, r, 2, N(n), 1);
    put(0, 10, 2, 0, 0, 4, 0x62); // vibrato on held note
    for (const [r, n] of mel1) put(1, r, 2, N(n), 1);
    put(1, 60, 2, N('E-3'), 1, 4, 0x84);
    // fill: snare roll at end of pattern 1
    put(1, 60, 0, N('C-2'), 5, 0xE, 0x93);
    put(1, 62, 0, N('D-2'), 5, 0xE, 0x93);

    return song;
  }

  return { PERIODS, noteName, noteFromName, periodToNote, parse, save,
           newSong, newPattern, emptySample, cellGet, cellSet, demoSong };
})();
