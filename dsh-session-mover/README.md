# dsh-session-mover

Drag a session row in the DSH Web sidebar onto another folder header to move
it there.

## What a "move" is in DSH

A sidebar folder is a Workspace: a registered directory. A session's Workspace
membership is derived from the directory recorded in its immutable session
header, and DSH exposes no API to rewrite that header. The plugin therefore
implements the move the only faithful way available:

1. the source session is archived (a running session is refused before anything
   is copied, so work is never stopped silently);
2. its complete event history is copied into a new session whose recorded
   directory is the target folder, using the source's Agent preset and model
   selection;
3. the copy is attached to the target Workspace and opened in the main view.

The original remains in the archive (visible through **View options → All
conversations** and restorable with Unarchive), so nothing is deleted. The copy
is a real Workspace member: it survives restarts, appears in search under the
target folder, and continues the conversation with the full history.

## Usage

- In either grouping mode (**WorkSpace** or **Workspace Tree**), drag a session
  row and drop it on a folder header. Eligible headers are outlined while
  dragging; the hovered one is highlighted.
- Dropping on the session's current folder, on an archived row, or on the blank
  New Session row does nothing.
- Archived sessions cannot be dragged (restore them first).
- If the session is running, the Host refuses the move and a toast asks you to
  stop it first.

Works only in the sidebar's grouped views; the flat **In one list** view has no
folder headers.

## Install

The `web` profile loads it as a bundle:

```json
{
  "dependencies": { "@local/dsh-session-mover": "link:/BACKUP/home/rhradec/.dsh/custom-plugins/dsh-session-mover" },
  "dsh": { "profile": { "bundles": ["…", "@local/dsh-session-mover"] } }
}
```

plus `node_modules/@local/dsh-session-mover` → this directory. The plugin's
`cordis.patch.yml` inserts its single Loader row. A page refresh is needed after
the Host loads the bundle.

## Implementation notes

- Host: `index.js` exposes `sessionMover/move(sessionId, targetWorkspaceId)` as
  an SRC-mode Typert Remote. It uses `buildForkSeed` for an exact inclusive
  prefix through the source's last event; open turns are closed with forked
  closers, exactly like the shipped Fork action.
- The copy's preset/model composition reuses the API Session controller's
  runtime helper (`ctx.sessionController.agents`), so it matches a shipped fork.
  If a future Host drops that helper, the service refuses cleanly with
  `session-mover/unsupported` instead of creating a half-configured copy.
- The browser half only provides native drag/drop, target validation, a toast,
  and navigation to the new session. It also makes rows draggable in the
  **Last updated** order mode, where the shipped browser has no drag wiring.
- Rollback: any failure after archiving unarchives the source; an attach failure
  also disposes and archives the orphan copy.

## Known limits

- The move is a copy + archive, so the copy has a new session id; links to the
  old id (terminal focus, logs) do not follow it.
- Running/scheduled work is not migrated and a running turn blocks the move.
- The copy inherits the source history up to the move instant; messages sent
  after the archive are only in the archived original.
- SRC-mode Remote dispatch is DSH's development fallback for endpoints without
  generated strict descriptors; it is used here rather than code-generating a
  contract for a local plugin.
