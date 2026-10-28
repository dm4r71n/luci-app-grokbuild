'use strict';
// Unit tests for /usr/share/grokbuild/proxy-lib.uc. Needs ucode, so it runs on
// the router: npm run test:router (tests/router/run.sh).

import * as lib from '/usr/share/grokbuild/proxy-lib.uc';

let passed = 0, failed = 0;
function rep(ch, n) { let s = ''; for (let i = 0; i < n; i++) s += ch; return s; }
function ok(name, cond) {
	if (cond) passed++;
	else { failed++; warn('FAIL ' + name + '\n'); }
}

// parse_head
let r = lib.parse_head('GET /ws?k=abc HTTP/1.1\r\nHost: h:7682\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nXYZ');
ok('parses method, path, query', r.method == 'GET' && r.path == '/ws' && r.query == 'k=abc' && r.version == '1.1');
ok('headers lower-cased in h', r.h.host == 'h:7682' && r.h.upgrade == 'websocket');
ok('keeps bytes after the head', r.rest == 'XYZ');
ok('no PROXY line means null proxy', r.proxy == null);
ok('incomplete head is null', lib.parse_head('GET / HTTP/1.1\r\nHost: x\r\n') == null);
ok('bad request line', lib.parse_head('GET\r\n\r\n').error == 400);
ok('absolute-form target refused', lib.parse_head('GET http://x/ HTTP/1.1\r\n\r\n').error == 400);
ok('bad header line', lib.parse_head('GET / HTTP/1.1\r\nno colon\r\n\r\n').error == 400);
ok('oversized head', lib.parse_head('GET / HTTP/1.1\r\nX: ' + rep('a', 17000)).error == 431);
r = lib.parse_head('PROXY TCP4 100.105.221.20 100.104.188.37 5555 7682\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n');
ok('PROXY v1 source', r.proxy.src == '100.105.221.20' && r.path == '/');
r = lib.parse_head('PROXY UNKNOWN\r\nGET / HTTP/1.1\r\n\r\n');
ok('PROXY UNKNOWN has no source', r.proxy != null && r.proxy.src == null);
ok('second PROXY line (client-sent) is a bad request',
	lib.parse_head('PROXY TCP4 1.2.3.4 5.6.7.8 1 2\r\nPROXY TCP4 10.0.0.1 5.6.7.8 1 2\r\nGET / HTTP/1.1\r\n\r\n').error == 400);
r = lib.parse_head('GET / HTTP/1.1\r\nCookie: a=1\r\ncookie: b=2\r\n\r\n');
ok('repeated headers are joined', r.h.cookie == 'a=1, b=2');

// query_param
ok('query_param', lib.query_param('a=1&k=xyz&b', 'k') == 'xyz' && lib.query_param('a=1', 'k') == null && lib.query_param(null, 'k') == null);

// is_private
for (let ip in [ '192.168.1.20', '10.1.2.3', '172.16.0.1', '172.31.255.255', '100.64.0.1', '100.127.255.254', '100.105.221.20', '127.0.0.1', '169.254.1.1', '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:192.168.1.5' ])
	ok('private ' + ip, lib.is_private(ip));
for (let ip in [ '8.8.8.8', '172.32.0.1', '100.128.0.1', '100.63.255.255', '192.169.0.1', '2001:4860::8888', '::ffff:8.8.8.8', 'garbage' ])
	ok('public ' + ip, !lib.is_private(ip));
ok('null source counts as local', lib.is_private(null));

// ids
ok('valid_sid', lib.valid_sid('0123456789abcdef0123456789abcdef') && !lib.valid_sid('0123456789ABCDEF0123456789abcdef') && !lib.valid_sid('x') && !lib.valid_sid(null));
ok('valid_ticket', lib.valid_ticket(rep('a', 48)) && !lib.valid_ticket('../../etc/passwd') && !lib.valid_ticket(null));
ok('clean_user', lib.clean_user('root') == 'root' && lib.clean_user('r\r\nX: y') == 'rXy' && lib.clean_user(null) == 'luci');

// host, origin, websocket
ok('host_name', lib.host_name('192.168.1.1:7682') == '192.168.1.1' && lib.host_name('[fd7a::1]:7682') == '[fd7a::1]' && lib.host_name('a b') == null && lib.host_name(null) == null);
let ws = lib.parse_head('GET /ws HTTP/1.1\r\nHost: 192.168.1.1:7682\r\nOrigin: https://192.168.1.1:7682\r\nUpgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\n\r\n');
ok('same origin ok', lib.origin_ok(ws));
ok('is_websocket', lib.is_websocket(ws));
ok('other origin refused', !lib.origin_ok(lib.parse_head('GET /ws HTTP/1.1\r\nHost: 192.168.1.1:7682\r\nOrigin: https://evil:7682\r\n\r\n')));
ok('http origin refused', !lib.origin_ok(lib.parse_head('GET /ws HTTP/1.1\r\nHost: 192.168.1.1:7682\r\nOrigin: http://192.168.1.1:7682\r\n\r\n')));
ok('missing origin refused', !lib.origin_ok(lib.parse_head('GET /ws HTTP/1.1\r\nHost: 192.168.1.1:7682\r\n\r\n')));

// upstream_head
let up = lib.upstream_head(lib.parse_head('GET /ws?k=secret HTTP/1.1\r\nHost: h\r\nX-GrokBuild-User: admin\r\nx-grokbuild-user: admin2\r\nX-GrokBuild-Key: secret\r\n\r\n'), 'root');
ok('upstream drops the query', index(up, 'GET /ws HTTP/1.1\r\n') == 0 && index(up, 'secret') < 0);
ok('upstream replaces the auth header', index(up, 'admin') < 0 && index(up, 'X-GrokBuild-User: root\r\n\r\n') > 0);

// responses
let resp = lib.response(200, { 'X-A': '1' }, 'hello');
ok('response', index(resp, 'HTTP/1.1 200 OK\r\n') == 0 && index(resp, 'Content-Length: 5\r\n') > 0 && index(resp, 'Connection: close\r\n\r\nhello') > 0);
ok('HEAD has no body', substr(lib.response(200, {}, 'hello', true), -4) == '\r\n\r\n');
ok('frame_ancestors', index(lib.frame_ancestors('192.168.1.1:7682'), 'https://192.168.1.1:*') > 0 && lib.frame_ancestors('bad host') == "frame-ancestors 'self'");

print(sprintf('%d passed, %d failed\n', passed, failed));
exit(failed ? 1 : 0);
