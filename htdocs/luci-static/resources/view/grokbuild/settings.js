'use strict';
'require view';
'require form';
'require uci';

return view.extend({
	load: function() {
		return uci.load('grokbuild');
	},

	render: function() {
		var m = new form.Map('grokbuild', _('Grok Build'),
			_('The terminal is served over TLS on its own port and only to browsers logged in to LuCI. The firewall rule Block-GrokBuild-WAN rejects the port from the WAN; change its port too if you change it here. Saving restarts the service; the grok session keeps running.'));
		var s = m.section(form.NamedSection, 'main', 'grokbuild');
		s.anonymous = true;

		var o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'port', _('Port'));
		o.datatype = 'port';
		o.placeholder = '7682';

		o = s.option(form.DynamicList, 'listen', _('Listen addresses'),
			_('0.0.0.0 covers the LAN and Tailscale, including when tailscale0 comes up after boot.'));
		o.datatype = 'ipaddr';
		o.placeholder = '0.0.0.0';

		o = s.option(form.Flag, 'private_only', _('Private clients only'),
			_('Refuse clients outside private, Tailscale (100.64.0.0/10, fd7a::/16), and link-local ranges.'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'workdir', _('Working directory'));
		o.placeholder = '/root/grok-work';

		o = s.option(form.Value, 'command', _('Command'), _('Run in the tmux pane. Takes effect for a new session.'));
		o.placeholder = '/root/.grok/bin/grok';

		o = s.option(form.Value, 'cert', _('Certificate'), _('Empty uses the uhttpd certificate.'));
		o.optional = true;
		o = s.option(form.Value, 'key', _('Certificate key'), _('Empty uses the uhttpd key.'));
		o.optional = true;

		return m.render();
	}
});
