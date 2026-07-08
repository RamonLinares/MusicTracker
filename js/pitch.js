/* pitch.js — monophonic pitch detection for hum-to-pattern. Pure functions:
 * YIN detection on a frame, tracking over a buffer, and segmentation of the
 * pitch track into note events. No DOM, no audio APIs — unit-testable.
 */
'use strict';

const Pitch = (() => {

  /* YIN (de Cheveigné & Kawahara 2002): cumulative mean normalized difference
   * with absolute threshold and parabolic interpolation. */
  function yin(frame, sampleRate, minFreq = 65, maxFreq = 700, threshold = 0.15) {
    const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    const tauMax = Math.min(Math.floor(sampleRate / minFreq), frame.length >> 1);
    if (tauMax <= tauMin + 2) return { freq: 0, clarity: 0 };

    const n = frame.length - tauMax;
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const diff = frame[i] - frame[i + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    const cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
    }

    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) { // no dip under threshold: accept a clear global minimum only
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
      if (cmnd[best] < 0.3) tau = best;
      else return { freq: 0, clarity: 0 };
    }

    let betterTau = tau;
    if (tau > 1 && tau < tauMax) {
      const s0 = cmnd[tau - 1], s1 = cmnd[tau], s2 = cmnd[tau + 1];
      const denom = 2 * (2 * s1 - s0 - s2);
      if (denom !== 0) betterTau = tau + (s2 - s0) / denom;
    }
    return { freq: sampleRate / betterTau, clarity: 1 - cmnd[tau] };
  }

  /* simple 1:factor decimation with block averaging (enough anti-aliasing
   * for pitch work — we only care about < 700 Hz content) */
  function downsample(samples, factor) {
    const out = new Float32Array(Math.floor(samples.length / factor));
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let k = 0; k < factor; k++) sum += samples[i * factor + k];
      out[i] = sum / factor;
    }
    return out;
  }

  /* run YIN over the buffer: [{freq, clarity, rms}] per hop */
  function track(samples, sampleRate, opts = {}) {
    const size = opts.size || 1024;
    const hop = opts.hop || 256;
    const frames = [];
    for (let off = 0; off + size <= samples.length; off += hop) {
      const frame = samples.subarray(off, off + size);
      let rms = 0;
      for (let i = 0; i < size; i++) rms += frame[i] * frame[i];
      rms = Math.sqrt(rms / size);
      if (rms < (opts.minRms || 0.01)) {
        frames.push({ freq: 0, clarity: 0, rms });
        continue;
      }
      const { freq, clarity } = yin(frame, sampleRate, opts.minFreq, opts.maxFreq);
      frames.push({ freq, clarity, rms });
    }
    return frames;
  }

  const freqToMidi = f => 69 + 12 * Math.log2(f / 440);

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  /* group the pitch track into note events:
   * [{start (s), dur (s), midi (rounded), rms}] */
  function segment(frames, hopTime, opts = {}) {
    const minClarity = opts.minClarity ?? 0.6;
    const minFrames = opts.minFrames ?? 3;
    const jump = opts.jump ?? 0.75; // semitones that count as a new note

    const voiced = frames.map(f =>
      f.clarity >= minClarity && f.freq >= 60 && f.freq <= 800);
    const midi = frames.map(f => f.freq > 0 ? freqToMidi(f.freq) : 0);

    // collect voiced runs, tolerating single-frame dropouts
    const runs = [];
    let start = -1;
    for (let i = 0; i <= frames.length; i++) {
      const on = i < frames.length &&
        (voiced[i] || (voiced[i - 1] && voiced[i + 1])); // bridge 1-frame gaps
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        if (i - start >= minFrames) runs.push([start, i]);
        start = -1;
      }
    }

    // split runs where the pitch moves to a new note and stays there
    const events = [];
    for (const [r0, r1] of runs) {
      let segStart = r0;
      let acc = [midi[r0]];
      const close = end => {
        if (end - segStart < minFrames) return;
        let rms = 0;
        for (let i = segStart; i < end; i++) rms += frames[i].rms;
        events.push({
          start: segStart * hopTime,
          dur: (end - segStart) * hopTime,
          midi: Math.round(median(acc)),
          rms: rms / (end - segStart)
        });
      };
      for (let i = r0 + 1; i < r1; i++) {
        if (!voiced[i]) { acc.push(median(acc)); continue; }
        const med = median(acc);
        if (Math.abs(midi[i] - med) > jump &&
            (i + 1 >= r1 || Math.abs(midi[i + 1] - med) > jump)) {
          close(i);
          segStart = i;
          acc = [midi[i]];
        } else {
          acc.push(midi[i]);
        }
      }
      close(r1);
    }
    return events;
  }

  return { yin, track, segment, downsample, freqToMidi };
})();
