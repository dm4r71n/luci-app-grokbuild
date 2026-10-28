# Development notes

## Layout

Same as `luci-app-netusage`: `root/` holds files at their install paths, `htdocs/` will hold the LuCI view, and `tests/` will hold fixtures.

Copy to the router:

```sh
tar -C root -cf - . | ssh root@router 'tar -C / -xf -'
```

## tmux

Everything uses its own socket, `tmux -L grokbuild`, and `-f /etc/grokbuild/tmux.conf`, so it does not touch any other tmux server.

`attach.sh` runs `tmux -u ... new-session -A -s grok -c /root/grok-work /usr/libexec/grokbuild/session.sh`. `-A` attaches when the session exists. `-u` forces UTF-8, because musl has no locale for tmux to detect it from.

`session.sh` runs `set -m` before grok so grok gets its own process group. Without it tmux reports `pane_current_command` as `sh`.

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
- ttyd takes the credential only as `-c user:pass`, so it is visible in `ps` to root on the router. At log level notice and above (`-d 7`) ttyd also writes it to syslog in base64. Keep `-d 3`.
- `GET /token` returns the base64 credential to any client that already passed basic auth. That is how ttyd's page opens the websocket.

## Findings from the spike

grok's TUI uses the alternate screen and turns on mouse tracking: `alternate_on=1`, `mouse_any_flag=1`, `mouse_all_flag=1` (any-motion, 1003), `mouse_sgr_flag=1`. `history_size` stays 0 while grok runs.

So tmux has no scrollback for grok's output, and copy-mode would only show the current screen. With `mouse on`, tmux's default wheel binding forwards wheel events to the pane when the pane has mouse tracking on. Scrolling back through a conversation is done by grok itself, in response to wheel events.

On a phone, xterm.js does not turn a touch drag into wheel events while mouse tracking is on. The touch layer has to send SGR wheel reports (`ESC [ < 64 ; x ; y M` up, `65` down) itself, or dispatch synthetic `wheel` events on the xterm element, one per line step of the swipe.

grok prints "Clipboard may be unreachable" under tmux. OSC 52 through tmux needs `set-clipboard on` and a browser side that accepts it. Not done in the spike.

## Plan

- Services > Grok Build in LuCI.
- Custom ttyd page (`ttyd -I`) with:
  - a touch layer that turns vertical swipes into wheel events,
  - a key bar: Esc, Tab, Ctrl, arrows, PgUp, PgDn, Shift+Tab, Enter,
  - fit on rotate and reconnect on wake.
- procd init script and UCI config in place of `spike-ttyd.sh`.
- LAN and Tailscale only.
