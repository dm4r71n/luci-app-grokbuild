'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

// Services > Grok Build > Terminal. Frames the terminal page served by the
// Grok Build proxy (https://<this host>:<port>/). Access is a one-time
// ticket from rpcd, bound to this LuCI session; the framed page asks for a
// new one with postMessage when its key stops working.

var callStatus = rpc.declare({
	object: 'grokbuild',
	method: 'status',
	expect: { '': {} }
});

var callTicket = rpc.declare({
	object: 'grokbuild',
	method: 'ticket',
	expect: { '': {} }
});

var callRestartSession = rpc.declare({
	object: 'grokbuild',
	method: 'restart_session',
	expect: { '': {} }
});

var callRestartService = rpc.declare({
	object: 'grokbuild',
	method: 'restart_service',
	expect: { '': {} }
});

function termOrigin(port) {
	var h = window.location.hostname;
	if (h.indexOf(':') >= 0)
		h = '[' + h + ']';
	return 'https://' + h + ':' + port;
}

function termUrl(t) {
	return termOrigin(t.port) + '/#t=' + t.ticket;
}

function describe(st) {
	var r = st.running || {}, s = st.session || {};
	var svc;
	if (!st.enabled)
		svc = _('Service disabled');
	else if (r.ttyd && r.proxy && r.tls)
		svc = _('Service running');
	else
		svc = _('Service not fully running (ttyd %s, proxy %s, TLS %s)').format(
			r.ttyd ? _('up') : _('down'), r.proxy ? _('up') : _('down'), r.tls ? _('up') : _('down'));

	var sess;
	if (!s.session)
		sess = _('no grok session (one starts when the terminal connects)');
	else
		sess = _('session since %s, %d attached, running %s').format(
			new Date(s.created * 1000).toLocaleString(), s.clients, s.command || '?');

	return svc + ' · ' + sess;
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		return Promise.all([ callStatus(), callTicket() ]);
	},

	render: function(data) {
		var st = data[0] || {}, ticket = data[1] || {};
		var port = st.port || ticket.port || 7682;
		var origin = termOrigin(port);
		var self = this;

		var statusEl = E('span', { 'class': 'gb-status' }, describe(st));

		// A frame whose certificate the browser has not accepted stays blank
		// and cannot say so; show this when the page has not checked in.
		var tlsNote = E('div', { 'class': 'alert-message notice gb-note', 'hidden': true }, [
			_('The terminal has not loaded. The browser may not have accepted the router\'s certificate for port %d yet:').format(port), ' ',
			E('a', { 'href': origin + '/', 'target': '_blank', 'rel': 'noopener' }, _('open %s once, accept it').format(origin)),
			_(', then reload this page.')
		]);
		window.setTimeout(function() {
			if (!heard && frame.src)
				tlsNote.hidden = false;
		}, 8000);

		var frame = E('iframe', {
			'class': 'gb-frame',
			'title': _('Grok Build terminal'),
			'allow': 'clipboard-read; clipboard-write',
			'referrerpolicy': 'no-referrer'
		});

		var heard = false;

		// The framed page says when it has loaded, and asks for a fresh
		// ticket when its key stops working.
		window.addEventListener('message', function(ev) {
			if (ev.source !== frame.contentWindow || ev.origin !== origin || !ev.data)
				return;
			heard = true;
			tlsNote.hidden = true;
			if (ev.data.grokbuild !== 'need-ticket')
				return;
			callTicket().then(function(t) {
				frame.contentWindow.postMessage({ grokbuild: 'ticket', ticket: t.ticket || null }, origin);
			}).catch(function() {
				frame.contentWindow.postMessage({ grokbuild: 'ticket', ticket: null }, origin);
			});
		});

		if (ticket.ticket)
			frame.src = termUrl(ticket);

		var fit = function() {
			var top = frame.getBoundingClientRect().top + window.scrollY;
			var h = Math.max(320, window.innerHeight - top - 12);
			frame.style.height = h + 'px';
		};
		window.addEventListener('resize', fit);
		if (window.visualViewport)
			window.visualViewport.addEventListener('resize', fit);

		var openFull = function(ev) {
			ev.preventDefault();
			// Open the tab now, inside the click, so it is not taken for a popup.
			var w = window.open('', '_blank');
			callTicket().then(function(t) {
				if (!t.ticket)
					throw new Error(t.error || 'no ticket');
				if (w) {
					w.opener = null;
					w.location.href = termUrl(t);
				}
				else {
					window.location.href = termUrl(t);
				}
			}).catch(function(e) {
				if (w)
					w.close();
				ui.addNotification(null, E('p', _('Could not open the terminal: %s').format(e.message)), 'danger');
			});
		};

		var restartSession = function(ev) {
			if (!confirm(_('End the grok session and start a new one? Anything grok is doing now is lost.')))
				return;
			return callRestartSession().then(function() {
				return self.refresh(statusEl);
			});
		};

		var restartService = function(ev) {
			return callRestartService().then(function() {
				return self.refresh(statusEl);
			});
		};

		poll.add(function() { return self.refresh(statusEl); }, 10);
		window.requestAnimationFrame(fit);

		return E('div', { 'class': 'gb-view' }, [
			E('style', {}, [
				'.gb-view { display: flex; flex-direction: column; gap: .5em; }',
				'.gb-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5em; }',
				'.gb-bar .gb-status { flex: 1 1 18em; font-size: 90%; opacity: .85; }',
				'.gb-bar .btn { margin: 0; }',
				'.gb-frame { width: 100%; min-height: 320px; border: 0; border-radius: 4px; background: #141822; display: block; }',
				'.gb-note { font-size: 90%; }',
				'@media (max-width: 600px) { .gb-bar .gb-status { flex-basis: 100%; } .gb-bar .btn { flex: 1 1 auto; } }'
			].join('\n')),
			E('div', { 'class': 'gb-bar' }, [
				statusEl,
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': openFull }, _('Full screen')),
				E('button', { 'class': 'btn cbi-button cbi-button-negative', 'click': ui.createHandlerFn(this, restartSession) }, _('Restart grok')),
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, restartService) }, _('Restart service'))
			]),
			ticket.ticket ? '' : E('p', { 'class': 'alert-message warning' }, _('Could not get access to the terminal: %s').format(ticket.error || '?')),
			tlsNote,
			frame
		]);
	},

	refresh: function(el) {
		return callStatus().then(function(st) {
			el.textContent = describe(st);
		});
	}
});
