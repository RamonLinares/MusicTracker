/* visual3d.js - A semantic Three.js spatial score for tracker patterns. */
'use strict';

import * as THREE from './vendor/three.module.min.js';

const ROWS = 64;
const ROW_STEP = 0.42;
const CH_STEP = 2.65;
const PITCH_STEP = 0.145;
const NOTE_COLORS = ['#49d6ff', '#ffb44a', '#70e58b', '#ff6484', '#bf8cff', '#ffe06a', '#55e8d0', '#ff855c'];
const EFFECT_COLOR = '#ffb44a';

class TrackerCore3D {
  constructor() {
    this.panel = document.getElementById('threePanel');
    this.mount = document.getElementById('threeMount');
    this.readout = document.getElementById('threeReadout');
    this.density = document.getElementById('threeDensity');
    this.detail = document.getElementById('threeDetail');
    this.legend = document.getElementById('threeLegend');
    this.overviewButton = document.getElementById('threeOverview');
    this.followButton = document.getElementById('threeFollow');
    this.fallback = document.getElementById('threeFallback');
    this.active = false;
    this.ready = false;
    this.failed = false;
    this.signature = '';
    this.frame = 0;
    this.cameraMode = 'overview';
    this.pointer = new THREE.Vector2();
    this.pointerBias = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.pickables = [];
    this.noteCells = [];
    this.lastFrameTime = performance.now();
    this.cameraTarget = new THREE.Vector3();
    this._onMove = event => this.onPointerMove(event);
    this._onLeave = () => this.onPointerLeave();
    this._onClick = event => this.onClick(event);
    this.panel.addEventListener('pointermove', this._onMove);
    this.panel.addEventListener('pointerleave', this._onLeave);
    this.panel.addEventListener('click', this._onClick);
    this.overviewButton.addEventListener('click', event => {
      event.stopPropagation();
      this.setCameraMode('overview');
    });
    this.followButton.addEventListener('click', event => {
      event.stopPropagation();
      this.setCameraMode('follow');
    });
  }

  setActive(active) {
    this.active = active;
    if (active) {
      if (!this.ready && !this.failed) this.init();
      this.resize();
      this.refresh();
      this.lastFrameTime = performance.now();
      this.animate();
    } else if (this.renderer) {
      this.renderer.setAnimationLoop(null);
    }
  }

  setCameraMode(mode) {
    this.cameraMode = mode === 'follow' ? 'follow' : 'overview';
    this.overviewButton.classList.toggle('active', this.cameraMode === 'overview');
    this.followButton.classList.toggle('active', this.cameraMode === 'follow');
    this.overviewButton.setAttribute('aria-pressed', String(this.cameraMode === 'overview'));
    this.followButton.setAttribute('aria-pressed', String(this.cameraMode === 'follow'));
  }

  init() {
    try {
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog(0x050812, 28, 74);
      this.camera = new THREE.PerspectiveCamera(43, 1, 0.1, 120);
      this.camera.position.set(0, 12, 28);

      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.08;
      this.mount.appendChild(this.renderer.domElement);

      this.world = new THREE.Group();
      this.scene.add(this.world);

      this.scene.add(new THREE.HemisphereLight(0xb9dfff, 0x07101b, 2.2));
      this.keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
      this.keyLight.position.set(-7, 13, 9);
      this.scene.add(this.keyLight);
      this.rimLight = new THREE.DirectionalLight(0x49d6ff, 1.7);
      this.rimLight.position.set(8, 6, -12);
      this.scene.add(this.rimLight);
      this.scanLight = new THREE.PointLight(0xffb44a, 10, 10);
      this.scene.add(this.scanLight);

      this.ready = true;
    } catch (error) {
      console.warn('3D view failed:', error);
      this.failed = true;
      this.fallback.classList.remove('hidden');
    }
  }

  refresh() {
    if (!this.active || !this.ready) return;
    const next = this.makeSignature();
    if (next === this.signature) {
      this.updateMarkers();
      return;
    }
    this.signature = next;
    this.rebuildWorld();
  }

