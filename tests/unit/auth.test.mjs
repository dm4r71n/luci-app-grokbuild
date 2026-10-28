import test from 'node:test';
import assert from 'node:assert/strict';
import { Auth, ticketFromHash, wsUrl, sessionStore, parentTicket, STORAGE_KEY } from '../../src/terminal/auth.js';

const T = 'a'.repeat(48), K = 'b'.repeat(32), K2 = 'c'.repeat(32);
const base = 'https://192.168.1.1:7682/';

function memStore(v = null) {
	return { v, get() { return this.v; }, set(x) { this.v = x; }, remove() { this.v = null; } };
}
function fakeFetch(responses) {
	const calls = [];
	const f = async (url, opts) => {
		calls.push({ url: String(url), opts });
		const r = responses.shift();
		if (r instanceof Error) throw r;
		return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
	};
	f.calls = calls;
	return f;
}

test('ticketFromHash takes only a 48-hex ticket', () => {
	assert.equal(ticketFromHash('#t=' + T), T);
	assert.equal(ticketFromHash('#x=1&t=' + T), T);
	assert.equal(ticketFromHash('#t=' + T + '&x=1'), T);
	assert.equal(ticketFromHash('#t=' + T.slice(1)), null);
	assert.equal(ticketFromHash('#t=' + 'g'.repeat(48)), null);
	assert.equal(ticketFromHash(''), null);
	assert.equal(ticketFromHash(undefined), null);
});

test('wsUrl keeps the base path and scheme and adds the key', () => {
	assert.equal(wsUrl(base, K), 'wss://192.168.1.1:7682/ws?k=' + K);
	assert.equal(wsUrl('http://h:1/x/', K), 'ws://h:1/x/ws?k=' + K);
});

test('a hash ticket is traded for a key and stored', async () => {
	const store = memStore();
	const fetch = fakeFetch([{ status: 200, body: { key: K } }]);
	const a = new Auth({ base, store, fetch, ticket: T });
	assert.equal(await a.key(), K);
	assert.equal(store.v, K);
	assert.equal(fetch.calls[0].url, base + 'auth');
	assert.equal(fetch.calls[0].opts.method, 'POST');
	assert.equal(fetch.calls[0].opts.headers['X-GrokBuild-Ticket'], T);
	// Second call uses the stored key, no request.
	assert.equal(await a.key(), K);
	assert.equal(fetch.calls.length, 1);
});

test('a new hash ticket wins over a stored key', async () => {
	const store = memStore(K);
	const fetch = fakeFetch([{ status: 200, body: { key: K2 } }]);
	const a = new Auth({ base, store, fetch, ticket: T });
	assert.equal(await a.key(), K2);
});

test('a stored key is used without a ticket', async () => {
	const fetch = fakeFetch([]);
	const a = new Auth({ base, store: memStore(K), fetch });
	assert.equal(await a.key(), K);
	assert.equal(fetch.calls.length, 0);
});

test('fresh drops the stored key and asks the parent for a ticket', async () => {
	const store = memStore(K);
	const fetch = fakeFetch([{ status: 200, body: { key: K2 } }]);
	let asked = 0;
	const a = new Auth({ base, store, fetch, requestTicket: async () => { asked++; return T; } });
	assert.equal(await a.key(true), K2);
	assert.equal(asked, 1);
	assert.equal(store.v, K2);
});

test('no ticket, refused ticket, or a bad key give null', async () => {
	assert.equal(await new Auth({ base, store: memStore(), fetch: fakeFetch([]) }).key(), null);
	const store = memStore(K);
	assert.equal(await new Auth({ base, store, fetch: fakeFetch([{ status: 403, body: {} }]), ticket: T }).key(), null);
	assert.equal(store.v, null);
	assert.equal(await new Auth({ base, store: memStore(), fetch: fakeFetch([{ status: 200, body: { key: 'x' } }]), ticket: T }).key(), null);
});

test('network and server errors reject so the caller retries', async () => {
	await assert.rejects(new Auth({ base, store: memStore(), fetch: fakeFetch([new Error('down')]), ticket: T }).key());
	await assert.rejects(new Auth({ base, store: memStore(), fetch: fakeFetch([{ status: 502, body: {} }]), ticket: T }).key());
});

test('sessionStore survives a storage that throws', () => {
	const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
	const s = sessionStore(bad);
	assert.equal(s.get(), null);
	s.set('v'); s.remove();
	const map = new Map();
	const good = sessionStore({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) });
	good.set(K);
	assert.equal(map.get(STORAGE_KEY), K);
	assert.equal(good.get(), K);
});

function fakeWin({ framed = true, hostname = '192.168.1.1' } = {}) {
	const listeners = new Set();
	const win = {
		location: { hostname },
		posted: [],
		addEventListener: (t, f) => listeners.add(f),
		removeEventListener: (t, f) => listeners.delete(f),
		emit: (e) => [...listeners].forEach((f) => f(e)),
	};
	win.parent = framed ? { postMessage: (m, o) => win.posted.push([m, o]) } : win;
	return win;
}

test('parentTicket: not framed resolves null at once', async () => {
	assert.equal(await parentTicket(fakeWin({ framed: false })), null);
});

test('parentTicket: accepts only the parent on the same host', async () => {
	const win = fakeWin();
	const p = parentTicket(win, 1000);
	assert.deepEqual(win.posted[0][0], { grokbuild: 'need-ticket' });
	win.emit({ source: {}, origin: 'https://192.168.1.1', data: { grokbuild: 'ticket', ticket: 'evil' } });
	win.emit({ source: win.parent, origin: 'https://evil.example', data: { grokbuild: 'ticket', ticket: 'evil' } });
	win.emit({ source: win.parent, origin: 'http://192.168.1.1', data: { grokbuild: 'other' } });
	win.emit({ source: win.parent, origin: 'http://192.168.1.1', data: { grokbuild: 'ticket', ticket: T } });
	assert.equal(await p, T);
});

test('parentTicket: times out to null', async () => {
	assert.equal(await parentTicket(fakeWin(), 20), null);
});
