# Claude Code status line

Model, effort, context use, prompt-cache TTL and the 5h / 7d rate-limit windows —
each as a compact gauge with a reset countdown.

```
Opus 5 (1M context) - high │ ctx ██░░░░░░░░  20% · cache  0h 43m │ 5h █░░░░░░░░░   6% ·  4h 45m │ 7d ███░░░░░░░  30% ·  2d 13h
```

Zero dependencies, no subprocesses, no network. One `node` process per render
(~40 ms, almost all of it interpreter startup) plus one small state file read.

## Install

Drop `statusline.cjs` in your Claude Code config directory (`~/.claude` on
Linux/macOS, `%USERPROFILE%\.claude` on Windows) and add this to
`settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node -e \"require(require('os').homedir()+'/.claude/statusline.cjs')\"",
    "refreshInterval": 30
  }
}
```

Requires `node` on `PATH`. The command deliberately contains no `~` or `$HOME`:
Node resolves the home directory itself, so the same line works under bash, Git
Bash, WSL, `cmd` and PowerShell.

`refreshInterval` is what makes the countdowns tick while you are idle — the
status line is otherwise only redrawn on events, so without it a countdown
freezes at whatever it read when you last typed. It is read at startup, so
changing it needs a restart; the script itself is re-read every render.

**Optional QOL:** set `refreshInterval` to `10`. At 30 the seconds-only
countdowns (the last ten minutes of any timer) step in 30-second jumps while
idle; at 10 the final minute reads close to true. The cost is one ~40 ms `node`
run per tick in each open session; the state file is only rewritten on change.

## What each field means

| Field | Source | Notes |
|---|---|---|
| model + effort | `model.display_name`, `effort.level` | effort omitted on models without it |
| `ctx` | `context_window.used_percentage` | `--%` before the first turn |
| `cache` | `prompt_cache.expires_at` / `.ttl` / `.requests` | absent until a turn is cached; trailing `↻` while the server keeps it warm |
| `5h` / `7d` | `rate_limits.five_hour` / `.seven_day` | subscription windows |

Colours: green under 70%, yellow 70–89%, red 90%+. The cache countdown is grey
until the last quarter of its TTL, yellow there, red inside the last twelfth,
then red `COLD`.

Countdowns gain precision as they shrink — `2d 13h` → `4h 45m` → `9m 30s` —
so the final minutes of a 5-minute cache tier stay readable. Every form is
seven columns wide, and every percentage four, so nothing reflows as values
change. Status symbols such as `↻` trail the cache countdown and take space
only while they are on, so the line shifts once when one appears.

## Deliberate behaviours

**Unknown is not zero.** A window never measured reads `--%`; one *past its
reset* reads `0%`, because a reset window genuinely starts empty. Same for
`ctx`: `--%` before the first turn, `0%` for a turn too small to register.

**Rate limits persist across sessions.** They are account-wide, and the payload
only carries them just after an API response, so the last reading is cached in
`~/.claude/.statusline-state.json` (mode `0600`). A new session inherits it
instead of starting blank. Placeholders are never persisted.

**The cache countdown survives a resume.** The CLI's prompt-cache tracker lives
in memory, so a resumed session reports nothing until its first response even
though the cache is still warm. The last expiry is stored per session to bridge
that gap; a live reading always wins, and entries are dropped a day past expiry.

**The cache countdown follows the server keepalive.** On accounts where Claude
Code runs its cache keepalive, the main session uses the 5-minute tier and the
CLI renews it every ~30 s for as long as there was activity in the last hour
(`activityWindowMinutes`, read from the CLI's cached feature flags in
`~/.claude.json`, default 60). A renewal moves `expires_at` without a new
request, which is how the script spots one. While renewals arrive, the segment
counts down to when the cache will really go cold — last request + window +
TTL — followed by `↻` (`cache  1h 04m ↻`). Without renewals for 150 s the `↻`
drops and the plain expiry shows again, so failed or stopped touches still end
in `COLD`.

**Overages tell the truth.** Past 100% the gauge saturates but the number does
not, so `105%` reads as `105%`.

Writes go to a temp file opened `wx` and are renamed into place, and each write
merges other sessions' entries from a read taken at write time — several
sessions share this one file and all of them write to it on the same timer.

## Optional integrations

The trailing `[CAVEMAN]` badge is for the
[caveman plugin](https://github.com/JuliusBrussee/caveman) and is **entirely
optional** — without the plugin its flag file does not exist and nothing
renders, so the script is safe to use as-is on instances that don't have it.
Delete `cavemanBadge` and its call in `render` if you would rather not carry
the code at all.

## Tests

```
node --test test/*.test.cjs
```

Each test renders the script in a child process against a throwaway config dir,
with `Date.now` pinned by `test/fake-clock.cjs`. No dependencies.

## A caveat worth knowing

`prompt_cache` is **not** in Claude Code's documented status-line schema. It is
real — verified in the CLI binary and in live payloads on 2.1.259 — but being
undocumented it may change or disappear without notice. If it does, the cache
segment simply stops rendering; nothing else is affected. The keepalive flag
(`tengu_sequential_cloud`) is internal too; if it goes, the window falls back to
60 minutes.

The keepalive countdown is an estimate in two places: typing without sending
also extends the server's window but is invisible here (the segment then falls
back to the live expiry), and a resumed session's touches do not reach the
payload, so its bridged countdown can read `COLD` while the server still keeps
the cache warm.

Field names for everything else come from the documented schema and are stable.

## Verified against

Claude Code 2.1.259, Node 24, Linux; the keepalive countdown against 2.1.299,
Node 26, Windows. The payload contract (`prompt_cache`,
`rate_limits`, `context_window`, `effort`) was checked against the CLI binary
rather than assumed.
