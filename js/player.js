/* player.js — main-thread wrapper around the AudioWorklet replayer. */
'use strict';

class Player {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.onpos = null;
    this.onscope = null;
    this.onstopped = null;
    this._pendingSong = null;
  }

  get ready() { return !!this.node; }

  async ensure() {
    if (!this._initPromise) this._initPromise = this._init();
    await this._initPromise;
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async _init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.audioWorklet.addModule('js/worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'mod-player', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]
    });
    this.node.connect(this.ctx.destination);
    this.node.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'pos' && this.onpos) this.onpos(m);
      else if (m.type === 'scope' && this.onscope) this.onscope(m);
      else if (m.type === 'stopped' && this.onstopped) this.onstopped();
    };
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this._pendingSong) { this.sendSong(this._pendingSong); this._pendingSong = null; }
  }

  msg(m) { if (this.node) this.node.port.postMessage(m); }

  static serializeSample(s) {
    const toF32 = a => {
      const f = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) f[i] = a[i];
      return f;
    };
    const out = {
      data: toF32(s.data), volume: s.volume, finetune: s.finetune,
      loopStart: s.loopStart, loopLen: s.loopLen
    };
    if (s.synth) {
      out.synth = {
        hybrid: !!s.synth.hybrid,
        volspeed: s.synth.volspeed, wfspeed: s.synth.wfspeed,
        voltbl: s.synth.voltbl.slice(), wftbl: s.synth.wftbl.slice(),
        waveforms: s.synth.waveforms.map(toF32)
      };
    }
    return out;
  }

  static serializeSong(song) {
    return {
      channels: song.channels,
      order: song.order.slice(),
      patterns: song.patterns.map(p => p.slice()),
      samples: song.samples.map(Player.serializeSample)
    };
  }

  sendSong(song) {
    if (!this.node) { this._pendingSong = song; return; }
    this._sentOnce = true;
    this.msg({ type: 'song', song: Player.serializeSong(song) });
  }

  sendPattern(song, index) {
    this.msg({ type: 'pattern', index, data: song.patterns[index].slice() });
  }

  sendOrder(song) { this.msg({ type: 'order', order: song.order.slice() }); }

  sendSample(song, index) {
    this.msg({ type: 'sample', index, sample: Player.serializeSample(song.samples[index]) });
  }

  play(opts) { this.msg({ type: 'play', ...opts }); }
  stop() { this.msg({ type: 'stop' }); }
  setMute(mute) { this.msg({ type: 'mute', mute: mute.slice() }); }
  jam(ch, sample, note, vol) { this.msg({ type: 'jam', ch, sample, note, vol: vol >= 0 ? vol : -1 }); }
  jamStop(ch) { this.msg({ type: 'jamStop', ch }); }
}
