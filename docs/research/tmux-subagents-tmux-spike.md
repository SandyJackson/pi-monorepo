# Tmux 3.8 behaviour the tmux subagent backend relies on

## Scope

This note records the spike for issue #59 (parent #56). It checks eight tmux behaviours that [Tmux subagents V1](../specs/tmux-subagents.md) §7 and §10 depend on. Each probe is marked **holds** or **fails**, with the commands run and their output.

Environment: macOS, `tmux 3.8` (Homebrew), bash probe scripts. Rendering and key handling with real Pi in Ghostty are out of scope; the operator checks those on the ticket 10 PR.

## Method

Every tmux command carried `-L <name>`. The sockets were:

| Socket | Role |
| --- | --- |
| `spike59-host` | Gives the outer clients a real pty. Each host window runs `env -u TMUX -u TMUX_PANE tmux -L spike59-outer attach -t =<session>`. |
| `spike59-outer` | Stands in for the operator's server. Started with `-f outer.conf` (bash panes, `extended-keys on`, `extended-keys-format csi-u`, `status off`). |
| `spike59-priv` | Stands in for `pi-subagents`. Started with `-f priv.conf`, the §7 config. |
| `spike59-cfg`, `spike59-cfgctl` | Config and exit probes for probe 8. |

Key presses reach an outer client through `tmux -L spike59-host send-keys -t h:<window> <key>`. The probes read what a client shows with `tmux -L spike59-host capture-pane -p -t h:<window>`. Each script kills every server on exit, and `tmux -L <name> ls` printed `no server running on /private/tmp/tmux-502/<name>` for all five sockets at the end.

`priv.conf`, the §7 settings as written for the probe:

```tmux
set -g prefix None
set -g prefix2 None
unbind-key -a -T root
unbind-key -a -T prefix
set -g status off
set -s escape-time 0
set -s extended-keys on
set -s extended-keys-format csi-u
set -s exit-empty on
set -s exit-unattached off
set -g destroy-unattached off
set -g remain-on-exit off
```

Below, `$` lines are commands, followed by output and `[exit N]`. Long scratch paths are shortened to `$D`.

## Results

| # | Behaviour | Result |
| --- | --- | --- |
| 1 | Duplicate `new-session` fails recognisably | holds |
| 2 | `show-environment` returns a `-e` value | holds |
| 3 | `#{session_attached}` counts clients, drops to 0 | holds |
| 4 | Modal float attaches; without `env -u` attach is refused | **fails** (second half) |
| 5 | `new-pane -O` on a zoomed window | holds, `-A` not needed |
| 6 | `kill-pane` on the float detaches only that client | holds |
| 7 | `display-menu` from `run-shell -b` shows on the invoking client; items run | holds, with a caveat |
| 8 | `-f` config is not merged with the user's; server exits with its last session | holds |

### 1. Duplicate session: holds

```text
$ tmux -L spike59-priv -f priv.conf new-session -d -s sa-p1 -- sleep 600
[exit 0]
$ tmux -L spike59-priv -f priv.conf new-session -d -s sa-p1 -- sleep 600
duplicate session: sa-p1
[exit 1]
$ tmux -L spike59-priv list-sessions -F '#{session_name} windows=#{session_windows}'
sa-p1 windows=1
```

The error text is `duplicate session: <name>` on stderr, with exit 1. The losing call creates nothing.

Exact-match targets matter. Without `=`, a target matches by prefix:

```text
$ tmux -L spike59-priv has-session -t =sa-p
can't find session: sa-p
[exit 1]
$ tmux -L spike59-priv has-session -t sa-p
[exit 0]
```

### 2. `show-environment`: holds

```text
$ tmux -L spike59-priv -f priv.conf new-session -d -s sa-p2 -e PI_SUBAGENT_NONCE=n0nce-abc123 -e 'SPIKE_SPACES=a b=c "q"' -- sleep 600
[exit 0]
$ tmux -L spike59-priv show-environment -t =sa-p2 PI_SUBAGENT_NONCE
PI_SUBAGENT_NONCE=n0nce-abc123
[exit 0]
$ tmux -L spike59-priv show-environment -t =sa-p2 SPIKE_SPACES
SPIKE_SPACES=a b=c "q"
[exit 0]
$ tmux -L spike59-priv show-environment -t =sa-p2 NOT_SET_VAR
unknown variable: NOT_SET_VAR
[exit 1]
$ tmux -L spike59-priv show-environment -t =sa-missing PI_SUBAGENT_NONCE
no such session: =sa-missing
[exit 1]
```

