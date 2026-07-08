/* chipsynth.js — compiles knob-style parameters into a MED-compatible synth
 * instrument (waveform set + volume/waveform programs) that the existing
 * synthsound interpreter in the audio worklet plays.
 *
 * Program language used (subset the worklet executes):
 *   volume table:   00-40 set volume · F0 SPD · F1 WAI · F2 CHD · F3 CHU · FF END
 *   waveform table: 00-EF set waveform · F2/F3 pitch slide · F4 VBD · F5 VBS
 *                   FC..FD arpeggio offsets · FE JMP · FF END
 */
'use strict';

const ChipSynth = (() => {

  const WAVE_LEN = 32;

  function genWave(type, duty) {
    const len = type === 'noise' ? 128 : WAVE_LEN;
    const d = new Int8Array(len);
    let seed = 0xACE1;
    for (let i = 0; i < len; i++) {
      const ph = i / len;
      switch (type) {
        case 'square': d[i] = ph < duty ? 100 : -100; break;
        case 'saw': d[i] = Math.round(-100 + 200 * ph); break;
        case 'tri': d[i] = Math.round(ph < 0.5 ? -100 + 400 * ph : 300 - 400 * ph); break;
        case 'sine': d[i] = Math.round(Math.sin(ph * 2 * Math.PI) * 100); break;
        default: // noise
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          d[i] = (seed % 201) - 100;
      }
    }
    return d;
  }

  // duty-cycle sweep frames for PWM (smooth loop: down then back up)
  const PWM_DUTIES = [0.50, 0.44, 0.37, 0.30, 0.23, 0.16, 0.10, 0.16, 0.23, 0.30, 0.37, 0.44];

  const ARPS = {
    off: null,
    octave: [0, 12],
    fifth: [0, 7],
    major: [0, 4, 7],
    minor: [0, 3, 7],
    sus4: [0, 5, 7],
    minor7: [0, 3, 7, 10]
  };

  const PRESETS = {
    'pwm lead':   { wave: 'square', duty: 0.50, pwm: true, pwmSpeed: 3, attack: 2, decay: 36, sustain: 36, arp: 'off', slide: 0, vibDepth: 3, vibSpeed: 3 },
    'chip bass':  { wave: 'square', duty: 0.25, pwm: false, pwmSpeed: 1, attack: 0, decay: 22, sustain: 20, arp: 'off', slide: 0, vibDepth: 0, vibSpeed: 1 },
    'chord stab': { wave: 'square', duty: 0.50, pwm: false, pwmSpeed: 1, attack: 0, decay: 26, sustain: 0, arp: 'minor', slide: 0, vibDepth: 0, vibSpeed: 1 },
    'kick':       { wave: 'sine', duty: 0.50, pwm: false, pwmSpeed: 1, attack: 0, decay: 7, sustain: 0, arp: 'off', slide: 14, vibDepth: 0, vibSpeed: 1 },
    'snare':      { wave: 'noise', duty: 0.50, pwm: false, pwmSpeed: 1, attack: 0, decay: 9, sustain: 0, arp: 'off', slide: 4, vibDepth: 0, vibSpeed: 1 },
    'hi-hat':     { wave: 'noise', duty: 0.50, pwm: false, pwmSpeed: 1, attack: 0, decay: 4, sustain: 0, arp: 'off', slide: 0, vibDepth: 0, vibSpeed: 1 },
    'laser zap':  { wave: 'saw', duty: 0.50, pwm: false, pwmSpeed: 1, attack: 0, decay: 12, sustain: 0, arp: 'off', slide: 30, vibDepth: 0, vibSpeed: 1 },
    'soft pad':   { wave: 'tri', duty: 0.50, pwm: false, pwmSpeed: 1, attack: 24, decay: 40, sustain: 44, arp: 'off', slide: 0, vibDepth: 4, vibSpeed: 2 }
  };

  const clampByte = v => Math.max(0, Math.min(240, v | 0));

  /* p: { wave, duty, pwm, pwmSpeed, attack (ticks), decay (ticks),
   *      sustain (0-64), arp (key of ARPS), slide (-31..31, + = pitch falls),
   *      vibDepth (0-15), vibSpeed (1-15) } */
  function build(p) {
    const waveforms = [];
    if (p.wave === 'square' && p.pwm) {
      for (const duty of PWM_DUTIES) waveforms.push(genWave('square', duty));
    } else {
      waveforms.push(genWave(p.wave, p.duty || 0.5));
    }

    // volume program: attack ramp, decay to sustain, hold
    const A = Math.max(0, p.attack | 0);
    const D = Math.max(0, p.decay | 0);
    const S = Math.max(0, Math.min(64, p.sustain | 0));
    const vol = [];
    if (A > 0) {
      vol.push(0, 0xF3, Math.max(1, Math.ceil(64 / A)), 0xF1, clampByte(A), 0xF3, 0, 64);
    } else {
      vol.push(64);
    }
    if (S < 64) {
      if (D > 0) vol.push(0xF2, Math.max(1, Math.ceil((64 - S) / D)), 0xF1, clampByte(D), 0xF2, 0);
      vol.push(S);
    }
    vol.push(0xFF);

    // waveform program: vibrato + pitch slide + arpeggio setup, then the
    // waveform sequence (looped when there is more than one frame)
    const wf = [];
    if (p.vibDepth > 0) wf.push(0xF4, Math.min(15, p.vibDepth | 0), 0xF5, Math.max(1, Math.min(15, p.vibSpeed | 0)));
    if (p.slide) wf.push(p.slide > 0 ? 0xF2 : 0xF3, Math.min(63, Math.abs(p.slide | 0)));
    const arp = ARPS[p.arp];
    if (arp) wf.push(0xFC, ...arp, 0xFD);
    const loopPos = wf.length;
    for (let i = 0; i < waveforms.length; i++) wf.push(i);
    if (waveforms.length > 1) wf.push(0xFE, loopPos);
    else wf.push(0xFF);

    return {
      hybrid: false,
      volspeed: 1,
      wfspeed: Math.max(1, Math.min(10, p.pwmSpeed | 0)),
      voltbl: new Uint8Array(vol),
      wftbl: new Uint8Array(wf),
      waveforms,
      chip: { ...p } // original knob values, kept for re-editing
    };
  }

  return { build, PRESETS, ARPS };
})();
