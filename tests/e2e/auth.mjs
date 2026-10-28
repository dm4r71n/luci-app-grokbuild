// End-to-end checks of the authenticating proxy, the service, and the router
// state. Logs in to LuCI with the root password from OPENWRT_PASSWORD (never
// printed), and needs ssh access to the router.
//
//   OPENWRT_PASSWORD=... node tests/e2e/auth.mjs
//   GB_HOST=100.104.188.37 GB_PORT=7682 GB_SLOW=1 (waits for the 60 s recheck)
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOST = process.env.GB_HOST || '100.104.188.37';
const PORT = +(process.env.GB_PORT || 7682);
const SSH = (process.env.GB_SSH || 'ssh -o BatchMode=yes -o UserKnownHostsFile=/workspace/.ssh/known_hosts -i /workspace/.ssh/openwrt root@100.104.188.37').split(' ');
const PASSWORD = process.env.OPENWRT_PASSWORD;
if (!PASSWORD) { console.error('OPENWRT_PASSWORD is not set'); process.exit(2); }
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok: !!ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const router = (cmd) => execFileSync(SSH[0], [...SSH.slice(1), cmd], { encoding: 'utf8' });

async function ubus(sid, obj, method, args = {}) {
	const r = await fetch(`https://${HOST}/ubus`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [sid, obj, method, args] }),
	});
	const j = await r.json();
	return j.result && j.result[0] === 0 ? (j.result[1] || {}) : null;
}

// One raw HTTP/1.1 exchange over TLS. Returns { status, headers, body, socket }.
function raw(head, { keep = false, timeout = 5000 } = {}) {
	return new Promise((resolve, reject) => {
		const s = tls.connect({ host: HOST, port: PORT, rejectUnauthorized: false, servername: undefined }, () => s.write(head));
		let buf = Buffer.alloc(0);
		const t = setTimeout(() => { s.destroy(); resolve({ status: 0, headers: '', body: '', socket: null }); }, timeout);
		const done = () => {
			clearTimeout(t);
			const text = buf.toString('latin1');
			const i = text.indexOf('\r\n\r\n');
			const headers = i < 0 ? text : text.slice(0, i);
			const status = +(headers.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0;
			resolve({ status, headers, body: i < 0 ? '' : text.slice(i + 4), socket: s, buf });
		};
		s.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			if (keep && buf.includes('\r\n\r\n')) { s.removeAllListeners('data'); s.removeAllListeners('end'); done(); }
		});
		s.on('end', done);
		s.on('error', (e) => { clearTimeout(t); resolve({ status: 0, headers: String(e), body: '', socket: null }); });
	});
}

function wsFrame(payload) {
	const data = Buffer.from(payload);
	const mask = crypto.randomBytes(4);
	const len = data.length;
	const head = len < 126 ? Buffer.from([0x82, 0x80 | len]) : Buffer.from([0x82, 0x80 | 126, len >> 8, len & 255]);
	const body = Buffer.alloc(len);
	for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
	return Buffer.concat([head, mask, body]);
}

const wsHead = (key, origin) => [
	`GET /ws${key ? '?k=' + key : ''} HTTP/1.1`,
	`Host: ${HOST}:${PORT}`,
	'Upgrade: websocket',
	'Connection: Upgrade',
	`Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
	'Sec-WebSocket-Version: 13',
	'Sec-WebSocket-Protocol: tty',
	...(origin ? [`Origin: ${origin}`] : []),
	'X-GrokBuild-User: spoofed',
	'', '',
].join('\r\n');
const get = (path, extra = []) => [`GET ${path} HTTP/1.1`, `Host: ${HOST}:${PORT}`, ...extra, '', ''].join('\r\n');
const post = (path, extra = []) => [`POST ${path} HTTP/1.1`, `Host: ${HOST}:${PORT}`, 'Content-Length: 0', ...extra, '', ''].join('\r\n');
const ORIGIN = `https://${HOST}:${PORT}`;

// ---------- login ----------
// The LuCI login form, so the session is a real LuCI one (logout works on it).
const lr = await fetch(`https://${HOST}/cgi-bin/luci/`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({ luci_username: 'root', luci_password: PASSWORD }),
	redirect: 'manual',
});
const sid = ((lr.headers.get('set-cookie') || '').match(/sysauth_https=([0-9a-f]{32})/) || [])[1];
check('LuCI login as root', !!sid);
if (!sid) process.exit(1);

const status = await ubus(sid, 'grokbuild', 'status');
check('grokbuild.status: all three instances running', status && status.running.ttyd && status.running.proxy && status.running.tls, JSON.stringify(status && status.running));

