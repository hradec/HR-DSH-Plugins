# RECOVERY — if DSH won't boot after installing dsh-zoom-call

## First: try this yourself (30 seconds, no AI needed)

```bash
bash /BACKUP/home/rhradec/.dsh/custom-plugins/dsh-zoom-call/uninstall.sh
systemctl --user stop deepseek-harness.socket deepseek-harness.service
sleep 2; pgrep -f "dsh.*bin.js web" || echo "server down OK"
systemctl --user start deepseek-harness.socket deepseek-harness.service
sleep 4; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3081   # want 200
```

`uninstall.sh` restores `~/.dsh/profiles/web/package.json` from
`package.json.bak-zoom-call` (written by install.sh) and deletes the plugin
symlink. That reverts the install completely — the plugin itself never edits
anything else.

## If that doesn't fix it — paste this brief to minimax code

> **TASK: DeepSeek Harness (DSH) fails to start after a plugin install. Fix the boot, break nothing else.**
>
> Facts:
> - DSH serves http://127.0.0.1:3081 as a **socket-activated** systemd user unit.
>   To take it down you MUST `systemctl --user stop deepseek-harness.socket deepseek-harness.service`
>   (stopping only the service re-activates it in ~1 s). Restart: `systemctl --user start deepseek-harness.socket deepseek-harness.service`.
> - The ONLY change made was installing one plugin bundle into the web profile:
>   1. `~/.dsh/profiles/web/package.json` gained a dependency `@local/dsh-zoom-call` (`link:` spec) and a `"dsh-zoom-call"` entry in `dsh.profile.bundles` — backup at `~/.dsh/profiles/web/package.json.bak-zoom-call`.
>   2. symlink `~/.dsh/profiles/web/node_modules/@local/dsh-zoom-call` → `/BACKUP/home/rhradec/.dsh/custom-plugins/dsh-zoom-call`.
>   Nothing else was modified. No DSH core, config, session, or storage files were touched.
>
> Do, in order:
> 1. Capture the boot error: `journalctl --user -u deepseek-harness.service --since "-5 min" | tail -80`
> 2. Revert the install: restore the backup (`cp ~/.dsh/profiles/web/package.json.bak-zoom-call ~/.dsh/profiles/web/package.json`), remove the symlink (`rm -f ~/.dsh/profiles/web/node_modules/@local/dsh-zoom-call`).
> 3. Socket-first restart as above; verify HTTP 200 on 127.0.0.1:3081 and that other sessions' data is intact.
> 4. Only if boot still fails after a full revert: the cause is NOT this plugin — diagnose from the journal error and report it; do not improvise config edits.
>
> ABSOLUTE don'ts:
> - NEVER edit, re-compress, or delete anything under `~/.dsh/sessions/` or `~/.dsh/storages/` — session logs are multi-frame zstd where frame 1 must decompress to exactly one header line; any naive rewrite silently corrupts sessions.
> - Do not edit `~/.dsh/profiles/web/cordis.yml` or the profile's `cordis.patch.yml` — bundle registration lives only in `package.json`.
> - Do not run DSH by hand (no `node bin.js web`) while the systemd socket is armed — that steals the port.
> - Back up `~/.dsh/profiles/web/package.json` before any edit, even the revert.

## If the plugin itself is the error (journal names dsh-zoom-call)

Send minimax the journal stack trace plus: the plugin source is
`/BACKUP/home/rhradec/.dsh/custom-plugins/dsh-zoom-call/index.js` (host half,
zero npm deps, only `tools` hard-required; `agentTeams`/`agents`/`webServer`
are optional via `ctx.inject`) and `client.js` (browser half). A host-half
crash can only come from `apply()`; a client-half error never blocks boot —
it shows in the browser console instead. Fix the line; don't deregister the
bundle unless the fix fails.

## Safer test path (recommended before any restart)

```bash
bash install.sh                                   # edits + backup, harness untouched
systemctl --user stop deepseek-harness.socket deepseek-harness.service
systemctl --user start deepseek-harness.socket deepseek-harness.service
sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3081 \
  && journalctl --user -u deepseek-harness.service --since "-2 min" | grep -i -m5 "error\|dsh-zoom-call"
```

If the code is 200 and the journal grep is quiet, you're up; if not, run
`uninstall.sh` and repeat — the loop is fully reversible in under a minute.
