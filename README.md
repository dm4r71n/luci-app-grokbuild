# luci-app-grokbuild

Runs Grok Build (`grok`) in a tmux session on the router and serves it through its own ttyd, with a terminal page made for a phone. Closing the browser only detaches; grok keeps running and the next page load reattaches to the same screen.

This is still a spike. There is no LuCI page, init script, or UCI config yet. The test ttyd is started by hand and is not started at boot.

## Requirements

- `ttyd` and `tmux` (tested with ttyd 1.7.7 and tmux 3.6a).
- Grok Build at `/root/.grok/bin/grok`, already signed in.
- `openssl`, to convert the uhttpd certificate to PEM.

## Files

| Path | Purpose |
|---|---|
| `/etc/grokbuild/tmux.conf` | tmux settings for the `grokbuild` socket only. |
| `/etc/grokbuild/credential` | `grok:<password>` for ttyd basic auth. Mode 600. Not in git. |
| `/etc/grokbuild/tls.crt`, `tls.key` | PEM copies of the uhttpd certificate and key. Mode 600. Made by `spike-ttyd.sh start`. |
| `/usr/libexec/grokbuild/attach.sh` | What ttyd runs. Creates or attaches the tmux session `grok`. |
| `/usr/libexec/grokbuild/session.sh` | Runs in the tmux pane. Starts grok, then leaves a shell when grok exits. |
| `/usr/libexec/grokbuild/spike-ttyd.sh` | Starts, stops, or checks the test ttyd. |
| `/usr/share/grokbuild/www/index.html` | The terminal page, served with `ttyd -I`. One file, no external requests. |
| `/root/grok-work` | grok's working directory. |

## Test ttyd

```sh
/usr/libexec/grokbuild/spike-ttyd.sh start
/usr/libexec/grokbuild/spike-ttyd.sh status
/usr/libexec/grokbuild/spike-ttyd.sh restart
/usr/libexec/grokbuild/spike-ttyd.sh stop
```

It is reachable from the LAN and over Tailscale, never from the WAN:

- LAN: `https://192.168.1.1:7682/`
- Tailscale: `https://100.104.188.37:7682/`

There is one ttyd per interface (`br-lan` and `tailscale0`), because `ttyd -i` binds one interface. Both serve the same page with the same credential and attach to the same tmux session, so a phone on the LAN and a laptop on Tailscale see the same grok. The certificate is the router's self-signed uhttpd one, so the browser warns once.

`start` runs a small supervisor loop for each interface. If a ttyd exits, for example because restarting tailscale removed `tailscale0`, its loop waits for the interface to have an address again and starts ttyd within a few seconds. The page reconnects by itself.

## Firewall

The `lan` zone's input policy is ACCEPT, so 7682 needs no rule from the LAN. As a second layer behind the per-interface binding, one firewall4 rule rejects 7682 from the WAN:

```
config rule
	option name 'Block-GrokBuild-WAN'
	option src 'wan'
	option proto 'tcp'
	option dest_port '7682'
	option target 'REJECT'
```

On this router it was added by hand with `uci` and `/etc/init.d/firewall reload`. In the LuCI phase the package's uci-defaults script will create it, only if no rule with that name exists.

Stopping ttyd does not stop grok. To end the session too:

```sh
tmux -L grokbuild kill-server
```

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

The pane falls back to a login shell in `/root/grok-work` with a one-line note. Type `grok` to start it again, or `exit` to close the session; the next page load creates a new one. grok is not restarted automatically, because a loop would spin on a crash or a lost login and hide the error.
