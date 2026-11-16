# Handoff — DSH session-tabs plugin

This session is the **continuation** of the `dsh tabs` conversation that ran in
the `rhradec` project (`/BACKUP/home/rhradec`). DSH has no native “move session”
action; this new session was created in this project instead so plugin work can
continue here with the project directory as its working directory.

## What the plugin is

Browser-style session tabs for the DSH Web GUI:

- one tab per opened Session at the top of the center column;
- click to switch, **×** or middle-click to close, drag to reorder, **+** for a
  new Session;
- running / waiting / unread status dots;
- tab order persisted in `localStorage` (`dsh-session-tabs.order.v1`);
- pure client plugin, no Host services or network access.

The source is the sibling directory `./dsh-session-tabs/` (moved here from
`/BACKUP/home/rhradec/dsh-session-tabs` together with the statusline and
Minimax importer projects).

## Current install state

The `web` profile loads the plugin as a selected bundle:

- `/home/rhradec/.dsh/profiles/web/package.json`:
  - dependency
    `"@local/dsh-session-tabs": "link:/BACKUP/home/rhradec/.dsh/custom-plugins/dsh-session-tabs"`;
  - `@local/dsh-session-tabs` is in `dsh.profile.bundles`;
- `node_modules/@local/dsh-session-tabs` links to this project;
- the plugin's own `cordis.patch.yml` inserts the Loader row.

The temporary manual `- insert:` row was removed from the profile patch after
the bundle entry was added, so there is exactly one Loader row.

## Verified in the live Web GUI

Headless Chromium checks against `http://127.0.0.1:3081` (auth cookie minted
locally, never printed):

- exactly one tab bar and one plugin style tag;
- header shifted from y=0 to y=34; Plugins page content starts below the strip;
- sidebar collapse/re-expand moves the strip 280↔56 px;
- right panel open leaves the strip ending exactly at the panel edge;
- right-panel fullscreen hides the strip and restores it on exit;
- modal dialogs mask the strip;
- open/switch, close-active/close-inactive, last-close-disabled, drag reorder,
  in-page reload persistence, 7-tab overflow, dark and light themes all pass;
- no new console errors (only the pre-existing account-profile warning and
  `/open-in-app/icon/filemanager` 404s).

## Files

- `client.js` — browser bundle: slot registration, tab strip, persistence,
  column measurement.
- `index.js` — no-op Host entry.
- `package.json` — manifest + `dsh.client` declaration.
- `cordis.patch.yml` — bundle patch with the Loader insert.
- `locale/en.json`, `icon.svg`, `README.md`.

## Suggested next steps

1. Read `dsh-session-tabs/README.md` and `client.js`; run `node --check` after
   edits.
2. Decide whether to keep the local tab-order persistence or move it to a Host
   setting.
3. Optional polish: edge fade for overflowing tabs, tab context menu (close
   others / close all), keyboard shortcuts (`Mod+1..9`), macOS/Windows desktop
   chrome handling, tests.
4. If publishing, remove `private: true`, add a license/version, and verify the
   `dsh.bundle.patch` install path on a clean profile.

## Notes / ceilings

- Web GUI only; macOS collapsed-sidebar inset uses a 160 px heuristic.
- The last tab cannot be closed into an empty/home state.
- Tabs opened in another window are added when this window selects them; order
  syncs through `localStorage`.
- Cross-full-browser-restart persistence was not proven in the headless harness
  (in-page reload is proven); a normal browser shutdown should flush it.
- No secrets or private credentials are stored in this project.
