# DSH session freeze on `web_search` — diagnosis + fix plan

Session that froze: **Nelare Realistic Animal Style** = `session-c88a2d74-ed79-4a12-84a3-67d88c717998`
Log: `~/.dsh/sessions/--net-192.168.10.52-RAID-atomo-home-rhradec-Videos-ai-production--/session-c88a2d74-ed79-4a12-84a3-67d88c717998/session.v4.jsonl.zstd`
Frozen since: 2026-11-08 **22:48:19** (America/Vancouver). Restart of DSH performed 2026-11-09 ~00:10 MST to clear it.

## Evidence (all read from the durable log + projection cache)

| Fact | Value |
| --- | --- |
| Turn state | `turn/start` #1636 (turn 32) with **no** `turn/end`; step 1 started 22:48:08 |
| Last assistant message | #1640 complete, finish reason `tool-calls`, one tool call |
| The wedged call | `web_search` id `call_801ff4ae8c4a4f9eb551cc2a\|fc_c9f030edf88147d4ad9988dd94bb397f`, emitted 22:48:19 |
| Its result | **none anywhere in the log** (the callId never appears after #1641) |
| Host's own state | projection-cache row `sessionStats.pendingCalls` still holds exactly that callId |
| Queued, undelivered | `inbox.next-step` = 6 items: 2 Comfy job-finished notices (`comfy-7a7e6fd9ce844027`, `comfy-e18e5e30b4e94d31`, both **completed**) + the 4 user messages typed after the freeze |
| Search dispatch proof | 3 × `web/deepseek-search-llm-request` at 22:48:19 → auth + credential resolved, endpoint `https://api.deepseek.com/anthropic/v1/messages`, model `deepseek-v4-flash`, tool `web_search_20250305` |
| Whole corpus | 165 session logs: **37** `web_search` calls, **36 settled**, **1 wedged — this one**; it is also the only log with an unbalanced tail |
| Timeout guard works elsewhere | 78 × `Error: tool call timed out after 30000ms` results across the corpus; `cordis.patch.yml` sets `tool-web: {fetch: true, searchTimeoutMs: 60000}` in 3 agent groups |
| Host health at freeze time | PID 773765 alive, session.lock held, **no** journald error from node, **no** open socket to api.deepseek.com, no proxy env; `curl https://api.deepseek.com/anthropic/v1/messages` now returns 401 in 0.28 s |
| Stop button | does nothing — see mechanism below |

## Mechanism (why one tool call freezes a whole session)

1. `dsh-tool-web` → `runSearchQueries()` fans the N queries out with `Promise.allSettled` over `AbortSignal.any([exec.signal, controller.signal])`.
2. `dsh-web-search-deepseek` → `search()` resolves auth, records the request, then `await fetch(endpoint, { signal })` and `await response.json()`.
3. `dsh-tool-call-timeout-policy` is **cooperative only**: it swaps `exec.signal` for a 30 s/60 s deadline and then `await next()`; it substitutes the timeout result **only after `next()` returns**. If the awaited promise never settles, the deadline cannot fire a result → no `tool/result`, no `step/end`, no `turn/end`.
4. Consequence: the step-inbox (your later messages + job notices) can never drain — the session looks frozen while the host is perfectly healthy.
5. `Stop` = `session.cancel()` → aborts the same signal; if the chain is wedged past the point of cooperation, no `turn/end` is written either, so the button appears dead. That matches the report.

**Open question still to nail:** which await ignores the abort — undici body/header read after the response headers arrive, or the `AbortSignal.any` fusion in the fan-out. Needs a targeted probe (see Probe 1).

## Fix plan (implement after the restart — NOT yet done)

New local plugin `~/.dsh/custom-plugins/dsh-websearch-safe/` (same shape as `dsh-auto-continue`: `export const name`, `inject`, `apply(ctx)`, `package.json` with `dsh-plugin` keyword), plus one entry in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-websearch-safe
      name: '@local/dsh-websearch-safe'
      config: { timeoutMs: 20000, backend: 'duckduckgo', searxngBaseUrl: '' }
```

Tool contract: same name/args as built-in (`queries: string[]`) so no prompt change; hard wall-clock `Promise.race` + `AbortSignal.timeout()` so a pending call can **never** outlive the deadline; always returns a result object (error text on failure) instead of throwing/hanging; own HTTP client, no dependency on api.deepseek.com.

Built-in must be turned off to avoid `tool "web_search" is already registered`: set `search: false` in the three `tool-web` groups of `cordis.patch.yml`, or register the replacement through the agent scope (`agent.ctx`) instead of globally.

Backend candidates (ask the user which): DuckDuckGo/Bing HTML scrape (no key), LAN SearXNG instance, Tavily/Brave/Serper with key, or DeepSeek search proxied through their own `codex-router`.

## Probes still worth running

1. **Probe 1 — reproduce deliberately.** Call `web_search` once in a throwaway session, watch `ss -tnp` for the api.deepseek.com socket + `pendingCalls` in the projection cache. If it wedges again → hang is in fetch/response-body; if it settles → race/one-off.
2. **Probe 2 — corpus check:** do any settled `web_search` results carry `WEB_PROVIDER_ERROR` / `DeepSeek search request failed`? (both strings exist in the corpus — need per-call attribution.)
3. **Probe 3 — does `tool-web.search: false` + replacement plugin survive a hot reload** (their `dsh-idle-watch.sh` restart gate), or does the agent group config need a full restart.
4. **Probe 4 — Stop semantics:** confirm whether `session.cancel` on a wedged turn ever writes `turn/end`; if not, a watchdog plugin that force-closes turns whose `pendingCalls` age > 90 s is the belt-and-braces fix.

## Post-restart probes (done)

- Resumed session retried `web_search` → **HTTP 401 in 0.3 s**: `Authentication Fails, Your api key: ****sdsd is invalid`. The stored `DEEPSEEK_API_KEY` credential has been invalid since **Oct 24 02:55** (24 consecutive 401s). Before that, 11 calls succeeded in 5.1–6.8 s. So built-in search has been dead for ~2 weeks.
- Corpus classification of 38 `web_search` calls: 11 real results (Oct 22–24), 24 × 401, **3 wedges** (Oct 29: 1.75 h, Oct 30: 17.8 h, Nov 8: 20.6 min). Each wedge was closed only by a host restart, which writes the synthetic “The tool call was interrupted after it was recorded, but no result was durably recorded.”
- Query count does not predict the wedge (2, 3 and 4 queries each wedged once).
- `dsh-tool-call-timeout-policy` fired 78 × for glob/grep/bash and **never once for web_search** → the deadline only substitutes a result after the tool returns; a never-settling search fetch is unkillable from that layer. `session.cancel()` (the Stop button) is equally powerless.
- Transport notes: DSH installs a global undici dispatcher (`dsh-http-proxy`; direct when no proxy env). `web_fetch` uses its own pinned-lookup Agent and has never wedged; `web_search` uses plain global `fetch`. Undici 8.11.2 vendored, Node v22.19.0.
- `deadline()` in `@deepseek-ai/dsh-timeout` is signal-only (“the signal only notifies; callers must stop their own work”) — confirms the cooperative contract.
- Note: an earlier line above claimed `searx.be …&format=json` worked (200/0.77 s). **Wrong** — the body was a “Verifying your browser…” wall, not JSON. Corrected below.

## Scraping probe: can this box search by itself? (measured)

Plain HTTP (`curl`, Firefox UA):
- `html.duckduckgo.com` / `lite.duckduckgo.com` → **202 bot challenge**, no results.
- `searx.be` HTML → “Verifying your browser…”; `format=json` returns the same wall. `searx.tiekoetter`/`priv.au` 429, `searxng.site` 403, `baresearch.org` bot wall.
- `bing.com/search` → 200, 132 KB, **0 parseable `b_algo` results**. `bing …&format=rss` → 200 XML, 7–10 items, but **junk** (gold-coin and hotel spam).
- `search.brave.com` 429; `mojeek` 200 via curl / 403 via browser; marginalia 302.

Headless Chromium (Playwright 1.60, cached chromium-1223) — query “FLUX.2 dev image editing ComfyUI photoreal”:
- bing 1.7 s → 10 results but **junk** (Windows printer help); an earlier probe of the same URL looked relevant → flaky bot-SERP, not dependable as a tool.
- google 5.8 s → 0 results (wall/consent); startpage 0; ecosia 0; marginalia 0; lite-ddg 0.
- Firefox + Xvfb not worth building: `Xvfb`/`xvfb-run`/`firefox-esr` exist, but Playwright has **no** firefox driver cached and Bing already fails headless.

Key-backed APIs are the only class answering cleanly from this IP: `api.search.brave.com` 422 in 0.06 s, `api.tavily.com` 401 in 0.11 s, `google.serper.dev` 403 in 0.09 s, `api.bing.microsoft.com` 404 — all auth-level, so the network path is open.

Conclusion: a local browser cannot replace the search backend on this host (engine-side blocking). A key-backed search API, wrapped in a replacement tool that enforces its own always-resolving deadline, can.

## Installed 11-09 18:48 — `dsh-web-search-local`

Fourth freeze, same signature: session `8426baa7` (“Open-H3-Regenerate-2K”, workspace
`…/ai-production/comfyui-custom-plugins`) fired one `web_search` at **16:52:56** with 4
queries, four `web/deepseek-search-llm-request` records, then nothing — no `tool/result`,
no `step/end`, no `turn/end`; turn 71 stayed open 1 h 47 min with one user message queued
behind it. Since the 00:09 restart the built-in tool produced exactly two outcomes across
two calls: one HTTP 401 in 0.3 s, one permanent hang.

Installed in its place:

- `~/.dsh/custom-plugins/dsh-web-search-local/serp.py` — asks the sites’ own public APIs
  first (DuckDuckGo instant-answer, Wikipedia, GitHub, arXiv, Hugging Face, StackOverflow,
  npm), then a persistent local browser result page — **DuckDuckGo first** (html, lite,
  app) as requested, then bing/mojeek/ecosia/google — only when the APIs did not answer. A
  token-overlap score rejects bot SERPs (Bing was measured serving TELUS and printer pages
  for real queries).
- `~/.dsh/custom-plugins/dsh-web-search-local/index.js` — registers `web_search` with the
  same model-facing shape; spawns the helper, owns its own wall clock, SIGKILLs the child
  at `totalTimeoutMs` (default 20 s) and returns a text result anyway. `execute` always
  settles, so a search can no longer hold a turn open. A registration clash is logged, not
  fatal to boot.
- `~/.dsh/profiles/web/cordis.patch.yml` — `search: false` in all three `tool-web` groups
  (now lines 383, 506, 695) plus one `insert:` block for the plugin. Pre-change backup:
  `/tmp/codex/cordis.patch.yml.bak-1109-1748`.
- `~/.dsh/profiles/web/node_modules/@local/dsh-web-search-local` →
  `../../../../custom-plugins/dsh-web-search-local` (same link shape as `dsh-auto-continue`,
  no package.json entry needed).

Measured with the helper:

- direct sources: 6 relevant hits in **1.67 s** for one query, **1.99 s** through the tool;
  “HiDream-O1 image model ComfyUI open source” returned arXiv 2605.11061.
- scraping from this box on 11-09: `html.duckduckgo.com`, `lite.duckduckgo.com`, the
  duckduckgo.com app, bing, mojeek, ecosia, google → **0 results each**.
- Firefox path: firefox-esr 140.12 started headless; Marionette answered its protocol-3
  greeting on :2828 and the remote agent serves a WebSocket at `/session` on :9223, but the
  Marionette handshake message was never answered, so no Firefox driver is wired yet — the
  helper uses the cached Playwright chromium. `chrome --headless=new --dump-dom` hung past
  45 s and was killed.
- anti-freeze proof: helper replaced by a script sleeping 60 s → the tool settled in
  **4.0 s** with an error text and killed the child.

After the next host start, verify: run `web_search` anywhere, expect ~2 s; that session’s
`~/.dsh/storages/session_projcache/sessions/<id>.json` must show `pendingCalls: {}` and the
turn must close. Rollback: restore the backup patch file, delete the `@local/dsh-web-search-local`
symlink, and the plugin directory itself.

## Files touched during this diagnosis

- `/tmp/codex/nelare.jsonl` — decompressed copy of the frozen log (analysis scratch).
- `~/.dsh/custom-plugins/dsh-websearch-freeze-notes.md` — this file.
- 11-09: the four files listed in the section above (plugin + patch + symlink); no Comfy
  host, project workspace, or other session file was touched.

## Activation log 11-09 20:46-20:52 (boots 2, 3, 4)

- Boot 2 cleared the freeze of session-8426baa7: `pendingCalls {}`, queued message delivered,
  turn resumed; the session has been running normally since (tool calls settle in ~2 s).
- Failure 1: registration threw `cannot get property "tools" without inject` → fixed with
  `export const inject = ['tools']`. The try/catch kept the host booting (it only logged).
- Failure 2: the **director preset defines its own `tool-web`** inside
  `dsh-director/cordis.patch.yml` (installed: `profiles/web/node_modules/dsh-director/cordis.patch.yml`,
  source: `custom-plugins/dsh-director/cordis.patch.yml`), so the profile-level
  `search: false` never reached it and the session hit api.deepseek.com again at 20:48:10.
  `search: false` + the plugin entry were added to both copies; backups
  `/tmp/codex/dsh-director-{installed,source}.patch.bak-1109-2052`. Any future
  `pnpm add dsh-director@…` overwrites the installed copy — the source copy must keep this
  edit (it does).
- Failure 3: a host-level `- insert:` registers globally and preset tool lists do not pick
  it up; sessions were left with no search tool at all. The plugin is therefore registered
  beside every `tool-web` entry (3 in the profile patch + 1 in the director patch).
- Boot 4 (20:52:08, PID 1021548): stamp `dsh-web-search-local/last-load.txt` shows five
  `registered web_search` lines and no `FAILED` line; no registration complaint in the journal
  for that boot.
- Confirmed absent: no `web/deepseek-search-llm-request` record in any session log after
  20:50 — the DeepSeek search path is unreachable, which is also the freeze path.
- Behaviour re-confirmed through the installed link: 6 sources (arXiv 2605.11061) in ~2 s,
  and the wall-clock test still settles in 4.0 s with the child killed.

## Verified live 20:55 (boot 4, PID 1021548)

The tool swap is proven at the LLM-request level, not just at registration: in the
`request/header` events after this boot, both a **standard**-preset session (this diagnostic
one) and the **director**-preset session-8426baa7 advertise `web_search` with the local
description (“Search the web from this machine…”) and never the built-in one (“Returns an
optional summary answer”). Zero `web/deepseek-search-llm-request` records after the boot.
`last-load.txt` shows six successful registrations and no `FAILED` line. Verification
reminder deleted; the DeepSeek search path — and with it the only freeze path found — is gone.