Output is `NAME=value` with no quoting. The parser should strip the `NAME=` prefix and keep the rest verbatim. The process sees the same value: a pane started with `-e PI_SUBAGENT_NONCE=proc-check` wrote `proc-check` from `$PI_SUBAGENT_NONCE`.

Related, not a probe. On `new-session`, `-e TMUX= -e TMUX_PANE=` has no effect. The pane still got the private server's values, plus a variable the launcher never passed with `-e`:

```text
$ tmux -L spike59-priv new-session -d -s sa-p2c -e TMUX= -e TMUX_PANE= -- sh -c 'env | grep "^TMUX" > out/p2-tmux-env.txt; sleep 600'
$ cat out/p2-tmux-env.txt
TMUX=/private/tmp/tmux-502/spike59-priv,27774,3
TMUX_PANE=%3
TMUX_PLUGIN_MANAGER_PATH=/Users/sandyjackson/.config/tmux/plugins/
```

`TMUX_PLUGIN_MANAGER_PATH` came from the environment of the process that started the private server. That matches tmux(1), "GLOBAL AND SESSION ENVIRONMENT": "When the server is started, tmux copies the environment into the global environment ... When a window is created, the session and global environments are merged. If a variable exists in both, the value from the session environment is used." See proposed change C.

### 3. `#{session_attached}`: holds

```text
$ tmux -L spike59-priv display-message -p -t =sa-p3: '#{session_attached}'
0
$ tmux -L spike59-host new-window -d -t h: -n p3 -- env -u TMUX -u TMUX_PANE tmux -L spike59-priv attach -t =sa-p3
$ tmux -L spike59-priv display-message -p -t =sa-p3: '#{session_attached}'
1
$ tmux -L spike59-host new-window -d -t h: -n p3b -- env -u TMUX -u TMUX_PANE tmux -L spike59-priv attach -t =sa-p3
$ tmux -L spike59-priv display-message -p -t =sa-p3: '#{session_attached}'
2
$ tmux -L spike59-host kill-window -t h:p3b
$ tmux -L spike59-priv display-message -p -t =sa-p3: '#{session_attached}'
1
$ tmux -L spike59-priv detach-client -s =sa-p3
$ tmux -L spike59-priv display-message -p -t =sa-p3: '#{session_attached}'
0
$ tmux -L spike59-host new-window -d -t h: -n p3 -- env -u TMUX -u TMUX_PANE tmux -L spike59-priv attach -t =sa-p3
$ tmux -L spike59-priv display-message -p -t =sa-p3: '#{session_attached}'
1
$ tmux -L spike59-host kill-pane -t h:p3
$ tmux -L spike59-priv display-message -p -t =sa-p3: '#{session_attached}'
0
```

Each read came about 1 s after the change. A missing session does not error:

```text
$ tmux -L spike59-priv display-message -p -t =sa-missing: '#{session_attached}'

[exit 0]
```

It prints an empty line and exits 0. The implementer notes already require an empty or unparseable count to be treated as attached. That rule is needed because exit status alone does not show the session is absent. Use `has-session` for that.

### 4. Modal float from an outer pane: first half holds, second half fails

The contract command, typed into the shell of outer pane `%0` (where `TMUX` points at the outer server):

```text
TMUX=/private/tmp/tmux-502/spike59-outer,18340,0
$ tmux -L spike59-outer new-pane -O -x 90% -y 90% -- env -u TMUX -u TMUX_PANE tmux -L spike59-priv attach -t =sa-p4; echo new-pane-exit=$?
$ tmux -L spike59-outer list-panes -a -F '#{session_name} #{pane_id} float=#{pane_floating_flag} active=#{pane_active} zoomed=#{window_zoomed_flag} #{pane_width}x#{pane_height} cmd=#{pane_current_command}'
outer %0 float=0 active=0 zoomed=0 160x45 cmd=bash
outer %2 float=1 active=1 zoomed=0 142x38 cmd=tmux
outer2 %1 float=0 active=1 zoomed=0 160x45 cmd=bash
$ tmux -L spike59-priv display-message -p -t =sa-p4: '#{session_attached}'
1
$ tmux -L spike59-priv list-clients -F '#{client_name} session=#{client_session} #{client_width}x#{client_height}'
/dev/ttys044 session=sa-p4 142x38
```

