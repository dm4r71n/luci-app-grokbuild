# Development notes

## Layout

Same as `luci-app-netusage`: `root/` holds files at their install paths, `htdocs/` holds the LuCI views, and `tests/` holds tests. The terminal page source is in `src/terminal/`, and `tools/build.mjs` bundles it into `root/usr/share/grokbuild/www/index.html`. The built file is committed, because the router and the OpenWrt build have no Node.

```sh
npm ci
npm run build      # src/terminal -> root/usr/share/grokbuild/www/index.html
npm test           # unit tests, node --test
npm run test:router  # ucode tests of proxy-lib.uc and ctl.sh, run on the router over ssh
npm run e2e        # auth.mjs, luci.mjs, phone.mjs against the live router (OPENWRT_PASSWORD)
```

Copy to the router (the config is left alone; `/etc/config/grokbuild` is a conffile):

```sh
tar -C root --exclude=./etc/config/grokbuild -cf - . | ssh root@router 'tar -C / -xf -'
tar -C htdocs -cf - . | ssh root@router 'tar -C /www -xf -'
ssh root@router 'rm -f /tmp/luci-indexcache*; rm -rf /tmp/luci-modulecache; killall -HUP rpcd; /etc/init.d/grokbuild restart'
```

A new page takes effect on the next page load; the proxy reads the file per request. The rpcd plugin and ACL need `killall -HUP rpcd`; proxy changes need a service restart.

## tmux

Everything uses its own socket, `tmux -L grokbuild`, and `-f /etc/grokbuild/tmux.conf`, so it does not touch any other tmux server.

`attach.sh` runs `tmux -u ... new-session -A -s grok -c /root/grok-work /usr/libexec/grokbuild/session.sh`. `-A` attaches when the session exists. `-u` forces UTF-8, because musl has no locale for tmux to detect it from.

`session.sh` runs `set -m` before grok so grok gets its own process group. Without it tmux reports `pane_current_command` as `sh`.

`set-clipboard on` lets an application's OSC 52 through to the browser. The default, `external`, only forwards tmux's own copies. tmux's default `terminal-features` already gives `xterm*` the clipboard feature.

Checks:

```sh
tmux -L grokbuild ls
tmux -L grokbuild list-clients
tmux -L grokbuild list-panes -F '#{pane_current_command} alt=#{alternate_on} mouse_any=#{mouse_any_flag} sgr=#{mouse_sgr_flag} hist=#{history_size}'
tmux -L grokbuild capture-pane -p -t grok
```

## Service and auth

### Why stunnel and a ucode proxy

ttyd can only authenticate with `-c user:pass`, which puts the password on its command line and in syslog at notice level, or with `-H <header>`, which trusts whatever reverse proxy is in front of it. uhttpd cannot proxy websockets. So something has to terminate TLS, check the LuCI session, and relay the websocket.

- nginx (`nginx-ssl`, 832 KiB) ships a uci-defaults that takes over ports 80 and 443 from uhttpd, and its session check would need `auth_request` plus a backend. haproxy is several MiB.
- stunnel (220 KiB, uses the OpenSSL already installed for `openssl-util`) does TLS and PROXY v1 and nothing else.
- The session check and the relay are about 300 lines of ucode (`proxy.uc`) using `socket`, `uloop`, and `ubus`, all already installed for LuCI.

Each piece runs as a procd instance with respawn.

### Flow

