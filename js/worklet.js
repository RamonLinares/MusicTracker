/* worklet.js — ProTracker replayer + Paula-style mixer, runs in the audio thread.
 *
 * Timing: one "tick" every (sampleRate * 2.5 / BPM) frames, `speed` ticks per row.
 * Channels resample 8-bit samples at PAULA_CLOCK / period Hz.
 * Panning follows the Amiga L-R-R-L layout with softened separation.
 *
 * Paula mode (message {type:'paula'}): nearest-neighbour sampling plus the
 * A500 output chain — a fixed ~4.9 kHz RC low-pass and the ~3.3 kHz "LED"
 * filter toggled by effect E0x. Modern mode uses linear interpolation, no filters.
 *
 * MED synthsounds: instruments may carry a `synth` program (volume table +
 * waveform table executed at tick rate, with SPD/WAI/JMP/HLT/CHU/CHD/ARP...).
 */
'use strict';

const PAULA = 3546895; // PAL clock / 2

const PERIODS = [
  856,808,762,720,678,640,604,570,538,508,480,453,
  428,404,381,360,339,320,302,285,269,254,240,226,
  214,202,190,180,170,160,151,143,135,127,120,113
];

function periodForNote(note, finetune) {
  if (note < 1) note = 1;
  if (note > 36) note = 36;
  return PERIODS[note - 1] * Math.pow(2, -(finetune || 0) / 96);
}

/* vibrato/tremolo waveforms (E4x/E7x): 0 sine, 1 ramp down, 2 square, 3 random */
function waveAmp(wave, pos) {
  const p = pos & 63;
  switch (wave & 3) {
    case 0: return Math.sin(p * Math.PI / 32) * 255;
    case 1: return 255 - p * 8;
    case 2: return p < 32 ? 255 : -255;
    default: return Math.random() * 510 - 255;
  }
}

class Ch {
  constructor() {
    this.sample = -1;      // sample index 0..30, -1 = none
    this.pos = 0;          // sample position (float)
    this.playing = false;
    this.note = 0;
    this.period = 0;
    this.target = 0;       // tone portamento target period
    this.finetune = 0;
    this.vol = 0;
    this.portaSpeed = 0;
    this.glissando = false;
    this.glissP = 0;       // semitone-snapped output period during glissando
    this.vibPos = 0; this.vibSpeed = 0; this.vibDepth = 0; this.vibDelta = 0; this.vibWave = 0;
    this.tremPos = 0; this.tremSpeed = 0; this.tremDepth = 0; this.tremDelta = 0; this.tremWave = 0;
    this.offsetMem = 0;
    this.loopRow = 0; this.loopCount = 0;
    this.curFx = -1; this.curPm = 0;
    this.delayed = null; this.delayTick = 0;
    this.arpPeriod = 0;
    this.sy = null;        // MED synthsound runtime state
  }
}

class ModPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.song = null;
    this.playing = false;
    this.patternMode = false;
    this.speed = 6;
    this.bpm = 125;
    this.tick = 0;
    this.row = 0;
    this.pos = 0;
    this.tickLen = sampleRate * 2.5 / 125;
    this.tickCounter = 0;
    this.channels = [];
    this.mute = [];
    this.breakFlag = false; this.breakRow = 0; this.jumpPos = -1; this.loopJumpRow = -1;
    this.rowDelay = 0;
    this.rowDelayActive = false;
    this.scopeLen = 512;
    this.scopeBufs = [];
    this.scopePos = 0;
    this.scopeTimer = 0;
    // Paula mode + Amiga output filters
    this.paula = false;
    this.led = false;
    this.aRC = 1 - Math.exp(-2 * Math.PI * 4900 / sampleRate);
    this.aLED = 1 - Math.exp(-2 * Math.PI * 3275 / sampleRate);
    this.rcL = 0; this.rcR = 0;
    this.l1L = 0; this.l2L = 0; this.l1R = 0; this.l2R = 0;
    this.port.onmessage = e => this.onmsg(e.data);
    // offline rendering: port messages can be starved until rendering ends,
    // so the whole setup may arrive synchronously via processorOptions instead
    const po = options && options.processorOptions;
    if (po && po.song) {
      this.setSong(po.song);
      if (po.mute) this.mute = po.mute;
      if (po.paula) this.paula = true;
      if (po.play) this.startPlay(po.play);
    }
  }

  onmsg(m) {
    switch (m.type) {
      case 'song': this.setSong(m.song); break;
      case 'pattern':
        if (this.song) {
          while (this.song.patterns.length <= m.index) this.song.patterns.push(new Uint8Array(64 * this.song.channels * 4));
          this.song.patterns[m.index] = m.data;
        }
        break;
      case 'order': if (this.song) this.song.order = m.order; break;
      case 'sample': if (this.song) this.song.samples[m.index] = m.sample; break;
      case 'play': this.startPlay(m); break;
      case 'stop': this.stopPlay(); break;
      case 'speed':
        if (m.speed) this.speed = m.speed;
        if (m.bpm) { this.bpm = m.bpm; this.tickLen = sampleRate * 2.5 / this.bpm; }
        break;
      case 'mute': this.mute = m.mute; break;
      case 'paula': this.paula = !!m.on; break;
      case 'jam': this.jam(m); break;
      case 'jamStop':
        if (!this.playing && this.channels[m.ch]) this.channels[m.ch].playing = false;
        break;
      case 'ping':
        this.port.postMessage({ type: 'pong', hasSong: !!this.song, playing: this.playing,
                                frames: this.framesDone | 0 });
        break;
    }
  }

  setSong(s) {
    this.song = s;
    this.playing = false;
    this.channels = [];
    this.scopeBufs = [];
    for (let i = 0; i < s.channels; i++) {
      this.channels.push(new Ch());
      this.scopeBufs.push(new Float32Array(this.scopeLen));
    }
  }

  startPlay(m) {
    if (!this.song) return;
    for (let i = 0; i < this.channels.length; i++) this.channels[i] = new Ch();
    this.patternMode = !!m.patternMode;
    this.pos = Math.min(m.pos || 0, this.song.order.length - 1);
    this.row = m.row || 0;
    this.speed = m.speed || 6;
    this.bpm = m.bpm || 125;
    this.tickLen = sampleRate * 2.5 / this.bpm;
    this.tick = 0;
    this.tickCounter = 0;
    this.breakFlag = false; this.jumpPos = -1; this.loopJumpRow = -1; this.rowDelay = 0;
    this.led = false;
    this.playing = true;
  }

  stopPlay() {
    this.playing = false;
    for (const c of this.channels) c.playing = false;
    this.port.postMessage({ type: 'stopped' });
  }

  hasSound(s) {
    return !!(s && (s.data.length || (s.synth && s.synth.waveforms.some(w => w.length))));
  }

  jam(m) {
    const c = this.channels[m.ch];
    if (!c || !this.song) return;
    const s = this.song.samples[m.sample];
    if (!this.hasSound(s)) return;
    c.sample = m.sample;
    c.finetune = s.finetune;
    c.vol = s.volume;
    c.note = m.note;
    c.period = c.target = periodForNote(m.note, c.finetune);
    c.pos = 0;
    c.curFx = -1;
    c.arpPeriod = 0; c.vibDelta = 0; c.tremDelta = 0; c.glissP = 0;
    this.initSynth(c, s);
    c.playing = true;
  }

  // ---- MED synthsound interpreter -----------------------------------------

  initSynth(c, s) {
    if (!s.synth) { c.sy = null; return; }
    c.sy = {
      vp: 0, wp: 0, volWait: 0, wfWait: 0, volCnt: 1, wfCnt: 1,
      volSpeed: Math.max(1, s.synth.volspeed), wfSpeed: Math.max(1, s.synth.wfspeed),
      vol: 64, wf: 0, volHalt: false, wfHalt: false,
      volSlide: 0, slide: 0, arp: null, arpPos: 0
    };
  }

  execTable(c, sy, syn, isVol) {
    const tbl = isVol ? syn.voltbl : syn.wftbl;
    let guard = 64;
    while (guard-- > 0) {
      const pos = isVol ? sy.vp : sy.wp;
      if (pos >= tbl.length) {
        if (isVol) sy.volHalt = true; else sy.wfHalt = true;
        return;
      }
      const cmd = tbl[pos];
      const setP = n => { if (isVol) sy.vp = n; else sy.wp = n; };
      setP(pos + 1);
      if (isVol && cmd <= 0x40) { sy.vol = cmd; return; }
      if (!isVol && cmd < 0xF0) { sy.wf = Math.min(cmd, Math.max(0, syn.waveforms.length - 1)); return; }
      const arg = () => {
        const p2 = isVol ? sy.vp : sy.wp;
        const v = p2 < tbl.length ? tbl[p2] : 0;
        setP(p2 + 1);
        return v;
      };
      switch (cmd) {
        case 0xFF: case 0xFB: // END / HLT
          if (isVol) sy.volHalt = true; else sy.wfHalt = true;
          return;
        case 0xFE: setP(Math.min(arg(), tbl.length)); break;               // JMP
        case 0xF0: { const v = Math.max(1, arg()); if (isVol) sy.volSpeed = v; else sy.wfSpeed = v; break; } // SPD
        case 0xF1: { const v = arg(); if (isVol) sy.volWait = v; else sy.wfWait = v; return; }               // WAI
        case 0xF2: { const v = arg(); if (isVol) sy.volSlide = -v; else sy.slide = v; break; }  // CHD (vol down / pitch down)
        case 0xF3: { const v = arg(); if (isVol) sy.volSlide = v; else sy.slide = -v; break; }  // CHU
        case 0xF4: case 0xF5: arg(); break;                                  // EN1/EN2 or VBD/VBS — not implemented
        case 0xF6: if (!isVol) { sy.slide = 0; c.period = periodForNote(c.note, c.finetune); } break; // RES
        case 0xF7: if (!isVol) arg(); break;                                 // VWF — not implemented
        case 0xFA: { const v = arg(); if (isVol) sy.wp = v; else sy.vp = v; break; } // JWS / JVS
        case 0xFC: {                                                         // ARP … ARE (waveform table)
          if (!isVol) {
            const arr = [];
            let p2 = sy.wp;
            while (p2 < tbl.length && tbl[p2] < 0xF0) arr.push(tbl[p2++]);
            if (p2 < tbl.length && tbl[p2] === 0xFD) p2++;
            sy.wp = p2;
            sy.arp = arr.length ? arr : null;
            sy.arpPos = 0;
          }
          break;
        }
        case 0xFD: break; // stray ARE
        default: break;
      }
    }
  }

  synthTick(c) {
    const s = c.sample >= 0 ? this.song.samples[c.sample] : null;
    if (!s || !s.synth || !c.sy) return;
    const sy = c.sy, syn = s.synth;
    if (--sy.volCnt <= 0) {
      sy.volCnt = sy.volSpeed;
      if (sy.volWait > 0) sy.volWait--;
      else if (!sy.volHalt) this.execTable(c, sy, syn, true);
    }
    if (--sy.wfCnt <= 0) {
      sy.wfCnt = sy.wfSpeed;
      if (sy.wfWait > 0) sy.wfWait--;
      else if (!sy.wfHalt) this.execTable(c, sy, syn, false);
    }
    if (sy.volSlide) sy.vol = Math.max(0, Math.min(64, sy.vol + sy.volSlide));
    if (sy.slide) c.period = Math.max(100, Math.min(3424, c.period + sy.slide));
    if (sy.arp && sy.arp.length) sy.arpPos = (sy.arpPos + 1) % sy.arp.length;
  }

  patternAt(pos) {
    const p = this.song.order[pos] | 0;
    return this.song.patterns[p] || null;
  }

  // ---- sequencer ---------------------------------------------------------

  doTick() {
    if (this.playing) {
      if (this.tick === 0) this.processRow(this.rowDelayActive === true);
      else this.tickEffects();
      this.tick++;
      if (this.tick >= this.speed) {
        this.tick = 0;
        this.nextRow();
      }
    }
    // synthsounds run at tick rate even when the sequencer is stopped (jam)
    for (const c of this.channels) if (c.playing && c.sy) this.synthTick(c);
  }

  nextRow() {
    if (this.rowDelay > 0) { // EEx pattern delay: repeat row without retriggering notes
      this.rowDelay--;
      this.rowDelayActive = true;
      return;
    }
    this.rowDelayActive = false;
    if (this.loopJumpRow >= 0) { // E6x pattern loop
      this.row = this.loopJumpRow;
      this.loopJumpRow = -1;
      return;
    }
    if (this.breakFlag) {
      if (!this.patternMode) {
        this.pos = this.jumpPos >= 0 ? this.jumpPos : this.pos + 1;
      }
      this.row = this.breakRow;
      this.breakFlag = false; this.jumpPos = -1; this.breakRow = 0;
    } else {
      this.row++;
      if (this.row >= 64) {
        this.row = 0;
        if (!this.patternMode) this.pos++;
      }
    }
    if (this.row >= 64) this.row = 0;
    if (!this.patternMode && this.pos >= this.song.order.length) this.pos = 0;
  }

  processRow(skipNotes) {
    const pd = this.patternAt(this.pos);
    this.port.postMessage({ type: 'pos', pos: this.pos, row: this.row,
                            pattern: this.song.order[this.pos] | 0, speed: this.speed, bpm: this.bpm });
    if (!pd) return;
    const nch = this.song.channels;
    for (let ch = 0; ch < nch; ch++) {
      const o = (this.row * nch + ch) * 4;
      const note = pd[o], smp = pd[o + 1], fx = pd[o + 2], pm = pd[o + 3];
      const c = this.channels[ch];
      c.curFx = fx; c.curPm = pm;
      c.arpPeriod = 0;
      if (fx !== 4 && fx !== 6) c.vibDelta = 0;
      if (fx !== 7) c.tremDelta = 0;
      if (fx !== 3 && fx !== 5) c.glissP = 0;
      c.delayed = null;

      if (fx === 0xE && (pm >> 4) === 0xD && (pm & 15) > 0) { // EDx note delay
        c.delayed = { note, smp, fx, pm };
        c.delayTick = pm & 15;
        continue;
      }
      if (!skipNotes) this.triggerCell(c, note, smp, fx, pm);
      this.rowFx(c, ch, fx, pm);
    }
  }

  triggerCell(c, note, smp, fx, pm) {
    if (fx === 0xE && (pm >> 4) === 5) { // E5x set finetune (before pitch calc)
      const y = pm & 15;
      c.finetune = y < 8 ? y : y - 16;
    }
    if (smp > 0) {
      const s = this.song.samples[smp - 1];
      if (s) {
        c.sample = smp - 1;
        c.vol = s.volume;
        if (!(fx === 0xE && (pm >> 4) === 5)) c.finetune = s.finetune;
      }
    }
    if (note) {
      if (fx === 3 || fx === 5) { // tone portamento: set target, don't retrigger
        c.note = note;
        c.target = periodForNote(note, c.finetune);
      } else {
        c.note = note;
        c.period = c.target = periodForNote(note, c.finetune);
        c.pos = 0;
        c.glissP = 0;
        if (!(c.vibWave & 4)) c.vibPos = 0;   // waveform bit 4 = don't retrigger
        if (!(c.tremWave & 4)) c.tremPos = 0;
        const s = c.sample >= 0 ? this.song.samples[c.sample] : null;
        c.playing = this.hasSound(s);
        if (s) this.initSynth(c, s);
        if (fx === 9 && c.playing && s.data.length) { // sample offset
          const off = pm || c.offsetMem;
          if (pm) c.offsetMem = pm;
          c.pos = off * 256;
          if (c.pos >= s.data.length) c.playing = s.loopLen > 2 ? (c.pos = s.loopStart, true) : false;
        }
      }
    }
  }

  rowFx(c, ch, fx, pm) {
    switch (fx) {
      case 3: if (pm) c.portaSpeed = pm; break;
      case 4:
        if (pm >> 4) c.vibSpeed = pm >> 4;
        if (pm & 15) c.vibDepth = pm & 15;
        break;
      case 7:
        if (pm >> 4) c.tremSpeed = pm >> 4;
        if (pm & 15) c.tremDepth = pm & 15;
        break;
      case 0xB:
        this.breakFlag = true; this.jumpPos = pm; this.breakRow = 0;
        break;
      case 0xC: c.vol = Math.min(64, pm); break;
      case 0xD:
        this.breakFlag = true;
        if (this.jumpPos < 0) this.breakRow = Math.min(63, (pm >> 4) * 10 + (pm & 15));
        break;
      case 0xF:
        if (pm === 0) break;
        if (pm < 32) this.speed = pm;
        else { this.bpm = pm; this.tickLen = sampleRate * 2.5 / this.bpm; }
        break;
      case 0xE: this.extFx(c, pm); break;
    }
  }

  extFx(c, pm) {
    const x = pm >> 4, y = pm & 15;
    switch (x) {
      case 0: this.led = (y & 1) === 0; break;          // E0x LED filter (0 = on)
      case 1: c.period = Math.max(113, c.period - y); c.target = c.period; break; // fine porta up
      case 2: c.period = Math.min(856, c.period + y); c.target = c.period; break; // fine porta down
      case 3: c.glissando = y !== 0; break;             // glissando control
      case 4: c.vibWave = y & 7; break;                 // vibrato waveform
      case 6: // pattern loop
        if (y === 0) c.loopRow = this.row;
        else if (c.loopCount === 0) { c.loopCount = y; this.loopJumpRow = c.loopRow; }
        else { c.loopCount--; if (c.loopCount !== 0) this.loopJumpRow = c.loopRow; }
        break;
      case 7: c.tremWave = y & 7; break;                // tremolo waveform
      case 0xA: c.vol = Math.min(64, c.vol + y); break; // fine vol up
      case 0xB: c.vol = Math.max(0, c.vol - y); break;  // fine vol down
      case 0xC: if (y === 0) c.vol = 0; break;          // EC0 cuts immediately
      case 0xE: this.rowDelay = y; break;               // pattern delay
    }
  }

  volSlide(c, pm) {
    const x = pm >> 4, y = pm & 15;
    if (x) c.vol = Math.min(64, c.vol + x);
    else c.vol = Math.max(0, c.vol - y);
  }

  doPorta(c) {
    if (!c.target || !c.period) return;
    if (c.period < c.target) c.period = Math.min(c.target, c.period + c.portaSpeed);
    else if (c.period > c.target) c.period = Math.max(c.target, c.period - c.portaSpeed);
    c.glissP = 0;
    if (c.glissando) { // output snaps to the nearest semitone while sliding
      let best = 0, bd = 1e9;
      for (let n = 1; n <= 36; n++) {
        const pp = periodForNote(n, c.finetune);
        const dd = Math.abs(pp - c.period);
        if (dd < bd) { bd = dd; best = pp; }
      }
      c.glissP = best;
    }
  }

  doVib(c) {
    c.vibPos = (c.vibPos + c.vibSpeed) & 63;
    c.vibDelta = waveAmp(c.vibWave, c.vibPos) * c.vibDepth / 128;
  }

  doTrem(c) {
    c.tremPos = (c.tremPos + c.tremSpeed) & 63;
    c.tremDelta = waveAmp(c.tremWave, c.tremPos) * c.tremDepth / 64;
  }

  tickEffects() {
    for (const c of this.channels) {
      if (c.delayed && this.tick === c.delayTick) {
        const d = c.delayed;
        c.delayed = null;
        this.triggerCell(c, d.note, d.smp, 0, 0);
      }
      const fx = c.curFx, pm = c.curPm;
      switch (fx) {
        case 0:
          if (pm) {
            const t = this.tick % 3;
            c.arpPeriod = t === 0 ? 0
              : periodForNote(c.note + (t === 1 ? pm >> 4 : pm & 15), c.finetune);
          }
          break;
        case 1: c.period = Math.max(113, c.period - pm); c.target = c.period; break;
        case 2: c.period = Math.min(856, c.period + pm); c.target = c.period; break;
        case 3: this.doPorta(c); break;
        case 4: this.doVib(c); break;
        case 5: this.doPorta(c); this.volSlide(c, pm); break;
        case 6: this.doVib(c); this.volSlide(c, pm); break;
        case 7: this.doTrem(c); break;
        case 0xA: this.volSlide(c, pm); break;
        case 0xE: {
          const x = pm >> 4, y = pm & 15;
          if (x === 9 && y && this.tick % y === 0) { // retrigger
            c.pos = 0;
            const s = c.sample >= 0 ? this.song.samples[c.sample] : null;
            c.playing = this.hasSound(s);
            if (s) this.initSynth(c, s);
          } else if (x === 0xC && this.tick === y) { // note cut
            c.vol = 0;
          }
          break;
        }
      }
    }
  }

  // ---- mixer ---------------------------------------------------------------

  process(inputs, outputs) {
    const outL = outputs[0][0], outR = outputs[0][1] || outputs[0][0];
    const n = outL.length;
    if (!this.song) { return true; }

    this.framesDone = (this.framesDone || 0) + n;
    const nch = this.channels.length;
    const master = 0.9 / Math.sqrt(Math.max(4, nch));

    for (let f = 0; f < n; f++) {
      if (this.tickCounter <= 0) {
        this.doTick();
        this.tickCounter += this.tickLen;
      }
      this.tickCounter--;

      let L = 0, R = 0;
      for (let i = 0; i < nch; i++) {
        const c = this.channels[i];
        let v = 0;
        if (c.playing && !this.mute[i]) {
          const s = this.song.samples[c.sample];
          let d = null, ls = 0, ll = 0, volScale = 1, per = 0;
          if (s && s.synth && c.sy) {
            d = s.synth.waveforms[c.sy.wf] || null;
            if (d && d.length) {
              if (s.synth.hybrid && c.sy.wf === 0) { ls = s.loopStart; ll = s.loopLen; }
              else { ls = 0; ll = d.length; } // pure synth waveforms always loop fully
              volScale = c.sy.vol / 64;
              per = (c.sy.arp && c.sy.arp.length)
                ? periodForNote(c.note + c.sy.arp[c.sy.arpPos], c.finetune)
                : (c.glissP || c.period) + c.vibDelta;
            } else d = null;
          } else if (s && s.data.length) {
            d = s.data; ls = s.loopStart; ll = s.loopLen;
            per = c.arpPeriod || ((c.glissP || c.period) + c.vibDelta);
          }
          if (!d) {
            c.playing = false;
          } else {
            // wrap/stop before reading (waveform may have changed size)
            if (ll > 2) {
              const end = ls + ll;
              while (c.pos >= end) c.pos -= ll;
              if (c.pos < 0) c.pos = ls;
            } else if (c.pos >= d.length) {
              c.playing = false;
            }
            if (c.playing) {
              if (per < 100) per = 100;
              const inc = PAULA / per / sampleRate;
              const p = c.pos | 0;
              let raw;
              if (this.paula) {
                raw = d[p]; // nearest-neighbour, like Paula
              } else {
                const p2 = p + 1 < d.length ? p + 1 : (ll > 2 ? ls : p);
                const frac = c.pos - p;
                raw = d[p] + (d[p2] - d[p]) * frac;
              }
              let vol = c.vol + c.tremDelta;
              if (vol < 0) vol = 0; else if (vol > 64) vol = 64;
              v = raw / 128 * (vol / 64) * volScale;
              c.pos += inc;
            }
          }
        }
        // Amiga panning L R R L, softened
        const left = (i & 3) === 0 || (i & 3) === 3;
        L += v * (left ? 0.75 : 0.25);
        R += v * (left ? 0.25 : 0.75);
        this.scopeBufs[i][this.scopePos] = v;
      }
      this.scopePos = (this.scopePos + 1) % this.scopeLen;

      if (this.paula) {
        // fixed A500 RC low-pass (~4.9 kHz, 6 dB/oct)
        this.rcL += this.aRC * (L - this.rcL); L = this.rcL;
        this.rcR += this.aRC * (R - this.rcR); R = this.rcR;
        if (this.led) {
          // "LED" filter (~3.3 kHz, 12 dB/oct), toggled by E0x
          this.l1L += this.aLED * (L - this.l1L);
          this.l2L += this.aLED * (this.l1L - this.l2L); L = this.l2L;
          this.l1R += this.aLED * (R - this.l1R);
          this.l2R += this.aLED * (this.l1R - this.l2R); R = this.l2R;
        }
      }
      outL[f] = L * master;
      outR[f] = R * master;
    }

    this.scopeTimer += n;
    if (this.scopeTimer >= sampleRate / 30) {
      this.scopeTimer = 0;
      this.port.postMessage({ type: 'scope', data: this.scopeBufs.map(b => b.slice()) });
    }
    return true;
  }
}

registerProcessor('mod-player', ModPlayerProcessor);
