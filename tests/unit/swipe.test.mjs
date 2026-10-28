import test from 'node:test';
import assert from 'node:assert/strict';
import { SwipeScroller, sgrWheel, sgrClick, cellAt, WHEEL_UP, WHEEL_DOWN } from '../../src/terminal/swipe.js';

test('SGR sequences', () => {
	assert.equal(sgrWheel(WHEEL_UP, 10, 5), '\x1b[<64;10;5M');
	assert.equal(sgrWheel(WHEEL_DOWN, 1, 1), '\x1b[<65;1;1M');
	assert.equal(sgrClick(3, 4), '\x1b[<0;3;4M\x1b[<0;3;4m');
});

test('cellAt maps points to 1-based cells and clamps', () => {
	const rect = { left: 10, top: 20, width: 400, height: 200 }; // 40x10 cells of 10x20
	assert.deepEqual(cellAt(10, 20, rect, 40, 10), { col: 1, row: 1 });
	assert.deepEqual(cellAt(25, 45, rect, 40, 10), { col: 2, row: 2 });
	assert.deepEqual(cellAt(409, 219, rect, 40, 10), { col: 40, row: 10 });
	assert.deepEqual(cellAt(0, 0, rect, 40, 10), { col: 1, row: 1 });
	assert.deepEqual(cellAt(9999, 9999, rect, 40, 10), { col: 40, row: 10 });
});

function swipe(s, from, to, steps, ms) {
	const out = [];
	s.start(100, from, 0);
	for (let i = 1; i <= steps; i++) {
		out.push(...s.move(100, from + ((to - from) * i) / steps, (ms * i) / steps));
	}
	return { out, end: s.end(ms + 5) };
}

test('finger down scrolls back (wheel up), one event per line after the slop', () => {
	const s = new SwipeScroller({ lineHeight: 20, slop: 10 });
	const { out, end } = swipe(s, 100, 310, 21, 1000); // slow drag
	// The first 10 px are slop; the remaining 200 px are 10 lines.
	assert.equal(out.length, 10);
	assert.ok(out.every((b) => b === WHEEL_UP));
	assert.equal(end.kind, 'swipe');
	assert.equal(end.velocity, 0, 'slow drag does not fling');
});

test('finger up scrolls forward (wheel down)', () => {
	const s = new SwipeScroller({ lineHeight: 20, slop: 10 });
	const { out } = swipe(s, 400, 190, 21, 1000);
	assert.equal(out.length, 10);
	assert.ok(out.every((b) => b === WHEEL_DOWN));
});

test('direction change mid-swipe', () => {
	const s = new SwipeScroller({ lineHeight: 10, slop: 5 });
	s.start(0, 100, 0);
	const a = s.move(0, 150, 100); // 45 px past the 5 px slop
	const b = s.move(0, 180, 200); // +30, with 5 px left over
	const c = s.move(0, 120, 300); // -60
	assert.deepEqual(a, Array(4).fill(WHEEL_UP));
	assert.deepEqual(b, Array(3).fill(WHEEL_UP));
	assert.deepEqual(c, Array(5).fill(WHEEL_DOWN));
});

test('tap, long-press, and small jitter send nothing', () => {
	const s = new SwipeScroller({ lineHeight: 20, slop: 10 });
	s.start(50, 50, 0);
	assert.deepEqual(s.move(54, 56, 50), []);
	assert.equal(s.end(120).kind, 'tap');
	s.start(50, 50, 0);
	assert.deepEqual(s.move(52, 47, 300), []);
	const lp = s.end(800);
	assert.equal(lp.kind, 'longpress');
	assert.equal(lp.velocity, 0);
});

test('a flick produces momentum that decays to a stop', () => {
	const s = new SwipeScroller({ lineHeight: 20, slop: 10 });
	const { out, end } = swipe(s, 600, 300, 6, 60); // 300 px in 60 ms, upward
	assert.equal(out.length, 14); // (300 - 10) / 20
	assert.equal(end.kind, 'swipe');
	assert.ok(end.velocity < -1, `velocity ${end.velocity}`);
	let total = 0, frames = 0;
	while (s.moving && frames < 1000) {
		const ev = s.step(16);
		assert.ok(ev.length <= s.maxPerStep);
		assert.ok(ev.every((b) => b === WHEEL_DOWN));
		total += ev.length;
		frames++;
	}
	assert.ok(!s.moving, 'stops');
	assert.ok(total > 10, `momentum lines ${total}`);
	assert.ok(frames < 300, `frames ${frames}`);
});

test('a finger that pauses before lifting does not fling', () => {
	const s = new SwipeScroller({ lineHeight: 20 });
	s.start(0, 500, 0);
	s.move(0, 300, 40);
	s.move(0, 300, 200);
	assert.equal(s.end(400).velocity, 0);
});

test('stop() ends momentum', () => {
	const s = new SwipeScroller({ lineHeight: 20 });
	swipe(s, 600, 300, 6, 60);
	assert.ok(s.moving);
	s.stop();
	assert.ok(!s.moving);
	assert.deepEqual(s.step(16), []);
});