  resize() {
    if (!this.ready || !this.renderer) return;
    const bounds = this.panel.getBoundingClientRect();
    const width = Math.max(2, Math.floor(bounds.width));
    const height = Math.max(2, Math.floor(bounds.height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    if (!this.ready || !this.active) return;
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) * 0.001));
      this.lastFrameTime = now;
      this.frame++;
      if (this.frame % 20 === 0) this.refresh();
      this.updateCamera(dt);
      this.updateMarkers(now);
      if (this.scanMaterial) this.scanMaterial.opacity = 0.11 + Math.sin(now * 0.006) * 0.025;
      if (this.cursorMarker) {
        const pulse = (this.cursorScale || 1) * (1 + Math.sin(now * 0.008) * 0.045);
        this.cursorMarker.scale.setScalar(pulse);
      }
      this.renderer.render(this.scene, this.camera);
    });
  }

  updateCamera(dt) {
    const state = this.tracker?.state;
    if (!state || !this.song) return;
    const focusRow = state.playing && state.playRow >= 0 ? state.playRow : state.cursor.row;
      const laneWidth = Math.max(8, this.song.channels * CH_STEP);
    let desiredPosition;
    let desiredTarget;

    if (this.cameraMode === 'follow') {
      const focusZ = rowZ(focusRow);
      desiredPosition = new THREE.Vector3(
        this.pointerBias.x * 0.8,
        7.1 + this.pointerBias.y * 0.35,
        focusZ + 9.8
      );
      desiredTarget = new THREE.Vector3(0, 2.25, focusZ - 4.2);
    } else {
      const mobile = this.camera.aspect < 0.72;
      desiredPosition = new THREE.Vector3(
        this.pointerBias.x * 1.15,
        mobile ? 20 : 11.6,
        mobile ? 23.5 : Math.max(24.5, laneWidth * 1.8)
      );
      desiredTarget = new THREE.Vector3(0, 0.9 + this.pointerBias.y * 0.35, mobile ? -0.5 : -5.2);
    }

    this.camera.position.lerp(desiredPosition, 1 - Math.exp(-dt * 4.2));
    this.cameraTarget.lerp(desiredTarget, 1 - Math.exp(-dt * 4.8));
    this.camera.lookAt(this.cameraTarget);
  }

  get tracker() { return window.tracker; }

  get song() { return this.tracker?.state?.song; }

  get patternIndex() {
    const state = this.tracker.state;
    return state.song.order[state.curPos] | 0;
  }

  makeSignature() {
    if (!this.tracker || !this.song) return 'empty';
    const state = this.tracker.state;
    const song = state.song;
    const pattern = song.patterns[this.patternIndex] || new Uint8Array(0);
    let hash = 2166136261;
    for (let index = 0; index < pattern.length; index++) {
      hash ^= pattern[index] + index;
      hash = Math.imul(hash, 16777619);
    }
    const sampleState = song.samples.map(sample => `${sample.name}:${sample.volume}`).join('~');
    const palette = this.palette();
    return [
      song.title, song.channels, this.patternIndex, state.curPos, hash >>> 0,
      sampleState, state.muted.join(''), palette.bg, palette.accent, palette.cyan
    ].join('|');
  }

  palette() {
    const css = getComputedStyle(document.documentElement);
    return {
      bg: css.getPropertyValue('--surface').trim() || '#0d1017',
      accent: css.getPropertyValue('--accent').trim() || '#ffb44a',
      cyan: css.getPropertyValue('--cyan').trim() || '#49d6ff',
      green: css.getPropertyValue('--green').trim() || '#70e58b',
      text: css.getPropertyValue('--text-bright').trim() || '#d6e2f5'
    };
  }

  clearWorld() {
    this.pickables.length = 0;
    this.noteCells.length = 0;
    while (this.world.children.length) {
      const child = this.world.children.pop();
      disposeObject(child);
    }
  }

  rebuildWorld() {
    this.clearWorld();
    const song = this.song;
    if (!song) return;

    const palette = this.palette();
    this.scene.background = new THREE.Color(palette.bg).multiplyScalar(0.42);
    this.scene.fog.color.copy(this.scene.background);
    this.rimLight.color.set(palette.cyan);
    this.scanLight.color.set(palette.accent);

    const pattern = song.patterns[this.patternIndex] || new Uint8Array(ROWS * song.channels * 4);
    this.buildArchitecture(song, pattern, palette);
    this.buildNotes(song, pattern, palette);
    this.buildActivity(song, pattern, palette);
    this.buildMarkers(song, palette);
    this.buildLegend(song, pattern);
    this.updateMarkers();
  }

  buildArchitecture(song, pattern, palette) {
    const channels = song.channels;
    const length = ROWS * ROW_STEP + 1.4;
    const laneGeometry = new THREE.BoxGeometry(1.68, 0.08, length);
    const laneMaterials = [
      new THREE.MeshStandardMaterial({ color: '#0b1823', roughness: 0.84, metalness: 0.2 }),
      new THREE.MeshStandardMaterial({ color: '#101b28', roughness: 0.78, metalness: 0.24 })
    ];
    for (let channel = 0; channel < channels; channel++) {
      const lane = new THREE.Mesh(laneGeometry, laneMaterials[channel % 2]);
      lane.position.set(laneX(channel, channels), -0.06, 0);
      this.world.add(lane);
    }

    const rowPositions = [];
    const rowColors = [];
    const minor = new THREE.Color('#26384b');
    const beat = new THREE.Color(palette.cyan).multiplyScalar(0.56);
    const width = (channels - 1) * CH_STEP + 1.85;
    for (let row = 0; row < ROWS; row++) {
      const color = row % 4 === 0 ? beat : minor;
      rowPositions.push(-width / 2, 0.015, rowZ(row), width / 2, 0.015, rowZ(row));
      rowColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    const rowGeometry = new THREE.BufferGeometry();
    rowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rowPositions, 3));
    rowGeometry.setAttribute('color', new THREE.Float32BufferAttribute(rowColors, 3));
    const rowLines = new THREE.LineSegments(rowGeometry, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.68
    }));
    this.world.add(rowLines);

    const barGeometry = new THREE.BoxGeometry(width + 0.35, 0.055, 0.075);
    const barMaterial = new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.72 });
    const bars = new THREE.InstancedMesh(barGeometry, barMaterial, 4);
    const dummy = new THREE.Object3D();
    for (let bar = 0; bar < 4; bar++) {
      dummy.position.set(0, 0.045, rowZ(bar * 16));
      dummy.updateMatrix();
      bars.setMatrixAt(bar, dummy.matrix);
    }
    this.world.add(bars);

    for (let row = 0; row < ROWS; row += 8) {
      this.world.add(makeLabel(hex2(row), row % 16 === 0 ? palette.accent : palette.cyan,
        -width / 2 - 0.7, 0.18, rowZ(row), 0.48));
    }
    for (let note = 1; note <= 36; note += 12) {
      this.world.add(makeLabel(this.tracker.MOD.noteName(note), palette.text,
        width / 2 + 0.85, pitchY(note), rowZ(0), 0.58));
    }
  }

  buildNotes(song, pattern, palette) {
    const cells = [];
    const effects = [];
    const perChannel = Array.from({ length: song.channels }, () => []);
    for (let row = 0; row < ROWS; row++) {
      for (let channel = 0; channel < song.channels; channel++) {
        const offset = (row * song.channels + channel) * 4;
        const cell = {
          row,
          ch: channel,
          note: pattern[offset] || 0,
          smp: pattern[offset + 1] || 0,
          fx: pattern[offset + 2] || 0,
          pm: pattern[offset + 3] || 0
        };
        if (cell.note) {
          cells.push(cell);
          perChannel[channel].push(cell);
        } else if (cell.fx || cell.pm) {
          effects.push(cell);
        }
      }
    }

    const stemGeometry = new THREE.CylinderGeometry(0.022, 0.022, 1, 5);
    const stemMaterial = new THREE.MeshBasicMaterial({ color: palette.cyan, transparent: true, opacity: 0.42 });
    const stems = new THREE.InstancedMesh(stemGeometry, stemMaterial, Math.max(1, cells.length));
    const stemDummy = new THREE.Object3D();

    cells.forEach((cell, index) => {
      const y = pitchY(cell.note);
      stemDummy.position.set(laneX(cell.ch, song.channels), y / 2, rowZ(cell.row));
      stemDummy.scale.set(1, Math.max(0.12, y), 1);
      stemDummy.updateMatrix();
      stems.setMatrixAt(index, stemDummy.matrix);
    });
    stems.count = cells.length;
    stems.instanceMatrix.needsUpdate = true;
    this.world.add(stems);

    const noteGeometry = makeNoteGeometry();
    const colorGroups = Array.from({ length: NOTE_COLORS.length * 2 }, () => []);
    for (const cell of cells) {
      const colorIndex = ((cell.smp ? cell.smp - 1 : cell.ch) % NOTE_COLORS.length + NOTE_COLORS.length) % NOTE_COLORS.length;
      const mutedIndex = this.tracker.state.muted[cell.ch] ? 1 : 0;
      colorGroups[colorIndex * 2 + mutedIndex].push(cell);
    }
    this.noteMeshes = [];
    for (let groupIndex = 0; groupIndex < colorGroups.length; groupIndex++) {
      const groupCells = colorGroups[groupIndex];
      if (!groupCells.length) continue;
      const colorIndex = Math.floor(groupIndex / 2);
      const muted = groupIndex % 2 === 1;
      const material = new THREE.MeshStandardMaterial({
        color: NOTE_COLORS[colorIndex],
        emissive: NOTE_COLORS[colorIndex],
        emissiveIntensity: muted ? 0.04 : 0.38,
        roughness: 0.3,
        metalness: 0.38,
        toneMapped: false,
        transparent: muted,
        opacity: muted ? 0.18 : 1
      });
      const notes = new THREE.InstancedMesh(noteGeometry, material, groupCells.length);
      notes.userData.cells = groupCells;
      const dummy = new THREE.Object3D();
      groupCells.forEach((cell, index) => {
        const volume = cellVolume(song, cell);
        dummy.position.set(laneX(cell.ch, song.channels), pitchY(cell.note), rowZ(cell.row));
        dummy.scale.set(0.68 + volume * 0.32, 1, 1);
        dummy.updateMatrix();
        notes.setMatrixAt(index, dummy.matrix);
      });
      notes.instanceMatrix.needsUpdate = true;
      this.noteMeshes.push(notes);
      this.pickables.push(notes);
      this.world.add(notes);
    }
    this.noteMesh = this.noteMeshes[0] || null;
    this.noteCells = cells;

    if (effects.length) {
      const effectGeometry = new THREE.OctahedronGeometry(0.14, 0);
      const effectMaterial = new THREE.MeshStandardMaterial({
        color: EFFECT_COLOR,
        emissive: EFFECT_COLOR,
        emissiveIntensity: 0.65,
        roughness: 0.32,
        metalness: 0.42
      });
      const effectMesh = new THREE.InstancedMesh(effectGeometry, effectMaterial, effects.length);
      effectMesh.userData.cells = effects;
      const dummy = new THREE.Object3D();
      effects.forEach((cell, index) => {
        dummy.position.set(laneX(cell.ch, song.channels), 0.32, rowZ(cell.row));
        dummy.updateMatrix();
        effectMesh.setMatrixAt(index, dummy.matrix);
      });
      effectMesh.instanceMatrix.needsUpdate = true;
      this.pickables.push(effectMesh);
      this.world.add(effectMesh);
    }

    for (let channel = 0; channel < perChannel.length; channel++) {
      this.buildPhraseLine(perChannel[channel], song.channels, channel);
    }
    this.noteCount = cells.length;
    this.effectCount = effects.length;
  }

  buildPhraseLine(cells, channels, channel) {
    if (cells.length < 2) return;
    const positions = [];
    for (let index = 1; index < cells.length; index++) {
      const previous = cells[index - 1];
      const current = cells[index];
      if (current.row - previous.row > 16) continue;
      const x = laneX(channel, channels);
      positions.push(
        x, pitchY(previous.note), rowZ(previous.row),
        x, pitchY(current.note), rowZ(current.row)
      );
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: NOTE_COLORS[channel % NOTE_COLORS.length],
      transparent: true,
      opacity: 0.43
    }));
    this.world.add(line);
  }

  buildActivity(song, pattern, palette) {
    const counts = new Uint8Array(ROWS);
    let maxCount = 1;
    for (let row = 0; row < ROWS; row++) {
      for (let channel = 0; channel < song.channels; channel++) {
        const offset = (row * song.channels + channel) * 4;
        if (pattern[offset] || pattern[offset + 2] || pattern[offset + 3]) counts[row]++;
      }
      maxCount = Math.max(maxCount, counts[row]);
    }
    const width = (song.channels - 1) * CH_STEP + 1.85;
    const geometry = new THREE.BoxGeometry(0.22, 1, ROW_STEP * 0.55);
    const material = new THREE.MeshStandardMaterial({
      color: palette.cyan,
      emissive: palette.cyan,
      emissiveIntensity: 0.22,
      transparent: true,
      opacity: 0.56,
      roughness: 0.5,
      metalness: 0.28
    });
    const mesh = new THREE.InstancedMesh(geometry, material, ROWS);
    const dummy = new THREE.Object3D();
    for (let row = 0; row < ROWS; row++) {
      const height = 0.08 + (counts[row] / maxCount) * 1.45;
      dummy.position.set(width / 2 + 0.62, height / 2, rowZ(row));
      dummy.scale.set(1, height, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(row, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.world.add(mesh);
  }

  buildMarkers(song, palette) {
    const width = (song.channels - 1) * CH_STEP + 2.25;
    this.scanMaterial = new THREE.MeshBasicMaterial({
      color: palette.accent,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.playhead = new THREE.Mesh(new THREE.PlaneGeometry(width, 6.8), this.scanMaterial);
    this.playhead.position.y = 3.35;
    this.world.add(this.playhead);

    this.playheadRail = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.25, 0.08, 0.12),
      new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.94 })
    );
    this.world.add(this.playheadRail);

    const markerGeometry = makeNoteGeometry(1.5, 0.54, 0.44);
    const edges = new THREE.EdgesGeometry(markerGeometry);
    this.cursorMarker = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
      color: palette.text,
      transparent: true,
      opacity: 0.92
    }));
    this.world.add(this.cursorMarker);
  }

  buildLegend(song, pattern) {
    const used = new Map();
    for (let row = 0; row < ROWS; row++) {
      for (let channel = 0; channel < song.channels; channel++) {
        const offset = (row * song.channels + channel) * 4;
        const sample = pattern[offset + 1] || 0;
        if (!pattern[offset] || !sample || used.has(sample)) continue;
        const name = song.samples[sample - 1]?.name || `SAMPLE ${hex2(sample)}`;
        used.set(sample, name);
      }
    }
    this.legend.replaceChildren();
    for (const [sample, name] of [...used.entries()].slice(0, 6)) {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.setProperty('--swatch', instrumentColor(sample, 0));
      item.append(swatch, document.createTextNode(`${hex2(sample)} ${name}`));
      this.legend.appendChild(item);
    }
  }

  updateMarkers(now = performance.now()) {
    if (!this.tracker || !this.cursorMarker || !this.playhead) return;
    const state = this.tracker.state;
    const song = state.song;
    const playRow = state.playing && state.playRow >= 0 ? state.playRow : state.cursor.row;
    const cursorCell = readCell(song, this.patternIndex, state.cursor.row, state.cursor.ch);
    const cursorY = cursorCell.note ? pitchY(cursorCell.note) : 0.28;
    this.cursorScale = cursorCell.note ? 1 : 0.72;

    this.cursorMarker.position.set(laneX(state.cursor.ch, song.channels), cursorY, rowZ(state.cursor.row));
    this.cursorMarker.scale.setScalar(this.cursorScale);
    this.playhead.position.z = rowZ(playRow);
    this.playheadRail.position.set(0, 0.09, rowZ(playRow));
    this.scanLight.position.set(0, 3.2, rowZ(playRow) + 0.4);
    this.playhead.visible = state.playing;
    this.playheadRail.visible = state.playing || state.view === 'three';
    this.playheadRail.material.opacity = state.playing ? 0.9 : 0.52 + Math.sin(now * 0.006) * 0.12;
    this.updateHud(cursorCell, playRow);
  }

  updateHud(cell, activeRow) {
    if (!this.tracker || !this.song) return;
    const state = this.tracker.state;
    this.readout.textContent = `PAT ${hex2(this.patternIndex)}  ROW ${hex2(activeRow)}  CH ${state.cursor.ch + 1}`;
    this.density.textContent = `${this.noteCount || 0} NOTES  ${this.effectCount || 0} FX`;
    this.detail.textContent = describeCell(this.song, this.hoveredCell || cell);
  }

  onPointerMove(event) {
    const bounds = this.panel.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1;
    this.pointer.y = -(((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 - 1);
    this.pointerBias.set(this.pointer.x, this.pointer.y);
    const cell = this.pickCell();
    this.hoveredCell = cell;
    this.panel.classList.toggle('has-pick', Boolean(cell));
    if (this.song && this.tracker) {
      const cursor = this.tracker.state.cursor;
      this.updateHud(readCell(this.song, this.patternIndex, cursor.row, cursor.ch),
        this.tracker.state.playing ? this.tracker.state.playRow : cursor.row);
    }
  }

  onPointerLeave() {
    this.hoveredCell = null;
    this.pointerBias.set(0, 0);
    this.panel.classList.remove('has-pick');
  }

  pickCell() {
    if (!this.active || !this.ready) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    if (!hit || hit.instanceId == null) return null;
    return hit.object.userData.cells?.[hit.instanceId] || null;
  }

  onClick(event) {
    if (!this.active || !this.ready) return;
    this.onPointerMove(event);
    if (!this.hoveredCell) return;
    this.tracker.ui?.setCursor(this.hoveredCell.row, this.hoveredCell.ch);
  }

  diagnostics() {
    if (!this.renderer) return null;
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pixelRatio: this.renderer.getPixelRatio(),
      mode: this.cameraMode
    };
  }
}

