/* scoreview.js - Horizontally scrolling multi-channel song score. */
'use strict';

(() => {
  let VF = window.VexFlow || null;
  const ROWS = 64;
  const MEASURE_WIDTH = 420;
  const STAFF_HEIGHT = 124;
  const CHANNEL_LABEL_WIDTH = 104;
  const POSITION_BORDER_WIDTH = 5;
  const KEY_OPTIONS = [
    ['Major', ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']],
    ['Minor', ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']]
  ];
  const DURATION_BY_GRID = { 1: 'q', 2: '8', 4: '16', 8: '32' };
  const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const FLAT_NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
  const COLUMN_NAMES = ['NOTE', 'INSTRUMENT HI', 'INSTRUMENT LO', 'EFFECT', 'PARAM HI', 'PARAM LO'];

  class TrackerScoreView {
    constructor() {
      this.panel = document.getElementById('scorePanel');
      this.scroll = document.getElementById('scoreScroll');
      this.songElement = document.getElementById('scoreSong');
      this.info = document.getElementById('scoreCellInfo');
      this.fallback = document.getElementById('scoreFallback');
      this.controls = {
        clef: document.getElementById('scoreClef'),
        key: document.getElementById('scoreKey'),
        time: document.getElementById('scoreTime'),
        grid: document.getElementById('scoreGrid')
      };
      this.active = false;
      this.failed = false;
      this.signature = '';
      this.positions = new Map();
      this.lastFocusKey = '';
      this.enginePromise = null;
      this.observer = null;
      this.followFrame = 0;
      this.followLastTime = 0;
      this.initControls();
    }

    get tracker() { return window.tracker; }
    get state() { return this.tracker?.state; }
    get song() { return this.state?.song; }

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

      for (const name of ['clef', 'key', 'time', 'grid']) {
        this.controls[name].addEventListener('change', () => {
          const value = name === 'grid' ? Number(this.controls[name].value) : this.controls[name].value;
          this.tracker.ui.updateScoreMeta({ [name]: value });
        });
      }
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
    }

    setActive(active) {
      this.active = active;
      if (!active) {
        this.stopPlaybackFollow();
        return;
      }
      this.ensureEngine().then(() => {
        if (!this.active || this.failed) return;
        this.refresh(true);
        this.panel.focus({ preventScroll: true });
      });
    }

    ensureEngine() {
      if (VF) return Promise.resolve(VF);
      if (this.enginePromise) return this.enginePromise;
      this.enginePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'js/vendor/vexflow.min.js';
        script.onload = () => {
          VF = window.VexFlow;
          VF ? resolve(VF) : reject(new Error('VexFlow did not initialize'));
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
      this.syncControls();
      const signature = this.makeSignature();
      if (force || signature !== this.signature) {
        this.signature = signature;
        this.renderSong();
      }
      this.updateCursorAndPlayback();
      this.updateInfo();
    }

    syncControls() {
      const score = this.state.score;
      this.controls.clef.value = score.clef;
      this.controls.key.value = score.key;
      this.controls.time.value = score.time;
      this.controls.grid.value = String(score.grid);
    }

    scoreLayout() {
      const [beats, beatValue] = this.state.score.time.split('/').map(Number);
      const rowsPerMeasure = Math.max(1, Math.round(beats * this.state.score.grid * 4 / beatValue));
      const measuresPerPattern = Math.ceil(ROWS / rowsPerMeasure);
      return {
        beats,
        beatValue,
        rowsPerMeasure,
        measuresPerPattern,
        positionWidth: POSITION_BORDER_WIDTH + CHANNEL_LABEL_WIDTH + measuresPerPattern * MEASURE_WIDTH
      };
    }

    makeSignature() {
      let hash = 2166136261;
      for (const pattern of this.song.patterns) {
        for (let index = 0; index < pattern.length; index++) {
          hash ^= pattern[index] + index;
          hash = Math.imul(hash, 16777619);
        }
      }
      const score = this.state.score;
      return [
        this.song.channels, this.song.order.join(','), hash >>> 0,
        score.key, score.time, score.clef, score.grid,
        this.song.samples.map(sample => sample.name).join('|'), this.state.muted.join('')
      ].join('~');
    }

    renderSong() {
      this.observer?.disconnect();
      this.positions.clear();
      this.songElement.replaceChildren();
      this.fallback.classList.add('hidden');
      const layout = this.scoreLayout();

      for (let position = 0; position < this.song.order.length; position++) {
        const pattern = this.song.order[position] | 0;
        const section = document.createElement('section');
        section.className = 'score-position';
        section.dataset.pos = String(position);
        section.style.width = `${layout.positionWidth}px`;
        section.style.height = `${32 + this.song.channels * STAFF_HEIGHT}px`;

        const header = document.createElement('div');
        header.className = 'score-position-header';
        header.innerHTML = `<b>POS ${hex2(position)}</b><span>PAT ${hex2(pattern)}</span>`;
        section.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 'score-loading';
        loading.style.height = `${this.song.channels * STAFF_HEIGHT}px`;
        section.appendChild(loading);
        this.songElement.appendChild(section);
        this.positions.set(position, { element: section, pattern, rendered: false, layout });
      }

      if ('IntersectionObserver' in window) {
        this.observer = new IntersectionObserver(entries => {
          for (const entry of entries) {
            if (entry.isIntersecting) this.ensurePosition(Number(entry.target.dataset.pos));
          }
        }, { root: this.scroll, rootMargin: '0px 1800px', threshold: 0 });
        for (const item of this.positions.values()) this.observer.observe(item.element);
      } else {
        for (const position of this.positions.keys()) this.ensurePosition(position);
      }

      const activePosition = this.state.playing && this.state.playPos >= 0
        ? this.state.playPos : this.state.curPos;
      for (let position = Math.max(0, activePosition - 1);
        position <= Math.min(this.song.order.length - 1, activePosition + 1); position++) {
        this.ensurePosition(position);
      }
    }

    ensurePosition(position) {
      const item = this.positions.get(position);
      if (!item || item.rendered) return item?.element || null;
      item.rendered = true;
      item.element.querySelector('.score-loading')?.remove();
      try {
        this.renderPosition(item, position);
      } catch (error) {
        console.error('Score rendering failed:', error);
        item.rendered = false;
        item.element.querySelectorAll('.score-channel-row').forEach(row => row.remove());
        const failed = document.createElement('div');
        failed.className = 'score-loading';
        failed.textContent = 'Could not engrave this position';
        item.element.appendChild(failed);
      }
      return item.element;
    }

    renderPosition(item, position) {
      const mounts = [];
      for (let channel = 0; channel < this.song.channels; channel++) {
        const row = document.createElement('div');
        row.className = 'score-channel-row';
        row.classList.toggle('muted', Boolean(this.state.muted[channel]));
        row.dataset.ch = String(channel);

        const label = document.createElement('div');
        label.className = 'score-channel-label';
        const instrument = dominantInstrument(this.song, item.pattern, channel);
        label.innerHTML = `<b>CH ${channel + 1}</b><span>${instrument}</span>`;
        row.appendChild(label);

        const measures = document.createElement('div');
        measures.className = 'score-measures';
        row.appendChild(measures);
        item.element.appendChild(row);
        mounts.push(measures);
      }

      const previousInstruments = new Array(this.song.channels).fill(-1);
      for (let measure = 0; measure < item.layout.measuresPerPattern; measure++) {
        this.renderAlignedMeasure({
          mounts,
          position,
          pattern: item.pattern,
          measure,
          previousInstruments,
          layout: item.layout
        });
      }
    }

    renderAlignedMeasure({ mounts, position, pattern, measure, previousInstruments, layout }) {
      const score = this.state.score;
      const startRow = measure * layout.rowsPerMeasure;
      const systems = mounts.map((mount, channel) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'score-inline-measure';
        wrapper.dataset.measure = String(measure);
        mount.appendChild(wrapper);

        const renderer = new VF.Renderer(wrapper, VF.Renderer.Backends.SVG);
        renderer.resize(MEASURE_WIDTH, STAFF_HEIGHT);
        const context = renderer.getContext();
        const staveX = measure === 0 ? 7 : 0;
        const stave = new VF.Stave(staveX, 19, MEASURE_WIDTH - staveX);
        if (measure === 0) {
          stave.addClef(score.clef);
          if (score.clef !== 'percussion') stave.addKeySignature(score.key);
          stave.addTimeSignature(score.time);
        }
        stave.setContext(context).draw();

        const notes = [];
        let previousInstrument = previousInstruments[channel];
        for (let slot = 0; slot < layout.rowsPerMeasure; slot++) {
          const trackerRow = startRow + slot;
          const cell = trackerRow < ROWS
            ? readCell(this.song, pattern, trackerRow, channel)
            : emptyCell(trackerRow, channel);
          const duration = DURATION_BY_GRID[score.grid] || '16';
          const note = cell.note
            ? new VF.StaveNote({ clef: score.clef, keys: [vexKey(cell.note, score.key, score.clef)], duration })
            : new VF.StaveNote({ clef: score.clef, keys: [restKey(score.clef)], duration: `${duration}r` });

          if (cell.note && cell.smp && cell.smp !== previousInstrument) {
            note.addModifier(new VF.Annotation(`I${hex2(cell.smp)}`)
              .setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM)
              .setFont('Arial', 7)
              .setStyle({ fillStyle: '#42566b', strokeStyle: '#42566b' }), 0);
            previousInstrument = cell.smp;
          }
          if (cell.fx || cell.pm) {
            note.addModifier(new VF.Annotation(`${cell.fx.toString(16).toUpperCase()}${hex2(cell.pm)}`)
              .setVerticalJustification(VF.Annotation.VerticalJustify.TOP)
              .setFont('Arial', 7, 'bold')
              .setStyle({ fillStyle: '#a34712', strokeStyle: '#a34712' }), 0);
          }
          if (trackerRow >= ROWS) note.setStyle({ fillStyle: '#cbd1d8', strokeStyle: '#cbd1d8' });
          notes.push(note);
        }
        previousInstruments[channel] = previousInstrument;

        const voice = new VF.Voice({ numBeats: layout.beats, beatValue: layout.beatValue })
          .addTickables(notes);
        if (score.clef !== 'percussion') VF.Accidental.applyAccidentals([voice], score.key);
        return { channel, wrapper, context, stave, notes, voice };
      });

      const referenceStave = systems[0].stave;
      const formatWidth = referenceStave.getNoteEndX() - referenceStave.getNoteStartX() - 8;
      for (const system of systems) {
        new VF.Formatter().joinVoices([system.voice]).format([system.voice], formatWidth);
      }

      // Keep per-staff modifier layout, then pin every voice to tracker-time columns.
      const noteStartX = referenceStave.getNoteStartX();
      const noteEndX = referenceStave.getNoteEndX();
      const centers = systems[0].notes.map((note, slot, notes) =>
        noteStartX + (slot + 0.5) * (noteEndX - noteStartX) / notes.length);
      for (const system of systems) {
        system.notes.forEach((note, slot) => {
          const tickContext = note.getTickContext();
          tickContext.setX(tickContext.getX() + centers[slot] - note.getAbsoluteX());
        });
      }

      for (const system of systems) {
        system.voice.draw(system.context, system.stave);
        VF.Beam.generateBeams(system.notes).forEach(beam => beam.setContext(system.context).draw());
      }

      for (const { channel, wrapper, stave } of systems) {
        centers.forEach((center, slot) => {
          const trackerRow = startRow + slot;
          if (trackerRow >= ROWS) return;
          const previous = slot ? centers[slot - 1] : stave.getNoteStartX();
          const next = slot < centers.length - 1 ? centers[slot + 1] : stave.getNoteEndX();
          const left = Math.max(stave.getNoteStartX(), (previous + center) / 2);
          const right = Math.min(stave.getNoteEndX(), (center + next) / 2);
          const hit = document.createElement('button');
          hit.type = 'button';
          hit.className = 'score-hit';
          hit.dataset.pos = String(position);
          hit.dataset.row = String(trackerRow);
          hit.dataset.ch = String(channel);
          hit.style.left = `${left}px`;
          hit.style.width = `${Math.max(12, right - left)}px`;
          hit.setAttribute('aria-label', `Position ${hex2(position)} row ${hex2(trackerRow)} channel ${channel + 1}`);
          hit.title = describeCell(this.song, position, pattern, trackerRow, channel, 0, this.tracker.ui.describeEffect);
          hit.addEventListener('click', () => this.selectCell(position, trackerRow, channel));
          wrapper.appendChild(hit);
        });
      }
    }

    selectCell(position, row, channel) {
      this.tracker.ui.setScoreCursor(position, row, channel);
      this.panel.focus({ preventScroll: true });
      this.refresh();
    }

    updateCursorAndPlayback() {
      const state = this.state;
      const playPosition = state.playing && state.playPos >= 0 ? state.playPos : -1;
      const activePosition = playPosition >= 0 ? playPosition : state.curPos;
      this.ensurePosition(activePosition);

      for (const [position, item] of this.positions) {
        item.element.classList.toggle('active', position === state.curPos);
        item.element.classList.toggle('playing', position === playPosition);
      }
      for (const hit of this.songElement.querySelectorAll('.score-hit.selected, .score-hit.playing')) {
        hit.classList.remove('selected', 'playing');
      }

      const selected = this.songElement.querySelector(
        `.score-hit[data-pos="${state.curPos}"][data-row="${state.cursor.row}"][data-ch="${state.cursor.ch}"]`);
      selected?.classList.add('selected');

      if (playPosition >= 0 && state.playRow >= 0) {
        for (const hit of this.songElement.querySelectorAll(
          `.score-hit[data-pos="${playPosition}"][data-row="${state.playRow}"]`)) {
          hit.classList.add('playing');
        }
      }

      if (playPosition >= 0 && state.follow) this.startPlaybackFollow();
      else this.stopPlaybackFollow();

      const focusKey = playPosition >= 0
        ? `play:${playPosition}:${state.playRow}`
        : `edit:${state.curPos}:${state.cursor.row}:${state.cursor.ch}`;
      if (focusKey !== this.lastFocusKey) {
        this.lastFocusKey = focusKey;
        const target = playPosition >= 0
          ? this.songElement.querySelector(
            `.score-hit[data-pos="${playPosition}"][data-row="${state.playRow}"][data-ch="${state.cursor.ch}"]`)
          : selected;
        if (playPosition < 0 && document.activeElement === this.panel) {
          target?.scrollIntoView({
            behavior: 'smooth',
            inline: 'center',
            block: 'nearest'
          });
        }
      }
    }

    startPlaybackFollow() {
      if (this.followFrame) return;
      this.followLastTime = performance.now();
      this.followFrame = requestAnimationFrame(now => this.animatePlaybackFollow(now));
    }

    stopPlaybackFollow() {
      if (this.followFrame) cancelAnimationFrame(this.followFrame);
      this.followFrame = 0;
      this.followLastTime = 0;
    }

    animatePlaybackFollow(now) {
      const state = this.state;
      if (!this.active || !state?.playing || !state.follow || state.playPos < 0 || state.playRow < 0) {
        this.followFrame = 0;
        this.followLastTime = 0;
        return;
      }

      let nextPosition = state.playPos;
      let nextRow = state.playRow + 1;
      if (nextRow >= ROWS) {
        nextRow = 0;
        nextPosition = Math.min(state.playPos + 1, this.song.order.length - 1);
      }
      this.ensurePosition(state.playPos);
      this.ensurePosition(nextPosition);

      const current = this.songElement.querySelector(
        `.score-hit[data-pos="${state.playPos}"][data-row="${state.playRow}"][data-ch="0"]`);
      const next = this.songElement.querySelector(
        `.score-hit[data-pos="${nextPosition}"][data-row="${nextRow}"][data-ch="0"]`) || current;
      if (current && next) {
        const scrollBounds = this.scroll.getBoundingClientRect();
        const contentCenter = hit => {
          const bounds = hit.getBoundingClientRect();
          return this.scroll.scrollLeft + bounds.left - scrollBounds.left + bounds.width / 2;
        };
        const bpm = Number(document.getElementById('bpmInput').value) || 125;
        const speed = Number(document.getElementById('speedInput').value) || 6;
        const swing = state.swing > 50
          ? (state.playRow % 2 === 0 ? state.swing / 50 : 2 - state.swing / 50)
          : 1;
        const rowMs = speed * 2500 / bpm * swing;
        const progress = Math.max(0, Math.min(1,
          state.lastRowTime ? (now - state.lastRowTime) / rowMs : 0));
        const playheadX = contentCenter(current) +
          (contentCenter(next) - contentCenter(current)) * progress;
        const maxScroll = Math.max(0, this.scroll.scrollWidth - this.scroll.clientWidth);
        const desired = Math.max(0, Math.min(maxScroll, playheadX - this.scroll.clientWidth / 2));
        const elapsed = Math.max(0, Math.min(50, now - this.followLastTime));
        const blend = 1 - Math.exp(-elapsed / 70);
        this.scroll.scrollLeft += (desired - this.scroll.scrollLeft) * blend;
      }

      this.followLastTime = now;
      this.followFrame = requestAnimationFrame(nextNow => this.animatePlaybackFollow(nextNow));
    }

    updateInfo() {
      const state = this.state;
      const position = state.curPos;
      const pattern = this.song.order[position] | 0;
      this.info.textContent = describeCell(
        this.song, position, pattern, state.cursor.row, state.cursor.ch, state.cursor.col,
        this.tracker.ui.describeEffect);
    }
  }

  function readCell(song, patternIndex, row, channel) {
    const pattern = song.patterns[patternIndex];
    const offset = (row * song.channels + channel) * 4;
    return {
      note: pattern[offset] || 0,
      smp: pattern[offset + 1] || 0,
      fx: pattern[offset + 2] || 0,
      pm: pattern[offset + 3] || 0
    };
  }

  function emptyCell() {
    return { note: 0, smp: 0, fx: 0, pm: 0 };
  }

  function dominantInstrument(song, patternIndex, channel) {
    const counts = new Map();
    for (let row = 0; row < ROWS; row++) {
      const sample = readCell(song, patternIndex, row, channel).smp;
      if (sample) counts.set(sample, (counts.get(sample) || 0) + 1);
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
    return `${(/b/.test(key) ? FLAT_NAMES : SHARP_NAMES)[pitchClass]}/${octave}`;
  }

  function restKey(clef) {
    if (clef === 'bass') return 'd/3';
    if (clef === 'alto') return 'c/4';
    return 'b/4';
  }

  function describeCell(song, position, pattern, row, channel, column, describeEffect) {
    const cell = readCell(song, pattern, row, channel);
    const parts = [
      `POS ${hex2(position)}`,
      `PAT ${hex2(pattern)}`,
      `ROW ${hex2(row)}`,
      `CH ${channel + 1}`,
      `COL ${COLUMN_NAMES[column] || 'NOTE'}`,
      cell.note ? window.tracker.MOD.noteName(cell.note) : 'REST'
    ];
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
