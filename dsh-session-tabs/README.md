# dsh-session-tabs

Browser-style session tabs for the DeepSeek Harness Web GUI. Every Session you
open gets a tab at the top of the conversation area; click to switch, close
tabs, drag to reorder, and start a new Session from the **+** button.

Pure browser plugin: no Host services, no network access, no model-visible
effect. Navigation goes through the public `ctx.uiWorkspace.openSession` and
`ctx.uiWorkspace.startSession` methods.

## What it does

- One tab per opened Session. Tab order mirrors the sidebar's rendered Session
  order: Workspace grouping in the sidebar's current mode, its Order by setting
  (recency or manual), pinned rows first, and Ungrouped Sessions trailing.
- The active Session is highlighted; clicking another tab switches to it.
- The status icon is the shipped sidebar `StateDot` (`@deepseek-ai/dsh-client-ui-primitives`):
  an animated spinner while the Session runs, an amber dot while it waits for
  you, and a green dot when it finished unviewed — identical to the sidebar and
  with the same reduced-motion behavior.
- **×** closes a tab without deleting or stopping the Session. Closing the
  active tab activates its right neighbor (or its left neighbor at the end).
  The last remaining tab stays open.
- Middle-click a tab also closes it.
- Dragging a tab temporarily overrides that order; the next sidebar change
  restores the sidebar's order.
- **+** starts a new Session through the shipped New Session flow.
- Overflow scrolls horizontally (mouse wheel works over the strip); the active
  tab is scrolled into view.
- Blank Sessions are labeled **New Session**, matching the sidebar row.
- The persisted `localStorage` list remembers which tabs are open (and orders
  tabs the sidebar currently hides behind its row watermark, a folded group, or
  a collapsed sidebar). Archived or deleted Sessions are removed from the strip.

## Session colors

When the `dsh-session-colors` plugin is installed and active, each tab inherits
the color the sidebar shows for its Session. The color plugin owns the palette
and exposes it at runtime through `window.__dshSessionColors` (version 1,
`getTabTints(sessionId, workspaceId)`). The tabs plugin does not read the color
plugin's storage keys and holds no tint math of its own.

- an explicit Session color wins; the tab uses the row's idle/hover/active
  tints and underline color;
- if the Session has no explicit color but sits in a colored folder, the tab
  uses the same muted folder channels and tint steps;
- Sessions with neither stay neutral;
- while a status icon is visible, the background mirrors the sidebar: running
  brightens to the plugin's working tints (a business-theme fallback for an
  uncolored Session); waiting (amber) and finished-unread (green) pulse every
  1.8 s to a 42% dot-color tint, or a steady 20% tint with reduced motion;
- the color plugin announces changes (picker, clear, folder edit, another
  window, shared Host sync) and tabs re-read the runtime API immediately;
- with the color plugin — or its runtime API — absent, tabs render unchanged,
  so stale stored colors are ignored.

A page refresh is needed after either client bundle changes, because these are
pure browser plugins and need no Host restart.

## Layout

The strip is 34 px tall, fixed at the top of the center column:

- it starts at the sidebar's right edge and follows sidebar drag/collapse;
- it stops at the right panel's left edge, so the right panel keeps its own
  header controls;
- only the center column is padded down by the strip height — the sidebar and
  right panel are not moved;
- it hides while the right panel is in fullscreen mode;
- modal dialogs render above it.

It uses the shipped `--dsw-alias-*` theme tokens, so light and dark themes both
work without configuration.

## Install

This copy is already installed in the `web` profile:

- `~/.dsh/profiles/web/package.json` lists
  `"@local/dsh-session-tabs": "link:/BACKUP/home/rhradec/.dsh/custom-plugins/dsh-session-tabs"`;
- `~/.dsh/profiles/web/node_modules/@local/dsh-session-tabs` links to this
  directory;
- `~/.dsh/profiles/web/cordis.patch.yml` ends with the Loader row:

  ```yaml
  - insert:
      - id: dsh-session-tabs
        name: '@local/dsh-session-tabs'
        config: {}
  ```

With `patchReload: live`, the row applies without restarting the Host. A page
refresh is enough if the client bundle has not loaded yet.

For another profile, copy this directory, add the same dependency and patch
row, and refresh the Web UI. The package declares its browser bundle through
`dsh.client` in `package.json`, so no build step is required.

## Uninstall

Remove the `- insert:` block from the profile's `cordis.patch.yml`, remove the
dependency from `package.json`, and delete the
`node_modules/@local/dsh-session-tabs` link. The Host row is a no-op, so the
client bundle disappears after the next recomposition/refresh. The plugin keeps
no data besides the `dsh-session-tabs.order.v1` localStorage key, which can be
removed independently.

## Files

| File | Role |
| --- | --- |
| `client.js` | Browser bundle: slot registration, tab strip, persistence, layout measurement. |
| `index.js` | No-op Host entry; its existence makes the profile row declare the client bundle. |
| `cordis.patch.yml` | Bundle patch that inserts the Host row. |
| `package.json` | Manifest, `dsh.client` declaration, exports. |
| `locale/en.json` | Plugin metadata for the Plugins surfaces. |
| `icon.svg` | Plugin icon. |

## Limitations

- Web GUI only.
- The macOS collapsed-sidebar `shell.leading` controls use a 160 px left inset
  heuristic; the strip may need adjustment on unusual desktop chrome.
- A Session opened in another browser window is added when this window selects
  it; open-tab membership syncs through the shared `localStorage` key, while
  display order is re-derived from the sidebar.
- Sessions the sidebar hides (row watermark, folded group, collapsed sidebar)
  cannot supply a position; they stay after the ordered tabs in their previous
  fallback order until the sidebar reveals them.
- Closing all tabs into an empty state is not supported: at least one tab stays
  so the current Session remains reachable.
- The status icon reports the live Session status that the shipped sidebar uses;
  it does not add notification history.
- Inherited Session colors depend on the color plugin's shared Host copy and
  sync; a different DSH Host keeps its own colors.
- A folder tint reaches a tab only while that Session is grouped in the colored
  Workspace; moving the Session elsewhere removes the inherited tint.
