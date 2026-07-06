# WebTracker

A modern web-based Amiga music tracker inspired by **ProTracker** and **OctaMED**,
compatible with the classic Amiga module formats: loads and saves ProTracker
`.MOD` (`M.K.`, plus `M!K!`, `FLT4`, `xCHN` and 15-sample Ultimate SoundTracker
on load) and loads **OctaMED MMD0/MMD1** modules.

## Running

The app is plain HTML/JS — it only needs a static file server (the AudioWorklet
module can't be loaded from `file://`):

```sh
python3 -m http.server 8642
# then open http://localhost:8642
```

A demo chiptune is loaded on startup. Press **Space** to loop the current
pattern, **Shift+Space** to play the song, **F1** for the keyboard reference.

## Features

- **Authentic playback engine** — a ProTracker replayer running in an
  AudioWorklet: Paula-style period-based resampling (PAL clock), tick/row
  timing from BPM (`sampleRate · 2.5 / BPM`), Amiga L-R-R-L stereo panning.
- **Full effect set** — arpeggio (0xy), portamento (1/2/3), vibrato (4),
  porta+volslide (5), vib+volslide (6), tremolo (7), sample offset (9),
  volume slide (A), position jump (B), set volume (C), pattern break (D),
  E-commands (LED filter E0, fine porta E1/E2, glissando control E3,
  vibrato/tremolo waveform select E4/E7 — sine/ramp/square/random,
  set finetune E5, pattern loop E6, retrigger E9, fine volume EA/EB,
  note cut EC, note delay ED, pattern delay EE), and speed/tempo (F).
- **Paula mode** — a header toggle switches from clean linear interpolation to
  authentic Amiga output: nearest-neighbour 8-bit resampling, the A500's fixed
  ~4.9 kHz RC low-pass, and the ~3.3 kHz "LED" filter controlled by E0x.
  WAV export honors the toggle.
- **Live record mode** — with EDIT on while playing (button turns to a red
  REC), note keys sound immediately and are written into the playing pattern,
  quantized to the nearest row; one undo step removes the whole take.
- **Pattern editor** — canvas grid with ProTracker-style two-row piano keymap,
  hex entry for sample/effect columns, adjustable edit step, follow mode,
  live jam on keys, **block selection** (Shift+arrows or mouse drag),
  **copy/cut/paste**, **transpose** (semitone/octave), track insert/delete,
  per-channel **mute and solo**.
- **Undo/redo** — up to 250 steps covering pattern edits, block operations,
  order-list changes and sample edits (Ctrl/⌘+Z, Shift+Ctrl/⌘+Z).
- **31 samples** — 8-bit signed with loop points, volume, finetune; import any
  audio file (WAV/MP3/…) resampled to the Amiga C-2 rate (8287 Hz).
- **Waveform editor** — drag to select a region; trim, cut, fade in/out,
  normalize, reverse, silence, set loop from selection; freehand **draw mode**
  (drawing on an empty slot creates a looping chip waveform).
- **Song editor** — order list (up to 128 positions), insert/delete positions,
  per-position pattern assignment, oscilloscopes per channel, **4–8 channels**
  (CH −/+ in the order bar; 4-channel songs save as `M.K.`, others as
  `6CHN`/`8CHN` etc., which OpenMPT/MilkyTracker and most players read).
- **File I/O** — byte-exact round-trip of pattern data with real ProTracker
  modules; saved files open in ProTracker, OctaMED, OpenMPT, MilkyTracker, etc.
  OctaMED MMD0/MMD1 files are converted on load (blocks longer than 64 lines
  are split into chained patterns, MED commands are mapped to their ProTracker
  equivalents, play/sample transpose is baked in; MMD2/3 are not supported).
- **MED synthsounds** — synthetic and hybrid instruments play through a
  tick-rate interpreter of their volume/waveform programs: volume envelopes,
  waveform cycling, SPD/WAI/JMP/HLT/CHU/CHD, ARP chord arpeggios and the
  JVS/JWS cross-jumps (synth vibrato commands are parsed but skipped). Synth
  instruments show as `syn`/`hyb` in the sample list and can be jammed and
  sequenced like samples — but they can't be saved to .MOD, which has no
  synth concept.
- **WAV export** — renders the whole song offline (honoring tempo changes,
  jumps, breaks and loops when computing the length) to 44.1 kHz 16-bit
  stereo. Muted channels stay muted, so it can also render stems.

## Keys

Press **F1** in the app for the full reference.

| Key | Action |
| --- | --- |
| `Z`–`M`, `Q`–`P` | enter notes (two octaves, ProTracker layout) |
| `Space` / `Shift+Space` | play pattern / play song · stop |
| `[` / `]` | octave down / up |
| `Tab`, arrows, PgUp/PgDn, Home/End | navigate |
| `Shift`+arrows or mouse drag | select block |
| `Ctrl/⌘` + `C` `X` `V` `A` `Z` | copy · cut · paste · select · undo |
| `Shift+Alt+↑/↓` (`PgUp/PgDn`) | transpose ±1 semitone (±1 octave) |
| `0-9 A-F` | hex entry in sample/effect columns |
| `Delete` / `Insert` / `Backspace` | clear · push track down · pull up |
| click / shift+click channel header | mute / solo |

## Files

- `index.html`, `css/style.css` — UI shell
- `js/mod.js` — ProTracker MOD parser/writer, note tables, demo song
- `js/med.js` — OctaMED MMD0/MMD1 loader
- `js/worklet.js` — replayer + mixer (audio thread)
- `js/player.js` — main-thread AudioWorklet wrapper
- `js/patternview.js` — canvas pattern editor
- `js/app.js` — UI glue, keyboard, selection/undo, sample & order editors, file I/O
