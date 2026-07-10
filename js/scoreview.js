/* scoreview.js - Standard notation editor over the current tracker pattern. */
'use strict';

(() => {
  let VF = window.VexFlow || null;
  const ROWS = 64;
  const SCORE_WIDTH = 920;
  const MEASURE_HEIGHT = 180;
  const STAVE_X = 38;
  const STAVE_WIDTH = 850;
  const KEY_OPTIONS = [
    ['Major', ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']],
    ['Minor', ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']]
  ];
  const EFFECTS = [
    'Arpeggio', 'Portamento up', 'Portamento down', 'Tone portamento',
    'Vibrato', 'Porta + volume slide', 'Vibrato + volume slide', 'Tremolo',
    'Panning / sync', 'Sample offset', 'Volume slide', 'Position jump',
    'Set volume', 'Pattern break', 'Extended command', 'Speed / tempo'
  ];
  const DURATION_BY_GRID = { 1: 'q', 2: '8', 4: '16', 8: '32' };
  const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const FLAT_NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

  class TrackerScoreView {
    constructor() {
      this.panel = document.getElementById('scorePanel');
      this.sheet = document.getElementById('scoreSheet');
      this.info = document.getElementById('scoreCellInfo');
      this.fallback = document.getElementById('scoreFallback');
      this.controls = {
        channel: document.getElementById('scoreChannel'),
        clef: document.getElementById('scoreClef'),
        key: document.getElementById('scoreKey'),
        time: document.getElementById('scoreTime'),
        grid: document.getElementById('scoreGrid'),
        row: document.getElementById('scoreRow'),
        note: document.getElementById('scoreNote'),
        instrument: document.getElementById('scoreInstrument'),
        effect: document.getElementById('scoreEffect'),
        param: document.getElementById('scoreParam')
      };
      this.active = false;
      this.signature = '';
      this.optionSignature = '';
      this.failed = false;
      this.enginePromise = null;
      this.initControls();
    }

    get tracker() { return window.tracker; }
    get state() { return this.tracker?.state; }
    get song() { return this.state?.song; }
    get patternIndex() { return this.song.order[this.state.curPos] | 0; }

    initControls() {
      for (const [label, keys] of KEY_OPTIONS) {
        const group = document.createElement('optgroup');
        group.label = label;
        for (const key of keys) {
          const option = document.createElement('option');
          option.value = key;
          option.textContent = `${key.replace('m', '')} ${key.endsWith('m') ? 'minor' : 'major'}`;
          group.appendChild(option);
        }
        this.controls.key.appendChild(group);
      }

      for (let note = 0; note <= 36; note++) {
        const option = document.createElement('option');
        option.value = String(note);
        option.textContent = note ? this.tracker.MOD.noteName(note) : 'REST';
        this.controls.note.appendChild(option);
      }

      const none = document.createElement('option');
      none.value = 'none';
      none.textContent = '-- none';
      this.controls.effect.appendChild(none);
      for (let effect = 0; effect < EFFECTS.length; effect++) {
        const option = document.createElement('option');
        option.value = String(effect);
        option.textContent = `${effect.toString(16).toUpperCase()} - ${EFFECTS[effect]}`;
        this.controls.effect.appendChild(option);
      }

      for (const name of ['clef', 'key', 'time', 'grid']) {
        this.controls[name].addEventListener('change', () => {
          const value = name === 'grid' ? Number(this.controls[name].value) : this.controls[name].value;
          this.tracker.ui.updateScoreMeta({ [name]: value });
        });
      }
      this.controls.channel.addEventListener('change', () => {
        const channel = Number(this.controls.channel.value);
        this.tracker.ui.updateScoreMeta({ channel });
        this.tracker.ui.setCursor(this.state.cursor.row, channel);
      });
      document.getElementById('scoreDetectKey').addEventListener('click', () => {
        const detected = this.tracker.ui.detectScoreKey();
        if (!detected) {
          this.info.textContent = 'NO NOTES AVAILABLE FOR KEY DETECTION';
          return;
        }
        this.controls.key.value = detected.key;
        this.info.textContent = `DETECTED ${detected.key}  ${Math.round(detected.confidence * 100)}% CONFIDENCE`;
        this.refresh(true);
      });
      document.getElementById('scoreWrite').addEventListener('click', () => this.writeCell());
      document.getElementById('scoreClear').addEventListener('click', () => this.clearCell());
      this.controls.param.addEventListener('input', () => {
        this.controls.param.value = this.controls.param.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 2);
      });
    }

    setActive(active) {
      this.active = active;
      if (active) {
        this.state.score.channel = Math.min(this.song.channels - 1, this.state.score.channel | 0);
        this.ensureEngine().then(() => {
          if (this.active) this.refresh(true);
        });
      }
    }

    ensureEngine() {
      if (VF) return Promise.resolve(VF);
      if (this.enginePromise) return this.enginePromise;
      this.enginePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'js/vendor/vexflow.min.js';
        script.onload = () => {
          VF = window.VexFlow;
          if (!VF) {
            reject(new Error('VexFlow did not initialize'));
            return;
          }
          resolve(VF);
        };
        script.onerror = () => reject(new Error('Could not load VexFlow'));
        document.head.appendChild(script);
      }).catch(error => {
        console.error('Notation engine failed:', error);
        this.failed = true;
        this.fallback.textContent = 'Notation engine unavailable';
        this.fallback.classList.remove('hidden');
        return null;
      });
      return this.enginePromise;
    }

    refresh(force = false) {
      if (!this.active || this.failed || !this.tracker) return;
      if (!VF) {
        this.ensureEngine();
        return;
      }
      this.syncOptions();
      this.syncConfigControls();
      const signature = this.makeSignature();
      if (force || signature !== this.signature) {
        this.signature = signature;
        this.render();
      }
      this.updateSelection();
      this.syncCellEditor();
    }

    syncOptions() {
      const optionSignature = [
        this.song.channels,
        ...this.song.samples.map(sample => `${sample.name}:${sample.data?.length || 0}:${sample.synth ? 1 : 0}`)
      ].join('|');
      if (optionSignature === this.optionSignature) return;
      this.optionSignature = optionSignature;

      this.controls.channel.replaceChildren();
      for (let channel = 0; channel < this.song.channels; channel++) {
        const option = document.createElement('option');
        option.value = String(channel);
        option.textContent = `CH ${channel + 1} - ${dominantInstrument(this.song, this.patternIndex, channel)}`;
        this.controls.channel.appendChild(option);
      }

      this.controls.instrument.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '0';
      empty.textContent = '00 - none';
      this.controls.instrument.appendChild(empty);
      this.song.samples.forEach((sample, index) => {
        const option = document.createElement('option');
        option.value = String(index + 1);
        option.textContent = `${hex2(index + 1)} - ${sample.name || 'unnamed'}`;
        this.controls.instrument.appendChild(option);
      });
    }

    syncConfigControls() {
      const score = this.state.score;
      this.controls.channel.value = String(score.channel);
      this.controls.clef.value = score.clef;
      this.controls.key.value = score.key;
      this.controls.time.value = score.time;
      this.controls.grid.value = String(score.grid);
    }

    makeSignature() {
      const score = this.state.score;
      const pattern = this.song.patterns[this.patternIndex];
      let hash = 2166136261;
      for (let row = 0; row < ROWS; row++) {
        const offset = (row * this.song.channels + score.channel) * 4;
        for (let byte = 0; byte < 4; byte++) {
          hash ^= pattern[offset + byte] + row * 4 + byte;
          hash = Math.imul(hash, 16777619);
        }
      }
      return [
        this.patternIndex, score.channel, score.key, score.time, score.clef, score.grid,
        hash >>> 0, this.optionSignature
      ].join('|');
    }

    render() {
      this.sheet.replaceChildren();
      this.fallback.classList.add('hidden');
      const score = this.state.score;
      const [beats, beatValue] = score.time.split('/').map(Number);
      const rowsPerMeasure = Math.max(1, Math.round(beats * score.grid * 4 / beatValue));
      const measures = Math.ceil(ROWS / rowsPerMeasure);

      try {
        for (let measure = 0; measure < measures; measure++) {
          this.renderMeasure(measure, rowsPerMeasure, beats, beatValue);
        }
      } catch (error) {
        console.error('Score rendering failed:', error);
        this.fallback.textContent = 'Could not engrave this score configuration';
        this.fallback.classList.remove('hidden');
      }
    }

    renderMeasure(measure, rowsPerMeasure, beats, beatValue) {
      const score = this.state.score;
      const startRow = measure * rowsPerMeasure;
      const endRow = Math.min(ROWS - 1, startRow + rowsPerMeasure - 1);
      const wrapper = document.createElement('section');
      wrapper.className = 'score-measure';
      wrapper.dataset.measure = String(measure);
      const label = document.createElement('span');
      label.className = 'score-measure-label';
      label.textContent = `MEASURE ${measure + 1}  ROWS ${hex2(startRow)}-${hex2(endRow)}`;
      wrapper.appendChild(label);
      this.sheet.appendChild(wrapper);

      const renderer = new VF.Renderer(wrapper, VF.Renderer.Backends.SVG);
      renderer.resize(SCORE_WIDTH, MEASURE_HEIGHT);
      const context = renderer.getContext();
      const stave = new VF.Stave(STAVE_X, 33, STAVE_WIDTH);
      stave.addClef(score.clef);
      if (score.clef !== 'percussion') stave.addKeySignature(score.key);
      if (measure === 0) stave.addTimeSignature(score.time);
      stave.setContext(context).draw();

      const notes = [];
      let previousInstrument = -1;
      for (let slot = 0; slot < rowsPerMeasure; slot++) {
        const row = startRow + slot;
        const cell = row < ROWS ? readCell(this.song, this.patternIndex, row, score.channel) : emptyCell(row, score.channel);
        const duration = DURATION_BY_GRID[score.grid] || '16';
        const note = cell.note
          ? new VF.StaveNote({ clef: score.clef, keys: [vexKey(cell.note, score.key, score.clef)], duration })
          : new VF.StaveNote({ clef: score.clef, keys: [restKey(score.clef)], duration: `${duration}r` });

        if (cell.note && cell.smp && cell.smp !== previousInstrument) {
          const annotation = new VF.Annotation(`I${hex2(cell.smp)}`)
            .setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM)
            .setFont('Arial', 7)
            .setStyle({ fillStyle: '#42566b', strokeStyle: '#42566b' });
          note.addModifier(annotation, 0);
          previousInstrument = cell.smp;
        }
        if (cell.fx || cell.pm) {
          const annotation = new VF.Annotation(`${cell.fx.toString(16).toUpperCase()}${hex2(cell.pm)}`)
            .setVerticalJustification(VF.Annotation.VerticalJustify.TOP)
            .setFont('Arial', 7, 'bold')
            .setStyle({ fillStyle: '#a34712', strokeStyle: '#a34712' });
          note.addModifier(annotation, 0);
        }
        if (row >= ROWS) note.setStyle({ fillStyle: '#cbd1d8', strokeStyle: '#cbd1d8' });
        notes.push(note);
      }

      const voice = new VF.Voice({ numBeats: beats, beatValue }).addTickables(notes);
      if (score.clef !== 'percussion') VF.Accidental.applyAccidentals([voice], score.key);
      const formatWidth = stave.getNoteEndX() - stave.getNoteStartX() - 12;
      new VF.Formatter().joinVoices([voice]).format([voice], formatWidth);
      voice.draw(context, stave);
      VF.Beam.generateBeams(notes).forEach(beam => beam.setContext(context).draw());

      const centers = notes.map(note => note.getAbsoluteX());
      notes.forEach((note, slot) => {
        const row = startRow + slot;
        if (row >= ROWS) return;
        const previous = slot ? centers[slot - 1] : stave.getNoteStartX();
        const next = slot < centers.length - 1 ? centers[slot + 1] : stave.getNoteEndX();
        const left = Math.max(stave.getNoteStartX(), (previous + centers[slot]) / 2);
        const right = Math.min(stave.getNoteEndX(), (centers[slot] + next) / 2);
        const hit = document.createElement('button');
        hit.type = 'button';
        hit.className = 'score-hit';
        hit.dataset.row = String(row);
        hit.style.left = `${left}px`;
        hit.style.width = `${Math.max(12, right - left)}px`;
        hit.setAttribute('aria-label', `Row ${hex2(row)}`);
        hit.title = describeCell(this.song, this.patternIndex, row, score.channel, this.tracker.ui.describeEffect);
        hit.addEventListener('click', () => this.selectRow(row));
        wrapper.appendChild(hit);
      });
    }

    selectRow(row) {
      this.tracker.ui.setCursor(row, this.state.score.channel);
      this.updateSelection();
      this.syncCellEditor();
    }

    updateSelection() {
      const selectedRow = this.state.cursor.row;
      const playRow = this.state.playing ? this.state.playRow : -1;
      for (const hit of this.sheet.querySelectorAll('.score-hit')) {
        const row = Number(hit.dataset.row);
        hit.classList.toggle('selected', row === selectedRow);
        hit.classList.toggle('playing', row === playRow);
      }
      if (this.state.playing && this.state.follow && playRow >= 0) {
        this.sheet.querySelector(`.score-hit[data-row="${playRow}"]`)?.scrollIntoView({ block: 'center' });
      }
    }

    syncCellEditor() {
      const row = this.state.cursor.row;
      const channel = this.state.score.channel;
      const cell = readCell(this.song, this.patternIndex, row, channel);
      this.controls.row.textContent = hex2(row);
      this.controls.note.value = String(cell.note);
      this.controls.instrument.value = String(cell.smp);
      this.controls.effect.value = cell.fx || cell.pm ? String(cell.fx) : 'none';
      this.controls.param.value = hex2(cell.pm);
      this.info.textContent = describeCell(this.song, this.patternIndex, row, channel, this.tracker.ui.describeEffect);
    }

    writeCell() {
      const effectValue = this.controls.effect.value;
      const effect = effectValue === 'none' ? 0 : Number(effectValue);
      const parameter = effectValue === 'none' ? 0 : parseInt(this.controls.param.value || '0', 16);
      this.tracker.ui.editScoreCell(this.state.cursor.row, this.state.score.channel, {
        note: Number(this.controls.note.value),
        smp: Number(this.controls.instrument.value),
        fx: effect,
        pm: Number.isFinite(parameter) ? parameter : 0
      });
      this.refresh(true);
    }

    clearCell() {
      this.tracker.ui.editScoreCell(this.state.cursor.row, this.state.score.channel,
        { note: 0, smp: 0, fx: 0, pm: 0 });
      this.refresh(true);
    }
  }

  function readCell(song, patternIndex, row, channel) {
    const pattern = song.patterns[patternIndex];
    const offset = (row * song.channels + channel) * 4;
    return {
      row,
      ch: channel,
      note: pattern[offset] || 0,
      smp: pattern[offset + 1] || 0,
      fx: pattern[offset + 2] || 0,
      pm: pattern[offset + 3] || 0
    };
  }

  function emptyCell(row, channel) {
    return { row, ch: channel, note: 0, smp: 0, fx: 0, pm: 0 };
  }

  function dominantInstrument(song, patternIndex, channel) {
    const counts = new Map();
    for (let row = 0; row < ROWS; row++) {
      const cell = readCell(song, patternIndex, row, channel);
      if (cell.smp) counts.set(cell.smp, (counts.get(cell.smp) || 0) + 1);
    }
    let sample = 0;
    let count = 0;
    for (const [candidate, total] of counts) {
      if (total > count) {
        sample = candidate;
        count = total;
      }
    }
    return sample ? `${hex2(sample)} ${song.samples[sample - 1]?.name || 'unnamed'}` : 'empty';
  }

  function vexKey(note, key, clef) {
    if (clef === 'percussion') return 'c/5';
    const pitchClass = (note - 1) % 12;
    const octave = Math.floor((note - 1) / 12) + 1;
    const useFlats = /b/.test(key);
    return `${(useFlats ? FLAT_NAMES : SHARP_NAMES)[pitchClass]}/${octave}`;
  }

  function restKey(clef) {
    if (clef === 'bass') return 'd/3';
    if (clef === 'alto') return 'c/4';
    return 'b/4';
  }

  function describeCell(song, patternIndex, row, channel, describeEffect) {
    const cell = readCell(song, patternIndex, row, channel);
    const parts = [`ROW ${hex2(row)}`, `CH ${channel + 1}`];
    parts.push(cell.note ? window.tracker.MOD.noteName(cell.note) : 'REST');
    if (cell.smp) parts.push(`I${hex2(cell.smp)} ${song.samples[cell.smp - 1]?.name || 'unnamed'}`);
    if (cell.fx || cell.pm) {
      const command = `${cell.fx.toString(16).toUpperCase()}${hex2(cell.pm)}`;
      parts.push(`${command} ${describeEffect(cell.fx, cell.pm) || 'effect'}`);
    }
    return parts.join('  |  ').toUpperCase();
  }

  function hex2(value) {
    return Math.max(0, value | 0).toString(16).toUpperCase().padStart(2, '0');
  }

  window.WebTrackerScore = new TrackerScoreView();
  if (window.tracker?.state?.view === 'score') window.WebTrackerScore.setActive(true);
})();
