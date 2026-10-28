# Development notes

## Layout

Same as `luci-app-netusage`: `root/` holds files at their install paths, `htdocs/` will hold the LuCI view, and `tests/` holds tests. The terminal page source is in `src/terminal/`, and `tools/build.mjs` bundles it into `root/usr/share/grokbuild/www/index.html`. The built file is committed, because the router and the OpenWrt build have no Node.

```sh
npm ci
npm run build      # src/terminal -> root/usr/share/grokbuild/www/index.html
npm test           # unit tests, node --test
npm run e2e        # Pixel 7 in headless Chromium against the live test ttyd
```

Copy to the router:

```sh
tar -C root -cf - . | ssh root@router 'tar -C / -xf -'
```

A new page takes effect on the next page load; ttyd reads the file per request. Changes to `spike-ttyd.sh` need `spike-ttyd.sh restart`.

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

## ttyd

- uhttpd stores `/etc/uhttpd.crt` and `/etc/uhttpd.key` in DER. libwebsockets only reads PEM and fails with `PEM routines::no start line`. `spike-ttyd.sh` converts them into `/etc/grokbuild/`.
- That uhttpd certificate is self-signed, has no subjectAltName, and expired on 2026-04-02.
- ttyd takes the credential only as `-c user:pass`, so it is visible in `ps` to anyone who can run `ps` on the router. The supervisor reads it from the file, so only the ttyd line shows it. At log level notice and above (`-d 7`) ttyd also writes it to syslog in base64. Keep `-d 3`. Moving to `-H` (an auth header from a reverse proxy, for example uhttpd or LuCI) would take it off the command line.
- `GET /token` returns the base64 credential to any client that already passed basic auth. That is how the page opens the websocket.
- `-i` binds one interface, so `spike-ttyd.sh` runs two ttyd processes on 7682: `-i br-lan` (192.168.1.1) and `-i tailscale0` (100.104.188.37). Each has its own supervisor and pid file, `/var/run/grokbuild-ttyd-<iface>.pid`. Each browser connection is one more tmux client on the same session; tmux sizes the window to the most recently active client.
- Binding to `0.0.0.0` and relying on the firewall was rejected. Per-interface binding keeps 7682 off `eth0` even if the firewall is stopped, and `Block-GrokBuild-WAN` (see the README) covers the WAN if a later change binds wider. ttyd is started without `-6`, so it listens on IPv4 only; the rule has no `family`, so it covers IPv6 too.
- The rule is added by hand for now. The LuCI package will add it in `root/etc/uci-defaults/` with `uci add firewall rule` guarded by a name check, then `uci commit firewall`. It will not reload the firewall from uci-defaults; the first boot or `/etc/init.d/firewall reload` picks it up.
- Restarting tailscale deletes `tailscale0` and ttyd exits. Binding to the IP instead would not help: the address goes away with the interface, and ttyd cannot bind it until it is back. The supervisor in `spike-ttyd.sh` waits for an IPv4 address on `tailscale0` and starts ttyd again. The procd init script will replace it with `respawn`, plus a hotplug or `ubus` trigger on the interface.

## Terminal page

### Why a self-built page

The page is xterm.js 5.5 with the fit, WebGL, canvas, and Unicode 11 addons, bundled with esbuild into one HTML file, and it speaks ttyd's protocol itself. ttyd's own frontend is a minified Preact bundle; patching it for touch and a key bar means editing generated code that changes with each ttyd release. ttyd's protocol is small and stable, so owning the page is less fragile:

- Upgrade: basic auth is checked on the websocket request too (`check_auth` in `protocol.c`); the browser sends the cached credential for same-origin requests.
- First message: `{"AuthToken": <GET /token>, "columns", "rows"}`.
- Client to server: `0` + input, `1` + `{"columns","rows"}`, `2` pause, `3` resume.
- Server to client: `0` + output, `1` + title, `2` + preferences (ignored).

ttyd serves only the index, `/token`, and `/ws`, so CSS and JS are inlined. The page sets a CSP with `default-src 'none'` and `connect-src 'self'`, and uses system monospace fonts, so it makes no other requests. The e2e test checks that.

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

`tests/unit/` runs under `node --test`: swipe-to-wheel mapping, slop, direction changes, tap and long-press, fling and decay, cell mapping, key sequences, sticky modifiers, OSC 52 decoding, and backoff.

`tests/e2e/phone.mjs` drives the live test ttyd with a Pixel 7 in headless Chromium: CDP touch events for taps, swipes, flings, long press, and pinch; the key bar; resizing for the keyboard and rotation; OSC 52 with `tmux set-buffer -w`; the copy sheet; reconnect after closing the socket and after killing ttyd; and a desktop mouse wheel. It records websocket frames and compares `tmux capture-pane` before and after. Screenshots go to `GB_SHOTS` (default `/workspace/luci-app-grokbuild-shots`). It sends Esc, arrows, PgUp/PgDn, Ctrl+U, and Shift+Tab (then cycles grok's mode back), and never a prompt. `GB_FRESH=1` restarts grok in the pane first so its welcome screen, with the Changelog item to tap and scroll, is showing; only use it when grok is idle.

## Plan

- Services > Grok Build in LuCI, embedding or linking the page.
- procd init script and UCI config in place of `spike-ttyd.sh`, with one instance per listed interface.
- LAN and Tailscale only, with `Block-GrokBuild-WAN` from uci-defaults.
