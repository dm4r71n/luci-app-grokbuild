# luci-app-grokbuild

Runs Grok Build (`grok`) in a tmux session on the router and shows it in LuCI under **Services > Grok Build**, with a terminal page made for a phone. Closing the browser only detaches; grok keeps running and the next page load reattaches to the same screen.

The terminal is behind the LuCI login. There is no separate password, and nothing secret is on any command line.

## Use it

Log in to LuCI and open **Services > Grok Build**:

- LAN: `https://192.168.1.1/cgi-bin/luci/admin/services/grokbuild`
- Tailscale: `https://100.104.188.37/cgi-bin/luci/admin/services/grokbuild`

The Terminal tab frames the terminal and has three buttons:

- **Full screen** opens the terminal by itself in a new tab (best on a phone).
- **Restart grok** ends the tmux session, after a confirmation, and starts a fresh one. Whatever grok was doing is lost.
- **Restart service** restarts ttyd, the proxy, and stunnel. The grok session keeps running and the page reconnects.

The line above the buttons shows whether the service is running and whether the grok session exists, how many browsers are attached, and what is running in it.

The Settings tab edits `/etc/config/grokbuild`.

The terminal itself is served on port 7682 (`https://<router>:7682/`) with the router's uhttpd certificate. The browser has to accept that certificate for port 7682 too; if the framed terminal stays blank, LuCI shows a link to open it once. Opening `https://<router>:7682/` directly without coming from LuCI shows "open from LuCI".

## How it fits together

```
browser ──TLS──> stunnel 0.0.0.0:7682 ──PROXY v1──> proxy.uc 127.0.0.1:7683 ──unix──> ttyd ──> tmux -L grokbuild (grok)
```

- **ttyd** listens only on `/var/run/grokbuild/ttyd.sock` (directory mode 0700) and trusts the `X-GrokBuild-User` header (`ttyd -H`). No TCP port, no credential.
- **proxy.uc** (ucode, uloop) checks every `/token` request and websocket upgrade against rpcd: the key must be a live LuCI session with write access to the `luci-app-grokbuild` ACL group. It strips any client-sent `X-GrokBuild-User` and adds its own. It rechecks open terminals every 60 s, so logging out of LuCI closes them.
- **stunnel** terminates TLS and passes the client address with a PROXY v1 line. The proxy refuses addresses outside private, Tailscale (100.64.0.0/10, fd7a::), loopback, and link-local ranges.
- **Access**: the LuCI page calls `grokbuild.ticket` over rpcd, which writes a random 48-hex one-time ticket (60 s) bound to the caller's session to `/var/run/grokbuild/tickets/`. The page opens the terminal at `#t=<ticket>` (the fragment is never sent to a server and is removed from the address bar at once). The terminal page trades it at `POST /auth` for the key and keeps the key in `sessionStorage` for that tab. When the key stops working, a framed page asks LuCI for a new ticket with `postMessage`.

## Service

`/etc/init.d/grokbuild` (procd, enabled at boot, `START=99`) runs three instances, `ttyd`, `proxy`, and `tls`, each respawned two seconds after it exits. Listening on `0.0.0.0` means a `tailscale0` that comes up late, or is recreated by a tailscale restart, needs nothing special. Stopping or restarting the service does not stop the tmux session.

```sh
/etc/init.d/grokbuild start|stop|restart|enable|disable
ubus call service list '{"name":"grokbuild"}'
/usr/libexec/grokbuild/ctl.sh status            # JSON about the tmux session
/usr/libexec/grokbuild/ctl.sh restart-session
tmux -L grokbuild kill-server                    # end grok and the session
```

## Configuration

`/etc/config/grokbuild`:

| Option | Default | |
|---|---|---|
| `enabled` | `1` | |
| `port` | `7682` | Public TLS port. |
| `listen` (list) | `0.0.0.0` | Addresses stunnel listens on. |
| `private_only` | `1` | Refuse clients outside private and Tailscale ranges. |
| `proxy_port` | `7683` | Internal; the proxy on 127.0.0.1. |
| `workdir` | `/root/grok-work` | grok's working directory. |
| `command` | `/root/.grok/bin/grok` | What runs in the pane. Takes effect for a new session. |
| `cert`, `key` | empty | PEM or DER. Empty means uhttpd's. Converted to PEM in `/etc/grokbuild/tls.*`. |