function laneX(channel, channels) {
  return (channel - (channels - 1) / 2) * CH_STEP;
}

function rowZ(row) {
  return (31.5 - row) * ROW_STEP;
}

function pitchY(note) {
  return 0.62 + Math.max(0, note - 1) * PITCH_STEP;
}

function instrumentColor(sample, channel) {
  const index = sample ? sample - 1 : channel;
  return NOTE_COLORS[((index % NOTE_COLORS.length) + NOTE_COLORS.length) % NOTE_COLORS.length];
}

function cellVolume(song, cell) {
  if (cell.fx === 0xC) return THREE.MathUtils.clamp(cell.pm / 64, 0.12, 1);
  const sample = cell.smp ? song.samples[cell.smp - 1] : null;
  return THREE.MathUtils.clamp((sample?.volume ?? 48) / 64, 0.12, 1);
}

function readCell(song, patternIndex, row, channel) {
  const pattern = song.patterns[patternIndex];
  const offset = (row * song.channels + channel) * 4;
  return {
    row,
    ch: channel,
    note: pattern?.[offset] || 0,
    smp: pattern?.[offset + 1] || 0,
    fx: pattern?.[offset + 2] || 0,
    pm: pattern?.[offset + 3] || 0
  };
}

function describeCell(song, cell) {
  if (!cell) return 'NO EVENT';
  const note = window.tracker?.MOD?.noteName(cell.note) || '...';
  const sampleName = cell.smp ? (song.samples[cell.smp - 1]?.name || `SAMPLE ${hex2(cell.smp)}`) : 'NO SAMPLE';
  const effect = cell.fx || cell.pm ? `  FX ${cell.fx.toString(16).toUpperCase()}${hex2(cell.pm)}` : '';
  if (!cell.note && !cell.fx && !cell.pm) return `ROW ${hex2(cell.row)}  CH ${cell.ch + 1}  EMPTY`;
  return `ROW ${hex2(cell.row)}  CH ${cell.ch + 1}  ${note}  ${hex2(cell.smp)} ${sampleName.toUpperCase()}${effect}`;
}

