/* med.js — OctaMED MMD0/MMD1 loader. Converts a MED module into the internal
 * song model (load-only; saving always writes ProTracker format).
 *
 * Notes on the conversion:
 * - MED blocks can have any number of lines; blocks longer than 64 lines are
 *   split into consecutive patterns, shorter ones get a D00 pattern break.
 * - play/sample transpose is baked into the note values.
 * - MED commands are mapped to their ProTracker equivalents where one exists
 *   (9 = secondary tempo -> Fxx speed, 0D -> A, 1x two-digit commands -> E-cmds).
 * - Synth/hybrid instruments have no PCM data and are imported empty.
 */
'use strict';

const MED = (() => {

  function readStr(b, off, len) {
    let r = '';
    for (let i = 0; i < len; i++) {
      const c = b[off + i];
      if (!c) break;
      r += c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
    }
    return r.replace(/\s+$/, '');
  }

  // MED tempo (non-BPM mode) to MOD BPM. Real MED songs almost always use
  // deftempo 33 == SoundTracker 125 BPM; scale linearly from there.
  function tempoToBpm(t) {
    if (t <= 0) return 125;
    if (t <= 10) return 125; // legacy "tempo 1-10" timer values, approximate
    return Math.round(t * 125 / 33);
  }

  function convertCmd(cmd, dat, opts) {
    switch (cmd) {
      case 0x0: case 0x1: case 0x2: case 0x3: case 0x4:
      case 0x5: case 0x6: case 0x7: case 0xB:
        return [cmd, dat];
      case 0xC: {
        let v = dat;
        if (!opts.volHex) v = (dat >> 4) * 10 + (dat & 15); // decimal volume mode
        return [0xC, Math.min(64, v)];
      }
      case 0x8: return [0, 0];                       // hold/decay — n/a
      case 0x9:                                       // secondary tempo = ticks/line
        return dat >= 1 && dat < 32 ? [0xF, dat] : [0, 0];
      case 0xA: case 0xD: return [0xA, dat];          // volume slide
      case 0xE: return [0, 0];                        // synth jump — n/a
      case 0xF:
        if (dat === 0) return [0xD, 0];               // F00 = pattern break
        if (dat <= 0xF0) {                            // set tempo
          const v = opts.bpmMode ? dat : tempoToBpm(dat);
          return [0xF, Math.max(32, Math.min(255, v))];
        }
        switch (dat) {
          case 0xF1: return [0xE, 0x93];              // play note twice
          case 0xF2: return [0xE, 0xD3];              // delay 1/2 line
          case 0xF3: return [0xE, 0x92];              // play note three times
          case 0xFF: return [0xE, 0xC0];              // note off
          default: return [0, 0];
        }
      // MMD1 two-digit commands (11-1F)
      case 0x11: return [0xE, 0x10 | Math.min(15, dat)]; // fine slide up
      case 0x12: return [0xE, 0x20 | Math.min(15, dat)]; // fine slide down
      case 0x14: return [0x4, dat];                      // deeper vibrato
      case 0x15: return [0xE, 0x50 | (dat & 15)];        // set finetune
      case 0x16: return [0xE, 0x60 | Math.min(15, dat)]; // pattern loop
      case 0x18: return [0xE, 0xC0 | Math.min(15, dat)]; // cut note
      case 0x19: return [0x9, dat];                      // sample offset
      case 0x1A: return [0xE, 0xA0 | Math.min(15, dat)]; // fine vol up
      case 0x1B: return [0xE, 0xB0 | Math.min(15, dat)]; // fine vol down
      case 0x1D: return [0xD, dat];                      // jump to line of next block
      case 0x1E: return [0xE, 0xE0 | Math.min(15, dat)]; // pattern delay
      case 0x1F: {                                       // delay + retrigger
        const d = dat >> 4, r = dat & 15;
        if (r) return [0xE, 0x90 | r];
        if (d) return [0xE, 0xD0 | d];
        return [0, 0];
      }
      default: return [0, 0];
    }
  }

  /* MED SynthInstr: header at instrument pointer p —
   *   p+0 ULONG len · p+4 WORD type (-1 synth, -2 hybrid) · p+6 decay · p+10/12 rep/replen
   *   p+14/16 voltbllen/wftbllen · p+18/19 volspeed/wfspeed · p+20 wforms
   *   p+22 voltbl[128] · p+150 wftbl[128] · p+278 ULONG wf[wforms]
   * Waveform pointers are usually relative to p (the struct is self-contained),
   * some writers store absolute file offsets — accept either.
   */
  function parseSynth(s, p, hybrid, io) {
    const { b, dv, u32, u16 } = io;
    if (p + 278 > b.length) return false;
    const voltbllen = Math.min(128, u16(p + 14));
    const wftbllen = Math.min(128, u16(p + 16));
    const volspeed = Math.max(1, b[p + 18]);
    const wfspeed = Math.max(1, b[p + 19]);
    const wforms = Math.min(64, u16(p + 20));
    if (!wforms) return false;

    const validWf = q => q > 0 && q + 2 <= b.length && u16(q) > 0 &&
                         u16(q) <= 32768 && q + 2 + u16(q) * 2 <= b.length;
    const validHdr = q => q > 0 && q + 6 <= b.length && u32(q) > 0 &&
                          q + 6 + Math.min(u32(q), 4) <= b.length;

    const waveforms = [];
    for (let w = 0; w < wforms; w++) {
      const raw = u32(p + 278 + w * 4);
      const isSample = hybrid && w === 0;
      const ok = isSample ? validHdr : validWf;
      let q = p + raw;                    // relative to struct (normal case)
      if (!ok(q)) q = raw;                // absolute fallback
      if (!ok(q)) { waveforms.push(new Int8Array(0)); continue; }
      if (isSample) {
        const slen = Math.min(u32(q), b.length - q - 6);
        const d = new Int8Array(slen);
        for (let k = 0; k < slen; k++) d[k] = dv.getInt8(q + 6 + k);
        waveforms.push(d);
      } else {
        const wl = u16(q) * 2;
        const d = new Int8Array(wl);
        for (let k = 0; k < wl; k++) d[k] = dv.getInt8(q + 2 + k);
        waveforms.push(d);
      }
    }
    if (!waveforms.some(w => w.length)) return false;

    s.synth = {
      hybrid,
      volspeed, wfspeed,
      voltbl: b.slice(p + 22, p + 22 + voltbllen),
      wftbl: b.slice(p + 150, p + 150 + wftbllen),
      waveforms
    };
    if (hybrid) s.data = waveforms[0];
    return true;
  }

  function parse(buf) {
    const b = new Uint8Array(buf);
    const dv = new DataView(buf);
    const u32 = o => (o >= 0 && o + 4 <= b.length) ? dv.getUint32(o) : 0;
    const u16 = o => (o >= 0 && o + 2 <= b.length) ? dv.getUint16(o) : 0;
    const i8 = o => (o >= 0 && o < b.length) ? dv.getInt8(o) : 0;

    const id = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (id !== 'MMD0' && id !== 'MMD1') {
      throw new Error(id.startsWith('MMD')
        ? `OctaMED ${id} is not supported (only MMD0/MMD1)`
        : 'Not an OctaMED module');
    }
    const v1 = id === 'MMD1';
    const songOff = u32(8);
    const blockarr = u32(16);
    const smplarr = u32(24);
    const expdata = u32(32);
    if (!songOff || songOff + 788 > b.length) throw new Error('Corrupt MMD: bad song offset');

    const numblocks = u16(songOff + 504);
    if (!numblocks || numblocks > 999) throw new Error('Corrupt MMD: implausible block count');
    const songlen = Math.max(1, Math.min(256, u16(songOff + 506)));
    const deftempo = u16(songOff + 764);
    const playtransp = i8(songOff + 766);
    const flags = b[songOff + 767];
    const flags2 = b[songOff + 768];
    const tempo2 = b[songOff + 769] || 6;
    const numsamples = Math.min(63, b[songOff + 787]);

    const bpmMode = !!(flags2 & 0x20);
    const volHex = !!(flags & 0x10);
    const opts = { bpmMode, volHex };
    const speed = Math.min(31, Math.max(1, tempo2));
    let bpm;
    if (bpmMode) {
      const rowsPerBeat = (flags2 & 0x1F) + 1;
      bpm = Math.round(deftempo * rowsPerBeat / 4);
    } else {
      bpm = tempoToBpm(deftempo);
    }
    bpm = Math.max(32, Math.min(255, bpm || 125));

    // per-sample header info (loop, volume, transpose)
    const sinfo = [];
    for (let i = 0; i < 63; i++) {
      const o = songOff + i * 8;
      sinfo.push({
        rep: u16(o) * 2, replen: u16(o + 2) * 2,
        svol: Math.min(64, b[o + 6]), strans: i8(o + 7)
      });
    }

    // expansion data: instrument names, finetune, song name
    const names = new Array(63).fill('');
    const fines = new Array(63).fill(0);
    let songname = '';
    if (expdata && expdata + 52 <= b.length) {
      const iinfo = u32(expdata + 20);
      const iEntries = u16(expdata + 24);
      const iSize = u16(expdata + 26);
      if (iinfo && iSize) {
        for (let i = 0; i < Math.min(63, iEntries); i++) {
          names[i] = readStr(b, iinfo + i * iSize, Math.min(iSize, 40));
        }
      }
      const expSmp = u32(expdata + 4);
      const sEntries = u16(expdata + 8);
      const sSize = u16(expdata + 10);
      if (expSmp && sSize >= 4) {
        for (let i = 0; i < Math.min(63, sEntries); i++) {
          fines[i] = i8(expSmp + i * sSize + 3);
        }
      }
      const snOff = u32(expdata + 44);
      const snLen = u32(expdata + 48);
      if (snOff && snLen) songname = readStr(b, snOff, Math.min(64, snLen));
    }

    // instruments (only the first 31 fit the internal/MOD model)
    const samples = [];
    for (let i = 0; i < 31; i++) samples.push(MOD.emptySample());
    let skippedSynth = 0, synthCount = 0;
    for (let i = 0; i < Math.min(31, numsamples); i++) {
      const s = samples[i];
      s.name = names[i] || '';
      s.volume = sinfo[i].svol;
      s.finetune = Math.max(-8, Math.min(7, fines[i]));
      const p = u32(smplarr + i * 4);
      if (!p || p + 6 > b.length) continue;
      const len = u32(p);
      const type = (o => o >= 0 && o + 2 <= b.length ? dv.getInt16(o) : 0)(p + 4);
      if (type < 0) { // synthetic (-1) or hybrid (-2) instrument
        if (parseSynth(s, p, type === -2, { b, dv, u32, u16 })) {
          synthCount++;
          if (sinfo[i].replen > 2 && s.data.length) { // hybrid loop from song header
            s.loopStart = Math.min(sinfo[i].rep, s.data.length);
            s.loopLen = Math.min(sinfo[i].replen, s.data.length - s.loopStart);
          }
        } else {
          s.name = (s.name || 'instr ' + (i + 1)) + ' [synth?]';
          skippedSynth++;
        }
        continue;
      }
      const is16 = !!(type & 0x10);
      const isStereo = !!(type & 0x20);
      const avail = Math.max(0, Math.min(len, b.length - p - 6));
      if (is16) {
        const n = avail >> 1;
        const d = new Int8Array(n);
        for (let k = 0; k < n; k++) d[k] = i8(p + 6 + k * 2); // high byte of BE 16-bit
        s.data = d;
      } else {
        s.data = new Int8Array(buf.slice(p + 6, p + 6 + avail));
      }
      if (isStereo) s.data = s.data.slice(0, s.data.length >> 1);
      if ((type & 0xF) !== 0 && s.name) s.name += ' [multi-oct]';
      if (sinfo[i].replen > 2 && sinfo[i].rep < s.data.length) {
        s.loopStart = sinfo[i].rep;
        s.loopLen = Math.min(sinfo[i].replen, s.data.length - s.loopStart);
      }
    }

    // blocks
    const blocks = [];
    let maxTracks = 4;
    for (let i = 0; i < numblocks; i++) {
      const p = u32(blockarr + i * 4);
      if (!p) { blocks.push(null); continue; }
      let blk;
      if (v1) blk = { tracks: u16(p), lines: u16(p + 2) + 1, dataOff: p + 8, stride: 4 };
      else blk = { tracks: b[p], lines: b[p + 1] + 1, dataOff: p + 2, stride: 3 };
      // reject blocks whose header or data lie outside the file
      if (blk.tracks < 1 || blk.tracks > 64 || blk.lines > 3200 ||
          blk.dataOff + blk.lines * blk.tracks * blk.stride > b.length) {
        blocks.push(null);
        continue;
      }
      blocks.push(blk);
      maxTracks = Math.max(maxTracks, Math.min(8, blk.tracks));
    }
    const channels = maxTracks;

    const song = MOD.newSong(channels);
    song.title = (songname || '').slice(0, 20);
    song.samples = samples;
    song.patterns = [];
    song.initSpeed = speed;
    song.initBPM = bpm;

    const blockPats = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const blk = blocks[bi];
      if (!blk) { blockPats.push([]); continue; }
      const segs = Math.max(1, Math.ceil(blk.lines / 64));
      const list = [];
      for (let sg = 0; sg < segs; sg++) {
        const pd = MOD.newPattern(channels);
        list.push(song.patterns.length);
        song.patterns.push(pd);
        const base = sg * 64;
        const segLines = Math.min(64, blk.lines - base);
        for (let r = 0; r < segLines; r++) {
          for (let t = 0; t < Math.min(blk.tracks, channels); t++) {
            const no = blk.dataOff + ((base + r) * blk.tracks + t) * blk.stride;
            if (no + blk.stride > b.length) continue;
            let note, ins, cmd, dat;
            if (v1) {
              note = b[no] & 0x7F;
              ins = b[no + 1] & 0x3F;
              cmd = b[no + 2];
              dat = b[no + 3];
            } else {
              const b0 = b[no];
              note = b0 & 0x3F;
              ins = ((b0 & 0x80) >> 3) | ((b0 & 0x40) >> 1) | (b[no + 1] >> 4);
              cmd = b[no + 1] & 15;
              dat = b[no + 2];
            }
            if (ins > 31) ins = 0; // beyond the 31-sample model
            if (note) {
              let n = note + playtransp + (ins > 0 ? sinfo[ins - 1].strans : 0);
              while (n > 36) n -= 12;
              while (n < 1) n += 12;
              note = n;
            }
            const [fx, pm] = convertCmd(cmd, dat, opts);
            const o = (r * channels + t) * 4;
            pd[o] = note; pd[o + 1] = ins; pd[o + 2] = fx; pd[o + 3] = pm;
          }
        }
        if (segLines < 64) { // short block: force a pattern break on its last line
          const lr = Math.max(0, segLines - 1);
          for (let t = 0; t < channels; t++) {
            const o = (lr * channels + t) * 4;
            if (!pd[o + 2] && !pd[o + 3]) { pd[o + 2] = 0xD; pd[o + 3] = 0; break; }
          }
        }
      }
      blockPats.push(list);
    }
    if (!song.patterns.length) song.patterns.push(MOD.newPattern(channels));

    // play sequence -> order list (expanding split blocks)
    song.order = [];
    for (let i = 0; i < songlen && song.order.length < 128; i++) {
      const blk = b[songOff + 508 + i];
      if (blk < blockPats.length) song.order.push(...blockPats[blk]);
    }
    song.order = song.order.slice(0, 128);
    if (!song.order.length) song.order = [0];

    song.medInfo = `${id} · ${numblocks} blocks · ${numsamples} instruments` +
      (synthCount ? ` · ${synthCount} synth` : '') +
      (skippedSynth ? ` (${skippedSynth} synth skipped)` : '');
    return song;
  }

  return { parse };
})();
