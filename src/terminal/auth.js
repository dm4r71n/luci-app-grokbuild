// Access through the Grok Build proxy (root/usr/share/grokbuild/proxy.uc).
//
// The LuCI page asks rpcd for a one-time ticket and opens this page at
// #t=<ticket>, or hands a ticket over with postMessage when it frames the
// page. POST /auth trades the ticket for the key (the LuCI session id). The key
// is kept in sessionStorage for this tab and sent with /token and /ws, so the
// terminal works only while that LuCI login is valid.

export const STORAGE_KEY = 'grokbuild.key';
const KEY_RE = /^[0-9a-f]{32}$/;

export function ticketFromHash(hash) {
	const m = /(?:^#|&)t=([0-9a-f]{48})(?:&|$)/.exec(hash || '');
	return m ? m[1] : null;
}

export function wsUrl(base, key) {
	const u = new URL('ws', base);
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
	u.search = 'k=' + encodeURIComponent(key);
	return u.href;
}

export function sessionStore(storage) {
	return {
		get() { try { return storage.getItem(STORAGE_KEY); } catch { return null; } },
		set(v) { try { storage.setItem(STORAGE_KEY, v); } catch {} },
		remove() { try { storage.removeItem(STORAGE_KEY); } catch {} },
	};
}

// Ask the LuCI page that frames us for a ticket. Resolves to null when not
// framed, when the parent says no, or after timeoutMs.
export function parentTicket(win, timeoutMs = 8000) {
	if (!win.parent || win.parent === win) return Promise.resolve(null);
	return new Promise((resolve) => {
		const done = (t) => { win.removeEventListener('message', onMsg); clearTimeout(timer); resolve(t); };
		const onMsg = (e) => {
			if (e.source !== win.parent || !e.data || e.data.grokbuild !== 'ticket') return;
			let host = null;
			try { host = new URL(e.origin).hostname; } catch {}
			if (host !== win.location.hostname) return;
			done(typeof e.data.ticket === 'string' ? e.data.ticket : null);
		};
		const timer = setTimeout(() => done(null), timeoutMs);
		win.addEventListener('message', onMsg);
		// The request carries nothing secret, and the parent's scheme and port
		// are not known here, so any origin may receive it.
		win.parent.postMessage({ grokbuild: 'need-ticket' }, '*');
	});
}

export class Auth {
	constructor({ base, store, fetch, requestTicket, ticket }) {
		this.base = base;
		this.store = store;
		this.fetch = fetch;
		this.requestTicket = requestTicket || (() => Promise.resolve(null));
		this.ticket = ticket || null;
	}

	// The key to use, trading a ticket for a new one when there is none or
	// when fresh is set (the old one was refused). Resolves to null when no
	// ticket is available or the proxy refuses it; rejects on network errors.
	async key(fresh = false) {
		if (!fresh && !this.ticket) {
			const k = this.store.get();
			if (k && KEY_RE.test(k)) return k;
		}
		this.store.remove();
		let t = this.ticket;
		this.ticket = null;
		if (!t) t = await this.requestTicket();
		if (!t) return null;
		const r = await this.fetch(new URL('auth', this.base), {
			method: 'POST',
			headers: { 'X-GrokBuild-Ticket': t },
			cache: 'no-store',
			credentials: 'omit',
		});
		if (!r.ok) {
			if (r.status >= 500) throw new Error('auth ' + r.status);
			return null;
		}
		const k = (await r.json()).key;
		if (typeof k !== 'string' || !KEY_RE.test(k)) return null;
		this.store.set(k);
		return k;
	}
}
