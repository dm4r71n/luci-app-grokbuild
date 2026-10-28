'use strict';

// Authenticating front for ttyd. stunnel terminates TLS on the public port and
// hands each connection to this process on 127.0.0.1:<proxy_port>, with a
// PROXY v1 line carrying the client address. ttyd listens on a Unix socket in
// a 0700 directory and trusts the X-GrokBuild-User header (ttyd -H), so only
// root can reach ttyd without going through here.
//
// Loopback TCP rather than a Unix socket towards stunnel: stunnel 5.75 stops
// reading a Unix socket on POLLHUP and drops what is still buffered, and logs
// a getnameinfo error for every Unix connection.
//
// Routes:
//   GET  /        the terminal page, no auth (static, no secrets)
//   POST /auth    X-GrokBuild-Ticket: one-time ticket from rpcd -> {"key": <LuCI sid>}
//   GET  /token   X-GrokBuild-Key or ?k= -> {"token": ""} or 401
//   GET  /ws?k=   websocket upgrade, relayed to ttyd with the auth header added
//
// The key is the LuCI session id. Every check asks rpcd whether that session
// still exists and has write access to the luci-app-grokbuild ACL group, so
// logging out of LuCI ends terminal access. Open websockets are rechecked
// every 60 s and closed when the session is gone.

import * as socket from 'socket';
import * as uloop from 'uloop';
import * as fs from 'fs';
import { connect } from 'ubus';
import { cursor } from 'uci';
import * as lib from '/usr/share/grokbuild/proxy-lib.uc';

const RUN = '/var/run/grokbuild';
const TTYD = RUN + '/ttyd.sock';
const TICKETS = RUN + '/tickets';
const INDEX = '/usr/share/grokbuild/www/index.html';
const ACL = 'luci-app-grokbuild';
const DONT = socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL;
const EAGAIN = 11, EINTR = 4;
const MAX_CONNS = 64;
const HEAD_TIMEOUT = 15000;
const RECHECK = 60000;

let uci = cursor();
const PRIVATE_ONLY = (uci.get('grokbuild', 'main', 'private_only') ?? '1') != '0';
const PROXY_PORT = +(uci.get('grokbuild', 'main', 'proxy_port') ?? 7683);
uci.unload();
const CLOSE_GRACE = 5000;

let conns = {}, nconns = 0, seq = 0;

function log(msg) {
	warn('grokbuild-proxy: ' + msg + '\n');
}

function again() {
	let e = socket.error(true);
	return e == EAGAIN || e == EINTR;
}

// ---- sessions ----

function session_user(sid) {
	if (!lib.valid_sid(sid))
		return null;
	let u = connect();
	if (!u)
		return null;
	let user = null;
	let r = u.call('session', 'access', {
		ubus_rpc_session: sid, scope: 'access-group', object: ACL, function: 'write'
	});
	if (r?.access) {
		let g = u.call('session', 'get', { ubus_rpc_session: sid, keys: [ 'username' ] });
		user = lib.clean_user(g?.values?.username);
	}
	u.disconnect();
	return user;
}

function redeem(ticket) {
	if (!lib.valid_ticket(ticket))
		return null;
	let path = TICKETS + '/' + ticket;
	let s = fs.readfile(path);
	fs.unlink(path);
	if (!s)
		return null;
	let t;
	try { t = json(s); } catch (e) { return null; }
	if (type(t) != 'object' || !(t.expires >= time()))
		return null;
	return session_user(t.sid) ? t.sid : null;
}

// ---- connection plumbing ----

function unwatch(c, name) {
	if (c[name]) {
		c[name].delete();
		c[name] = null;
	}
}

function close_conn(c) {
	if (c.closed)
		return;
	c.closed = true;
	for (let n in [ 'crh', 'cwh', 'urh', 'uwh' ])
		unwatch(c, n);
	if (c.timer)
		c.timer.cancel();
	c.client.close();
	if (c.up)
		c.up.close();
	delete conns[c.id];
	nconns--;
}