1. LuCI view calls `grokbuild.ticket` over `/ubus`. uhttpd-mod-ubus adds `ubus_rpc_session` to the call, and the rpcd ucode plugin receives it in `req.args`. The ACL requires write on `luci-app-grokbuild`. The plugin writes `{sid, expires}` to `/var/run/grokbuild/tickets/<48 hex>` (0700 directory) and purges old tickets.
2. The view frames `https://<same host>:<port>/#t=<ticket>`. The page removes the fragment with `history.replaceState`, then `POST /auth` with `X-GrokBuild-Ticket`. The proxy reads and deletes the ticket file, checks `expires`, checks the session, and answers `{"key": <sid>}`.
3. The page keeps the key in `sessionStorage` and sends it as `X-GrokBuild-Key` on `/token` and as `?k=` on `/ws` (a websocket cannot carry headers). No cookies, so third-party cookie rules for the cross-port frame do not matter.
4. For `/ws` the proxy checks `Upgrade`, that `Origin` is `https://` + `Host`, and the session, then connects to `ttyd.sock` and sends the request head without the query, without any client copy of `X-GrokBuild-User`, `X-GrokBuild-Key`, or `X-GrokBuild-Ticket`, and with `X-GrokBuild-User: <LuCI user>`. After that it relays bytes both ways with backpressure.
5. Every 60 s the proxy rechecks each open websocket's session and closes it if the session is gone. `session access` also refreshes the session's idle timeout, so an open terminal keeps that LuCI login alive.

The session check is `ubus call session access {ubus_rpc_session, scope: "access-group", object: "luci-app-grokbuild", function: "write"}`. A session made by `session login` over `/ubus` passes it, but LuCI's logout only destroys sessions that LuCI created through its login form; `auth.mjs` logs in through the form for that reason.

The proxy answers `/`, `/auth`, and `/token` itself and closes the connection after each response (`Connection: close`), so a second request on a kept-alive connection can never reach ttyd unchecked. Only websocket upgrades reach ttyd. `/` is served without a session; it is the static page. Its response has `Content-Security-Policy: frame-ancestors` for the same host name on any port, so only LuCI on this router can frame it.

### stunnel details

- stunnel 5.75 treats `POLLHUP` on a Unix socket as end of input and drops what it has not read yet, which cut off the 516 KiB page. It also logs a `getnameinfo` error for every Unix connection. So the proxy listens on `127.0.0.1:7683`. Loopback is fine here: the proxy is the authentication, and ttyd stays on a 0700 Unix socket.
- The proxy ends a connection with `shutdown(SHUT_WR)`, reads until stunnel closes, then closes (5 s cap). Closing with unread input would make the kernel reset the connection and drop queued output.
- `protocol = proxy` makes stunnel send `PROXY TCP4 <client> <server> <sport> <dport>` first. A client cannot forge it; its own `PROXY` line arrives as the request line and gets 400.
- `debug = 4` (warnings). At higher levels stunnel logs every connection.
- uhttpd stores `/etc/uhttpd.crt` and `/etc/uhttpd.key` in DER. OpenSSL in stunnel reads PEM, so the init script converts them into `/etc/grokbuild/`. That certificate is self-signed, has no subjectAltName, and expired on 2026-04-02.

### ttyd

- `ttyd -i /var/run/grokbuild/ttyd.sock -H X-GrokBuild-User -W -I index.html -d 3 attach.sh`. A `-i` path ending in `.sock` makes ttyd listen on a Unix socket. With `-H` and no `-c`, the websocket's `AuthToken` is not checked; the page sends an empty one.
- ttyd's own `/token` is never reached; the proxy answers `/token` with `{"token": ""}` after the session check, and the page uses it as its auth probe (401 means get a new ticket).

### tailscale0

Restarting tailscale deletes `tailscale0`. stunnel listens on `0.0.0.0`, so it does not care when tailscale0 comes or goes, and nothing in the service binds to it. The WAN is kept out by `Block-GrokBuild-WAN`, by `private_only` in the proxy, and by the LuCI login.

### Firewall rule

`/etc/uci-defaults/90_luci-app-grokbuild` adds `Block-GrokBuild-WAN` with `uci add firewall rule`, guarded by a name check, then `uci commit firewall`. It does not reload the firewall; the first boot or `/etc/init.d/firewall reload` picks it up. The rule has no `family`, so it covers IPv4 and IPv6.

