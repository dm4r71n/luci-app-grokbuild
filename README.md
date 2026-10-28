# luci-app-grokbuild

Runs Grok Build (`grok`) in a tmux session on the router and serves it through its own ttyd. Closing the browser only detaches; grok keeps running and the next page load reattaches to the same screen.

This is phase 1, a spike. There is no LuCI page, init script, or UCI config yet. The test ttyd is started by hand and is not started at boot.

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
| `/root/grok-work` | grok's working directory. |

## Test ttyd

```sh
/usr/libexec/grokbuild/spike-ttyd.sh start
/usr/libexec/grokbuild/spike-ttyd.sh status
/usr/libexec/grokbuild/spike-ttyd.sh stop
```

It listens on `https://100.104.188.37:7682/`, on `tailscale0` only. The certificate is the router's self-signed uhttpd one, so the browser warns once.

Stopping ttyd does not stop grok. To end the session too:

```sh
tmux -L grokbuild kill-server
```

## When grok exits

The pane falls back to a login shell in `/root/grok-work` with a one-line note. Type `grok` to start it again, or `exit` to close the session; the next page load creates a new one. grok is not restarted automatically, because a loop would spin on a crash or a lost login and hide the error.
