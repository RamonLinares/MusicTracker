/* assist.js — music-theory core for the Assist panel. Pure functions only:
 * scales, snapping, diatonic chords, key detection, bassline/melody
 * generators, and song analysis. Notes use the internal 1..36 index
 * (1 = C-1); pitch class of note n is (n-1) % 12 with 0 = C.
 */
'use strict';

const Assist = (() => {

  const SCALES = {
    major:      [0, 2, 4, 5, 7, 9, 11],
    minor:      [0, 2, 3, 5, 7, 8, 10],
    harmMinor:  [0, 2, 3, 5, 7, 8, 11],
    dorian:     [0, 2, 3, 5, 7, 9, 10],
    phrygian:   [0, 1, 3, 5, 7, 8, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    pentMajor:  [0, 2, 4, 7, 9],
    pentMinor:  [0, 3, 5, 7, 10],
    blues:      [0, 3, 5, 6, 7, 10]
  };

  const SCALE_LABELS = {
    major: 'major', minor: 'minor', harmMinor: 'harmonic minor',
    dorian: 'dorian', phrygian: 'phrygian', mixolydian: 'mixolydian',
    pentMajor: 'pentatonic maj', pentMinor: 'pentatonic min', blues: 'blues'
  };

  const CHORDS = {
    maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
    sus2: [0, 2, 7], sus4: [0, 5, 7],
    dom7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10]
  };

  const CHORD_LABELS = {
    maj: 'maj', min: 'min', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
    dom7: '7', maj7: 'maj7', min7: 'm7'
  };

  const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

  const pc = note => (note - 1) % 12;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function inScale(note, root, scale) {
    const iv = SCALES[scale];
    if (!iv) return true;
    return iv.includes((pc(note) - root + 12) % 12);
  }

  /* absolute pitch-class mask: mask[pc] = true when the pc is in the scale */
  function scaleMask(root, scale) {
    const iv = SCALES[scale];
    if (!iv) return null;
    const mask = new Array(12).fill(false);
    for (const s of iv) mask[(root + s) % 12] = true;
    return mask;
  }

  /* snap a note to the nearest scale tone (prefers moving down) */
  function snap(note, root, scale) {
    if (!SCALES[scale] || inScale(note, root, scale)) return note;
    for (const d of [-1, 1, -2, 2]) {
      const n = note + d;
      if (n >= 1 && n <= 36 && inScale(n, root, scale)) return n;
    }
    return note;
  }

  /* semitone offset of the n-th scale degree (degrees may exceed one octave) */
  function degreeToSemis(scale, degree) {
    const iv = SCALES[scale] || SCALES.minor;
    return iv[degree % iv.length] + 12 * Math.floor(degree / iv.length);
  }

  /* diatonic triads of a 7-note scale, as chords rooted on each degree */
  function diatonicTriads(root, scale) {
    const iv = SCALES[scale];
    if (!iv || iv.length !== 7) return [];
    const out = [];
    for (let d = 0; d < 7; d++) {
      const a = degreeToSemis(scale, d);
      const b = degreeToSemis(scale, d + 2) - a;
      const c = degreeToSemis(scale, d + 4) - a;
      const type = b === 4 && c === 7 ? 'maj'
        : b === 3 && c === 7 ? 'min'
        : b === 3 && c === 6 ? 'dim'
        : b === 4 && c === 8 ? 'aug' : null;
      const rootPc = (root + a) % 12;
      const roman = type === 'maj' || type === 'aug' ? ROMAN[d]
        : type === 'min' ? ROMAN[d].toLowerCase()
        : ROMAN[d].toLowerCase() + '°';
      out.push({ degree: d, roman, rootPc, type: type || 'min',
                 label: PC_NAMES[rootPc] + (type === 'maj' ? '' : type === 'min' ? 'm' : type === 'dim' ? '°' : '+') });
    }
    return out;
  }

  // ---- key detection (Krumhansl-style pitch-class profiles) -----------------

  const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function pitchHistogram(song) {
    // per-channel first, so percussion-like channels (1-2 pitch classes
    // hammered repeatedly) can be excluded from tonality judgments
    const nch = song.channels;
    const perCh = Array.from({ length: nch }, () => new Array(12).fill(0));
    const seen = new Set();
    for (const p of song.order) {
      if (seen.has(p) || !song.patterns[p]) continue;
      seen.add(p);
      const pd = song.patterns[p];
      for (let r = 0; r < 64; r++) {
        for (let c = 0; c < nch; c++) {
          const n = pd[(r * nch + c) * 4];
          if (n) perCh[c][pc(n)]++;
        }
      }
    }
    const melodic = perCh.filter(h => h.filter(v => v > 0).length > 2);
    const use = melodic.length ? melodic : perCh;
    const hist = new Array(12).fill(0);
    for (const h of use) for (let i = 0; i < 12; i++) hist[i] += h[i];
    return hist;
  }

  function detectKey(song) {
    const hist = pitchHistogram(song);
    const total = hist.reduce((a, v) => a + v, 0);
    if (!total) return null;
    let best = null, second = 0;
    for (let root = 0; root < 12; root++) {
      for (const [scale, profile] of [['major', PROFILE_MAJOR], ['minor', PROFILE_MINOR]]) {
        let score = 0;
        for (let i = 0; i < 12; i++) score += hist[(root + i) % 12] * profile[i];
        if (!best || score > best.score) { second = best ? best.score : 0; best = { root, scale, score }; }
        else if (score > second) second = score;
      }
    }
    best.confidence = second ? Math.min(1, (best.score - second) / best.score * 8) : 1;
    return best;
  }

  /* harmonize: move a note up by `degreesUp` scale degrees (2 = a third) */
  function harmonize(note, root, scale, degreesUp) {
    const iv = SCALES[scale] || SCALES.minor;
    const rel = (pc(note) - root + 12) % 12;
    let idx = iv.indexOf(rel);
    if (idx < 0) { // non-scale note: use the nearest degree below
      idx = 0;
      for (let i = 0; i < iv.length; i++) if (iv[i] <= rel) idx = i;
    }
    const delta = degreeToSemis(scale, idx + degreesUp) - iv[idx];
    let n = note + delta;
    while (n > 36) n -= 12;
    while (n < 1) n += 12;
    return n;
  }

  // ---- generators ------------------------------------------------------------

  const PROGRESSIONS = {
    'I–V–vi–IV':   [0, 4, 5, 3],
    'vi–IV–I–V':   [5, 3, 0, 4],
    'I–IV–V–IV':   [0, 3, 4, 3],
    'i–VI–III–VII': [0, 5, 2, 6],
    'i–iv–VI–V':   [0, 3, 5, 4],
    'i–VII–VI–VII': [0, 6, 5, 6]
  };

  function chordRootNote(root, scale, degree, octave) {
    return octave * 12 + ((root + degreeToSemis(scale, degree)) % 12) + 1;
  }

  /* 64 rows of bassline events: [{row, note, vol|null}] */
  function generateBass({ root, scale, progression, style, density, seed }) {
    const rnd = mulberry32(seed);
    const degs = PROGRESSIONS[progression] || PROGRESSIONS['i–VI–III–VII'];
    const events = [];
    const push = (row, note, vol) => { if (row < 64 && note >= 1 && note <= 36) events.push({ row, note, vol: vol || null }); };
    const fifth = n => (n + 7 <= 36 ? n + 7 : n - 5);
    const octUp = n => (n + 12 <= 36 ? n + 12 : n);

    // all scale tones over two low octaves, for walking lines
    const walkPool = [];
    for (let n = 1; n <= 24; n++) if (inScale(n, root, scale)) walkPool.push(n);
    const nearestIdx = n => {
      let bi = 0, bd = 99;
      walkPool.forEach((v, i) => { const d = Math.abs(v - n); if (d < bd) { bd = d; bi = i; } });
      return bi;
    };

    for (let bar = 0; bar < 4; bar++) {
      const b0 = bar * 16;
      const rn = chordRootNote(root, scale, degs[bar % degs.length], 0);
      const nxt = chordRootNote(root, scale, degs[(bar + 1) % degs.length], 0);
      switch (style) {
        case 'roots': {
          const rows = [[0, 8], [0, 4, 8, 12], [0, 4, 6, 8, 12], [0, 2, 4, 6, 8, 10, 12, 14]][density - 1];
          for (const r of rows) {
            const note = r % 8 === 0 ? rn : [rn, fifth(rn), octUp(rn)][Math.floor(rnd() * 3)];
            push(b0 + r, note, r % 4 ? 40 : null);
          }
          break;
        }
        case 'octaves': {
          const order = [0, 8, 4, 12, 2, 10, 6, 14];
          const take = order.slice(0, density * 2).sort((a, b) => a - b);
          take.forEach((r, i) => {
            const note = i % 2 ? (rnd() < 0.2 ? fifth(rn) : octUp(rn)) : rn;
            push(b0 + r, note, r % 4 ? 44 : null);
          });
          break;
        }
        case 'walking': {
          const from = nearestIdx(rn), to = nearestIdx(nxt);
          const step = to > from ? 1 : -1;
          const path = [walkPool[from]];
          let idx = from;
          for (let k = 1; k < 3; k++) {
            idx += (rnd() < 0.75 ? step : -step) * (rnd() < 0.2 ? 2 : 1);
            idx = Math.max(0, Math.min(walkPool.length - 1, idx));
            path.push(walkPool[idx]);
          }
          path.push(walkPool[Math.max(0, Math.min(walkPool.length - 1, to - step))]);
          path.forEach((n, i) => push(b0 + i * 4, n));
          break;
        }
        default: { // arp
          const seq = [rn, fifth(rn), octUp(rn), fifth(rn)];
          const rot = Math.floor(rnd() * 4);
          const order = [0, 8, 4, 12, 2, 10, 6, 14];
          const take = order.slice(0, density * 2).sort((a, b) => a - b);
          take.forEach((r, i) => push(b0 + r, i === 0 ? rn : seq[(i + rot) % 4], r % 4 ? 44 : null));
        }
      }
    }
    return events;
  }

  /* 64 rows of melody events following a contour, all in scale */
  function generateMelody({ root, scale, contour, density, seed }) {
    const rnd = mulberry32(seed);
    const pool = [];
    for (let n = 13; n <= 36; n++) if (inScale(n, root, scale)) pool.push(n);
    if (!pool.length) return [];
    const events = [];
    let prevIdx = pool.length >> 1;
    let repeats = 0;
    for (let row = 0; row < 64; row += 2) {
      const t = row / 62;
      let p = [0.35, 0.5, 0.65, 0.85][density - 1];
      if (row % 8 === 0) p += 0.25;
      if (row % 16 >= 14) p -= 0.35; // breathe at bar ends
      if (rnd() > p) continue;
      let idx;
      if (contour === 'walk') {
        idx = prevIdx + (rnd() < 0.5 ? -1 : 1) * (rnd() < 0.25 ? 2 : 1);
      } else {
        const target = contour === 'rise' ? t
          : contour === 'fall' ? 1 - t
          : contour === 'wave' ? 0.5 + 0.42 * Math.sin(t * Math.PI * 4)
          : Math.sin(t * Math.PI); // arch
        idx = Math.round(target * (pool.length - 1)) + Math.round((rnd() - 0.5) * 3);
      }
      idx = Math.max(0, Math.min(pool.length - 1, idx));
      if (idx === prevIdx) {
        repeats++;
        if (repeats > 1) { idx += rnd() < 0.5 ? -1 : 1; idx = Math.max(0, Math.min(pool.length - 1, idx)); repeats = 0; }
      } else repeats = 0;
      events.push({ row, note: pool[idx], vol: row % 4 ? 46 : null });
      prevIdx = idx;
    }
    return events;
  }

  // ---- analysis ---------------------------------------------------------------

  function chordForBar(hist) {
    const total = hist.reduce((a, v) => a + v, 0);
    if (!total) return null;
    let best = null;
    for (let root = 0; root < 12; root++) {
      for (const type of ['maj', 'min']) {
        const tones = CHORDS[type].map(s => (root + s) % 12);
        let score = hist[root] * 0.5;
        for (let i = 0; i < 12; i++) {
          score += tones.includes(i) ? hist[i] : -0.6 * hist[i];
        }
        if (!best || score > best.score) best = { root, type, score };
      }
    }
    return PC_NAMES[best.root] + (best.type === 'min' ? 'm' : '');
  }

  /* full song + current pattern analysis: key, chords, channel roles,
   * echo relationships, and improvement tips */
  function analyze(song, patternIndex) {
    const key = detectKey(song);
    const nch = song.channels;
    const pd = song.patterns[patternIndex];

    // chords per 16-row bar of the current pattern
    const chords = [];
    if (pd) {
      for (let bar = 0; bar < 4; bar++) {
        const hist = new Array(12).fill(0);
        for (let r = bar * 16; r < bar * 16 + 16; r++) {
          for (let c = 0; c < nch; c++) {
            const n = pd[(r * nch + c) * 4];
            if (n) hist[pc(n)]++;
          }
        }
        chords.push(chordForBar(hist) || '—');
      }
    }

    // channel stats over the whole song
    const channels = [];
    const seen = new Set();
    const used = song.order.filter(p => { const f = !seen.has(p); seen.add(p); return f; });
    for (let c = 0; c < nch; c++) {
      const notes = [], smps = new Set();
      for (const p of used) {
        const d = song.patterns[p];
        if (!d) continue;
        for (let r = 0; r < 64; r++) {
          const o = (r * nch + c) * 4;
          if (d[o]) { notes.push(d[o]); if (d[o + 1]) smps.add(d[o + 1]); }
        }
      }
      const variety = new Set(notes).size;
      const avg = notes.length ? notes.reduce((a, v) => a + v, 0) / notes.length : 0;
      const density = notes.length / Math.max(1, used.length * 64);
      const role = !notes.length ? 'empty'
        : variety <= 2 && notes.length >= 8 ? 'percussion'
        : avg <= 12 ? 'bass'
        : variety >= 8 ? 'lead'
        : 'accompaniment';
      channels.push({ notes: notes.length, variety, avgNote: avg, density, samples: [...smps], role });
    }

    // echo detection within the current pattern
    const echoes = [];
    if (pd) {
      for (let a = 0; a < nch; a++) {
        for (let b = 0; b < nch; b++) {
          if (a === b) continue;
          for (let d = 1; d <= 8; d++) {
            let match = 0, totalA = 0;
            for (let r = 0; r < 64 - d; r++) {
              const na = pd[(r * nch + a) * 4];
              if (!na) continue;
              totalA++;
              if (pd[((r + d) * nch + b) * 4] === na) match++;
            }
            if (totalA >= 6 && match / totalA >= 0.6) {
              echoes.push({ src: a, dst: b, delay: d, ratio: match / totalA });
              break;
            }
          }
        }
      }
    }

    // tips / nudges
    const tips = [];
    const emptyCh = channels.map((c, i) => c.role === 'empty' ? i + 1 : 0).filter(Boolean);
    if (emptyCh.length) tips.push(`Channel${emptyCh.length > 1 ? 's' : ''} ${emptyCh.join(', ')} ` +
      `${emptyCh.length > 1 ? 'are' : 'is'} unused — room for a harmony, echo, or percussion layer.`);

    const unusedSmp = song.samples
      .map((s, i) => s.data.length || s.synth ? i + 1 : 0)
      .filter(n => n && !channels.some(c => c.samples.includes(n)));
    if (unusedSmp.length) tips.push(`Sample${unusedSmp.length > 1 ? 's' : ''} ` +
      unusedSmp.map(n => n.toString(16).toUpperCase().padStart(2, '0')).join(', ') +
      ` ${unusedSmp.length > 1 ? 'are' : 'is'} loaded but never played.`);

    let hasVolume = false, hasVibrato = false, longNotes = 0;
    for (const p of used) {
      const d = song.patterns[p];
      if (!d) continue;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 2] === 0xC) hasVolume = true;
        if (d[i + 2] === 0x4 || d[i + 2] === 0x6) hasVibrato = true;
      }
    }
    if (!hasVolume && channels.some(c => c.notes > 0)) {
      tips.push('No volume commands anywhere — everything plays at full blast. ' +
        'Try Humanize, or C-commands for accents and ghost notes.');
    }
    const lead = channels.findIndex(c => c.role === 'lead');
    if (lead >= 0 && !hasVibrato) {
      tips.push(`Channel ${lead + 1} looks like the lead — held notes there would ` +
        'sing more with vibrato (effect 4xy, e.g. 462).');
    }

    let maxRun = 1, run = 1;
    for (let i = 1; i < song.order.length; i++) {
      run = song.order[i] === song.order[i - 1] ? run + 1 : 1;
      maxRun = Math.max(maxRun, run);
    }
    if (maxRun >= 3) tips.push(`The same pattern repeats ${maxRun}× in a row in the order list — ` +
      'consider a variation copy (change the last bar, drop a channel, or transpose).');

    if (key) {
      const hist = pitchHistogram(song);
      const mask = scaleMask(key.root, key.scale);
      const total = hist.reduce((a, v) => a + v, 0);
      let out = 0;
      for (let i = 0; i < 12; i++) if (!mask[i]) out += hist[i];
      if (total && out / total > 0.15) {
        tips.push(`About ${Math.round(out / total * 100)}% of notes fall outside ` +
          `${PC_NAMES[key.root]} ${SCALE_LABELS[key.scale]} — deliberate chromaticism, or worth a scale check?`);
      }
    }

    const percussion = channels.findIndex(c => c.role === 'percussion');
    const bass = channels.findIndex(c => c.role === 'bass');
    if (pd && percussion >= 0 && bass >= 0) {
      let both = 0, bassNotes = 0;
      for (let r = 0; r < 64; r++) {
        const bn = pd[(r * nch + bass) * 4];
        if (!bn) continue;
        bassNotes++;
        if (pd[(r * nch + percussion) * 4]) both++;
      }
      if (bassNotes >= 8 && both / bassNotes > 0.85) {
        tips.push(`Bass (ch ${bass + 1}) and percussion (ch ${percussion + 1}) hit the same rows almost ` +
          'every time — offsetting some bass notes by 1–2 rows adds groove.');
      }
    }

    return { key, chords, channels, echoes, tips };
  }

  return {
    SCALES, SCALE_LABELS, CHORDS, CHORD_LABELS, PC_NAMES, PROGRESSIONS,
    pc, inScale, scaleMask, snap, harmonize, diatonicTriads,
    detectKey, generateBass, generateMelody, analyze, mulberry32
  };
})();
