import test from 'node:test';
import assert from 'node:assert/strict';
import { keySequence, applyMods, ctrlChar, Sticky, modParam } from '../../src/terminal/keys.js';
import { decodeOsc52 } from '../../src/terminal/osc52.js';
import { backoff } from '../../src/terminal/backoff.js';

test('plain keys', () => {
	assert.equal(keySequence('esc'), '\x1b');
	assert.equal(keySequence('tab'), '\t');
	assert.equal(keySequence('stab'), '\x1b[Z');
	assert.equal(keySequence('enter'), '\r');
	assert.equal(keySequence('pgup'), '\x1b[5~');
	assert.equal(keySequence('pgdn'), '\x1b[6~');
});

test('cursor keys follow DECCKM', () => {
	assert.equal(keySequence('up'), '\x1b[A');
	assert.equal(keySequence('up', {}, true), '\x1bOA');
	assert.equal(keySequence('left', {}, true), '\x1bOD');
	assert.equal(keySequence('home'), '\x1b[H');
	assert.equal(keySequence('end', {}, true), '\x1bOF');
});

test('modifiers on bar keys', () => {
	assert.equal(modParam({ ctrl: true }), 5);
	assert.equal(modParam({ ctrl: true, alt: true }), 7);
	assert.equal(keySequence('right', { ctrl: true }, true), '\x1b[1;5C');
	assert.equal(keySequence('up', { alt: true }), '\x1b[1;3A');
	assert.equal(keySequence('pgup', { ctrl: true }), '\x1b[5;5~');
	assert.equal(keySequence('esc', { alt: true }), '\x1b\x1b');
	assert.equal(keySequence('tab', { shift: true }), '\x1b[Z');
	assert.equal(keySequence('enter', { alt: true }), '\x1b\r');
});

test('sticky Ctrl and Alt on typed text', () => {
	assert.equal(applyMods('c', { ctrl: true }), '\x03');
	assert.equal(applyMods('C', { ctrl: true }), '\x03');
	assert.equal(applyMods('x', { alt: true }), '\x1bx');
	assert.equal(applyMods('r', { ctrl: true, alt: true }), '\x1b\x12');
	assert.equal(applyMods('ab', { ctrl: true }), '\x01b');
	assert.equal(applyMods('hello', {}), 'hello');
	assert.equal(ctrlChar(' '), '\x00');
	assert.equal(ctrlChar('['), '\x1b');
	assert.equal(ctrlChar('?'), '\x7f');
});

test('Sticky cycles once, lock, off', () => {
	const s = new Sticky();
	assert.equal(s.tap(), 'once');
	assert.equal(s.used(), 'off');
	s.tap(); s.tap();
	assert.equal(s.state, 'lock');
	assert.equal(s.used(), 'lock');
	assert.equal(s.tap(), 'off');
});

test('OSC 52 decode', () => {
	const b64 = Buffer.from('héllo ✓', 'utf8').toString('base64');
	assert.equal(decodeOsc52('c;' + b64), 'héllo ✓');
	assert.equal(decodeOsc52(';' + b64), 'héllo ✓');
	assert.equal(decodeOsc52('c;?'), null);
	assert.equal(decodeOsc52('c;not base64!'), null);
	assert.equal(decodeOsc52('nosemicolon'), null);
});

test('reconnect backoff', () => {
	const mid = () => 0.5;
	assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => backoff(n, mid)), [500, 1000, 2000, 4000, 8000, 15000, 15000]);
});
