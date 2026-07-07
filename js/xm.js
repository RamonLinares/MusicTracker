/* xm.js — FastTracker II .XM loader. Converts an XM module into the internal
 * song model (load-only; saving always writes ProTracker format).
 *
 * Notes on the conversion:
 * - XM is little-endian and note-based (1 = C-0 .. 96 = B-7, 97 = key off).
 *   Notes map to the 3-octave MOD range via +relativeNote−36 with octave folding.
 * - Instruments can hold several keymapped samples; the one FT2 would use for
 *   C-4 is taken. Only the first 31 instruments fit the internal model.
 * - Sample data is delta-encoded; 16-bit is converted to 8-bit, ping-pong
 *   loops are unfolded into forward loops.
 * - The volume column is folded into the effect column when it is free.
 * - Patterns may have 1..256 rows; longer than 64 are split into chained
 *   patterns (a Dxx inside a split pattern will land one segment early —
 *   rare in practice, as most XMs use 64-row patterns).
 * - Dropped (no equivalent): envelopes, fadeout, auto-vibrato, panning,
 *   global volume (G/H), tremor (T), envelope position (L), channels past 8.
 */
'use strict';

const XM = (() => {

  function readStr(b, off, len) {
    let r = '';
    for (let i = 0; i < len; i++) {
      const c = b[off + i];
      if (!c) break;
      r += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
    }
    return r.replace(/\s+$/, '');
  }

  /* map an XM effect (+param) to a ProTracker effect; [0,0] = drop */
  function convertFx(fx, pm) {
    if (fx <= 0xF) {
      if (fx === 0xE) {
        const x = pm >> 4;
        // E-subcommands are PT-compatible except E8 (retrig in XM ≠ PT panning: drop both)
        return x === 8 ? [0, 0] : [0xE, pm];
      }
      return [fx, pm];
    }
    switch (fx) {
      case 20: return [0xE, 0xC0 | Math.min(15, pm)];        // Kxx key off -> note cut
      case 27: return pm & 15 ? [0xE, 0x90 | (pm & 15)] : [0, 0]; // Rxy multi retrig
      case 33:                                               // X1y/X2y extra fine porta
        if ((pm >> 4) === 1) return [0xE, 0x10 | (pm & 15)];
        if ((pm >> 4) === 2) return [0xE, 0x20 | (pm & 15)];
        return [0, 0];
      default: return [0, 0];                                // G,H,L,P,T,... no equivalent
    }
  }

  /* fold the XM volume column into a PT effect; used only when fx column is free */
  function volColumnFx(v) {
    if (v >= 0x10 && v <= 0x50) return [0xC, v - 0x10];         // set volume
    if (v >= 0x60 && v <= 0x6F) return [0xA, v & 15];           // slide down
    if (v >= 0x70 && v <= 0x7F) return [0xA, (v & 15) << 4];    // slide up
    if (v >= 0x80 && v <= 0x8F) return [0xE, 0xB0 | (v & 15)];  // fine slide down
    if (v >= 0x90 && v <= 0x9F) return [0xE, 0xA0 | (v & 15)];  // fine slide up
    if (v >= 0xA0 && v <= 0xAF) return [0x4, (v & 15) << 4];    // vibrato speed
    if (v >= 0xB0 && v <= 0xBF) return [0x4, v & 15];           // vibrato depth
    if (v >= 0xF0 && v <= 0xFF) return [0x3, (v & 15) << 4];    // tone portamento
    return [0, 0];                                              // panning etc.
  }

  function parse(buf) {
    const b = new Uint8Array(buf);
    const dv = new DataView(buf);
    if (b.length < 336 || readStr(b, 0, 17) !== 'Extended Module:') {
      throw new Error('Not a FastTracker II module');
    }
    const u16 = o => (o + 2 <= b.length) ? dv.getUint16(o, true) : 0;
    const u32 = o => (o + 4 <= b.length) ? dv.getUint32(o, true) : 0;
    const i8 = o => (o < b.length) ? dv.getInt8(o) : 0;

    const version = u16(58);
    const headerSize = u32(60);
    const songLen = Math.max(1, Math.min(256, u16(64)));
    const numChannels = u16(68);
    const numPatterns = Math.min(256, u16(70));
    const numInstruments = Math.min(128, u16(72));
    const defSpeed = Math.max(1, Math.min(31, u16(76) || 6));
    const defBPM = Math.max(32, Math.min(255, u16(78) || 125));
    if (numChannels < 1 || numChannels > 32) throw new Error('Corrupt XM: bad channel count');

    const channels = Math.max(4, Math.min(8, numChannels));
    const droppedChannels = Math.max(0, numChannels - 8);
    const orderTable = [];
    for (let i = 0; i < songLen; i++) orderTable.push(b[80 + i]);

    // ---- patterns (packed) -------------------------------------------------

    let off = 60 + headerSize;
    const rawPatterns = []; // { rows, cells: [note, ins, vol, fx, pm] per (row*numChannels+ch) }
    for (let p = 0; p < numPatterns; p++) {
      const phLen = u32(off);
      const rows = Math.max(1, Math.min(256, u16(off + 5)));
      const packedSize = u16(off + 7);
      let d = off + phLen;
      const end = d + packedSize;
      const cells = new Uint8Array(rows * numChannels * 5);
      if (packedSize > 0) {
        let idx = 0;
        const total = rows * numChannels;
        while (idx < total && d < end) {
          const o = idx * 5;
          const first = b[d++];
          if (first & 0x80) {
            if (first & 1) cells[o] = b[d++];
            if (first & 2) cells[o + 1] = b[d++];
            if (first & 4) cells[o + 2] = b[d++];
            if (first & 8) cells[o + 3] = b[d++];
            if (first & 16) cells[o + 4] = b[d++];
          } else {
            cells[o] = first;
            cells[o + 1] = b[d++];
            cells[o + 2] = b[d++];
            cells[o + 3] = b[d++];
            cells[o + 4] = b[d++];
          }
          idx++;
        }
      }
      rawPatterns.push({ rows, cells });
      off += phLen + packedSize;
    }

    // ---- instruments -------------------------------------------------------

    const song = MOD.newSong(channels);
    song.title = readStr(b, 17, 20);
    song.initSpeed = defSpeed;
    song.initBPM = defBPM;

    const relNotes = new Array(32).fill(0); // per converted instrument, for note mapping
    let droppedInstruments = Math.max(0, numInstruments - 31);
    let count16bit = 0;

    for (let ins = 0; ins < numInstruments && off + 29 <= b.length; ins++) {
      const insSize = u32(off) || 29;
      const name = readStr(b, off + 4, 22);
      const numSamples = u16(off + 27);
      const store = ins < 31 ? song.samples[ins] : null;
      if (store) store.name = name;

      if (numSamples === 0) {
        off += insSize;
        continue;
      }

      // sample headers follow the instrument header (40 bytes each), then data
      const keymap = b.slice(off + 33, off + 33 + 96);
      let sh = off + insSize;
      const headers = [];
      for (let sm = 0; sm < numSamples && sh + 40 <= b.length; sm++) {
        headers.push({
          length: u32(sh), loopStart: u32(sh + 4), loopLen: u32(sh + 8),
          volume: Math.min(64, b[sh + 12]), finetune: i8(sh + 13),
          type: b[sh + 14], relNote: i8(sh + 16)
        });
        sh += 40;
      }
      // pick the sample FT2 would play for C-4 (note 49)
      const pick = Math.min(numSamples - 1, keymap[48] || 0);

      if (store && headers[pick]) {
        const h = headers[pick];
        // sample data blocks are stored in header order; find our sample's start
        let dataOff = sh;
        for (let sm = 0; sm < pick; sm++) dataOff += headers[sm].length;
        const is16 = !!(h.type & 0x10);
        if (is16) count16bit++;

        // delta-decode (8-bit bytes / 16-bit words), 16-bit reduced to 8
        const n = is16 ? h.length >> 1 : h.length;
        const avail = Math.max(0, Math.min(n, is16 ? (b.length - dataOff) >> 1 : b.length - dataOff));
        let data = new Int8Array(avail);
        if (is16) {
          let cur = 0;
          for (let i = 0; i < avail; i++) {
            cur = (cur + dv.getInt16(dataOff + i * 2, true)) << 16 >> 16;
            data[i] = cur >> 8;
          }
        } else {
          let cur = 0;
          for (let i = 0; i < avail; i++) {
            cur = (cur + i8(dataOff + i)) << 24 >> 24;
            data[i] = cur;
          }
        }

        let loopStart = is16 ? h.loopStart >> 1 : h.loopStart;
        let loopLen = (h.type & 3) ? (is16 ? h.loopLen >> 1 : h.loopLen) : 0;
        if (loopStart >= data.length) { loopStart = 0; loopLen = 0; }
        if (loopStart + loopLen > data.length) loopLen = Math.max(0, data.length - loopStart);

        if ((h.type & 3) === 2 && loopLen > 2) { // ping-pong: unfold into forward loop
          const end = loopStart + loopLen;
          const unfolded = new Int8Array(Math.min(131070, end + loopLen));
          unfolded.set(data.slice(0, end), 0);
          for (let i = 0; i < unfolded.length - end; i++) unfolded[end + i] = data[end - 1 - i];
          data = unfolded;
          loopLen = data.length - loopStart;
        }

        store.data = data.length > 131070 ? data.slice(0, 131070) : data;
        store.volume = h.volume;
        store.finetune = Math.max(-8, Math.min(7, Math.round(h.finetune / 16)));
        store.loopStart = Math.min(loopStart, store.data.length) & ~1;
        store.loopLen = loopLen > 2 ? Math.min(loopLen, store.data.length - store.loopStart) & ~1 : 0;
        relNotes[ins] = h.relNote;
      }

      let dataTotal = 0;
      for (const h of headers) dataTotal += h.length;
      off += insSize + numSamples * 40 + dataTotal;
    }

    // ---- convert patterns to 64-row internal patterns ----------------------

    song.patterns = [];
    const patMap = []; // xm pattern index -> [internal pattern indices]
    for (let p = 0; p < rawPatterns.length; p++) {
      const rp = rawPatterns[p];
      const segs = Math.max(1, Math.ceil(rp.rows / 64));
      const list = [];
      for (let sg = 0; sg < segs; sg++) {
        const pd = MOD.newPattern(channels);
        list.push(song.patterns.length);
        song.patterns.push(pd);
        const base = sg * 64;
        const segRows = Math.min(64, rp.rows - base);
        for (let r = 0; r < segRows; r++) {
          for (let ch = 0; ch < Math.min(numChannels, channels); ch++) {
            const src = ((base + r) * numChannels + ch) * 5;
            let note = rp.cells[src];
            let insNum = rp.cells[src + 1];
            const vol = rp.cells[src + 2];
            let [fx, pm] = convertFx(rp.cells[src + 3], rp.cells[src + 4]);

            if (insNum > 31) { insNum = 0; }
            if (note === 97) { // key off
              note = 0;
              if (!fx && !pm) { fx = 0xE; pm = 0xC0; }
            } else if (note) {
              let n = note + (insNum > 0 ? relNotes[insNum - 1] : 0) - 36;
              while (n > 36) n -= 12;
              while (n < 1) n += 12;
              note = n;
            }
            if (vol && !fx && !pm) [fx, pm] = volColumnFx(vol);

            const o = (r * channels + ch) * 4;
            pd[o] = note; pd[o + 1] = insNum; pd[o + 2] = fx; pd[o + 3] = pm;
          }
        }
        if (segRows < 64) { // short pattern: force a break on its last line
          const lr = Math.max(0, segRows - 1);
          for (let ch = 0; ch < channels; ch++) {
            const o = (lr * channels + ch) * 4;
            if (!pd[o + 2] && !pd[o + 3]) { pd[o + 2] = 0xD; pd[o + 3] = 0; break; }
          }
        }
      }
      patMap.push(list);
    }
    if (!song.patterns.length) song.patterns.push(MOD.newPattern(channels));

    song.order = [];
    for (const pat of orderTable) {
      if (pat < patMap.length && song.order.length < 128) song.order.push(...patMap[pat]);
    }
    song.order = song.order.slice(0, 128);
    if (!song.order.length) song.order = [0];

    song.xmInfo = `XM v${(version >> 8)}.${String(version & 255).padStart(2, '0')} · ` +
      `${numChannels}ch${droppedChannels ? ` (${droppedChannels} dropped)` : ''} · ` +
      `${numInstruments} instruments${droppedInstruments ? ` (${droppedInstruments} dropped)` : ''}` +
      (count16bit ? ` · ${count16bit}×16-bit→8` : '');
    return song;
  }

  return { parse };
})();