// Graceful end towards stunnel: send FIN, read until its side closes too, so
// the kernel never resets the connection over unread bytes and stunnel
// forwards everything that was written.
function finish(c) {
	if (c.closed || c.state == 'closing')
		return;
	c.state = 'closing';
	for (let n in [ 'crh', 'cwh', 'urh', 'uwh' ])
		unwatch(c, n);
	if (c.up) {
		c.up.close();
		c.up = null;
	}
	c.client.shutdown(socket.SHUT_WR);
	if (c.timer)
		c.timer.cancel();
	c.timer = uloop.timer(CLOSE_GRACE, () => close_conn(c));
	c.crh = uloop.handle(c.client, () => {
		let d = c.client.recv(65536, DONT);
		if (d == '' || (d == null && !again()))
			close_conn(c);
	}, uloop.ULOOP_READ);
}

// Send as much as the socket takes. Returns the unsent rest, or null on error.
function send_some(sock, data) {
	while (length(data)) {
		let n = sock.send(data, DONT);
		if (n == null)
			return again() ? data : null;
		data = substr(data, n);
	}
	return '';
}

let on_client_read, on_up_read;

function watch_read(c, side) {
	if (side == 'client')
		c.crh ??= uloop.handle(c.client, () => on_client_read(c), uloop.ULOOP_READ);
	else if (c.up)
		c.urh ??= uloop.handle(c.up, () => on_up_read(c), uloop.ULOOP_READ);
}

function flush(c, side) {
	let sock = side == 'client' ? c.client : c.up;
	let rest = send_some(sock, c[side + '_out']);
	if (rest == null)
		return close_conn(c);
	c[side + '_out'] = rest;
	if (length(rest))
		return;
	unwatch(c, side == 'client' ? 'cwh' : 'uwh');
	if (side == 'client' && (c.state == 'respond' || c.up_eof))
		return finish(c);
	// Writer drained: read again from the other side.
	if (c.state == 'relay')
		watch_read(c, side == 'client' ? 'up' : 'client');
}

function write_to(c, side, data) {
	if (c.closed)
		return;
	if (length(c[side + '_out'])) {
		c[side + '_out'] += data;
		return;
	}
	let sock = side == 'client' ? c.client : c.up;
	let rest = send_some(sock, data);
	if (rest == null)
		return close_conn(c);
	if (!length(rest)) {
		if (side == 'client' && (c.state == 'respond' || c.up_eof))
			finish(c);
		return;
	}
	c[side + '_out'] = rest;
	// Backpressure: stop reading the source until this side drains.
	unwatch(c, side == 'client' ? 'urh' : 'crh');
	if (side == 'client')
		c.cwh ??= uloop.handle(c.client, () => flush(c, 'client'), uloop.ULOOP_WRITE);
	else
		c.uwh ??= uloop.handle(c.up, () => flush(c, 'up'), uloop.ULOOP_WRITE);
}

function respond(c, data) {
	c.state = 'respond';
	unwatch(c, 'crh');
	write_to(c, 'client', data);
}

// ---- routes ----

function serve_index(c, req) {
	let st = fs.stat(INDEX);
	if (!st)
		return respond(c, lib.json_response(503, { error: 'missing page' }));
	let etag = sprintf('"%x-%x"', st.mtime, st.size);
	let headers = {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-cache',
		'ETag': etag,
		'Content-Security-Policy': lib.frame_ancestors(req.h.host),
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer'
	};
	if (req.h['if-none-match'] == etag)
		return respond(c, lib.response(304, headers, '', true));
	let body = fs.readfile(INDEX) ?? '';
	respond(c, lib.response(200, headers, body, req.method == 'HEAD'));
}

function request_key(req) {
	return req.h['x-grokbuild-key'] ?? lib.query_param(req.query, 'k');
}

function start_relay(c, req, user) {
	let up = socket.create(socket.AF_UNIX, socket.SOCK_STREAM);
	if (!up || !up.connect(socket.sockaddr(TTYD))) {
		log('cannot reach ttyd: ' + socket.error());
		if (up)
			up.close();
		return respond(c, lib.json_response(502, { error: 'terminal not running' }));
	}
	c.up = up;
	c.state = 'relay';
	c.timer.cancel();
	c.timer = null;
	watch_read(c, 'up');
	write_to(c, 'up', lib.upstream_head(req, user) + req.rest);
}

