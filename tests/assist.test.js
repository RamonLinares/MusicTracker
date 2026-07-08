'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const context = {};
vm.createContext(context);
for (const [name, expose] of [['mod.js', 'MOD'], ['assist.js', 'Assist']]) {
  const code = fs.readFileSync(path.join(root, 'js', name), 'utf8');
  vm.runInContext(`${code}\nthis.${expose} = ${expose};`, context, { filename: `js/${name}` });
}
const { MOD, Assist } = context;

// ---- scale membership and snapping ----------------------------------------

// A natural minor = A B C D E F G (pcs 9 11 0 2 4 5 7)
const mask = Assist.scaleMask(9, 'minor');
assert.deepEqual(
  Array.from(mask).map((v, i) => v ? i : -1).filter(i => i >= 0),
  [0, 2, 4, 5, 7, 9, 11]
);

// C#-2 (note 14) is not in A minor; snapping moves it to a neighbour in scale
assert.equal(Assist.inScale(14, 9, 'minor'), false);
const snapped = Assist.snap(14, 9, 'minor');
assert.ok([13, 15].includes(snapped), 'C# snaps to C or D');
assert.ok(Assist.inScale(snapped, 9, 'minor'));
// in-scale notes pass through untouched
assert.equal(Assist.snap(13, 9, 'minor'), 13);

// ---- diatonic chords --------------------------------------------------------

const cMajor = Assist.diatonicTriads(0, 'major');
assert.equal(cMajor.length, 7);
assert.deepEqual(Array.from(cMajor, t => t.label), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'B°']);
assert.deepEqual(Array.from(cMajor, t => t.roman), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
// pentatonic scales have no diatonic triad row
assert.equal(Assist.diatonicTriads(0, 'pentMinor').length, 0);

// ---- key detection ----------------------------------------------------------

// the built-in demo song is written in A minor
const demo = MOD.demoSong();
const key = Assist.detectKey(demo);
assert.equal(key.root, 9, 'demo song root should be A');
assert.equal(key.scale, 'minor', 'demo song scale should be minor');

// ---- generators ---------------------------------------------------------------

for (const style of ['roots', 'octaves', 'walking', 'arp']) {
  const params = { root: 9, scale: 'minor', progression: 'i–VI–III–VII',
                   style, density: 3, seed: 42 };
  const a = Assist.generateBass(params);
  const b = Assist.generateBass(params);
  assert.ok(a.length > 0, `${style}: produces notes`);
  assert.deepEqual(a, b, `${style}: deterministic for the same seed`);
  for (const e of a) {
    assert.ok(e.row >= 0 && e.row < 64, `${style}: row in range`);
    assert.ok(Assist.inScale(e.note, 9, 'minor'), `${style}: note ${e.note} in scale`);
  }
}

for (const contour of ['arch', 'rise', 'fall', 'wave', 'walk']) {
  const params = { root: 0, scale: 'major', contour, density: 3, seed: 7 };
  const a = Assist.generateMelody(params);
  assert.ok(a.length > 0, `${contour}: produces notes`);
  assert.deepEqual(a, Assist.generateMelody(params), `${contour}: deterministic`);
  for (const e of a) assert.ok(Assist.inScale(e.note, 0, 'major'), `${contour}: in scale`);
}

// rising contour should actually rise on average
const rise = Assist.generateMelody({ root: 0, scale: 'major', contour: 'rise', density: 4, seed: 3 });
const firstHalf = Array.from(rise).filter(e => e.row < 32).map(e => e.note);
const secondHalf = Array.from(rise).filter(e => e.row >= 32).map(e => e.note);
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
assert.ok(avg(secondHalf) > avg(firstHalf), 'rise contour trends upward');

// ---- harmonize -----------------------------------------------------------------

// third above A (note 10, degree 0 of A minor) is C (note 13)
assert.equal(Assist.harmonize(10, 9, 'minor', 2), 13);
// fifth above A is E (note 17)
assert.equal(Assist.harmonize(10, 9, 'minor', 4), 17);

// ---- analysis -------------------------------------------------------------------

const rep = Assist.analyze(demo, 0);
assert.equal(rep.key.root, 9);
assert.equal(rep.chords.length, 4);
assert.match(rep.chords[0], /^A/, 'first bar of the demo is an A chord');
assert.equal(rep.channels.length, 4);
assert.ok(rep.channels.every(c => c.role !== 'empty'), 'demo uses all channels');
assert.ok(Array.isArray(rep.tips));

// an empty song yields the empty-channel tip and no key
const blank = MOD.newSong(4);
const repBlank = Assist.analyze(blank, 0);
assert.equal(repBlank.key, null);

console.log('Assist tests passed');
