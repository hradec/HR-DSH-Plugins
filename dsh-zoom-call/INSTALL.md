# Installing dsh-zoom-call (do this when you're back at the machine)

The plugin is **not registered yet** — nothing here has touched your running
harness. That is deliberate: a bad plugin entry can block DSH boot, so keep
every step reversible and run the restart yourself.

## Install

```bash
bash /BACKUP/home/rhradec/.dsh/custom-plugins/dsh-zoom-call/install.sh
```

It only does three things, each backed up:

1. copies `~/.dsh/profiles/web/package.json` → `package.json.bak-zoom-call`
2. adds the `@local/dsh-zoom-call` link dependency + bundle entry to it
3. symlinks `node_modules/@local/dsh-zoom-call` (no npm/network needed —
   the plugin has zero dependencies)

## Restart (socket-first — plain stop will NOT take the harness down)

```bash
systemctl --user stop deepseek-harness.socket deepseek-harness.service
pgrep -f "dsh.*bin.js web" && echo "still alive — stop investigating, do not proceed" 
systemctl --user start deepseek-harness.socket deepseek-harness.service
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3081   # expect 200
```

## Verify

1. Open a session in a project folder → the header shows a **🎥** button.
2. Click it: five film-crew members listed, all "off call" (the workspace
   `.zoom-call.cast.json` was seeded).
3. Ask the agent: *"zoom_call list, then assemble the screenwriter"* — it
   spawns a teammate. Press **▶ Call in all** for the rest.
4. Type in the panel 💬 to one member; a colored bubble appears in the chat
   when they answer the Lead.
5. The native **Agent Teams** header panel still shows the same roster;
   clicking a member opens their own conversation (now tinted their color).

## If DSH refuses to boot after installing

Start with [RECOVERY.md](RECOVERY.md): a 30-second self-fix and a
copy-paste brief for an external coding agent (minimax code) that states
exactly what was changed, how to revert it, and which files are off-limits.

```bash
bash /BACKUP/home/rhradec/.dsh/custom-plugins/dsh-zoom-call/uninstall.sh
# then repeat the socket-first restart
```

`uninstall.sh` restores `package.json` from the backup and removes the
symlink. The plugin's own failure modes are guarded: with Agent Teams absent
or the web server not mounted, it registers nothing and stays inert.
