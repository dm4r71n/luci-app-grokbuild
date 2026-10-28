'use strict';

// Pure helpers for proxy.uc: request parsing, address checks, header
// rewriting. No I/O, so tests/router/proxy-lib.test.uc can run them.

const AUTH_HEADER = 'X-GrokBuild-User';
const MAX_HEAD = 16384;

// RFC 9110 token, then the value. Built from a string because a backtick
// inside a regex literal confuses the ucode lexer.
const HEADER_RE = regexp("^([A-Za-z0-9!#$%&'*+.^_`|~-]+):(.*)$");

// Parse an optional PROXY v1 line (sent by stunnel) and an HTTP/1.x request
// head from buf. Returns null while the head is incomplete, { error: code }
// when it is malformed or too large, or the request.
function parse_head(buf) {
	let off = 0, proxy = null;

	if (substr(buf, 0, 6) == 'PROXY ') {
		let e = index(buf, '\r\n');
		if (e < 0)
			return length(buf) > 108 ? { error: 400 } : null;
		let f = split(substr(buf, 0, e), ' ');
		proxy = { proto: f[1], src: (f[1] == 'TCP4' || f[1] == 'TCP6') ? f[2] : null };
		off = e + 2;
	}

	let body = substr(buf, off);
	let end = index(body, '\r\n\r\n');
	if (end < 0)
		return length(body) > MAX_HEAD ? { error: 431 } : null;
	if (end > MAX_HEAD)
		return { error: 431 };

	let lines = split(substr(body, 0, end), '\r\n');
	let rl = match(lines[0], /^([A-Z]+) (\/[^ ]*) HTTP\/(1\.[01])$/);
	if (!rl)
		return { error: 400 };

	let target = rl[2], q = index(target, '?');
	let headers = [], h = {};

	for (let i = 1; i < length(lines); i++) {
		let m = match(lines[i], HEADER_RE);
		if (!m)
			return { error: 400 };
		let name = m[1], value = trim(m[2]), k = lc(name);
		push(headers, [ name, value ]);
		h[k] = (k in h) ? h[k] + ', ' + value : value;
	}

	return {
		proxy,
		method: rl[1],
		target,
		path: q < 0 ? target : substr(target, 0, q),
		query: q < 0 ? '' : substr(target, q + 1),
		version: rl[3],
		headers,
		h,
		rest: substr(body, end + 4)
	};
}

function query_param(query, name) {
	for (let kv in split(query ?? '', '&')) {
		let i = index(kv, '=');
		if (i > 0 && substr(kv, 0, i) == name)
			return substr(kv, i + 1);
	}
	return null;
}

// LAN, Tailscale (CGNAT 100.64/10 and fd7a::/48 in fc00::/7), loopback and
// link-local. A null source means the PROXY line was absent or UNKNOWN, which
// only happens for local connections to the 0700 run directory.
function is_private(ip) {
	if (ip == null)
		return true;

	let a = iptoarr(ip);
	if (type(a) != 'array')
		return false;

	if (length(a) == 16) {
		let zero10 = true;
		for (let i = 0; i < 10; i++)
			if (a[i] != 0) zero10 = false;

		if (zero10 && a[10] == 255 && a[11] == 255) {
			a = slice(a, 12);
		}
		else {
			let loop = zero10 && a[10] == 0 && a[11] == 0 && a[12] == 0 && a[13] == 0 && a[14] == 0 && a[15] == 1;
			return loop ||
				(a[0] & 0xfe) == 0xfc ||
				(a[0] == 0xfe && (a[1] & 0xc0) == 0x80);
		}
	}

	if (length(a) != 4)
		return false;

	return a[0] == 10 || a[0] == 127 ||
		(a[0] == 172 && (a[1] & 0xf0) == 16) ||
		(a[0] == 192 && a[1] == 168) ||
		(a[0] == 100 && (a[1] & 0xc0) == 64) ||
		(a[0] == 169 && a[1] == 254);
}

function valid_sid(s) {
	return type(s) == 'string' && match(s, /^[0-9a-f]{32}$/) != null;
}

function valid_ticket(s) {
	return type(s) == 'string' && match(s, /^[0-9a-f]{48}$/) != null;
}

function clean_user(u) {
	u = replace('' + (u ?? ''), /[^A-Za-z0-9._-]/g, '');
	return length(u) ? substr(u, 0, 64) : 'luci';
}

// Hostname part of a Host header, or null if it is not a plain host name,
// IPv4 address, or bracketed IPv6 address.
function host_name(host) {
	let m = match(host ?? '', /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]+)?$/);
	return m ? m[1] : null;
}

// A websocket must come from a page on this same origin.
function origin_ok(req) {
	let host = req.h.host, origin = req.h.origin;
	return host_name(host) != null && origin == 'https://' + host;
}

function is_websocket(req) {
	return req.method == 'GET' &&
		lc(req.h.upgrade ?? '') == 'websocket' &&
		index(lc(req.h.connection ?? ''), 'upgrade') >= 0;
}

// Request head for ttyd: path without the query (it carries the key), any
// client copy of the auth header removed, and the proxy's one added.
function upstream_head(req, user) {
	let out = sprintf('%s %s HTTP/%s\r\n', req.method, req.path, req.version);
	for (let hv in req.headers) {
		let k = lc(hv[0]);
		if (k == lc(AUTH_HEADER) || k == 'x-grokbuild-key' || k == 'x-grokbuild-ticket')
			continue;
		out += hv[0] + ': ' + hv[1] + '\r\n';
	}
	return out + AUTH_HEADER + ': ' + clean_user(user) + '\r\n\r\n';
}

const REASONS = {
	'200': 'OK', '304': 'Not Modified', '400': 'Bad Request', '401': 'Unauthorized',
	'403': 'Forbidden', '404': 'Not Found', '405': 'Method Not Allowed',
	'431': 'Request Header Fields Too Large', '502': 'Bad Gateway', '503': 'Service Unavailable'
};

function response(code, headers, body, head_only) {
	body = body ?? '';
	let out = sprintf('HTTP/1.1 %d %s\r\n', code, REASONS['' + code] ?? 'Error');
	for (let k, v in headers ?? {})
		out += k + ': ' + v + '\r\n';
	out += sprintf('Content-Length: %d\r\nConnection: close\r\n\r\n', length(body));
	return head_only ? out : out + body;
}

function json_response(code, obj) {
	return response(code, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff'
	}, sprintf('%J', obj));
}

// Only pages on the router's own host (LuCI on any port) may frame the terminal.
function frame_ancestors(host) {
	let name = host_name(host);
	if (name == null)
		return "frame-ancestors 'self'";
	return sprintf("frame-ancestors 'self' http://%s:* https://%s:* http://%s https://%s", name, name, name, name);
}

export {
	AUTH_HEADER,
	MAX_HEAD,
	parse_head,
	query_param,
	is_private,
	valid_sid,
	valid_ticket,
	clean_user,
	host_name,
	origin_ok,
	is_websocket,
	upstream_head,
	response,
	json_response,
	frame_ancestors
};
