/* visual3d.js - Three.js tracker core view. */
'use strict';

import * as THREE from './vendor/three.module.min.js';

const ROWS = 64;
const ROW_STEP = 0.34;
const CH_STEP = 1.72;
const COLORS = ['#6fc3e0', '#ffa040', '#7ee08a', '#ff5b7d', '#c891ff', '#ffe15a', '#55ffd8', '#ff7a4d'];

class TrackerCore3D {
  constructor() {
    this.panel = document.getElementById('threePanel');
    this.mount = document.getElementById('threeMount');
    this.readout = document.getElementById('threeReadout');
    this.density = document.getElementById('threeDensity');
    this.fallback = document.getElementById('threeFallback');
    this.active = false;
    this.ready = false;
    this.failed = false;
    this.signature = '';
    this.frame = 0;
    this.pointer = new THREE.Vector2();
    this.targetTilt = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.pickables = [];
    this.lastFrameTime = performance.now();
    this._onMove = e => this.onPointerMove(e);
    this._onClick = e => this.onClick(e);
    this.panel.addEventListener('pointermove', this._onMove);
    this.panel.addEventListener('click', this._onClick);
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

  init() {
    try {
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2(0x050812, 0.028);
      this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
      this.camera.position.set(0, 8.2, 15.5);
      this.camera.lookAt(0, 1.6, 0);

      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.2;
      this.mount.appendChild(this.renderer.domElement);

      this.world = new THREE.Group();
      this.scene.add(this.world);

      this.ambient = new THREE.AmbientLight(0x8aa0ff, 0.32);
      this.scene.add(this.ambient);
      this.keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
      this.keyLight.position.set(-5, 9, 7);
      this.scene.add(this.keyLight);
      this.cyberLight = new THREE.PointLight(0x6fc3e0, 22, 22);
      this.cyberLight.position.set(0, 4, 0);
      this.scene.add(this.cyberLight);
      this.warmLight = new THREE.PointLight(0xffa040, 14, 18);
      this.warmLight.position.set(4, 3, 5);
      this.scene.add(this.warmLight);

      this.ready = true;
    } catch (err) {
      console.warn('3D view failed:', err);
      this.failed = true;
      this.fallback.classList.remove('hidden');
    }
  }

  refresh() {
    if (!this.active || !this.ready) return;
    const next = this.makeSignature();
    if (next === this.signature) {
      this.updateHud();
      this.updateMarkers();
      return;
    }
    this.signature = next;
    this.rebuildWorld();
  }

  resize() {
    if (!this.ready || !this.renderer) return;
    const r = this.panel.getBoundingClientRect();
    const w = Math.max(2, Math.floor(r.width));
    const h = Math.max(2, Math.floor(r.height));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  animate() {
    if (!this.ready || !this.active) return;
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) * 0.001));
      this.lastFrameTime = now;
      const t = now * 0.001;
      this.frame++;
      if (this.frame % 24 === 0) this.refresh();
      this.world.rotation.y = THREE.MathUtils.damp(this.world.rotation.y, this.targetTilt.x * 0.18, 4, dt);
      this.world.rotation.x = THREE.MathUtils.damp(this.world.rotation.x, this.targetTilt.y * 0.06, 4, dt);
      if (this.core) {
        this.core.rotation.x += dt * 0.42;
        this.core.rotation.y += dt * 0.67;
        const s = 1 + Math.sin(t * 2.7) * 0.04;
        this.core.scale.setScalar(s);
      }
      if (this.sampleHelix) this.sampleHelix.rotation.y += dt * 0.22;
      if (this.starfield) this.starfield.rotation.y -= dt * 0.012;
      this.updateMarkers();
      this.renderer.render(this.scene, this.camera);
    });
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
    const pd = song.patterns[this.patternIndex] || new Uint8Array(0);
    let sum = 2166136261;
    for (let i = 0; i < pd.length; i++) {
      sum ^= pd[i] + i;
      sum = Math.imul(sum, 16777619);
    }
    const sample = song.samples[state.curSample] || {};
    return [
      song.title, song.channels, this.patternIndex, state.curPos, state.curSample,
      sample.name || '', sample.data ? sample.data.length : 0, sum >>> 0
    ].join('|');
  }

  palette() {
    const css = getComputedStyle(document.documentElement);
    return {
      bg: css.getPropertyValue('--surface').trim() || '#0d1017',
      accent: css.getPropertyValue('--accent').trim() || '#ffa040',
      cyan: css.getPropertyValue('--cyan').trim() || '#6fc3e0',
      green: css.getPropertyValue('--green').trim() || '#7ee08a',
      text: css.getPropertyValue('--text-bright').trim() || '#d6e2f5'
    };
  }

  clearWorld() {
    this.pickables.length = 0;
    while (this.world.children.length) {
      const child = this.world.children.pop();
      disposeObject(child);
    }
  }

  rebuildWorld() {
    this.clearWorld();
    const song = this.song;
    if (!song) return;

    const pal = this.palette();
    this.scene.background = new THREE.Color(pal.bg);
    this.scene.fog.color.set(pal.bg);
    this.cyberLight.color.set(pal.cyan);
    this.warmLight.color.set(pal.accent);

    this.buildStarfield(pal);
    this.buildFloor(song, pal);
    this.buildPattern(song, pal);
    this.buildSampleHelix(song, pal);
    this.buildWaveRibbon(song, pal);
    this.buildCore(pal);
    this.updateMarkers();
    this.updateHud();
  }

  buildStarfield(pal) {
    const count = 680;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const c1 = new THREE.Color(pal.cyan);
    const c2 = new THREE.Color(pal.accent);
    for (let i = 0; i < count; i++) {
      const r = 18 + seeded(i * 17) * 36;
      const a = seeded(i * 31) * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = -3 + seeded(i * 43) * 22;
      pos[i * 3 + 2] = Math.sin(a) * r - 8;
      const c = c1.clone().lerp(c2, seeded(i * 67));
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.045,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false
    });
    this.starfield = new THREE.Points(geo, mat);
    this.world.add(this.starfield);
  }

  buildFloor(song, pal) {
    const size = Math.max(32, song.channels * 5);
    const grid = new THREE.GridHelper(size, 32, new THREE.Color(pal.cyan), new THREE.Color('#1b263b'));
    grid.position.y = -0.12;
    grid.material.transparent = true;
    grid.material.opacity = 0.32;
    this.world.add(grid);

    const aisle = new THREE.Mesh(
      new THREE.PlaneGeometry(song.channels * CH_STEP + 2.5, ROWS * ROW_STEP + 4),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.cyan), transparent: true, opacity: 0.035, side: THREE.DoubleSide })
    );
    aisle.rotation.x = -Math.PI / 2;
    aisle.position.y = -0.105;
    this.world.add(aisle);
  }

  buildPattern(song, pal) {
    const channels = song.channels;
    const pd = song.patterns[this.patternIndex] || new Uint8Array(ROWS * channels * 4);
    const total = ROWS * channels;
    const x0 = -((channels - 1) * CH_STEP) / 2;
    const geom = new THREE.BoxGeometry(0.82, 1, 0.19);
    const mat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.28,
      metalness: 0.34,
      vertexColors: true,
      emissive: new THREE.Color('#081019'),
      emissiveIntensity: 0.85
    });
    const mesh = new THREE.InstancedMesh(geom, mat, total);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.cells = [];
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let notes = 0;

    for (let ch = 0; ch < channels; ch++) {
      for (let row = 0; row < ROWS; row++) {
        const i = ch * ROWS + row;
        const off = (row * channels + ch) * 4;
        const note = pd[off] || 0;
        const smp = pd[off + 1] || 0;
        const fx = pd[off + 2] || 0;
        const pm = pd[off + 3] || 0;
        const height = note ? 0.14 + (note / 36) * 2.65 : 0.025;
        const width = fx || pm ? 1.0 : 0.82;
        dummy.position.set(x0 + ch * CH_STEP, height / 2, rowZ(row));
        dummy.scale.set(width, height, note ? 1 : 0.58);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        color.set(note ? COLORS[(smp || ch + 1) % COLORS.length] : '#182338');
        if (fx || pm) color.lerp(new THREE.Color(pal.accent), 0.45);
        mesh.setColorAt(i, color);
        mesh.userData.cells[i] = { row, ch, note, smp, fx, pm };
        if (note) notes++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.noteMesh = mesh;
    this.pickables.push(mesh);
    this.world.add(mesh);
    this.noteCount = notes;

    const railGeom = new THREE.BoxGeometry(0.04, 0.04, ROWS * ROW_STEP + 0.8);
    const railMat = new THREE.MeshBasicMaterial({ color: pal.cyan, transparent: true, opacity: 0.3 });
    for (let ch = 0; ch < channels; ch++) {
      const rail = new THREE.Mesh(railGeom, railMat.clone());
      rail.position.set(x0 + ch * CH_STEP, 0.05, 0);
      this.world.add(rail);
      this.world.add(makeLabel(`CH ${ch + 1}`, COLORS[ch % COLORS.length], x0 + ch * CH_STEP, 3.6, rowZ(-3)));
      this.buildMelodyLine(pd, channels, ch, x0 + ch * CH_STEP, COLORS[ch % COLORS.length]);
    }

    this.cursor = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 2.9, 0.24),
      new THREE.MeshBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.18, depthWrite: false })
    );
    this.world.add(this.cursor);

    this.playhead = new THREE.Mesh(
      new THREE.BoxGeometry(channels * CH_STEP + 1.5, 0.08, 0.13),
      new THREE.MeshBasicMaterial({ color: pal.cyan, transparent: true, opacity: 0.7 })
    );
    this.world.add(this.playhead);
  }

  buildMelodyLine(pd, channels, ch, x, color) {
    const points = [];
    for (let row = 0; row < ROWS; row++) {
      const off = (row * channels + ch) * 4;
      const note = pd[off] || 0;
      if (!note) continue;
      points.push(new THREE.Vector3(x, 0.28 + (note / 36) * 2.65, rowZ(row)));
    }
    if (points.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.48 });
    const line = new THREE.Line(geo, mat);
    this.world.add(line);
  }

  buildSampleHelix(song, pal) {
    const state = this.tracker.state;
    const geom = new THREE.SphereGeometry(0.12, 14, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.18,
      metalness: 0.55,
      vertexColors: true,
      emissive: new THREE.Color(pal.cyan),
      emissiveIntensity: 0.28
    });
    const mesh = new THREE.InstancedMesh(geom, mat, 31);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const x = ((song.channels - 1) * CH_STEP) / 2 + 2.5;
    for (let i = 0; i < 31; i++) {
      const a = i * 0.72;
      const s = song.samples[i];
      const scale = i === state.curSample ? 1.75 : (s && (s.data.length || s.synth) ? 1.12 : 0.62);
      dummy.position.set(x + Math.cos(a) * 0.75, 0.35 + i * 0.105, rowZ(7 + i * 1.45) + Math.sin(a) * 0.75);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.set(i === state.curSample ? pal.accent : COLORS[i % COLORS.length]);
      if (!s || (!s.data.length && !s.synth)) color.multiplyScalar(0.35);
      mesh.setColorAt(i, color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.sampleHelix = mesh;
    this.world.add(mesh);
  }

  buildWaveRibbon(song, pal) {
    const state = this.tracker.state;
    const sample = song.samples[state.curSample];
    if (!sample) return;
    let data = sample.data;
    if ((!data || !data.length) && sample.synth) data = sample.synth.waveforms.find(w => w.length);
    if (!data || !data.length) return;
    const points = [];
    const take = Math.min(160, data.length);
    const xBase = -((song.channels - 1) * CH_STEP) / 2 - 2.3;
    for (let i = 0; i < take; i++) {
      const src = Math.floor((i / take) * data.length);
      points.push(new THREE.Vector3(
        xBase + (data[src] / 128) * 0.8,
        1.3 + Math.sin(i * 0.28) * 0.16,
        rowZ((i / take) * 63)
      ));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: pal.green, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(geo, mat);
    this.world.add(line);
    this.world.add(makeLabel('WAVE', pal.green, xBase, 2.55, rowZ(-4)));
  }

  buildCore(pal) {
    const coreGeo = new THREE.TorusKnotGeometry(0.84, 0.22, 140, 14, 2, 5);
    const coreMat = new THREE.MeshStandardMaterial({
      color: pal.accent,
      emissive: pal.accent,
      emissiveIntensity: 1.15,
      metalness: 0.58,
      roughness: 0.18
    });
    this.core = new THREE.Mesh(coreGeo, coreMat);
    this.core.position.set(0, 3.45, rowZ(29));
    this.world.add(this.core);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 32, 16),
      new THREE.MeshBasicMaterial({ color: pal.cyan, transparent: true, opacity: 0.08, depthWrite: false })
    );
    halo.position.copy(this.core.position);
    this.world.add(halo);
  }

  updateMarkers() {
    if (!this.tracker || !this.cursor || !this.playhead) return;
    const state = this.tracker.state;
    const song = state.song;
    const x0 = -((song.channels - 1) * CH_STEP) / 2;
    const row = state.playing && state.playRow >= 0 ? state.playRow : state.cursor.row;
    this.cursor.position.set(x0 + state.cursor.ch * CH_STEP, 1.45, rowZ(state.cursor.row));
    this.playhead.position.set(0, 3.15 + Math.sin(performance.now() * 0.008) * 0.06, rowZ(row));
    this.playhead.visible = state.playing || state.view === 'three';
    this.updateHud();
  }

  updateHud() {
    if (!this.tracker || !this.song) return;
    const state = this.tracker.state;
    const row = state.playing && state.playRow >= 0 ? state.playRow : state.cursor.row;
    this.readout.textContent = `PAT ${String(this.patternIndex).padStart(2, '0')} · ROW ${String(row).padStart(2, '0')} · CH ${state.cursor.ch + 1}`;
    this.density.textContent = `${String(this.noteCount || 0).padStart(2, '0')} NOTES`;
  }

  onPointerMove(e) {
    const r = this.panel.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    this.pointer.y = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
    this.targetTilt.set(this.pointer.x, this.pointer.y);
  }

  onClick(e) {
    if (!this.active || !this.ready || !this.noteMesh) return;
    this.onPointerMove(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    if (!hit || hit.instanceId == null) return;
    const cell = hit.object.userData.cells[hit.instanceId];
    if (!cell) return;
    this.tracker.ui?.setCursor(cell.row, cell.ch);
    this.updateHud();
  }
}

function rowZ(row) {
  return (31.5 - row) * ROW_STEP;
}

function seeded(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function makeLabel(text, color, x, y, z) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(x, y, z);
  sprite.scale.set(1.1, 0.28, 1);
  return sprite;
}

function disposeObject(obj) {
  obj.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        for (const value of Object.values(mat)) {
          if (value && value.isTexture) value.dispose();
        }
        mat.dispose();
      }
    }
  });
}

window.WebTracker3D = new TrackerCore3D();
if (window.tracker?.state?.view === 'three') window.WebTracker3D.setActive(true);
