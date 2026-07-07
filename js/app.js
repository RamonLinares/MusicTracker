/* app.js — UI glue: transport, keyboard editing, selection/clipboard, undo,
 * sample list + waveform editor, order editor, scopes, file I/O, WAV export. */
'use strict';

(() => {
  const $ = id => document.getElementById(id);

  const player = new Player();

  const state = {
    song: MOD.demoSong(),
    curPos: 0,                 // order position being viewed/edited
    cursor: { row: 0, ch: 0, col: 0 },
    playRow: -1,               // -1 = not playing
    playPos: -1,
    octave: 2,
    step: 1,
    curSample: 0,              // 0-based sample index used for note entry
    editMode: true,
    follow: true,
    playing: false,
    paula: false,              // Paula mode: nearest-neighbour + Amiga filters
    lastRowTime: 0,            // for record-mode quantization
    recUndo: false,            // one undo entry per recording take
    muted: [false, false, false, false],
    jamHeld: {},               // code -> channel, for keyup of looped jam notes
    sel: null,                 // normalized {r0,c0,r1,c1} or null
    selAnchor: null,           // {row,ch} where shift-selection started
    clipboard: null,           // {rows, chs, cells:Uint8Array}
    wave: { mode: 'select', a: -1, b: -1 } // waveform editor selection (bytes)
  };

  const AUTOSAVE_DB = 'webtracker-autosave';
  const AUTOSAVE_STORE = 'drafts';
  const AUTOSAVE_KEY = 'current';
  const AUTOSAVE_SCHEMA = 1;
  const AUTOSAVE_DELAY = 650;
  const autosave = { timer: 0, restoring: false };

  function curPattern() {
    return state.song.order[state.curPos] | 0;
  }

  // ---- autosave -----------------------------------------------------------

  function asInt8(data) {
    if (data instanceof Int8Array) return data.slice();
    if (ArrayBuffer.isView(data)) return new Int8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (data instanceof ArrayBuffer) return new Int8Array(data.slice(0));
    if (Array.isArray(data)) return new Int8Array(data);
    return new Int8Array(0);
  }

  function asUint8(data, fallbackLength) {
    if (data instanceof Uint8Array) return data.slice();
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (Array.isArray(data)) return new Uint8Array(data);
    return new Uint8Array(fallbackLength || 0);
  }

  function clampNum(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  function cloneSynthForStorage(synth) {
    if (!synth) return null;
    return {
      hybrid: !!synth.hybrid,
      volspeed: synth.volspeed || 0,
      wfspeed: synth.wfspeed || 0,
      voltbl: asUint8(synth.voltbl),
      wftbl: asUint8(synth.wftbl),
      waveforms: (synth.waveforms || []).map(w => asInt8(w))
    };
  }

  function cloneSampleForStorage(sample) {
    return {
      name: sample.name || '',
      volume: clampNum(sample.volume, 0, 64, 64),
      finetune: clampNum(sample.finetune, -8, 7, 0),
      loopStart: Math.max(0, sample.loopStart | 0),
      loopLen: Math.max(0, sample.loopLen | 0),
      data: asInt8(sample.data),
      synth: cloneSynthForStorage(sample.synth)
    };
  }

  function cloneSongForStorage(song) {
    return {
      title: song.title || '',
      channels: clampNum(song.channels, 1, 32, 4),
      order: song.order.slice(),
      patterns: song.patterns.map(p => asUint8(p)),
      samples: song.samples.map(cloneSampleForStorage),
      initBPM: song.initBPM || null,
      initSpeed: song.initSpeed || null
    };
  }

  function songFromStorage(saved) {
    const channels = clampNum(saved && saved.channels, 1, 32, 4);
    const song = MOD.newSong(channels);
    song.title = String(saved.title || '').slice(0, 20);
    song.order = Array.isArray(saved.order) && saved.order.length
      ? saved.order.slice(0, 128).map(v => clampNum(v, 0, 127, 0) | 0)
      : [0];
    song.patterns = Array.isArray(saved.patterns) && saved.patterns.length
      ? saved.patterns.map(p => {
        const raw = asUint8(p);
        const out = MOD.newPattern(channels);
        out.set(raw.slice(0, out.length));
        return out;
      })
      : [MOD.newPattern(channels)];
    while (song.patterns.length <= Math.max(...song.order)) song.patterns.push(MOD.newPattern(channels));
    song.samples = [];
    for (let i = 0; i < 31; i++) {
      const src = saved.samples && saved.samples[i] ? saved.samples[i] : {};
      const sample = MOD.emptySample();
      sample.name = String(src.name || '').slice(0, 22);
      sample.volume = clampNum(src.volume, 0, 64, 64);
      sample.finetune = clampNum(src.finetune, -8, 7, 0);
      sample.loopStart = Math.max(0, src.loopStart | 0);
      sample.loopLen = Math.max(0, src.loopLen | 0);
      sample.data = asInt8(src.data);
      sample.synth = cloneSynthForStorage(src.synth);
      if (!sample.synth) delete sample.synth;
      if (sample.loopStart >= sample.data.length) { sample.loopStart = 0; sample.loopLen = 0; }
      if (sample.loopStart + sample.loopLen > sample.data.length) {
        sample.loopLen = Math.max(0, sample.data.length - sample.loopStart);
      }
      song.samples.push(sample);
    }
    if (saved.initBPM) song.initBPM = clampNum(saved.initBPM, 32, 255, 125);
    if (saved.initSpeed) song.initSpeed = clampNum(saved.initSpeed, 1, 31, 6);
    return song;
  }

  function openAutosaveDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(AUTOSAVE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) db.createObjectStore(AUTOSAVE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function writeAutosaveDraft(draft) {
    const db = await openAutosaveDb();
    try {
      const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
      tx.objectStore(AUTOSAVE_STORE).put(draft, AUTOSAVE_KEY);
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  async function readAutosaveDraft() {
    const db = await openAutosaveDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(AUTOSAVE_STORE, 'readonly');
        const req = tx.objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  function buildAutosaveDraft() {
    return {
      schema: AUTOSAVE_SCHEMA,
      savedAt: Date.now(),
      song: cloneSongForStorage(state.song),
      curPos: state.curPos,
      cursor: { ...state.cursor },
      octave: state.octave,
      step: state.step,
      curSample: state.curSample,
      editMode: state.editMode,
      follow: state.follow,
      paula: state.paula,
      muted: state.muted.slice(),
      bpm: parseInt($('bpmInput').value, 10) || 125,
      speed: parseInt($('speedInput').value, 10) || 6
    };
  }

  function scheduleAutosave() {
    if (autosave.restoring) return;
    clearTimeout(autosave.timer);
    autosave.timer = window.setTimeout(() => {
      autosave.timer = 0;
      writeAutosaveDraft(buildAutosaveDraft())
        .catch(err => console.warn('Autosave failed:', err));
    }, AUTOSAVE_DELAY);
  }

  async function restoreAutosave() {
    let draft = null;
    try {
      draft = await readAutosaveDraft();
    } catch (err) {
      console.warn('Autosave restore failed:', err);
      return false;
    }
    if (!draft || draft.schema !== AUTOSAVE_SCHEMA || !draft.song) return false;

    autosave.restoring = true;
    try {
      const song = songFromStorage(draft.song);
      state.song = song;
      state.curPos = clampNum(draft.curPos, 0, song.order.length - 1, 0);
      state.cursor = {
        row: clampNum(draft.cursor && draft.cursor.row, 0, 63, 0),
        ch: clampNum(draft.cursor && draft.cursor.ch, 0, song.channels - 1, 0),
        col: clampNum(draft.cursor && draft.cursor.col, 0, 5, 0)
      };
      state.octave = clampNum(draft.octave, 1, 3, 2);
      state.step = clampNum(draft.step, 0, 16, 1);
      state.curSample = clampNum(draft.curSample, 0, 30, 0);
      state.editMode = draft.editMode !== false;
      state.follow = draft.follow !== false;
      state.paula = !!draft.paula;
      state.muted = Array.isArray(draft.muted)
        ? draft.muted.slice(0, song.channels).map(Boolean)
        : new Array(song.channels).fill(false);
      while (state.muted.length < song.channels) state.muted.push(false);
      state.wave.a = state.wave.b = -1;
      clearHistory();
      $('bpmInput').value = clampNum(draft.bpm, 32, 255, song.initBPM || 125);
      $('speedInput').value = clampNum(draft.speed, 1, 31, song.initSpeed || 6);
      player.sendSong(song);
      player.setMute(state.muted);
      player.msg({ type: 'paula', on: state.paula });
      renderAll();
      drawScopes(null);
      setStatusMsg('Restored autosaved draft from ' + new Date(draft.savedAt || Date.now()).toLocaleString());
      return true;
    } finally {
      autosave.restoring = false;
    }
  }

  // ---- project file format (.wtp) ------------------------------------------
  // Full-fidelity JSON container reusing the autosave serializer: keeps what
  // .MOD cannot hold (MED synth programs, 5-8 channels, initial tempo, Paula).

  const PROJECT_FORMAT = 'webtracker-project';

  function bytesToB64(view) {
    const u8 = view instanceof Uint8Array
      ? view
      : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const s = atob(String(b64 || ''));
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  function buildProjectJson() {
    const snap = cloneSongForStorage(state.song);
    const song = {
      ...snap,
      patterns: snap.patterns.map(bytesToB64),
      samples: snap.samples.map(s => ({
        ...s,
        data: bytesToB64(s.data),
        synth: s.synth ? {
          ...s.synth,
          voltbl: bytesToB64(s.synth.voltbl),
          wftbl: bytesToB64(s.synth.wftbl),
          waveforms: s.synth.waveforms.map(bytesToB64)
        } : null
      }))
    };
    return JSON.stringify({
      format: PROJECT_FORMAT,
      version: 1,
      savedAt: new Date().toISOString(),
      bpm: parseInt($('bpmInput').value, 10) || 125,
      speed: parseInt($('speedInput').value, 10) || 6,
      paula: state.paula,
      song
    });
  }

  function parseProjectJson(text) {
    const proj = JSON.parse(text);
    if (proj.format !== PROJECT_FORMAT || !proj.song) throw new Error('Not a WebTracker project file');
    const raw = proj.song;
    const saved = {
      ...raw,
      patterns: Array.isArray(raw.patterns) ? raw.patterns.map(b64ToBytes) : [],
      samples: Array.isArray(raw.samples) ? raw.samples.map(s => ({
        ...s,
        data: b64ToBytes(s.data),
        synth: s.synth ? {
          ...s.synth,
          voltbl: b64ToBytes(s.synth.voltbl),
          wftbl: b64ToBytes(s.synth.wftbl),
          waveforms: Array.isArray(s.synth.waveforms) ? s.synth.waveforms.map(b64ToBytes) : []
        } : null
      })) : []
    };
    const song = songFromStorage(saved);
    if (proj.bpm) song.initBPM = clampNum(proj.bpm, 32, 255, 125);
    if (proj.speed) song.initSpeed = clampNum(proj.speed, 1, 31, 6);
    return { song, paula: typeof proj.paula === 'boolean' ? proj.paula : null };
  }

  // ---- undo / redo ---------------------------------------------------------

  const undoStack = [], redoStack = [];
  const UNDO_MAX = 250;

  function snapshot(kind, index) {
    const song = state.song;
    if (kind === 'pattern') return { kind, index, data: song.patterns[index].slice() };
    if (kind === 'order') return { kind, order: song.order.slice(), curPos: state.curPos };
    if (kind === 'sample') {
      const s = song.samples[index];
      return { kind, index, sample: { name: s.name, volume: s.volume, finetune: s.finetune,
        loopStart: s.loopStart, loopLen: s.loopLen, data: s.data.slice(),
        synth: s.synth || null } };
    }
    if (kind === 'channels') {
      return { kind, channels: song.channels, patterns: song.patterns.map(p => p.slice()) };
    }
  }

  function pushUndo(kind, index) {
    undoStack.push(snapshot(kind, index));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  function applySnap(s) {
    const inverse = snapshot(s.kind, s.index);
    const song = state.song;
    if (s.kind === 'pattern') {
      song.patterns[s.index] = s.data.slice();
      player.sendPattern(song, s.index);
    } else if (s.kind === 'order') {
      song.order = s.order.slice();
      state.curPos = Math.min(s.curPos, song.order.length - 1);
      player.sendOrder(song);
    } else if (s.kind === 'sample') {
      const t = song.samples[s.index];
      Object.assign(t, s.sample, { data: s.sample.data.slice() });
      state.curSample = s.index;
      player.sendSample(song, s.index);
    } else if (s.kind === 'channels') {
      song.channels = s.channels;
      song.patterns = s.patterns.map(p => p.slice());
      state.muted = state.muted.slice(0, s.channels);
      while (state.muted.length < s.channels) state.muted.push(false);
      clampCursor();
      clearSel();
      player.sendSong(song);
      player.setMute(state.muted);
      drawScopes(null);
    }
    renderAll();
    scheduleAutosave();
    return inverse;
  }

  function doUndo() {
    const s = undoStack.pop();
    if (!s) { setStatusMsg('Nothing to undo'); return; }
    redoStack.push(applySnap(s));
    setStatusMsg('Undo');
  }

  function doRedo() {
    const s = redoStack.pop();
    if (!s) { setStatusMsg('Nothing to redo'); return; }
    undoStack.push(applySnap(s));
    setStatusMsg('Redo');
  }

  function clearHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    state.sel = null; state.selAnchor = null;
  }

  // ---- rendering ----------------------------------------------------------

  const patCanvas = $('pattern');

  function drawPattern() {
    PatternView.draw(patCanvas, state.song, {
      pattern: curPattern(),
      cursor: state.cursor,
      playRow: state.playing ? state.playRow : -1,
      follow: state.follow,
      muted: state.muted,
      editMode: state.editMode,
      sel: state.sel
    });
  }

  function renderChannelHeaders() {
    const box = $('chanHeaders');
    box.innerHTML = '';
    const m = PatternView.channelHeaderMetrics(state.song.channels);
    const spacer = document.createElement('div');
    spacer.style.width = m.rowNumW + 'px';
    spacer.className = 'ch-spacer';
    box.appendChild(spacer);
    for (let i = 0; i < state.song.channels; i++) {
      const d = document.createElement('div');
      d.className = 'ch-head' + (state.muted[i] ? ' muted' : '');
      d.style.width = m.cellW + 'px';
      d.textContent = (state.muted[i] ? '✕ ' : '▸ ') + 'CH ' + (i + 1);
      d.title = 'Click: mute/unmute · Shift+click: solo';
      d.onclick = e => {
        if (e.shiftKey) { // solo
          const others = state.muted.filter((m2, k) => k !== i);
          const isSolo = !state.muted[i] && others.every(v => v);
          for (let k = 0; k < state.muted.length; k++) state.muted[k] = isSolo ? false : k !== i;
        } else {
          state.muted[i] = !state.muted[i];
        }
        player.setMute(state.muted);
        scheduleAutosave();
        renderChannelHeaders();
        drawPattern();
      };
      box.appendChild(d);
    }
  }

  function renderOrder() {
    const box = $('orderList');
    box.innerHTML = '';
    state.song.order.forEach((pat, i) => {
      const d = document.createElement('div');
      d.className = 'order-chip' + (i === state.curPos ? ' sel' : '') +
        (state.playing && i === state.playPos ? ' playing' : '');
      d.innerHTML = `<span class="op">${String(i).padStart(2, '0')}</span>${String(pat).padStart(2, '0')}`;
      d.onclick = () => { state.curPos = i; clampCursor(); renderAll(); };
      box.appendChild(d);
    });
    const sel = box.querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderSamples() {
    const box = $('sampleList');
    box.innerHTML = '';
    state.song.samples.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'smp-row' + (i === state.curSample ? ' sel' : '');
      d.innerHTML =
        `<span class="smp-num">${(i + 1).toString(16).toUpperCase().padStart(2, '0')}</span>` +
        `<span class="smp-name">${s.name ? escapeHtml(s.name) : '<i>—</i>'}</span>` +
        `<span class="smp-len">${s.synth ? (s.synth.hybrid ? 'hyb' : 'syn') : s.data.length}</span>`;
      d.onclick = () => { selectSample(i); };
      box.appendChild(d);
    });
  }

  function selectSample(i) {
    state.curSample = Math.max(0, Math.min(30, i));
    state.wave.a = state.wave.b = -1;
    renderSamples(); renderSampleProps();
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function renderSampleProps() {
    const s = state.song.samples[state.curSample];
    $('smpName').value = s.name;
    $('smpVol').value = s.volume;
    $('smpFine').value = s.finetune;
    $('smpLoopStart').value = s.loopStart;
    $('smpLoopLen').value = s.loopLen;
    $('smpInfo').textContent = `#${(state.curSample + 1).toString(16).toUpperCase().padStart(2, '0')} · ` +
      (s.synth
        ? `${s.synth.hybrid ? 'hybrid' : 'synth'} · ${s.synth.waveforms.length} waveform${s.synth.waveforms.length !== 1 ? 's' : ''}`
        : `${s.data.length} bytes`);
    $('wvMode').classList.toggle('active', state.wave.mode === 'draw');
    renderWaveSel();
    drawWave();
  }

  function waveSelRange() {
    const len = state.song.samples[state.curSample].data.length;
    if (state.wave.a < 0 || state.wave.b < 0 || state.wave.a === state.wave.b) return null;
    const a = Math.max(0, Math.min(state.wave.a, state.wave.b));
    const b = Math.min(len, Math.max(state.wave.a, state.wave.b));
    return b > a ? [a, b] : null;
  }

  function renderWaveSel() {
    const r = waveSelRange();
    $('wvSel').textContent = r ? `sel ${r[0]}–${r[1]} (${r[1] - r[0]}b)` : 'no selection';
  }

  function drawWave() {
    const c = $('waveform');
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, 0, w, h);
    const s = state.song.samples[state.curSample];
    let d = s.data;
    if (!d.length && s.synth) d = s.synth.waveforms.find(w => w.length) || d; // preview first synth waveform
    if (!d.length) {
      ctx.fillStyle = '#333e58';
      ctx.font = '11px monospace';
      ctx.fillText(state.wave.mode === 'draw' ? 'draw mode: drag to create a waveform' : 'no sample data', 10, h / 2);
      if (state.wave.mode !== 'draw') return;
    }
    if (s.loopLen > 2 && d.length) {
      ctx.fillStyle = 'rgba(110,195,224,0.12)';
      const x0 = s.loopStart / d.length * w;
      const x1 = (s.loopStart + s.loopLen) / d.length * w;
      ctx.fillRect(x0, 0, x1 - x0, h);
    }
    const r = waveSelRange();
    if (r && d.length) {
      ctx.fillStyle = 'rgba(255,160,64,0.18)';
      ctx.fillRect(r[0] / d.length * w, 0, (r[1] - r[0]) / d.length * w, h);
    }
    if (d.length) {
      ctx.strokeStyle = '#7ee08a';
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const i = Math.floor(x / w * d.length);
        const y = h / 2 - (d[i] / 128) * (h / 2 - 2);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#232c42';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  }

  function renderStatus() {
    $('stPos').textContent = String(state.playing ? state.playPos : state.curPos).padStart(2, '0') +
      '/' + String(state.song.order.length).padStart(2, '0');
    $('stPat').textContent = String(curPattern()).padStart(2, '0');
    $('stRow').textContent = String(state.playing && state.playRow >= 0 ? state.playRow : state.cursor.row).padStart(2, '0');
    $('ledPlay').classList.toggle('on', state.playing);
    $('octDisp').textContent = state.octave;
    $('stepDisp').textContent = state.step;
    $('editBtn').classList.toggle('active', state.editMode);
    $('editBtn').classList.toggle('rec', state.editMode && state.playing);
    $('editBtn').textContent = state.editMode && state.playing ? 'REC' : 'EDIT';
    $('followBtn').classList.toggle('active', state.follow);
    $('paulaBtn').classList.toggle('active', state.paula);
    $('chDisp').textContent = state.song.channels;
  }

  function renderAll() {
    renderOrder();
    renderChannelHeaders();
    renderSamples();
    renderSampleProps();
    renderStatus();
    $('songTitle').value = state.song.title;
    drawPattern();
  }

  // ---- scopes ---------------------------------------------------------------

  function drawScopes(data) {
    const box = $('scopes');
    const n = state.song.channels;
    const m = PatternView.channelHeaderMetrics(n);
    // one scope per channel, sized to sit exactly over its pattern column
    if (box.dataset.n !== String(n) || box.dataset.w !== String(m.cellW)) {
      box.dataset.n = String(n);
      box.dataset.w = String(m.cellW);
      box.innerHTML = '';
      const sp = document.createElement('div');
      sp.className = 'scope-spacer';
      sp.style.width = m.rowNumW + 'px';
      box.appendChild(sp);
      for (let i = 0; i < n; i++) {
        const c = document.createElement('canvas');
        c.className = 'scope';
        c.style.marginLeft = '3px';
        c.style.marginRight = '7px';
        c.style.width = (m.cellW - 10) + 'px';
        box.appendChild(c);
      }
    }
    for (let i = 0; i < n; i++) {
      const c = box.children[i + 1];
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth || 120, h = c.clientHeight || 48;
      if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0d1017';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = state.muted[i] ? '#3a4456' : '#7ee08a';
      ctx.beginPath();
      const d = data ? data[i] : null;
      for (let x = 0; x < w; x++) {
        const v = d ? d[Math.floor(x / w * d.length)] : 0;
        const y = h / 2 - v * (h / 2 - 2);
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // ---- player events ----------------------------------------------------------

  player.onpos = m => {
    state.playPos = m.pos;
    state.playRow = m.row;
    state.lastRowTime = performance.now();
    $('bpmInput').value = m.bpm;
    $('speedInput').value = m.speed;
    if (state.follow) {
      state.curPos = Math.min(m.pos, state.song.order.length - 1);
      state.cursor.row = m.row;
    }
    renderOrder();
    renderStatus();
    drawPattern();
  };
  player.onscope = m => drawScopes(m.data);
  player.onstopped = () => {
    state.playing = false;
    state.playRow = -1;
    renderStatus();
    drawPattern();
    drawScopes(null);
  };

  // ---- transport --------------------------------------------------------------

  async function playSong(fromCurrent) {
    await player.ensure();
    player.sendSong(state.song);
    player.setMute(state.muted);
    player.msg({ type: 'paula', on: state.paula });
    state.playing = true;
    state.recUndo = false;
    state.playPos = fromCurrent ? state.curPos : 0;
    player.play({
      pos: fromCurrent ? state.curPos : 0, row: 0, patternMode: false,
      speed: parseInt($('speedInput').value, 10) || 6,
      bpm: parseInt($('bpmInput').value, 10) || 125
    });
    renderStatus();
  }

  async function playPattern() {
    await player.ensure();
    player.sendSong(state.song);
    player.setMute(state.muted);
    player.msg({ type: 'paula', on: state.paula });
    state.playing = true;
    state.recUndo = false;
    state.playPos = state.curPos;
    player.play({
      pos: state.curPos, row: 0, patternMode: true,
      speed: parseInt($('speedInput').value, 10) || 6,
      bpm: parseInt($('bpmInput').value, 10) || 125
    });
    renderStatus();
  }

  function stop() {
    player.stop();
    state.playing = false;
    state.playRow = -1;
    state.recUndo = false;
    renderStatus();
    drawPattern();
  }

  // ---- editing ------------------------------------------------------------------

  function clampCursor() {
    const c = state.cursor;
    c.row = Math.max(0, Math.min(63, c.row));
    c.ch = Math.max(0, Math.min(state.song.channels - 1, c.ch));
    c.col = Math.max(0, Math.min(5, c.col));
  }

  function clearSel() { state.sel = null; state.selAnchor = null; }

  function moveCursor(dr, dc, extendSel) {
    const c = state.cursor;
    if (extendSel && !state.selAnchor) state.selAnchor = { row: c.row, ch: c.ch };
    if (dr) c.row = (c.row + dr + 64) % 64;
    if (dc && extendSel) {
      // selection extends whole channels at a time
      c.ch = Math.max(0, Math.min(state.song.channels - 1, c.ch + dc));
    } else if (dc) {
      let lin = c.ch * 6 + c.col + dc;
      const max = state.song.channels * 6;
      lin = (lin + max) % max;
      c.ch = (lin / 6) | 0;
      c.col = lin % 6;
    }
    if (extendSel) {
      const a = state.selAnchor;
      state.sel = {
        r0: Math.min(a.row, c.row), r1: Math.max(a.row, c.row),
        c0: Math.min(a.ch, c.ch), c1: Math.max(a.ch, c.ch)
      };
    } else {
      clearSel();
    }
    renderStatus();
    drawPattern();
  }

  function patchCell(fn) {
    const p = curPattern();
    pushUndo('pattern', p);
    const [n, s, f, pm] = MOD.cellGet(state.song, p, state.cursor.row, state.cursor.ch);
    const out = fn(n, s, f, pm);
    MOD.cellSet(state.song, p, state.cursor.row, state.cursor.ch, out[0], out[1], out[2], out[3]);
    player.sendPattern(state.song, p);
    scheduleAutosave();
  }

  function advanceRow() {
    state.cursor.row = (state.cursor.row + state.step) % 64;
  }

  // ---- block operations -----------------------------------------------------------

  function selOrCursor() {
    return state.sel || {
      r0: state.cursor.row, r1: state.cursor.row,
      c0: state.cursor.ch, c1: state.cursor.ch
    };
  }

  function copyBlock(cut) {
    const s = selOrCursor();
    const rows = s.r1 - s.r0 + 1, chs = s.c1 - s.c0 + 1;
    const cells = new Uint8Array(rows * chs * 4);
    const p = curPattern();
    for (let r = 0; r < rows; r++) {
      for (let ch = 0; ch < chs; ch++) {
        const cell = MOD.cellGet(state.song, p, s.r0 + r, s.c0 + ch);
        cells.set(cell, (r * chs + ch) * 4);
      }
    }
    state.clipboard = { rows, chs, cells };
    if (cut) {
      pushUndo('pattern', p);
      for (let r = 0; r < rows; r++)
        for (let ch = 0; ch < chs; ch++)
          MOD.cellSet(state.song, p, s.r0 + r, s.c0 + ch, 0, 0, 0, 0);
      player.sendPattern(state.song, p);
      scheduleAutosave();
      drawPattern();
    }
    setStatusMsg((cut ? 'Cut' : 'Copied') + ` ${rows}×${chs} block`);
  }

  function pasteBlock() {
    const cb = state.clipboard;
    if (!cb) { setStatusMsg('Clipboard is empty'); return; }
    const p = curPattern();
    pushUndo('pattern', p);
    for (let r = 0; r < cb.rows; r++) {
      const tr = state.cursor.row + r;
      if (tr > 63) break;
      for (let ch = 0; ch < cb.chs; ch++) {
        const tc = state.cursor.ch + ch;
        if (tc >= state.song.channels) break;
        const o = (r * cb.chs + ch) * 4;
        MOD.cellSet(state.song, p, tr, tc, cb.cells[o], cb.cells[o + 1], cb.cells[o + 2], cb.cells[o + 3]);
      }
    }
    player.sendPattern(state.song, p);
    scheduleAutosave();
    drawPattern();
    setStatusMsg(`Pasted ${cb.rows}×${cb.chs} block`);
  }

  function clearBlock() {
    const s = selOrCursor();
    const p = curPattern();
    pushUndo('pattern', p);
    for (let r = s.r0; r <= s.r1; r++)
      for (let ch = s.c0; ch <= s.c1; ch++)
        MOD.cellSet(state.song, p, r, ch, 0, 0, 0, 0);
    player.sendPattern(state.song, p);
    scheduleAutosave();
    drawPattern();
  }

  function transposeBlock(delta) {
    const s = selOrCursor();
    const p = curPattern();
    pushUndo('pattern', p);
    for (let r = s.r0; r <= s.r1; r++) {
      for (let ch = s.c0; ch <= s.c1; ch++) {
        const [n, smp, f, pm] = MOD.cellGet(state.song, p, r, ch);
        if (n) MOD.cellSet(state.song, p, r, ch, Math.max(1, Math.min(36, n + delta)), smp, f, pm);
      }
    }
    player.sendPattern(state.song, p);
    scheduleAutosave();
    drawPattern();
    setStatusMsg(`Transposed ${delta > 0 ? '+' : ''}${delta}`);
  }

  function selectChannelOrAll() {
    const whole = state.sel && state.sel.r0 === 0 && state.sel.r1 === 63 &&
      state.sel.c0 === state.cursor.ch && state.sel.c1 === state.cursor.ch;
    state.sel = whole
      ? { r0: 0, r1: 63, c0: 0, c1: state.song.channels - 1 }
      : { r0: 0, r1: 63, c0: state.cursor.ch, c1: state.cursor.ch };
    state.selAnchor = null;
    drawPattern();
  }

  // classic tracker track ops: Insert pushes the channel down, Backspace pulls it up
  function insertRow() {
    const p = curPattern(), ch = state.cursor.ch, row = state.cursor.row;
    pushUndo('pattern', p);
    for (let r = 63; r > row; r--) {
      const c = MOD.cellGet(state.song, p, r - 1, ch);
      MOD.cellSet(state.song, p, r, ch, c[0], c[1], c[2], c[3]);
    }
    MOD.cellSet(state.song, p, row, ch, 0, 0, 0, 0);
    player.sendPattern(state.song, p);
    scheduleAutosave();
    drawPattern();
  }

  function deleteRowPullUp() {
    const p = curPattern(), ch = state.cursor.ch;
    const row = state.cursor.row;
    if (row === 0) return;
    pushUndo('pattern', p);
    for (let r = row - 1; r < 63; r++) {
      const c = MOD.cellGet(state.song, p, r + 1, ch);
      MOD.cellSet(state.song, p, r, ch, c[0], c[1], c[2], c[3]);
    }
    MOD.cellSet(state.song, p, 63, ch, 0, 0, 0, 0);
    state.cursor.row = row - 1;
    player.sendPattern(state.song, p);
    scheduleAutosave();
    drawPattern(); renderStatus();
  }

  // ---- keyboard -------------------------------------------------------------------

  const NOTE_KEYS = {
    KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
    KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
    Semicolon: 15, Slash: 16,
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
    KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25,
    KeyO: 26, Digit0: 27, KeyP: 28
  };

  async function jamNote(note, code) {
    await player.ensure();
    if (!player._sentOnce) { player.sendSong(state.song); player._sentOnce = true; }
    if (!state.playing) {
      player.jam(state.cursor.ch, state.curSample, note);
      state.jamHeld[code] = state.cursor.ch;
    } else if (state.editMode) {
      // record mode: sound the note immediately on the cursor channel
      player.jam(state.cursor.ch, state.curSample, note);
    }
  }

  // record mode: write the played note at the current play row, quantized to
  // the nearest row using the time since the row started
  function recordNote(note) {
    const speed = parseInt($('speedInput').value, 10) || 6;
    const bpm = parseInt($('bpmInput').value, 10) || 125;
    const rowMs = speed * 2500 / bpm;
    const frac = state.lastRowTime ? (performance.now() - state.lastRowTime) / rowMs : 0;
    let row = state.playRow >= 0 ? state.playRow : 0;
    if (frac > 0.5) row = Math.min(63, row + 1);
    const p = state.song.order[state.playPos >= 0 ? state.playPos : state.curPos] | 0;
    if (!state.recUndo) { pushUndo('pattern', p); state.recUndo = true; }
    const [, , f, pm] = MOD.cellGet(state.song, p, row, state.cursor.ch);
    MOD.cellSet(state.song, p, row, state.cursor.ch, note, state.curSample + 1, f, pm);
    player.sendPattern(state.song, p);
    scheduleAutosave();
    drawPattern();
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' &&
        (e.target.type === 'text' || e.target.type === 'number')) return;

    // help modal captures everything except its own close keys
    if (!$('helpModal').classList.contains('hidden')) {
      if (e.code === 'Escape' || e.code === 'F1' || e.key === '?') {
        e.preventDefault();
        toggleHelp(false);
      }
      return;
    }

    const c = state.cursor;
    const code = e.code;
    const mod = e.metaKey || e.ctrlKey;

    // undo / redo / clipboard / select-all
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (k === 'y') { e.preventDefault(); doRedo(); return; }
      if (k === 'c') { e.preventDefault(); copyBlock(false); return; }
      if (k === 'x') { e.preventDefault(); copyBlock(true); return; }
      if (k === 'v') { e.preventDefault(); pasteBlock(); return; }
      if (k === 'a') { e.preventDefault(); selectChannelOrAll(); return; }
      return;
    }

    // transpose: Shift+Alt+Up/Down = ±1 semitone, +Ctrl…no — Shift+Alt+PgUp/PgDn = ±12
    if (e.shiftKey && e.altKey) {
      if (code === 'ArrowUp') { e.preventDefault(); transposeBlock(1); return; }
      if (code === 'ArrowDown') { e.preventDefault(); transposeBlock(-1); return; }
      if (code === 'PageUp') { e.preventDefault(); transposeBlock(12); return; }
      if (code === 'PageDown') { e.preventDefault(); transposeBlock(-12); return; }
    }

    // transport
    if (code === 'Space') {
      e.preventDefault();
      if (state.playing) stop();
      else if (e.shiftKey) playSong(true);
      else playPattern();
      return;
    }
    if (code === 'Escape') {
      if (state.sel) { clearSel(); drawPattern(); }
      else stop();
      return;
    }
    if (code === 'F1') { e.preventDefault(); toggleHelp(true); return; }

    // navigation (shift extends the selection)
    switch (code) {
      case 'ArrowUp': e.preventDefault(); moveCursor(-1, 0, e.shiftKey); return;
      case 'ArrowDown': e.preventDefault(); moveCursor(1, 0, e.shiftKey); return;
      case 'ArrowLeft': e.preventDefault(); moveCursor(0, -1, e.shiftKey); return;
      case 'ArrowRight': e.preventDefault(); moveCursor(0, 1, e.shiftKey); return;
      case 'Tab':
        e.preventDefault();
        c.ch = (c.ch + (e.shiftKey ? -1 : 1) + state.song.channels) % state.song.channels;
        c.col = 0;
        clearSel();
        renderStatus(); drawPattern();
        return;
      case 'PageUp': e.preventDefault(); c.row = Math.max(0, c.row - 16); clearSel(); drawPattern(); renderStatus(); return;
      case 'PageDown': e.preventDefault(); c.row = Math.min(63, c.row + 16); clearSel(); drawPattern(); renderStatus(); return;
      case 'Home': e.preventDefault(); c.row = 0; clearSel(); drawPattern(); renderStatus(); return;
      case 'End': e.preventDefault(); c.row = 63; clearSel(); drawPattern(); renderStatus(); return;
      case 'BracketLeft': state.octave = Math.max(1, state.octave - 1); scheduleAutosave(); renderStatus(); return;
      case 'BracketRight': state.octave = Math.min(3, state.octave + 1); scheduleAutosave(); renderStatus(); return;
      case 'Insert':
        if (state.editMode) { e.preventDefault(); insertRow(); }
        return;
      case 'Backspace':
        if (state.editMode) { e.preventDefault(); deleteRowPullUp(); }
        return;
      case 'Delete':
        if (state.editMode) {
          e.preventDefault();
          if (state.sel) { clearBlock(); return; }
          if (e.shiftKey) patchCell(() => [0, 0, 0, 0]);
          else if (c.col === 0) patchCell((n, s, f, p) => [0, 0, f, p]);
          else if (c.col <= 2) patchCell((n, s, f, p) => [n, 0, f, p]);
          else patchCell((n, s) => [n, s, 0, 0]);
          advanceRow();
          drawPattern(); renderStatus();
        }
        return;
    }

    // note entry (only in note column)
    if (c.col === 0 && NOTE_KEYS.hasOwnProperty(code) && !mod && !e.altKey) {
      e.preventDefault();
      if (e.repeat) return;
      let note = (state.octave - 1) * 12 + NOTE_KEYS[code] + 1;
      if (note > 36) note = 36;
      jamNote(note, code);
      if (state.editMode && !state.playing) {
        patchCell(() => {
          const [, , f, p] = MOD.cellGet(state.song, curPattern(), c.row, c.ch);
          return [note, state.curSample + 1, f, p];
        });
        advanceRow();
        drawPattern(); renderStatus();
      } else if (state.editMode && state.playing) {
        recordNote(note);
      }
      return;
    }

    // hex entry for sample / effect / param columns
    if (state.editMode && c.col > 0 && /^[0-9a-fA-F]$/.test(e.key) && !mod) {
      e.preventDefault();
      const v = parseInt(e.key, 16);
      patchCell((n, s, f, p) => {
        switch (c.col) {
          case 1: s = Math.min(31, (v << 4) | (s & 15)); break;
          case 2: s = Math.min(31, (s & 0xF0) | v); break;
          case 3: f = v; break;
          case 4: p = (v << 4) | (p & 15); break;
          case 5: p = (p & 0xF0) | v; break;
        }
        return [n, s, f, p];
      });
      advanceRow();
      drawPattern(); renderStatus();
      return;
    }
  }

  function onKeyUp(e) {
    const ch = state.jamHeld[e.code];
    if (ch !== undefined) {
      delete state.jamHeld[e.code];
      const s = state.song.samples[state.curSample];
      if (s && s.loopLen > 2) player.jamStop(ch); // stop held looped notes on release
    }
  }

  // ---- pattern canvas mouse (click = cursor, drag = selection) -----------------------

  let patDrag = null;

  function patHit(e) {
    const r = patCanvas.getBoundingClientRect();
    return PatternView.hitTest(patCanvas, state.song,
      { cursor: state.cursor, playRow: state.playing ? state.playRow : -1, follow: state.follow },
      e.clientX - r.left, e.clientY - r.top);
  }

  patCanvas.addEventListener('mousedown', e => {
    const hit = patHit(e);
    if (!hit) return;
    patDrag = { row: hit.row, ch: hit.ch, moved: false };
    state.cursor = hit;
    clampCursor();
    clearSel();
    drawPattern(); renderStatus();
  });

  window.addEventListener('mousemove', e => {
    if (!patDrag) return;
    const hit = patHit(e);
    if (!hit) return;
    if (hit.row !== patDrag.row || hit.ch !== patDrag.ch) patDrag.moved = true;
    if (patDrag.moved) {
      state.sel = {
        r0: Math.min(patDrag.row, hit.row), r1: Math.max(patDrag.row, hit.row),
        c0: Math.min(patDrag.ch, hit.ch), c1: Math.max(patDrag.ch, hit.ch)
      };
      state.cursor.row = hit.row;
      state.cursor.ch = hit.ch;
      clampCursor();
      drawPattern(); renderStatus();
    }
  });

  window.addEventListener('mouseup', () => { patDrag = null; });

  patCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    state.cursor.row = Math.max(0, Math.min(63, state.cursor.row + Math.sign(e.deltaY)));
    drawPattern(); renderStatus();
  }, { passive: false });

  // keep channel headers and scopes horizontally aligned with the pattern grid
  const patWrap = document.querySelector('.pattern-wrap');
  patWrap.addEventListener('scroll', () => {
    $('chanHeaders').scrollLeft = patWrap.scrollLeft;
    $('scopes').scrollLeft = patWrap.scrollLeft;
  });

  // ---- order editor ---------------------------------------------------------------

  function orderChanged() {
    player.sendOrder(state.song);
    scheduleAutosave();
    renderOrder(); renderStatus(); drawPattern();
  }

  $('ordIns').onclick = () => {
    pushUndo('order');
    state.song.order.splice(state.curPos + 1, 0, state.song.order[state.curPos]);
    if (state.song.order.length > 128) state.song.order.length = 128;
    state.curPos++;
    orderChanged();
  };
  $('ordDel').onclick = () => {
    if (state.song.order.length <= 1) return;
    pushUndo('order');
    state.song.order.splice(state.curPos, 1);
    state.curPos = Math.min(state.curPos, state.song.order.length - 1);
    orderChanged();
  };
  $('ordPrev').onclick = () => { state.curPos = Math.max(0, state.curPos - 1); renderAll(); };
  $('ordNext').onclick = () => { state.curPos = Math.min(state.song.order.length - 1, state.curPos + 1); renderAll(); };
  $('patDec').onclick = () => {
    pushUndo('order');
    state.song.order[state.curPos] = Math.max(0, curPattern() - 1);
    orderChanged();
  };
  $('patInc').onclick = () => {
    pushUndo('order');
    const np = Math.min(99, curPattern() + 1);
    state.song.order[state.curPos] = np;
    while (state.song.patterns.length <= np) {
      state.song.patterns.push(MOD.newPattern(state.song.channels));
      player.sendPattern(state.song, state.song.patterns.length - 1);
    }
    orderChanged();
  };

  // ---- channel count ----------------------------------------------------------------

  function setChannels(n) {
    n = Math.max(4, Math.min(8, n));
    const song = state.song;
    const old = song.channels;
    if (n === old) return;
    if (n < old) {
      let hasData = false;
      outer: for (const pd of song.patterns) {
        for (let r = 0; r < 64; r++) {
          for (let ch = n; ch < old; ch++) {
            const o = (r * old + ch) * 4;
            if (pd[o] || pd[o + 1] || pd[o + 2] || pd[o + 3]) { hasData = true; break outer; }
          }
        }
      }
      if (hasData && !confirm(`Channels ${n + 1}–${old} contain data that will be deleted. Continue?`)) return;
    }
    stop();
    pushUndo('channels');
    song.patterns = song.patterns.map(pd => {
      const np = MOD.newPattern(n);
      for (let r = 0; r < 64; r++) {
        for (let ch = 0; ch < Math.min(old, n); ch++) {
          for (let k = 0; k < 4; k++) np[(r * n + ch) * 4 + k] = pd[(r * old + ch) * 4 + k];
        }
      }
      return np;
    });
    song.channels = n;
    state.muted = state.muted.slice(0, n);
    while (state.muted.length < n) state.muted.push(false);
    clampCursor();
    clearSel();
    player.sendSong(song);
    player.setMute(state.muted);
    renderAll();
    drawScopes(null);
    scheduleAutosave();
    setStatusMsg(`${n} channels — saves as ${n === 4 ? 'M.K.' : n + 'CHN'}` +
      (n === 5 || n === 7 ? ' (rare tag; 4, 6 or 8 channels is most compatible)' : ''));
  }

  $('chDec').onclick = () => setChannels(state.song.channels - 1);
  $('chInc').onclick = () => setChannels(state.song.channels + 1);

  // ---- transport buttons ------------------------------------------------------------

  $('btnPlaySong').onclick = () => playSong(false);
  $('btnPlayHere').onclick = () => playSong(true);
  $('btnPlayPat').onclick = () => playPattern();
  $('btnStop').onclick = () => stop();
  $('editBtn').onclick = () => { state.editMode = !state.editMode; scheduleAutosave(); renderStatus(); drawPattern(); };
  $('followBtn').onclick = () => { state.follow = !state.follow; scheduleAutosave(); renderStatus(); };
  $('paulaBtn').onclick = () => {
    state.paula = !state.paula;
    player.msg({ type: 'paula', on: state.paula });
    scheduleAutosave();
    renderStatus();
    setStatusMsg(state.paula
      ? 'Paula mode: 8-bit nearest-neighbour + Amiga RC filter (E0x toggles the LED filter)'
      : 'Modern mode: linear interpolation, no output filters');
  };
  $('octDown').onclick = () => { state.octave = Math.max(1, state.octave - 1); scheduleAutosave(); renderStatus(); };
  $('octUp').onclick = () => { state.octave = Math.min(3, state.octave + 1); scheduleAutosave(); renderStatus(); };
  $('stepDown').onclick = () => { state.step = Math.max(0, state.step - 1); scheduleAutosave(); renderStatus(); };
  $('stepUp').onclick = () => { state.step = Math.min(16, state.step + 1); scheduleAutosave(); renderStatus(); };

  $('bpmInput').onchange = () => {
    player.msg({ type: 'speed', bpm: parseInt($('bpmInput').value, 10) || 125 });
    scheduleAutosave();
  };
  $('speedInput').onchange = () => {
    player.msg({ type: 'speed', speed: parseInt($('speedInput').value, 10) || 6 });
    scheduleAutosave();
  };

  $('songTitle').oninput = () => {
    state.song.title = $('songTitle').value.slice(0, 20);
    scheduleAutosave();
  };

  // ---- help modal -------------------------------------------------------------------

  function toggleHelp(show) {
    $('helpModal').classList.toggle('hidden', !show);
  }
  $('btnHelp').onclick = () => toggleHelp(true);
  $('helpClose').onclick = () => toggleHelp(false);
  $('helpModal').addEventListener('mousedown', e => {
    if (e.target === $('helpModal')) toggleHelp(false);
  });

  // ---- file I/O -----------------------------------------------------------------------

  function adoptSong(song, msg) {
    stop();
    state.song = song;
    state.curPos = 0;
    state.cursor = { row: 0, ch: 0, col: 0 };
    state.curSample = 0;
    state.muted = new Array(song.channels).fill(false);
    state.wave.a = state.wave.b = -1;
    clearHistory();
    if (song.initBPM) $('bpmInput').value = song.initBPM;
    if (song.initSpeed) $('speedInput').value = song.initSpeed;
    player.sendSong(song);
    player.setMute(state.muted);
    renderAll();
    if (msg) setStatusMsg(msg);
    scheduleAutosave();
  }

  $('btnNew').onclick = () => {
    if (!confirm('Start a new song? Unsaved changes will be lost.')) return;
    adoptSong(MOD.newSong(4), 'New song');
  };

  function parseModuleBuffer(buf) {
    const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 17)));
    if (head.startsWith('MMD')) {
      const song = MED.parse(buf);
      return { song, kind: song.medInfo || 'OctaMED' };
    }
    if (head === 'Extended Module: ') {
      const song = XM.parse(buf);
      return { song, kind: song.xmInfo || 'FastTracker II' };
    }
    return { song: MOD.parse(buf), kind: 'ProTracker' };
  }

  async function loadModuleFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 16));
      let i = 0;
      while (i < head.length && (head[i] === 32 || head[i] === 9 || head[i] === 10 || head[i] === 13)) i++;
      if (head[i] === 0x7B) { // '{' — a WebTracker .wtp project
        const { song, paula } = parseProjectJson(new TextDecoder().decode(buf));
        adoptSong(song, `Loaded project "${song.title || file.name}" — ${song.channels}ch, ` +
          `${song.patterns.length} patterns`);
        if (paula !== null && paula !== state.paula) {
          state.paula = paula;
          player.msg({ type: 'paula', on: paula });
          renderStatus();
        }
        return;
      }
      const { song, kind } = parseModuleBuffer(buf);
      adoptSong(song, `Loaded "${song.title || file.name}" — ${song.channels}ch, ` +
        `${song.patterns.length} patterns (${kind})`);
    } catch (err) {
      alert('Could not load module: ' + err.message);
    }
  }

  $('btnLoad').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    loadModuleFile(file);
  };

  function dragHasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }

  window.addEventListener('dragenter', e => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });

  window.addEventListener('dragover', e => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dragging');
  });

  window.addEventListener('dragleave', e => {
    if (e.relatedTarget) return;
    document.body.classList.remove('dragging');
  });

  window.addEventListener('drop', e => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    const files = Array.from(e.dataTransfer.files || []);
    const moduleFile = files.find(file => /\.(mod|med|mmd|xm|wtp)$/i.test(file.name)) || files[0];
    if (moduleFile) loadModuleFile(moduleFile);
  });

  $('btnSave').onclick = () => {
    const bytes = MOD.save(state.song);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.song.title.trim().replace(/[^\w\- ]/g, '') || 'untitled') + '.mod';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatusMsg('Saved ' + a.download + ' (ProTracker format)');
  };

  $('btnSaveProj').onclick = () => {
    const blob = new Blob([buildProjectJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.song.title.trim().replace(/[^\w\- ]/g, '') || 'untitled') + '.wtp';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatusMsg('Saved ' + a.download + ' (full-fidelity WebTracker project)');
  };

  // ---- WAV export -----------------------------------------------------------------------

  // walk the song once, honoring speed/tempo changes, jumps, breaks, loops and
  // pattern delay, to estimate its duration in seconds
  function simulateDuration(song, speed0, bpm0) {
    let pos = 0, row = 0, speed = speed0, bpm = bpm0, time = 0, guard = 0;
    const loopCnt = new Array(song.channels).fill(0);
    const loopRow = new Array(song.channels).fill(0);
    while (pos < song.order.length && time < 1200 && guard++ < 500000) {
      const pd = song.patterns[song.order[pos]];
      let rowDelay = 0, brk = false, brkRow = 0, jump = -1, loopJump = -1;
      if (pd) for (let ch = 0; ch < song.channels; ch++) {
        const o = (row * song.channels + ch) * 4;
        const fx = pd[o + 2], pm = pd[o + 3];
        if (fx === 0xF && pm) { if (pm < 32) speed = pm; else bpm = pm; }
        else if (fx === 0xB) { brk = true; jump = pm; brkRow = 0; }
        else if (fx === 0xD) { brk = true; if (jump < 0) brkRow = Math.min(63, (pm >> 4) * 10 + (pm & 15)); }
        else if (fx === 0xE) {
          const x = pm >> 4, y = pm & 15;
          if (x === 0xE) rowDelay = y;
          else if (x === 6) {
            if (y === 0) loopRow[ch] = row;
            else if (loopCnt[ch] === 0) { loopCnt[ch] = y; loopJump = loopRow[ch]; }
            else { loopCnt[ch]--; if (loopCnt[ch] !== 0) loopJump = loopRow[ch]; }
          }
        }
      }
      time += (1 + rowDelay) * speed * 2.5 / bpm;
      if (loopJump >= 0) { row = loopJump; continue; }
      if (brk) {
        if (jump >= 0 && jump <= pos) break; // backward jump: song loops here
        pos = jump >= 0 ? jump : pos + 1;
        row = brkRow;
      } else {
        row++;
        if (row >= 64) { row = 0; pos++; }
      }
    }
    return Math.min(1200, time);
  }

  function encodeWav(audioBuf) {
    const n = audioBuf.length, ch = 2, sr = audioBuf.sampleRate;
    const bytes = 44 + n * ch * 2;
    const b = new DataView(new ArrayBuffer(bytes));
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); b.setUint32(4, bytes - 8, true); ws(8, 'WAVE');
    ws(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, ch, true);
    b.setUint32(24, sr, true); b.setUint32(28, sr * ch * 2, true); b.setUint16(32, ch * 2, true);
    b.setUint16(34, 16, true);
    ws(36, 'data'); b.setUint32(40, n * ch * 2, true);
    const L = audioBuf.getChannelData(0), R = audioBuf.getChannelData(1);
    let o = 44;
    for (let i = 0; i < n; i++) {
      b.setInt16(o, Math.max(-32768, Math.min(32767, L[i] * 32767)), true); o += 2;
      b.setInt16(o, Math.max(-32768, Math.min(32767, R[i] * 32767)), true); o += 2;
    }
    return b.buffer;
  }

  $('btnExport').onclick = async () => {
    const btn = $('btnExport');
    if (btn.disabled) return;
    const speed = parseInt($('speedInput').value, 10) || 6;
    const bpm = parseInt($('bpmInput').value, 10) || 125;
    const dur = simulateDuration(state.song, speed, bpm) + 1;
    btn.disabled = true;
    setStatusMsg(`Rendering ${dur.toFixed(1)}s of audio…`);
    try {
      const sr = 44100;
      const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
      await ctx.audioWorklet.addModule('js/worklet.js');
      // song + transport go via processorOptions: port messages are not
      // reliably delivered before offline rendering starts
      const node = new AudioWorkletNode(ctx, 'mod-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: {
          song: Player.serializeSong(state.song),
          mute: state.muted.slice(),
          paula: state.paula,
          play: { pos: 0, row: 0, patternMode: false, speed, bpm }
        }
      });
      node.connect(ctx.destination);
      const rendered = await ctx.startRendering();
      const blob = new Blob([encodeWav(rendered)], { type: 'audio/wav' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.song.title.trim().replace(/[^\w\- ]/g, '') || 'untitled') + '.wav';
      a.click();
      URL.revokeObjectURL(a.href);
      setStatusMsg(`Exported ${a.download} (${dur.toFixed(1)}s, 44.1 kHz 16-bit stereo)`);
    } catch (err) {
      setStatusMsg('WAV export failed: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  };

  // ---- sample property editing --------------------------------------------------------

  function setStatusMsg(msg) {
    $('statusMsg').textContent = msg;
  }

  function sampleChanged() {
    player.sendSample(state.song, state.curSample);
    scheduleAutosave();
    renderSamples(); renderSampleProps();
  }

  $('smpName').onchange = () => {
    pushUndo('sample', state.curSample);
    state.song.samples[state.curSample].name = $('smpName').value.slice(0, 22);
    sampleChanged();
  };
  $('smpVol').onchange = () => {
    pushUndo('sample', state.curSample);
    state.song.samples[state.curSample].volume = Math.max(0, Math.min(64, parseInt($('smpVol').value, 10) || 0));
    sampleChanged();
  };
  $('smpFine').onchange = () => {
    pushUndo('sample', state.curSample);
    state.song.samples[state.curSample].finetune = Math.max(-8, Math.min(7, parseInt($('smpFine').value, 10) || 0));
    sampleChanged();
  };
  $('smpLoopStart').onchange = $('smpLoopLen').onchange = () => {
    pushUndo('sample', state.curSample);
    const s = state.song.samples[state.curSample];
    s.loopStart = Math.max(0, (parseInt($('smpLoopStart').value, 10) || 0) & ~1);
    s.loopLen = Math.max(0, (parseInt($('smpLoopLen').value, 10) || 0) & ~1);
    if (s.loopStart >= s.data.length) s.loopStart = 0;
    if (s.loopStart + s.loopLen > s.data.length) s.loopLen = Math.max(0, s.data.length - s.loopStart);
    sampleChanged();
  };

  $('btnSmpClear').onclick = () => {
    if (!confirm('Clear this sample?')) return;
    pushUndo('sample', state.curSample);
    state.song.samples[state.curSample] = MOD.emptySample();
    state.wave.a = state.wave.b = -1;
    sampleChanged();
  };

  $('btnSmpImport').onclick = () => $('wavInput').click();
  $('wavInput').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await player.ensure();
      const buf = await file.arrayBuffer();
      const audio = await player.ctx.decodeAudioData(buf);
      const mono = new Float32Array(audio.length);
      for (let ch = 0; ch < audio.numberOfChannels; ch++) {
        const d = audio.getChannelData(ch);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels;
      }
      // resample to Amiga C-2 rate (PAL: 8287 Hz) and convert to signed 8-bit
      const RATE = 8287;
      const outLen = Math.min(131070, Math.floor(mono.length * RATE / audio.sampleRate)) & ~1;
      const out = new Int8Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const src = i * audio.sampleRate / RATE;
        const p = src | 0, frac = src - p;
        const v = mono[p] + ((mono[p + 1] || 0) - mono[p]) * frac;
        out[i] = Math.max(-127, Math.min(127, Math.round(v * 127)));
      }
      pushUndo('sample', state.curSample);
      const s = state.song.samples[state.curSample];
      s.data = out;
      s.loopStart = 0; s.loopLen = 0;
      s.volume = 64;
      if (!s.name) s.name = file.name.replace(/\.\w+$/, '').slice(0, 22);
      state.wave.a = state.wave.b = -1;
      sampleChanged();
      setStatusMsg(`Imported ${file.name} → ${outLen} bytes @ 8287 Hz (plays original pitch on C-2)`);
    } catch (err) {
      alert('Could not import audio: ' + err.message);
    }
  };

  // ---- waveform editor -------------------------------------------------------------------

  const waveCanvas = $('waveform');
  let waveDrag = null; // {mode:'select'|'draw', lastX, lastY}

  function waveByteAt(x) {
    const len = state.song.samples[state.curSample].data.length;
    return Math.max(0, Math.min(len, Math.round(x / waveCanvas.clientWidth * len)));
  }

  function waveValueAt(y) {
    const h = waveCanvas.clientHeight;
    return Math.max(-127, Math.min(127, Math.round((h / 2 - y) / (h / 2 - 2) * 127)));
  }

  function waveDrawAt(x, y, lastX, lastY) {
    const s = state.song.samples[state.curSample];
    if (!s.data.length) return;
    const i0 = Math.min(s.data.length - 1, waveByteAt(Math.min(x, lastX)));
    const i1 = Math.min(s.data.length - 1, waveByteAt(Math.max(x, lastX)));
    const v0 = waveValueAt(x <= lastX ? y : lastY);
    const v1 = waveValueAt(x <= lastX ? lastY : y);
    for (let i = i0; i <= i1; i++) {
      const t = i1 === i0 ? 0 : (i - i0) / (i1 - i0);
      s.data[i] = Math.round(v0 + (v1 - v0) * t);
    }
    drawWave();
  }

  waveCanvas.addEventListener('mousedown', e => {
    const r = waveCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (state.wave.mode === 'draw') {
      const s = state.song.samples[state.curSample];
      if (s.synth) { setStatusMsg('Synth instrument — waveform drawing not supported'); return; }
      if (!s.data.length) { // drawing on an empty slot creates a loopable wave
        pushUndo('sample', state.curSample);
        s.data = new Int8Array(128);
        s.loopStart = 0; s.loopLen = 128;
        s.volume = 64;
        if (!s.name) s.name = 'drawn wave';
      } else {
        pushUndo('sample', state.curSample);
      }
      waveDrag = { mode: 'draw', lastX: x, lastY: y };
      waveDrawAt(x, y, x, y);
    } else {
      state.wave.a = waveByteAt(x);
      state.wave.b = state.wave.a;
      waveDrag = { mode: 'select' };
      renderWaveSel(); drawWave();
    }
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!waveDrag) return;
    const r = waveCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (waveDrag.mode === 'draw') {
      waveDrawAt(x, y, waveDrag.lastX, waveDrag.lastY);
      waveDrag.lastX = x; waveDrag.lastY = y;
    } else {
      state.wave.b = waveByteAt(x);
      renderWaveSel(); drawWave();
    }
  });

  window.addEventListener('mouseup', () => {
    if (waveDrag) {
      if (waveDrag.mode === 'draw') sampleChanged();
      waveDrag = null;
    }
  });

  $('wvMode').onclick = () => {
    state.wave.mode = state.wave.mode === 'draw' ? 'select' : 'draw';
    $('wvMode').classList.toggle('active', state.wave.mode === 'draw');
    drawWave();
  };

  // an op over the wave selection (or the whole sample when nothing is selected)
  function waveOp(fn, needData = true) {
    const s = state.song.samples[state.curSample];
    if (needData && !s.data.length) { setStatusMsg('Sample is empty'); return; }
    pushUndo('sample', state.curSample);
    const r = waveSelRange() || [0, s.data.length];
    fn(s, r[0], r[1]);
    if (s.loopStart >= s.data.length) { s.loopStart = 0; s.loopLen = 0; }
    if (s.loopStart + s.loopLen > s.data.length) s.loopLen = Math.max(0, s.data.length - s.loopStart);
    sampleChanged();
  }

  $('wvTrim').onclick = () => {
    if (!waveSelRange()) { setStatusMsg('Select a region to trim to'); return; }
    waveOp((s, a, b) => {
      s.data = s.data.slice(a & ~1, b & ~1);
      s.loopStart = Math.max(0, s.loopStart - (a & ~1));
      state.wave.a = state.wave.b = -1;
    });
  };

  $('wvCut').onclick = () => {
    if (!waveSelRange()) { setStatusMsg('Select a region to cut'); return; }
    waveOp((s, a, b) => {
    a &= ~1; b &= ~1;
    const d = new Int8Array(s.data.length - (b - a));
    d.set(s.data.slice(0, a), 0);
    d.set(s.data.slice(b), a);
    s.data = d;
    if (s.loopStart >= b) s.loopStart -= (b - a);
    state.wave.a = state.wave.b = -1;
    });
  };

  $('wvFadeIn').onclick = () => waveOp((s, a, b) => {
    for (let i = a; i < b; i++) s.data[i] = Math.round(s.data[i] * (i - a) / (b - a));
  });

  $('wvFadeOut').onclick = () => waveOp((s, a, b) => {
    for (let i = a; i < b; i++) s.data[i] = Math.round(s.data[i] * (b - 1 - i) / (b - a));
  });

  $('wvNorm').onclick = () => waveOp((s, a, b) => {
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(s.data[i]));
    if (!peak) return;
    const g = 127 / peak;
    for (let i = a; i < b; i++) s.data[i] = Math.max(-127, Math.min(127, Math.round(s.data[i] * g)));
  });

  $('wvRev').onclick = () => waveOp((s, a, b) => {
    for (let i = a, j = b - 1; i < j; i++, j--) {
      const t = s.data[i]; s.data[i] = s.data[j]; s.data[j] = t;
    }
  });

  $('wvSil').onclick = () => waveOp((s, a, b) => {
    for (let i = a; i < b; i++) s.data[i] = 0;
  });

  $('wvLoop').onclick = () => {
    const r = waveSelRange();
    if (!r) { setStatusMsg('Select a region to loop'); return; }
    pushUndo('sample', state.curSample);
    const s = state.song.samples[state.curSample];
    s.loopStart = r[0] & ~1;
    s.loopLen = (r[1] - r[0]) & ~1;
    sampleChanged();
    setStatusMsg(`Loop set: ${s.loopStart} +${s.loopLen}`);
  };

  // ---- boot ----------------------------------------------------------------------------

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', () => { drawPattern(); drawScopes(null); drawWave(); });

  // audio needs a user gesture — init lazily on first interaction
  const initAudio = () => {
    player.ensure().then(() => {
      player.sendSong(state.song);
      player._sentOnce = true;
    }).catch(err => setStatusMsg('Audio init failed: ' + err.message));
    window.removeEventListener('pointerdown', initAudio);
  };
  window.addEventListener('pointerdown', initAudio);

  renderAll();
  drawScopes(null);
  restoreAutosave().then(restored => {
    if (!restored) setStatusMsg('Demo song loaded — Space plays the pattern, Shift+Space the song, F1 for help.');
  });

  // console access for debugging / tinkering
  window.tracker = { player, state, MOD, MED, XM,
    project: { build: buildProjectJson, parse: parseProjectJson } };
})();