## Terminal page

### Why a self-built page

The page is xterm.js 5.5 with the fit, WebGL, canvas, and Unicode 11 addons, bundled with esbuild into one HTML file, and it speaks ttyd's protocol itself. ttyd's own frontend is a minified Preact bundle; patching it for touch and a key bar means editing generated code that changes with each ttyd release. ttyd's protocol is small and stable, so owning the page is less fragile:

- Upgrade: `GET /ws?k=<key>` with subprotocol `tty`; the proxy checks the key (see Service and auth).
- First message: `{"AuthToken": "", "columns", "rows"}`. ttyd runs without `-c`, so the token is not checked.
- Client to server: `0` + input, `1` + `{"columns","rows"}`, `2` pause, `3` resume.
- Server to client: `0` + output, `1` + title, `2` + preferences (ignored).

The proxy serves only the page, `/auth`, `/token`, and `/ws`, so CSS and JS are inlined. Auth is in `src/terminal/auth.js`. The page sets a CSP with `default-src 'none'` and `connect-src 'self'`, and uses system monospace fonts, so it makes no other requests. The e2e test checks that.

### What grok does with the mouse

grok's TUI uses the alternate screen and turns on mouse tracking: `alternate_on=1`, `mouse_any_flag=1`, `mouse_all_flag=1` (any-motion, 1003), `mouse_sgr_flag=1`. `history_size` stays 0 while grok runs. tmux has no scrollback for grok, and with `mouse on` its default wheel binding forwards wheel events to the pane. grok scrolls its own transcript, about three lines per wheel event (measured in the release notes view).

### Touch

`src/terminal/swipe.js` has no DOM code and is unit tested.

- Touch handlers sit on `#term` in the capture phase with `passive: false`, call `preventDefault`, and stop propagation, so neither xterm nor the browser sees the touch.
- A move under 10 px is not a swipe. After that, every `cellHeight × swipeLines` pixels of travel sends one SGR wheel report at the finger's cell: `ESC[<64;x;yM` (finger down, older content) or `ESC[<65;x;yM` (finger up, newer). If the terminal has no mouse tracking (a plain shell without tmux mouse), it scrolls xterm's own scrollback instead.
- On lift, the velocity over the last 100 ms starts momentum when it is over 0.25 px/ms, unless the finger stopped first. The velocity decays by 0.94 per 16 ms frame, with at most 6 events per frame.
- A tap (no swipe, under 350 ms) sends an SGR left press and release at that cell. A tap that stops a fling sends nothing. A long press sends nothing.
- Two fingers change the font size; it is saved on release.
- The keyboard does not open on tap. Use ⌨. That keeps it from popping up when tapping grok's menus or stopping a scroll. When it is already open, it stays open.

### Keys

`src/terminal/keys.js`. Arrows, Home, and End follow DECCKM (`ESC O A` when grok turns on application cursor keys). With modifiers they use the xterm form (`ESC[1;5C` for Ctrl+Right, `ESC[5;5~` for Ctrl+PgUp). Sticky Ctrl and Alt apply to the next typed character (`u` becomes `^U`, Alt adds an ESC prefix). Sequences xterm generates itself, such as focus reports (`ESC[I`) and mouse reports, start with ESC and skip the sticky modifiers. Bar buttons cancel `mousedown` so the textarea keeps focus and the keyboard stays up.

### Layout

The meta viewport has `interactive-widget=resizes-content`, `maximum-scale=1`, and `user-scalable=no`. `#app` is fixed at `var(--app-h)`, set from `visualViewport.height` (falling back to `100dvh`), so the key bar sits on top of the keyboard. A ResizeObserver on `#term` refits xterm, and xterm's resize sends ttyd a resize, which tmux follows. `overscroll-behavior: none` and `touch-action: none` stop pull-to-refresh and page zoom.

### Reconnect

