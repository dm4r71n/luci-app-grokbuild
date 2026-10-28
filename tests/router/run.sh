#!/bin/sh
# Run the ucode tests on the router against the installed proxy-lib.uc.
#   GB_SSH="ssh root@router" tests/router/run.sh
SSH=${GB_SSH:-"ssh -o BatchMode=yes -o UserKnownHostsFile=/workspace/.ssh/known_hosts -i /workspace/.ssh/openwrt root@100.104.188.37"}
dir=$(dirname "$0")
$SSH 'cat > /tmp/grokbuild-proxy-lib.test.uc && ucode /tmp/grokbuild-proxy-lib.test.uc; rc=$?; rm -f /tmp/grokbuild-proxy-lib.test.uc; exit $rc' < "$dir/proxy-lib.test.uc"

# ctl.sh status and restart-session against a throwaway tmux server, so the
# real grok session is never touched.
$SSH 'export GROKBUILD_SOCKET=grokbuild-test GROKBUILD_COMMAND=/bin/true
fail=0
tmux -L grokbuild-test kill-server 2>/dev/null
[ "$(/usr/libexec/grokbuild/ctl.sh status)" = "{\"session\":false}" ] || { echo "FAIL status without session"; fail=1; }
/usr/libexec/grokbuild/attach.sh detached
a=$(/usr/libexec/grokbuild/ctl.sh status | sed -n "s/.*\"created\":\([0-9]*\).*/\1/p")
[ -n "$a" ] || { echo "FAIL status with session"; fail=1; }
sleep 1
b=$(/usr/libexec/grokbuild/ctl.sh restart-session | sed -n "s/.*\"created\":\([0-9]*\).*/\1/p")
[ -n "$b" ] && [ "$b" != "$a" ] || { echo "FAIL restart-session makes a new session"; fail=1; }
tmux -L grokbuild-test capture-pane -p -t grok | grep -q "grok exited" || { echo "FAIL pane falls back to a shell"; fail=1; }
tmux -L grokbuild-test kill-server
[ $fail = 0 ] && echo "ctl.sh: 4 passed"
exit $fail'
