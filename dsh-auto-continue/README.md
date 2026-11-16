# dsh-auto-continue

Host-only DSH plugin. When DSH exits while sessions are running, those sessions
keep an open tail turn; the GUI shows them the "Task stopped — The DSH process
exited before this turn finished…" card. On the next start, this plugin scans
the cold session corpus once and sends one prompt (default `continue`) to every
session still in that state, so they resume without manual typing.

A session that was already continued (by anyone) has a balanced log tail and is
never matched again; running sessions, stale interruptions (older than
`maxAgeHours`), deterministic turn failures, and — by default — delegated
sub-agent/teammate sessions are skipped.

Turns that fail with a TRANSIENT error (default: router 503 "no reachable
URL") are retried live: the plugin waits `errorRetryDelaySeconds`, re-checks
the log tail, and re-sends the prompt — at most `maxErrorRetries` times per
session per boot, so a persistently dead router cannot loop.

Also auto-continued (same live path and budget, and by the boot scan):
- **Output token limit** — turn closed `max-tokens` (the GUI's "Send continue
  to let the model resume" card).
- **Fake tool call** — turn closed `completed`, but its final assistant text
  literally printed `<tool_call>…` markup instead of issuing the call;
  matched by `toolCallPattern`. A session that merely *quotes* such markup
  last gets one stray continue — capped by the budget.

## Config (patch entry `config:`)

| Key | Default | Meaning |
|---|---|---|
| `promptText` | `continue` | Exact text sent to each stuck session. |
| `maxAgeHours` | `72` | Only continue sessions whose turn stopped this recently. |
| `delaySeconds` | `5` | Delay after host start before the scan runs. |
| `includeDelegated` | `false` | Also continue orphaned sub-agent/teammate sessions. |
| `resumeErrorPattern` | `503\|no reachable URL\|every configured URL failed` | Regex: which `turn failed` errors count as transient and get retried. |
| `toolCallPattern` | `<tool_call / <tool_call> / <function_call / <invoke` variants | Regex: literal tool-call markup in final assistant text that marks a fake-call stall. |
| `errorRetryDelaySeconds` | `60` | Wait before auto-continue after a live stalled turn close. |
| `maxErrorRetries` | `3` | Max automatic continues per session per boot (all live triggers). |

## Install

```bash
ln -s ../../../../custom-plugins/dsh-auto-continue ~/.dsh/profiles/web/node_modules/@local/dsh-auto-continue
```

and append to `~/.dsh/profiles/web/cordis.patch.yml` (a NEW plugin needs the
`- insert:` form; a bare `- id:` entry only modifies an already-installed one
and is silently refused):

```yaml
- insert:
    - id: dsh-auto-continue
      name: '@local/dsh-auto-continue'
      config: {}
```

No restart needed: cordis hot-applies the patch file, and any touch of it
re-loads the plugin (also re-runs the scan).

Ceilings: one full cold-log read per session per boot (fine at local scale);
archived sessions simply reject the prompt and are skipped with a log line;
error-retry counts reset at boot (the boot scan then grants one more attempt).