The outer client showed a bordered float containing `PRIVATE-MARKER-sa-p4`, the private session's output. `new-pane` exits 0 straight away, without waiting for the float.

The nesting claim does not hold. Attaching to the private server without `env -u` works, even with `TMUX` set to the outer server:

```text
$ tmux -L spike59-outer new-pane -O -x 90% -y 90% -t %0 -- sh -c 'echo TMUX=$TMUX > $D/out/p4-nested-priv.txt; tmux -L spike59-priv attach -t =sa-p4 >> $D/out/p4-nested-priv.txt 2>&1; echo exit=$? >> $D/out/p4-nested-priv.txt'
$ tmux -L spike59-priv display-message -p -t =sa-p4: '#{session_attached}'
1
$ cat out/p4-nested-priv.txt
TMUX=/private/tmp/tmux-502/spike59-outer,18340,0
```

The attach stayed up and showed the private session. The refusal only happens when the client attaches to the server that owns its own pane:

```text
$ tmux -L spike59-outer new-pane -O -t %0 -- sh -c 'tmux -L spike59-outer attach -t =outer2 > $D/out/p4-nested-outer.txt 2>&1; echo exit=$? >> $D/out/p4-nested-outer.txt'
$ cat out/p4-nested-outer.txt
sessions should be nested with care, unset $TMUX to force
exit=1
```

My reading, which I have not checked in tmux source, is that tmux refuses only when the client's tty is a pane of the server being attached to. `env -u TMUX -u TMUX_PANE` is harmless, but it is not what makes `open` work. See proposed change A.

`-e` on `new-pane` acts differently from `new-session`. `-e TMUX=` emptied `TMUX`, but `TMUX_PANE` kept the tmux value:

```text
$ tmux -L spike59-outer new-pane -O -t %0 -e TMUX= -e TMUX_PANE= -e SPIKE_E=set -- sh -c "env | grep '^TMUX=\|^TMUX_PANE=\|^SPIKE_E=' > $D/out/p4-newpane-env.txt"
$ cat out/p4-newpane-env.txt
TMUX=
TMUX_PANE=%4
SPIKE_E=set
```

This partly contradicts the implementer note that `-e TMUX=` is ignored for the new pane. Clearing both variables with `env -u` in the command is still the dependable way.

A second modal pane on the same window is refused:

```text
$ tmux -L spike59-outer new-pane -O -t %0 -- sleep 30
window already has a modal pane
[exit 1]
```

`open` hits this when a float is already open on the target window. One way is the operator pressing the picker key from inside an open float, since `-K` is not passed so the prefix still works. See proposed change B.

### 5. `new-pane -O` on a zoomed window: holds without `-A`

```text
$ tmux -L spike59-outer split-window -d -t %0 -- sh -c 'echo TILED-SECOND-PANE; exec sleep 3600'
$ tmux -L spike59-outer resize-pane -Z -t %0
$ tmux -L spike59-outer new-pane -O -x 90% -y 90% -t %0 -- env -u TMUX -u TMUX_PANE tmux -L spike59-priv attach -t =sa-p4
[exit 0]
$ tmux -L spike59-outer list-panes -a -F '...'
outer %0 float=0 active=0 zoomed=1 160x45 cmd=tmux
outer %3 float=0 active=0 zoomed=1 160x22 cmd=sleep
outer %4 float=1 active=1 zoomed=1 142x38 cmd=tmux
$ tmux -L spike59-priv display-message -p -t =sa-p4: '#{session_attached}'
1
```

