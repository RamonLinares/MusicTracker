/* patternview.js — canvas pattern editor rendering + hit-testing.
 *
 * Each channel cell renders as "C-2 01 A0F" (note, sample hex, effect+param).
 * Cursor sub-columns: 0=note, 1/2=sample digits, 3=effect, 4/5=param digits.
 */
'use strict';

const PatternView = (() => {
  const ROWH = 18;
  const FONT = '13px "SF Mono", Menlo, Consolas, monospace';
  const CELL_CHARS = 10;       // "C-2 01 A0F"
  const PAD = 8;               // px padding inside each channel column
  const ROWNUM_W = 34;

  // char index span for each cursor sub-column within the cell text
  const COL_SPAN = [[0, 3], [4, 1], [5, 1], [7, 1], [8, 1], [9, 1]];

  const CLR = {
    bg: '#0d1017',
    rowNum: '#4d5a75',
    rowNumBeat: '#7d8db0',
    beatBg: '#141926',
    barBg: '#181f30',
    playBg: '#28405c',
    cursorRowBg: '#1c2740',
    sep: '#232c42',
    note: '#d6e2f5',
    noteEmpty: '#333e58',
    ins: '#6fc3e0',
    fx: '#f0a860',
    fxEmpty: '#2c3650',
    cursorBg: '#ff933030',
    cursor: '#ffa040',
    cursorText: '#10131a',
    mutedOverlay: 'rgba(13,16,23,0.72)'
  };

  let charW = 8;
  let measured = false;

  function measure(ctx) {
    ctx.font = FONT;
    charW = ctx.measureText('0').width;
    measured = true;
  }

  function cellW() { return CELL_CHARS * charW + PAD * 2; }
  function totalW(channels) { return ROWNUM_W + channels * cellW(); }

  function hex(n, d) { return n.toString(16).toUpperCase().padStart(d, '0'); }

  function cellText(pd, channels, row, ch) {
    const o = (row * channels + ch) * 4;
    const note = pd[o], smp = pd[o + 1], fx = pd[o + 2], pm = pd[o + 3];
    return {
      note: MOD.noteName(note),
      hasNote: !!note,
      ins: smp ? hex(smp, 2) : '··',
      hasIns: !!smp,
      fx: (fx || pm) ? hex(fx, 1) + hex(pm, 2) : '···',
      hasFx: !!(fx || pm)
    };
  }

  /* state: { pattern (index), cursor:{row,ch,col}, playRow (or -1), muted:[], editMode } */
  function draw(canvas, song, state) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    measure(ctx);

    const channels = song.channels;
    const w = totalW(channels);
    const cssH = canvas.clientHeight || 460;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = w + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const h = cssH;
    ctx.fillStyle = CLR.bg;
    ctx.fillRect(0, 0, w, h);

    const pd = song.patterns[state.pattern];
    const visRows = Math.floor(h / ROWH);
    const centerRow = state.playRow >= 0 && state.follow ? state.playRow : state.cursor.row;
    const topRow = centerRow - (visRows >> 1);
    const cw = cellW();

    for (let i = 0; i < visRows; i++) {
      const r = topRow + i;
      if (r < 0 || r > 63) continue;
      const y = i * ROWH;

      if (r % 16 === 0) { ctx.fillStyle = CLR.barBg; ctx.fillRect(0, y, w, ROWH); }
      else if (r % 4 === 0) { ctx.fillStyle = CLR.beatBg; ctx.fillRect(0, y, w, ROWH); }
      if (r === state.cursor.row && state.playRow < 0) {
        ctx.fillStyle = CLR.cursorRowBg; ctx.fillRect(0, y, w, ROWH);
      }
      if (r === state.playRow) { ctx.fillStyle = CLR.playBg; ctx.fillRect(0, y, w, ROWH); }

      ctx.fillStyle = r % 4 === 0 ? CLR.rowNumBeat : CLR.rowNum;
      ctx.fillText(String(r).padStart(2, '0'), 8, y + ROWH / 2);

      if (!pd) continue;
      for (let ch = 0; ch < channels; ch++) {
        const x0 = ROWNUM_W + ch * cw + PAD;
        const t = cellText(pd, channels, r, ch);

        // cursor cell background
        if (r === state.cursor.row && ch === state.cursor.ch) {
          const [ci, cl] = COL_SPAN[state.cursor.col];
          ctx.fillStyle = state.editMode ? CLR.cursor : '#5a6a8a';
          ctx.fillRect(x0 + ci * charW - 2, y + 1, cl * charW + 4, ROWH - 2);
        }

        const drawPart = (str, chIdx, color) => {
          for (let k = 0; k < str.length; k++) {
            const cx = chIdx + k;
            const onCursor = r === state.cursor.row && ch === state.cursor.ch &&
              cx >= COL_SPAN[state.cursor.col][0] &&
              cx < COL_SPAN[state.cursor.col][0] + COL_SPAN[state.cursor.col][1];
            ctx.fillStyle = onCursor ? CLR.cursorText : color;
            ctx.fillText(str[k], x0 + cx * charW, y + ROWH / 2);
          }
        };
        drawPart(t.note, 0, t.hasNote ? CLR.note : CLR.noteEmpty);
        drawPart(t.ins, 4, t.hasIns ? CLR.ins : CLR.noteEmpty);
        drawPart(t.fx, 7, t.hasFx ? CLR.fx : CLR.fxEmpty);
      }
    }

    // block selection overlay
    if (state.sel) {
      const s = state.sel;
      const y0 = Math.max(-1, (s.r0 - topRow)) * ROWH;
      const y1 = Math.min(visRows + 1, (s.r1 - topRow + 1)) * ROWH;
      if (y1 > 0 && y0 < h) {
        const x0 = ROWNUM_W + s.c0 * cw;
        const x1 = ROWNUM_W + (s.c1 + 1) * cw;
        ctx.fillStyle = 'rgba(110,160,255,0.16)';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = 'rgba(130,175,255,0.55)';
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      }
    }

    // channel separators + muted overlay
    for (let ch = 0; ch <= channels; ch++) {
      const x = ROWNUM_W + ch * cw;
      ctx.fillStyle = CLR.sep;
      ctx.fillRect(x - (ch ? 1 : 0), 0, 1, h);
    }
    for (let ch = 0; ch < channels; ch++) {
      if (state.muted && state.muted[ch]) {
        ctx.fillStyle = CLR.mutedOverlay;
        ctx.fillRect(ROWNUM_W + ch * cw, 0, cw, h);
      }
    }

    // center line marker
    const cy = (visRows >> 1) * ROWH;
    ctx.strokeStyle = '#3a4a6a';
    ctx.strokeRect(0.5, cy + 0.5, w - 1, ROWH - 1);
  }

  /* map click position to {row, ch, col} or null */
  function hitTest(canvas, song, state, px, py) {
    const channels = song.channels;
    const cssH = canvas.clientHeight || 460;
    const visRows = Math.floor(cssH / ROWH);
    const centerRow = state.playRow >= 0 && state.follow ? state.playRow : state.cursor.row;
    const topRow = centerRow - (visRows >> 1);
    const row = topRow + Math.floor(py / ROWH);
    if (row < 0 || row > 63) return null;
    const cw = cellW();
    if (px < ROWNUM_W) return { row, ch: state.cursor.ch, col: state.cursor.col };
    const ch = Math.floor((px - ROWNUM_W) / cw);
    if (ch < 0 || ch >= channels) return null;
    const cx = Math.floor((px - ROWNUM_W - ch * cw - PAD) / charW);
    let col = 0;
    for (let i = 0; i < COL_SPAN.length; i++) {
      const [s, l] = COL_SPAN[i];
      if (cx >= s && cx < s + l) { col = i; break; }
      if (cx >= s + l) col = i;
    }
    return { row, ch, col };
  }

  function channelHeaderMetrics(channels) {
    if (!measured) measure(document.createElement('canvas').getContext('2d'));
    return { rowNumW: ROWNUM_W, cellW: cellW() };
  }

  return { draw, hitTest, channelHeaderMetrics, ROWH };
})();