// ---------- unauthenticated ----------
let r = await raw(get('/'));
check('GET / serves the page without auth', r.status === 200 && /<title>Grok Build<\/title>/.test(r.body));
check('page may only be framed by this host', /frame-ancestors 'self' http:\/\/[^ ]+:\* https:/.test(r.headers));
r = await raw(get('/token'));
check('GET /token without key is 401', r.status === 401);
r = await raw(get('/token', ['X-GrokBuild-Key: ' + 'f'.repeat(32)]));
check('GET /token with a made-up key is 401', r.status === 401);
r = await raw(get('/token', ['X-GrokBuild-User: root']));
check('a client-sent X-GrokBuild-User does not authenticate', r.status === 401);
r = await raw(wsHead(null, ORIGIN));
check('websocket without key is refused (401)', r.status === 401);
r = await raw(post('/auth', ['X-GrokBuild-Ticket: ' + '0'.repeat(48)]));
check('unknown ticket is refused (403)', r.status === 403);
r = await raw('PROXY TCP4 8.8.8.8 1.1.1.1 1 2\r\n' + get('/'));
check('a client-sent PROXY line is not trusted (400)', r.status === 400);
r = await raw(get('/etc/passwd'));
check('other paths are 404', r.status === 404);

// ---------- ticket ----------
const t = await ubus(sid, 'grokbuild', 'ticket');
check('grokbuild.ticket returns a ticket and the port', t && /^[0-9a-f]{48}$/.test(t.ticket) && t.port === PORT);
const noSession = await ubus('00000000000000000000000000000000', 'grokbuild', 'ticket');
check('grokbuild.ticket is refused without a LuCI login', noSession === null);
r = await raw(post('/auth', ['X-GrokBuild-Ticket: ' + t.ticket]));
const key = r.status === 200 && JSON.parse(r.body).key;
check('ticket is exchanged for the session key', key === sid);
r = await raw(post('/auth', ['X-GrokBuild-Ticket: ' + t.ticket]));
check('a ticket works only once', r.status === 403);
const stale = crypto.randomBytes(24).toString('hex');
router(`printf '{"sid":"${sid}","expires":%d}' $(( $(date +%s) - 1 )) > /var/run/grokbuild/tickets/${stale}`);
r = await raw(post('/auth', ['X-GrokBuild-Ticket: ' + stale]));
check('an expired ticket is refused', r.status === 403);

// ---------- authenticated ----------
r = await raw(get('/token', ['X-GrokBuild-Key: ' + key]));
check('GET /token with the key is 200', r.status === 200);
r = await raw(wsHead(key, 'https://evil.example'));
check('websocket from another origin is refused (403)', r.status === 403);
r = await raw(wsHead(key, null));
check('websocket without Origin is refused (403)', r.status === 403);

const ws = await raw(wsHead(key, ORIGIN), { keep: true });
check('websocket with key and same origin upgrades (101)', ws.status === 101);
let screen = '';
if (ws.socket) {
	ws.socket.on('data', (d) => { screen += d.toString('latin1'); });
	ws.socket.write(wsFrame(JSON.stringify({ AuthToken: '', columns: 100, rows: 30 })));
	for (let i = 0; i < 40 && !/grok|Grok|❯|\$ /.test(screen); i++) await sleep(250);
	check('terminal output arrives over the websocket', screen.length > 100, `${screen.length} bytes`);
	const clients = router('tmux -L grokbuild list-clients -t grok -F "#{client_width}x#{client_height}"');
	check('the websocket is a client of the grok tmux session', /100x30/.test(clients), clients.trim().replace(/\n/g, ' '));
}

// ---------- process list and router state ----------
const ps = router('ps w');
check('no secret on any command line', !ps.includes(sid) && !ps.includes(t.ticket) && !/ttyd[^\n]* -c /.test(ps) && !ps.includes(PASSWORD));
check('ttyd listens on a Unix socket only', /ttyd -i \/var\/run\/grokbuild\/ttyd\.sock -H X-GrokBuild-User/.test(ps));
const listen = router('netstat -ltnp 2>/dev/null');
check(`only stunnel listens on ${PORT}`, new RegExp(`:${PORT} .*stunnel`).test(listen) && !new RegExp(`:${PORT} .*ttyd`).test(listen));
check('the stock ttyd on 7681 is still there', /:7681 .*ttyd/.test(listen));
const fw = router(`nft list chain inet fw4 input_wan`);
check(`firewall rejects ${PORT} from wan`, new RegExp(`tcp dport ${PORT} .*Block-GrokBuild-WAN`).test(fw.replace(/\n/g, ' ')) || new RegExp(`dport ${PORT}[^\\n]*reject`).test(fw));
check('no basic-auth credential file left', router('[ -e /etc/grokbuild/credential ] && echo yes || echo no').trim() === 'no');
check('service enabled at boot', router('ls /etc/rc.d/').includes('S99grokbuild'));

// ---------- logout ----------
// The same request as LuCI's Log out link.
await fetch(`https://${HOST}/cgi-bin/luci/admin/logout`, { headers: { Cookie: `sysauth_https=${sid}` }, redirect: 'manual' });
r = await raw(get('/token', ['X-GrokBuild-Key: ' + key]));
check('after LuCI logout the key is refused', r.status === 401);
if (process.env.GB_SLOW && ws.socket) {
	let closed = false;
	ws.socket.on('close', () => { closed = true; });
	for (let i = 0; i < 70 && !closed; i++) await sleep(1000);
	check('the open terminal is closed within 60 s of logout', closed);
}
if (ws.socket) ws.socket.destroy();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