The window stayed zoomed, and the client showed the float with `PRIVATE-MARKER-sa-p4` above the zoomed pane. With `-A` added (`new-pane -O -A -x 90% -y 90% -t %0 -- ...`) the result was the same: exit 0, `zoomed=1`, float visible and attached. `-A` is not needed. Adding it causes no harm that I saw.

### 6. `kill-pane` on the float: holds

```text
$ tmux -L spike59-outer kill-pane -t %2
[exit 0]
$ tmux -L spike59-outer list-panes -a -F '...'
outer %0 float=0 active=1 zoomed=0 160x45 cmd=bash
outer2 %1 float=0 active=1 zoomed=0 160x45 cmd=bash
$ tmux -L spike59-priv has-session -t =sa-p4
[exit 0]
$ tmux -L spike59-priv display-message -p -t =sa-p4: '#{session_attached}'
0
$ tmux -L spike59-priv list-panes -t =sa-p4: -F '#{pane_id} dead=#{pane_dead} pid=#{pane_pid} cmd=#{pane_current_command}'
%1 dead=0 pid=18349 cmd=sleep
$ ps -o pid=,command= -p 18349
18349 sleep 3600
```

The outer pane got focus back and showed `new-pane-exit=0` and its prompt. The other direction also holds, matching §10 "If the child exits, the attach client exits and the pane closes":

```text
$ tmux -L spike59-outer new-pane -O -x 90% -y 90% -t %0 -- env -u TMUX -u TMUX_PANE tmux -L spike59-priv attach -t =sa-p6
$ tmux -L spike59-outer list-panes -a -F '...'
outer %3 float=1 active=1 zoomed=0 142x38 cmd=tmux
$ tmux -L spike59-priv kill-session -t =sa-p6
$ tmux -L spike59-outer list-panes -a -F '...'
outer %0 float=0 active=1 zoomed=0 160x45 cmd=bash
outer2 %1 float=0 active=1 zoomed=0 160x45 cmd=bash
```

### 7. `display-menu` from `run-shell -b`: holds, with a caveat

The binding, shaped like the README snippet:

```text
$ tmux -L spike59-outer bind-key -n F12 run-shell -b "$D/p7-menu.sh '#{pane_id}' '#{client_name}'"
```

`p7-menu.sh` runs `tmux -L spike59-outer display-menu -t "$1" -T Spike -x C -y C "Item one" 1 "run-shell 'echo selected-from-#{client_name} > $D/out/p7-selected.txt'" "Item two" 2 "display-message two"`.

Client A was on session `outer` and client B on `outer2`. F12 was pressed on B:

```text
menu lines on A: 0
-- B's screen
          ┌─Spike────────┐
          │ Item one (1) │
          │ Item two (2) │
          └──────────────┘
args: pane=%1 client=/dev/ttys043
TMUX=/private/tmp/tmux-502/spike59-outer,18340,1
display-menu exit=0
-- press 1 on B
$ cat out/p7-selected.txt
selected-from-/dev/ttys043
```

The job gets `TMUX` but not `TMUX_PANE`. `display-menu` returns 0 at once, without waiting for a choice. A binding with no `-t` and no `-c` (`p7-menu-not.sh`) also opened the menu on the pressing client's window, six presses out of six (alternating B, A, B, C, B, A).

The caveat: in tmux 3.8 the menu belongs to the target pane's window, not to one client. With clients A and C both on session `outer`, a menu opened from either client showed on both. Either client could pick an item or dismiss it with Escape. `-c` did not decide where the menu appeared. It only set `#{client_name}` for the item's command:

```text
-- 1: -c A -t <pane of outer2>
$ tmux -L spike59-outer display-menu -c /dev/ttys040 -t %1 ...
A: menu=0  C: menu=0  B: menu=1
-- 2: -c B -t <pane of outer>
$ tmux -L spike59-outer display-menu -c /dev/ttys042 -t %0 ...
A: menu=1  C: menu=1  B: menu=0
-- 4: -c C, no -t
A: menu=0  C: menu=0  B: menu=1
-- 5: -c B, no -t
A: menu=1  C: menu=1  B: menu=0
-- 6: -c A -t <pane of outer>, then press 1 on C
$ cat out/p7-selected.txt
selected-from-/dev/ttys040
```