`src/terminal/ttyd.js`. When the socket closes, the page retries after 0.5, 1, 2, 4, 8, then 15 s (±15%). The pill shows the countdown; tapping it retries now. On `visibilitychange` to visible, `online`, `focus`, and `pageshow`, it reconnects at once if the socket is not open. If the page was hidden for more than 30 s it reconnects even when the socket says open, because a phone that slept can hold a dead socket. Each new socket resets the terminal; tmux redraws the whole screen and its modes when it attaches.

### Renderer

WebGL is the default, with the DOM renderer as a fallback when the GPU context is lost. `?renderer=canvas` or `?renderer=dom` overrides it and is remembered.

Chromium's device-scale emulation (Playwright's `deviceScaleFactor`) does not scale ResizeObserver's `devicePixelContentBoxSize`, and xterm's WebGL and canvas renderers use it to size their canvases. Under emulation they draw at 2.625 times the size and show only the top-left of the screen. A real phone reports device pixels. The e2e test makes `observe(..., {box: 'device-pixel-content-box'})` throw, so xterm uses its `css × devicePixelRatio` fallback, which matches a real device. If the phone ever shows the same zoomed top-left, use `?renderer=dom`.

## Tests

`tests/unit/` runs under `node --test`: swipe-to-wheel mapping, slop, direction changes, tap and long-press, fling and decay, cell mapping, key sequences, sticky modifiers, OSC 52 decoding, backoff, and `auth.js` (hash ticket parsing, ticket-for-key exchange, stored keys, refusal, network errors, and the `postMessage` ticket request with its origin and source checks).

`tests/router/run.sh` copies `proxy-lib.test.uc` to the router and runs it with ucode against the installed `proxy-lib.uc` (request parsing, PROXY lines, address ranges, header rewriting, origin checks, responses). It also runs `ctl.sh status` and `restart-session` against a throwaway tmux server (`GROKBUILD_SOCKET=grokbuild-test`, `GROKBUILD_COMMAND=/bin/true`), so the real grok session is never touched.

`tests/e2e/auth.mjs` logs in through the LuCI form and checks the proxy over raw TLS: no access without a key, made-up keys, a client-sent `X-GrokBuild-User` or `PROXY` line, unknown, reused, and expired tickets, wrong or missing `Origin`, a working websocket that becomes a tmux client, nothing secret in `ps`, only stunnel on the port, the stock ttyd on 7681 still there, the WAN rule in `nft`, no old credential file, the boot link, and refusal after LuCI logout. `GB_SLOW=1` also waits for the 60 s recheck to close an open websocket.

`tests/e2e/luci.mjs` uses a Pixel 7 in headless Chromium: LuCI form login, the menu entry, the framed terminal connecting and showing grok, the frame's size on a phone, the status line, a refused key replaced through `postMessage`, Restart grok's confirmation (dismissed), Restart service (the session survives and the frame reconnects), Full screen, the Settings tab, and logout.

`tests/e2e/phone.mjs` drives the terminal page with a Pixel 7: it logs in to LuCI, takes a ticket, and opens `#t=<ticket>`. Then CDP touch events for taps, swipes, flings, long press, and pinch; the key bar; resizing for the keyboard and rotation; OSC 52 with `tmux set-buffer -w`; the copy sheet; reconnect after closing the socket and after killing ttyd (procd restarts it); and a desktop mouse wheel. It records websocket frames and compares `tmux capture-pane` before and after. Screenshots go to `GB_SHOTS` (default `/workspace/luci-app-grokbuild-shots`). It sends Esc, arrows, PgUp/PgDn, Ctrl+U, and Shift+Tab (then cycles grok's mode back), and never a prompt. The Shift+Tab check reads grok's mode label, which only shows on some grok screens. `GB_FRESH=1` restarts grok in the pane first so its welcome screen, with the Changelog item to tap and scroll, is showing; only use it when grok is idle.

