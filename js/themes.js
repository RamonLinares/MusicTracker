/* themes.js — visual themes. Each theme is a pair of:
 *   - CSS custom properties, applied via [data-theme] blocks in style.css
 *   - a canvas palette used by the pattern view, scopes, waveform and drum grid
 * The choice persists in localStorage (it's a UI preference, not song data). */
'use strict';

const Themes = (() => {

  const THEMES = {
    amiga: {
      label: 'Amiga (retro)',
      canvas: {
        bg: '#0d1017', rowNum: '#4d5a75', rowNumBeat: '#7d8db0',
        beatBg: '#141926', barBg: '#181f30', playBg: '#28405c',
        cursorRowBg: '#1c2740', sep: '#232c42',
        note: '#d6e2f5', noteEmpty: '#333e58', ins: '#6fc3e0',
        fx: '#f0a860', fxEmpty: '#2c3650',
        cursor: '#ffa040', cursorText: '#10131a',
        mutedOverlay: 'rgba(13,16,23,0.72)',
        selFill: 'rgba(110,160,255,0.16)', selStroke: 'rgba(130,175,255,0.55)',
        scope: '#7ee08a', scopeMuted: '#3a4456',
        wave: '#7ee08a', waveLoop: 'rgba(110,195,224,0.12)',
        waveSel: 'rgba(255,160,64,0.18)', centerline: '#232c42',
        gridCell: '#141926', gridBeat: '#1c2438', gridHit: '#ffa040',
        gridPlay: 'rgba(140,180,255,0.22)'
      }
    },

    workbench: {
      label: 'Workbench (skeuomorphic)',
      canvas: {
        bg: '#e8e8ec', rowNum: '#8a8a96', rowNumBeat: '#50505c',
        beatBg: '#dedee4', barBg: '#d2d2dc', playBg: '#b0c8e8',
        cursorRowBg: '#d4e0f2', sep: '#a8a8b4',
        note: '#14203a', noteEmpty: '#c0c0ca', ins: '#0055aa',
        fx: '#b04a00', fxEmpty: '#d0d0d8',
        cursor: '#0055aa', cursorText: '#ffffff',
        mutedOverlay: 'rgba(232,232,236,0.72)',
        selFill: 'rgba(0,85,170,0.14)', selStroke: 'rgba(0,85,170,0.5)',
        scope: '#20663a', scopeMuted: '#a8b0a8',
        wave: '#20663a', waveLoop: 'rgba(0,85,170,0.12)',
        waveSel: 'rgba(176,74,0,0.18)', centerline: '#b8b8c2',
        gridCell: '#d8d8e0', gridBeat: '#c8c8d4', gridHit: '#cc5a00',
        gridPlay: 'rgba(0,85,170,0.25)'
      }
    },

    studio: {
      label: 'Studio (modern dark)',
      canvas: {
        bg: '#101114', rowNum: '#565a64', rowNumBeat: '#888c98',
        beatBg: '#16171b', barBg: '#1c1d22', playBg: '#3a3320',
        cursorRowBg: '#232016', sep: '#26282e',
        note: '#e8eaee', noteEmpty: '#33353c', ins: '#38b6d8',
        fx: '#ffb020', fxEmpty: '#2b2d34',
        cursor: '#ffb020', cursorText: '#141414',
        mutedOverlay: 'rgba(16,17,20,0.72)',
        selFill: 'rgba(255,176,32,0.12)', selStroke: 'rgba(255,176,32,0.45)',
        scope: '#ffb020', scopeMuted: '#3c3e44',
        wave: '#4ade80', waveLoop: 'rgba(56,182,216,0.12)',
        waveSel: 'rgba(255,176,32,0.18)', centerline: '#26282e',
        gridCell: '#191a1f', gridBeat: '#222329', gridHit: '#ffb020',
        gridPlay: 'rgba(56,182,216,0.25)'
      }
    },

    brutalist: {
      label: 'Brutalist',
      canvas: {
        bg: '#ffffff', rowNum: '#888888', rowNumBeat: '#000000',
        beatBg: '#f2f2f2', barBg: '#e6e6e6', playBg: '#c8d4ff',
        cursorRowBg: '#fff3b0', sep: '#000000',
        note: '#000000', noteEmpty: '#cccccc', ins: '#0000dd',
        fx: '#ee1100', fxEmpty: '#dddddd',
        cursor: '#000000', cursorText: '#ffff00',
        mutedOverlay: 'rgba(255,255,255,0.75)',
        selFill: 'rgba(255,240,0,0.35)', selStroke: '#000000',
        scope: '#000000', scopeMuted: '#bbbbbb',
        wave: '#000000', waveLoop: 'rgba(0,0,221,0.10)',
        waveSel: 'rgba(238,17,0,0.20)', centerline: '#999999',
        gridCell: '#eeeeee', gridBeat: '#dddddd', gridHit: '#ee1100',
        gridPlay: 'rgba(0,0,221,0.20)'
      }
    },

    terminal: {
      label: 'Terminal',
      canvas: {
        bg: '#000800', rowNum: '#0a5a2a', rowNumBeat: '#12a04c',
        beatBg: '#021204', barBg: '#053012', playBg: '#0a4020',
        cursorRowBg: '#062c12', sep: '#0a3a18',
        note: '#38ff88', noteEmpty: '#0a3a1a', ins: '#00e0c0',
        fx: '#c8ff50', fxEmpty: '#0a2c14',
        cursor: '#38ff88', cursorText: '#001004',
        mutedOverlay: 'rgba(0,6,0,0.75)',
        selFill: 'rgba(56,255,136,0.12)', selStroke: 'rgba(56,255,136,0.5)',
        scope: '#38ff88', scopeMuted: '#0e4020',
        wave: '#38ff88', waveLoop: 'rgba(0,224,192,0.12)',
        waveSel: 'rgba(200,255,80,0.18)', centerline: '#0a3a18',
        gridCell: '#021204', gridBeat: '#053012', gridHit: '#38ff88',
        gridPlay: 'rgba(0,224,192,0.25)'
      }
    },

    vapor: {
      label: 'Vaporwave',
      canvas: {
        bg: '#160a28', rowNum: '#6a5494', rowNumBeat: '#9d86cc',
        beatBg: '#1d0f34', barBg: '#251344', playBg: '#3c2a6a',
        cursorRowBg: '#2b1850', sep: '#342058',
        note: '#f2e6ff', noteEmpty: '#3c2a60', ins: '#29e6ff',
        fx: '#ff4fa0', fxEmpty: '#332052',
        cursor: '#ff4fa0', cursorText: '#1a0930',
        mutedOverlay: 'rgba(22,10,40,0.72)',
        selFill: 'rgba(41,230,255,0.13)', selStroke: 'rgba(41,230,255,0.5)',
        scope: '#29e6ff', scopeMuted: '#42306a',
        wave: '#ff4fa0', waveLoop: 'rgba(41,230,255,0.12)',
        waveSel: 'rgba(255,79,160,0.2)', centerline: '#342058',
        gridCell: '#1d0f34', gridBeat: '#2a1750', gridHit: '#ff4fa0',
        gridPlay: 'rgba(41,230,255,0.25)'
      }
    }
  };

  let current = 'amiga';

  function apply(name) {
    if (!THEMES[name]) name = 'amiga';
    current = name;
    document.documentElement.dataset.theme = name;
    try { localStorage.setItem('webtracker-theme', name); } catch (e) { /* private mode */ }
  }

  function canvas() { return THEMES[current].canvas; }

  function saved() {
    try { return localStorage.getItem('webtracker-theme') || 'amiga'; }
    catch (e) { return 'amiga'; }
  }

  // apply the saved theme immediately so the page doesn't flash the default
  apply(saved());

  return { THEMES, apply, canvas, get current() { return current; } };
})();