function handle(c, req) {
	let src = req.proxy?.src;
	c.src = src ?? 'local';

	if (PRIVATE_ONLY && !lib.is_private(src)) {
		log('refused non-private source ' + src);
		return respond(c, lib.json_response(403, { error: 'forbidden' }));
	}

	switch (req.path) {
	case '/':
	case '/index.html':
		if (req.method != 'GET' && req.method != 'HEAD')
			return respond(c, lib.json_response(405, { error: 'method' }));
		return serve_index(c, req);

	case '/auth': {
		if (req.method != 'POST')
			return respond(c, lib.json_response(405, { error: 'method' }));
		let sid = redeem(req.h['x-grokbuild-ticket']);
		if (!sid) {
			log('rejected ticket from ' + c.src);
			return respond(c, lib.json_response(403, { error: 'invalid ticket' }));
		}
		return respond(c, lib.json_response(200, { key: sid }));
	}

	case '/token':
		if (req.method != 'GET')
			return respond(c, lib.json_response(405, { error: 'method' }));
		if (!session_user(request_key(req)))
			return respond(c, lib.json_response(401, { error: 'login required' }));
		return respond(c, lib.json_response(200, { token: '' }));

	case '/ws': {
		if (!lib.is_websocket(req))
			return respond(c, lib.json_response(400, { error: 'websocket only' }));
		if (!lib.origin_ok(req)) {
			log('refused websocket with origin ' + (req.h.origin ?? '-') + ' from ' + c.src);
			return respond(c, lib.json_response(403, { error: 'origin' }));
		}
		let key = request_key(req);
		let user = session_user(key);
		if (!user)
			return respond(c, lib.json_response(401, { error: 'login required' }));
		c.sid = key;
		return start_relay(c, req, user);
	}
	}

	return respond(c, lib.json_response(404, { error: 'not found' }));
}

on_client_read = function(c) {
	if (c.closed)
		return;
	let d = c.client.recv(65536, DONT);
	if (d == null) {
		if (!again())
			close_conn(c);
		return;
	}
	if (d == '')
		return close_conn(c);

	if (c.state == 'relay')
		return write_to(c, 'up', d);
	if (c.state != 'head')
		return;

	c.buf += d;
	let req = lib.parse_head(c.buf);
	if (req == null)
		return;
	c.buf = '';
	if (req.error)
		return respond(c, lib.json_response(req.error, { error: 'bad request' }));
	handle(c, req);
};

on_up_read = function(c) {
	if (c.closed)
		return;
	let d = c.up.recv(65536, DONT);
	if (d == null) {
		if (!again())
			close_conn(c);
		return;
	}
	if (d == '') {
		// ttyd ended the session: pass on what is queued, then finish.
		c.up_eof = true;
		unwatch(c, 'urh');
		if (!length(c.client_out))
			finish(c);
		return;
	}
	write_to(c, 'client', d);
};

// ---- main ----

fs.mkdir(RUN, 448);
fs.chmod(RUN, 448);

let srv = socket.listen('127.0.0.1', PROXY_PORT, null, 64, true);
if (!srv) {
	log('cannot listen on 127.0.0.1:' + PROXY_PORT + ': ' + socket.error());
	exit(1);
}

uloop.init();

uloop.handle(srv, () => {
	let s = srv.accept();
	if (!s)
		return;
	if (nconns >= MAX_CONNS) {
		s.close();
		return;
	}
	let c = { id: ++seq, client: s, state: 'head', buf: '', client_out: '', up_out: '' };
	conns[c.id] = c;
	nconns++;
	c.timer = uloop.timer(HEAD_TIMEOUT, () => close_conn(c));
	watch_read(c, 'client');
}, uloop.ULOOP_READ);

uloop.interval(RECHECK, () => {
	let ended = filter(values(conns), (c) => c.state == 'relay' && !session_user(c.sid));
	for (let c in ended) {
		log('LuCI session ended, closing terminal for ' + c.src);
		close_conn(c);
	}
});

log('listening on 127.0.0.1:' + PROXY_PORT);
uloop.run();
