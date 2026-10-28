// Key bar sequences and sticky modifiers. No DOM access.

// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4)
export function modParam({ shift = false, alt = false, ctrl = false } = {}) {
	return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

const CURSOR = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE = { pgup: 5, pgdn: 6, ins: 2, del: 3 };

// Sequence for a key bar key. `appCursor` is DECCKM (application cursor keys).
export function keySequence(key, mods = {}, appCursor = false) {
	const m = modParam(mods);
	if (key in CURSOR) {
		const c = CURSOR[key];
		if (m > 1) return `\x1b[1;${m}${c}`;
		return (appCursor ? '\x1bO' : '\x1b[') + c;
	}
	if (key in TILDE) {
		return m > 1 ? `\x1b[${TILDE[key]};${m}~` : `\x1b[${TILDE[key]}~`;
	}
	let s;
	switch (key) {
	case 'esc': s = '\x1b'; break;
	case 'tab': return mods.shift ? '\x1b[Z' : (mods.alt ? '\x1b\t' : '\t');
	case 'stab': return '\x1b[Z';
	case 'enter': s = '\r'; break;
	case 'bksp': s = mods.ctrl ? '\x08' : '\x7f'; break;
	default: throw new Error('unknown key ' + key);
	}
	return mods.alt ? '\x1b' + s : s;
}

// Apply sticky Ctrl/Alt to text typed on the soft keyboard. Only the first
// character takes the modifier; the rest pass through.
export function applyMods(data, mods = {}) {
	if (!data || (!mods.ctrl && !mods.alt)) return data;
	let first = data[0];
	const rest = data.slice(1);
	if (mods.ctrl) first = ctrlChar(first);
	if (mods.alt) first = '\x1b' + first;
	return first + rest;
}

export function ctrlChar(ch) {
	const c = ch.charCodeAt(0);
	if (ch.length !== 1) return ch;
	if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60); // a-z
	if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40); // @ A-Z [ \ ] ^ _
	switch (ch) {
	case ' ': case '2': return '\x00';
	case '3': return '\x1b';
	case '4': return '\x1c';
	case '5': return '\x1d';
	case '6': return '\x1e';
	case '7': case '/': return '\x1f';
	case '8': case '?': return '\x7f';
	default: return ch;
	}
}

// Sticky modifier state: tap once for the next key, tap twice to lock, tap again to clear.
export class Sticky {
	constructor() { this.state = 'off'; }
	tap() {
		this.state = this.state === 'off' ? 'once' : this.state === 'once' ? 'lock' : 'off';
		return this.state;
	}
	get on() { return this.state !== 'off'; }
	used() { if (this.state === 'once') this.state = 'off'; return this.state; }
	clear() { this.state = 'off'; }
}