function makeNoteGeometry(width = 1.62, height = 0.38, depth = 0.34) {
  const radius = 0.1;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2 + radius, -height / 2);
  shape.lineTo(width / 2 - radius, -height / 2);
  shape.quadraticCurveTo(width / 2, -height / 2, width / 2, -height / 2 + radius);
  shape.lineTo(width / 2, height / 2 - radius);
  shape.quadraticCurveTo(width / 2, height / 2, width / 2 - radius, height / 2);
  shape.lineTo(-width / 2 + radius, height / 2);
  shape.quadraticCurveTo(-width / 2, height / 2, -width / 2, height / 2 - radius);
  shape.lineTo(-width / 2, -height / 2 + radius);
  shape.quadraticCurveTo(-width / 2, -height / 2, -width / 2 + radius, -height / 2);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.035,
    bevelThickness: 0.035
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

function makeLabel(text, color, x, y, z, width = 1.1) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = '600 30px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = 'rgba(4, 8, 14, 0.72)';
  context.fillRect(0, 12, canvas.width, 72);
  context.strokeStyle = color;
  context.globalAlpha = 0.46;
  context.strokeRect(1, 13, canvas.width - 2, 70);
  context.globalAlpha = 1;
  context.fillStyle = color;
  context.fillText(text, 256, 50);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(x, y, z);
  sprite.scale.set(width, width * 0.1875, 1);
  return sprite;
}

function hex2(value) {
  return Math.max(0, value | 0).toString(16).toUpperCase().padStart(2, '0');
}

function disposeObject(object) {
  object.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (!child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose();
      }
      material.dispose();
    }
  });
}

window.WebTracker3D = new TrackerCore3D();
if (window.tracker?.state?.view === 'three') window.WebTracker3D.setActive(true);