Without `-t` and outside a key binding (cases 4 and 5), the menu landed on whichever session tmux took as current, not on the `-c` client. So `pick` should pass `-t <--pane>`. See proposed change D. `display-message -c` did follow its client: `MSG-FOR-C` showed on C only.

### 8. Private config and server exit: holds

With `XDG_CONFIG_HOME` pointed at a scratch directory whose `tmux/tmux.conf` sets `@usermarker`:

```text
$ tmux -L spike59-cfgctl new-session -d -s ctl -- sleep 600      # no -f: control
$ tmux -L spike59-cfgctl show-options -gv @usermarker
from-user-config
$ tmux -L spike59-cfg -f priv.conf new-session -d -s sa-p8 -- sleep 600
$ tmux -L spike59-cfg show-options -gv @usermarker
invalid option: @usermarker
[exit 1]
```

Every `priv.conf` setting read back as written: `prefix None`, `prefix2 None`, `status off`, `remain-on-exit off`, `destroy-unattached off`, `escape-time 0`, `extended-keys on`, `extended-keys-format csi-u`, `exit-empty on`, `exit-unattached off`. `list-keys -T root` printed nothing, and `list-keys -T prefix` printed `table prefix doesn't exist`. Only the `copy-mode`, `copy-mode-vi` and `move` tables remain, and with no root or prefix keys nothing can reach them. `show-messages` held no config errors.

With the operator's real `~/.config/tmux/tmux.conf` in place, `prefix` read `C-z` without `-f` and `None` with `-f priv.conf`. The system file `/opt/homebrew/etc/tmux.conf` does not exist here, so this run did not test whether `-f` also skips it. tmux(1) describes `-f` as replacing the default file lookup.

The server exits with its last session:

```text
$ tmux -L spike59-cfg -f priv.conf new-session -d -s sa-p8e -- sleep 2
$ tmux -L spike59-cfg list-sessions -F '#{session_name} pid=#{pid}'
sa-p8e pid=28282
# 3.5 s later
$ tmux -L spike59-cfg list-sessions
no server running on /private/tmp/tmux-502/spike59-cfg
[exit 1]
```

With two sessions (`sleep 2`, `sleep 5`), only `sa-b` was left after 3 s, and the server was gone after 6.5 s. A command that exits at once (`sh -c 'echo boom; exit 3'`) took its session and the server with it within 1 s.

A consequence for `ensureLive` step 4: when a child dies during startup, `remain-on-exit off` and `exit-empty on` remove the pane right away, so `capture-pane` text is usually gone before anyone can read it. The spec already says "if any was obtained". Expect `failed` without output in that case.

## Proposed contract changes

These are proposals for the operator. I have not edited the spec or the issues.

**A (probe 4).** §10 `open`, replace the sentence "The variables are cleared in the executed command because tmux sets its own `TMUX` and `TMUX_PANE` for the new pane regardless of `-e`." with: "The variables are cleared in the executed command as hygiene: tmux 3.8 sets `TMUX_PANE` for the new pane regardless of `-e`, and the attach client has no use for the outer server's values. Clearing them is not what allows the attach; tmux refuses a nested attach only to the server that owns the client's pane, and `pi-subagents` is a different server." The command does not change.

**B (probe 4, new finding).** §10 `open`, add: "If `new-pane -O` fails because the window already has a modal pane (`window already has a modal pane`, exit 1), `open` shows that error with `display-message` and does nothing else. It does not close or reuse the existing float."

**C (probe 2, new finding).** §7 Environment, add: "The child's environment is the private server's global environment, copied from whichever process started that server, overlaid with the `-e` values. A variable missing from a later launcher's environment is not removed; the child inherits the server's copy." This is a documentation change. Removing inherited variables would need `set-environment -gu` or `-r` handling, which I am not proposing for V1.

**D (probe 7).** §10 `pick`, add: "`display-menu` is run with `-t <--pane>`. In tmux 3.8 the menu belongs to that pane's window and shows on every client viewing it; `-c` does not choose where it is drawn." Change the §10 **Verify** line to: "`display-menu -t <pane>` from `run-shell -b` shows on the invoking pane's window (holds, ticket 03)."
