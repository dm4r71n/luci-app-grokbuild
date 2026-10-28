// Touch swipe to SGR mouse-wheel mapping. No DOM access, so it can be unit tested.

export const WHEEL_UP = 64;   // older content
export const WHEEL_DOWN = 65; // newer content

export function sgrWheel(button, col, row) {
	return `\x1b[<${button};${col};${row}M`;
}

export function sgrClick(col, row, button = 0) {
	return `\x1b[<${button};${col};${row}M\x1b[<${button};${col};${row}m`;
}

// Map a client point to a 1-based terminal cell, clamped to the grid.
export function cellAt(x, y, rect, cols, rows) {
	const cw = rect.width / cols;
	const ch = rect.height / rows;
	const col = Math.floor((x - rect.left) / cw) + 1;
	const row = Math.floor((y - rect.top) / ch) + 1;
	return {
		col: Math.min(Math.max(col, 1), cols),
		row: Math.min(Math.max(row, 1), rows),
	};
}

// Tracks one finger. Natural scrolling: the content follows the finger, so a
// finger moving down reveals older lines (wheel up) and moving up reveals newer
// lines (wheel down). One wheel event per `lineHeight` pixels of travel.
export class SwipeScroller {
	constructor(opts = {}) {
		this.lineHeight = opts.lineHeight || 16;
		this.slop = opts.slop ?? 10;             // px before a touch counts as a swipe
		this.tapMs = opts.tapMs ?? 350;          // longer than this without moving is a long-press
		this.friction = opts.friction ?? 0.94;   // velocity kept per 16 ms of momentum
		this.minFling = opts.minFling ?? 0.25;   // px/ms needed to start momentum
		this.stopSpeed = opts.stopSpeed ?? 0.03; // px/ms where momentum ends
		this.maxSpeed = opts.maxSpeed ?? 6;      // px/ms cap
		this.maxPerStep = opts.maxPerStep ?? 6;  // wheel events per momentum frame
		this.reset();
	}

	reset() {
		this.active = false;
		this.swiping = false;
		this.startX = this.startY = 0;
		this.lastY = 0;
		this.startT = 0;
		this.acc = 0;
		this.samples = [];
		this.velocity = 0;
	}

	// Returns nothing. Stops any momentum.
	start(x, y, t) {
		this.reset();
		this.active = true;
		this.startX = x;
		this.startY = y;
		this.lastY = y;
		this.startT = t;
		this.samples.push({ y, t });
	}

	// Returns an array of wheel buttons to send, in order.
	move(x, y, t) {
		if (!this.active) return [];
		if (!this.swiping) {
			if (Math.abs(y - this.startY) < this.slop && Math.abs(x - this.startX) < this.slop) return [];
			this.swiping = true;
			// Count travel from the edge of the slop, so the slop itself never scrolls.
			const dir = Math.sign(y - this.startY);
			this.lastY = this.startY + dir * Math.min(this.slop, Math.abs(y - this.startY));
		}
		const dy = y - this.lastY;
		this.lastY = y;
		this.samples.push({ y, t });
		while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
		return this._travel(dy);
	}

	// Ends the touch. Returns { kind: 'tap' | 'longpress' | 'swipe', velocity }.
	// velocity is px/ms (positive = finger moving down) and is 0 unless a fling should run.
	end(t) {
		if (!this.active) return { kind: 'none', velocity: 0 };
		this.active = false;
		if (!this.swiping) {
			return { kind: t - this.startT > this.tapMs ? 'longpress' : 'tap', velocity: 0 };
		}
		let v = 0;
		const s = this.samples;
		if (s.length >= 2) {
			const a = s[0], b = s[s.length - 1];
			// A finger that stopped before lifting should not fling.
			if (t - b.t < 60 && b.t > a.t) v = (b.y - a.y) / (b.t - a.t);
		}
		v = Math.max(-this.maxSpeed, Math.min(this.maxSpeed, v));
		this.velocity = Math.abs(v) >= this.minFling ? v : 0;
		return { kind: 'swipe', velocity: this.velocity };
	}

	// Advance momentum by dt ms. Returns wheel buttons; sets this.velocity to 0 when done.
	step(dt) {
		if (!this.velocity) return [];
		const out = this._travel(this.velocity * dt, this.maxPerStep);
		this.velocity *= Math.pow(this.friction, dt / 16);
		if (Math.abs(this.velocity) < this.stopSpeed) this.velocity = 0;
		return out;
	}

	stop() {
		this.velocity = 0;
	}

	get moving() {
		return this.velocity !== 0;
	}

	_travel(dy, cap = Infinity) {
		this.acc += dy;
		const out = [];
		const lh = this.lineHeight;
		while (this.acc >= lh && out.length < cap) {
			this.acc -= lh;
			out.push(WHEEL_UP);
		}
		while (this.acc <= -lh && out.length < cap) {
			this.acc += lh;
			out.push(WHEEL_DOWN);
		}
		if (out.length >= cap) this.acc = Math.max(-lh, Math.min(lh, this.acc));
		return out;
	}
}
