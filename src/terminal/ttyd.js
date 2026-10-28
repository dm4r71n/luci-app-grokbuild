// ttyd 1.7.7 websocket protocol (src/server.h, src/protocol.c).
// Client -> server: '0' input, '1' resize JSON, '2' pause, '3' resume,
//                   and a first message that is JSON {AuthToken, columns, rows}.
// Server -> client: '0' output, '1' window title, '2' preferences JSON.
// The Grok Build proxy in front of ttyd checks the key from auth.js on /token
// and /ws and adds the header ttyd -H trusts; ttyd's own AuthToken is empty.

import { backoff } from './backoff.js';
import { wsUrl } from './auth.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class TtydConnection {
	constructor({ base, auth, onOutput, onTitle, onStatus, size }) {
		this.base = base;            // e.g. https://host:7682/
		this.auth = auth;            // Auth from auth.js
		this.onOutput = onOutput;    // (Uint8Array, done) => void
		this.onTitle = onTitle || (() => {});
		this.onStatus = onStatus || (() => {});
		this.size = size;            // () => {columns, rows}
		this.ws = null;
		this.attempt = 0;
		this.timer = null;
		this.openedAt = 0;
		this.paused = false;
		this.pending = 0;
		this.stopped = false;
		this.generation = 0;
	}

	get open() {
		return this.ws && this.ws.readyState === WebSocket.OPEN;
	}

	async connect() {
		clearTimeout(this.timer);
		this.timer = null;
		const gen = ++this.generation;
		if (this.ws) {
			const old = this.ws;
			this.ws = null;
			old.onclose = old.onerror = old.onmessage = old.onopen = null;
			try { old.close(); } catch {}
		}
		this.onStatus('connecting');
		let key = null;
		try {
			key = await this.auth.key();
			if (gen !== this.generation) return;
			if (key) {
				const r = await fetch(new URL('token', this.base), {
					cache: 'no-store', credentials: 'omit', headers: { 'X-GrokBuild-Key': key },
				});
				if (r.status === 401) key = await this.auth.key(true);
				else if (!r.ok) throw new Error('token ' + r.status);
			}
		} catch (e) {
			if (gen === this.generation) this._retry();
			return;
		}
		if (gen !== this.generation) return;
		if (!key) { this.onStatus('auth'); return; }
		const ws = new WebSocket(wsUrl(this.base, key), ['tty']);
		ws.binaryType = 'arraybuffer';
		this.ws = ws;
		this.paused = false;
		this.pending = 0;
		ws.onopen = () => {
			this.openedAt = Date.now();
			const { columns, rows } = this.size();
			ws.send(enc.encode(JSON.stringify({ AuthToken: '', columns, rows })));
			this.onStatus('open');
		};
		ws.onmessage = (ev) => this._message(ev.data);
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			if (!this.stopped) this._retry();
		};
		ws.onerror = () => {};
	}

	// Close the socket and let the normal retry path reconnect.
	drop() {
		if (this.ws) this.ws.close();
	}

	_retry() {
		if (this.openedAt && Date.now() - this.openedAt > 10000) this.attempt = 0;
		this.openedAt = 0;
		const ms = backoff(this.attempt++);
		this.onStatus('retry', ms);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.connect(), ms);
	}

	// Reconnect now if not connected; used on wake, focus, and network changes.
	kick() {
		if (this.open) return;
		if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
		this.attempt = 0;
		this.connect();
	}

	_message(buf) {
		const u8 = new Uint8Array(buf);
		const cmd = String.fromCharCode(u8[0]);
		const body = u8.subarray(1);
		if (cmd === '0') {
			this.pending += body.length;
			if (!this.paused && this.pending > 262144) { this.paused = true; this._send('2'); }
			this.onOutput(body, () => {
				this.pending -= body.length;
				if (this.paused && this.pending < 32768) { this.paused = false; this._send('3'); }
			});
		} else if (cmd === '1') {
			this.onTitle(dec.decode(body));
		}
		// '2' preferences: ignored, the page has its own.
	}

	_send(s) {
		if (this.open) this.ws.send(enc.encode(s));
	}

	input(data) {
		if (!this.open) return false;
		this.ws.send(enc.encode('0' + data));
		return true;
	}

	resize(columns, rows) {
		this._send('1' + JSON.stringify({ columns, rows }));
	}
}
