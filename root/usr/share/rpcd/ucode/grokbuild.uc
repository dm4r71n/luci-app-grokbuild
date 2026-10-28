'use strict';

// Grok Build RPC for the LuCI page.
//   status           service instances and the tmux session
//   ticket           one-time ticket (60 s) that the terminal page trades for
//                    access; bound to the caller's LuCI session
//   restart_session  kill the grok tmux session and start a new one
//   restart_service  /etc/init.d/grokbuild restart (the session survives)

import { open, readfile, writefile, mkdir, chmod, lsdir, unlink, stat, popen } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';

const RUN = '/var/run/grokbuild';
const TICKETS = RUN + '/tickets';
const TTL = 60;
const CTL = '/usr/libexec/grokbuild/ctl.sh';

function rand_hex(n) {
	let f = open('/dev/urandom', 'r');
	if (!f)
		return null;
	let b = f.read(n);
	f.close();
	return (b && length(b) == n) ? hexenc(b) : null;
}

function run_json(cmd) {
	let p = popen(cmd, 'r');
	if (!p)
		return null;
	let out = p.read('all');
	p.close();
	try { return json(trim(out ?? '')); } catch (e) { return null; }
}

function config() {
	let c = cursor();
	let s = c.get_all('grokbuild', 'main') ?? {};
	c.unload();
	return {
		enabled: (s.enabled ?? '1') != '0',
		port: +(s.port ?? 7682)
	};
}

function purge_tickets() {
	let now = time();
	for (let name in (lsdir(TICKETS) ?? [])) {
		let st = stat(TICKETS + '/' + name);
		if (!st || st.mtime < now - TTL)
			unlink(TICKETS + '/' + name);
	}
}

function status() {
	let cfg = config();
	let u = connect();
	let svc = u ? u.call('service', 'list', { name: 'grokbuild' }) : null;
	if (u)
		u.disconnect();
	let inst = svc?.grokbuild?.instances ?? {};
	let running = {};
	for (let name in [ 'ttyd', 'proxy', 'tls' ])
		running[name] = !!inst[name]?.running;
	return {
		enabled: cfg.enabled,
		port: cfg.port,
		running,
		session: run_json(CTL + ' status') ?? { session: false }
	};
}

return {
	grokbuild: {
		status: {
			call: function() {
				return status();
			}
		},

		ticket: {
			call: function(req) {
				let sid = req.args?.ubus_rpc_session;
				if (type(sid) != 'string' || !match(sid, /^[0-9a-f]{32}$/))
					return { error: 'no session' };
				mkdir(RUN, 448);
				mkdir(TICKETS, 448);
				chmod(RUN, 448);
				chmod(TICKETS, 448);
				purge_tickets();
				let t = rand_hex(24);
				if (!t || !writefile(TICKETS + '/' + t, sprintf('%J', { sid, expires: time() + TTL })))
					return { error: 'cannot create ticket' };
				return { ticket: t, port: config().port, ttl: TTL };
			}
		},

		restart_session: {
			call: function() {
				let r = run_json(CTL + ' restart-session');
				return { result: !!r?.session, session: r ?? { session: false } };
			}
		},

		restart_service: {
			call: function() {
				let rc = system('/etc/init.d/grokbuild restart >/dev/null 2>&1');
				return { result: rc == 0 };
			}
		}
	}
};