Changing the config reloads the service.

## Firewall

The `lan` zone's input policy is ACCEPT, so 7682 needs no rule from the LAN. One firewall4 rule rejects 7682 from the WAN:

```
config rule
	option name 'Block-GrokBuild-WAN'
	option src 'wan'
	option proto 'tcp'
	option dest_port '7682'
	option target 'REJECT'
```

`/etc/uci-defaults/90_luci-app-grokbuild` adds it only if no rule with that name exists, and does not reload the firewall. If you change `port`, change the rule's `dest_port` too.

## Requirements

`ttyd` (1.7.7), `tmux` (3.6a), `stunnel` (5.75), `openssl-util`, `ucode` with the `fs`, `socket`, `uloop`, `ubus`, and `uci` modules, and `rpcd-mod-ucode`. Grok Build at `/root/.grok/bin/grok`, already signed in.

The stunnel package enables an example service on localhost:6000. The uci-defaults script turns the stock stunnel init script off when that example is all its config has; Grok Build runs its own stunnel from procd.

## Files

| Path | Purpose |
|---|---|
| `/etc/config/grokbuild` | Settings. |
| `/etc/init.d/grokbuild` | procd service. |
| `/etc/uci-defaults/90_luci-app-grokbuild` | Config section, WAN rule, stunnel example off, enable at boot. |
| `/etc/grokbuild/tmux.conf` | tmux settings for the `grokbuild` socket only. |
| `/etc/grokbuild/tls.crt`, `tls.key` | PEM copies of the certificate and key. Mode 600. |
| `/usr/libexec/grokbuild/attach.sh` | What ttyd runs. Creates or attaches the tmux session `grok`. |
| `/usr/libexec/grokbuild/session.sh` | Runs in the tmux pane. Starts grok, then leaves a shell when grok exits. |
| `/usr/libexec/grokbuild/ctl.sh` | Session status and restart, for rpcd. |
| `/usr/share/grokbuild/proxy.uc`, `proxy-lib.uc` | The authenticating proxy. |
| `/usr/share/grokbuild/www/index.html` | The terminal page. One file, no external requests. |
| `/usr/share/rpcd/ucode/grokbuild.uc` | rpcd object `grokbuild`: `status`, `ticket`, `restart_session`, `restart_service`. |
| `/usr/share/rpcd/acl.d/luci-app-grokbuild.json` | ACL group `luci-app-grokbuild`. |
| `/usr/share/luci/menu.d/luci-app-grokbuild.json` | Services > Grok Build. |
| `/www/luci-static/resources/view/grokbuild/` | `terminal.js`, `settings.js`. |
| `/var/run/grokbuild/` | Mode 0700: `ttyd.sock`, `stunnel.conf`, `tickets/`. |

## On the phone

- Swipe up or down on the terminal to scroll grok's output. A flick keeps scrolling; a tap stops it.
- A tap is a click at that spot. A long press does nothing.
- The key bar has ⌨ (show or hide the keyboard), Esc, Tab, ⇧Tab, Ctrl, Alt, arrows, ⏎, PgUp, PgDn, Home, End, A− and A+ (text size), Copy, Paste, and ▾ (hide the bar). Scroll it sideways for the rest.
- Ctrl and Alt are sticky: tap once for the next key, twice to lock, again to release.
- Pinch to change the text size. It is saved in the browser.
- Copy opens the visible screen as plain text. Long-press there to select, or press Copy for all of it. When grok or tmux copies something (OSC 52), it goes to the phone's clipboard; if the browser blocks that, a "Tap to copy" message appears.
- The pill at the top right shows the connection. Tap it to reconnect now.

URL options, remembered in the browser: `?renderer=webgl|canvas|dom`, `?swipe=N` (lines of finger travel per wheel event, default 1), `?keys=1` (show the key bar on a desktop).

## When grok exits

The pane falls back to a login shell in the working directory with a one-line note. Type `grok` to start it again, or `exit` to close the session; the next page load creates a new one. grok is not restarted automatically, because a loop would spin on a crash or a lost login and hide the error.
