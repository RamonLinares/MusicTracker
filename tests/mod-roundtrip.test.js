'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'js', 'mod.js'), 'utf8');
const MOD = vm.runInNewContext(`${code}\nMOD;`, {}, { filename: 'js/mod.js' });

function tag(bytes) {
  return String.fromCharCode(bytes[1080], bytes[1081], bytes[1082], bytes[1083]);
}

function cell(song, pattern, row, channel) {
  return Array.from(MOD.cellGet(song, pattern, row, channel));
}

const demo = MOD.demoSong();
const saved = MOD.save(demo);
const parsed = MOD.parse(saved.buffer);

assert.equal(parsed.title, demo.title);
assert.equal(parsed.channels, 4);
assert.equal(tag(saved), 'M.K.');
assert.deepEqual(parsed.order, demo.order);
assert.equal(parsed.patterns.length, demo.patterns.length);
assert.equal(parsed.samples[0].name, 'chip lead');
assert.equal(parsed.samples[0].data.length, 32);
assert.deepEqual(cell(parsed, 0, 0, 0), cell(demo, 0, 0, 0));
assert.deepEqual(cell(parsed, 1, 60, 0), cell(demo, 1, 60, 0));

const six = MOD.newSong(6);
six.title = 'six channel test';
six.samples[0].name = 'tiny';
six.samples[0].data = new Int8Array([0, 32, -32, 0]);
MOD.cellSet(six, 0, 0, 5, MOD.noteFromName('C-2'), 1, 0xC, 0x20);

const sixSaved = MOD.save(six);
const sixParsed = MOD.parse(sixSaved.buffer);

assert.equal(tag(sixSaved), '6CHN');
assert.equal(sixParsed.channels, 6);
assert.equal(sixParsed.title, 'six channel test');
assert.deepEqual(cell(sixParsed, 0, 0, 5), [MOD.noteFromName('C-2'), 1, 0xC, 0x20]);

console.log('MOD round-trip tests passed');
