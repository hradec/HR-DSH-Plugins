/**
 * dsh-session-mover — browser half.
 *
 * Drag a session row from the sidebar onto a Workspace (folder) header to move
 * it there. The Host performs the actual move (full-history copy + archive of
 * the original); this half only provides the drag affordance, validates the
 * drop target, and reports the outcome.
 *
 * Public surfaces used:
 *   - the sidebar tree's own `data-row-key` markers (`session:<id>`,
 *     `workspace:<id>`) and the shipped native drag events;
 *   - `ctx.workspaces.list` for Workspace membership and labels;
 *   - `ctx.connection.rpc.call('/api', 'sessionMover/move', …)` for the move;
 *   - `ctx.uiWorkspace.openSession(id)` to reveal the new copy.
 *
 * No Host data is edited here and no client-side grouping override exists: the
 * copy is a real Workspace member after the Host commits it.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-mover',
  factory() {
    const NAME = 'dsh-session-mover'
    const DRAG_MIME = 'application/x-dsh-session-mover'

    const CSS = `
html[data-dsh-mover-dragging] [data-dsh-mover-target]{
  outline:1px dashed var(--dsw-alias-state-business-primary,#4d6bfe);
  outline-offset:-1px;
  border-radius:var(--dsw-radius-md,6px);
}
html[data-dsh-mover-dragging] [data-dsh-mover-target][data-dsh-mover-over]{
  outline:1.5px solid var(--dsw-alias-state-business-primary,#4d6bfe);
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055));
}
html[data-dsh-mover-dragging] [data-row-key^='session:']{cursor:grabbing}
.dsm-toast{
  position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
  z-index:2147483000;max-width:min(560px,calc(100vw - 32px));
  box-sizing:border-box;padding:9px 14px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#24272b);
  color:var(--dsw-alias-label-primary,#f5f6f7);
  border:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  box-shadow:0 8px 28px rgba(0,0,0,.28);
  font:13px/19px inherit;white-space:pre-wrap;pointer-events:none;
  opacity:0;transition:opacity 120ms ease,transform 120ms ease;
}
.dsm-toast[data-shown]{opacity:1;transform:translate(-50%,-4px)}
.dsm-toast[data-kind='error']{border-color:var(--dsw-alias-state-error-primary,#e05555)}
`

    /**
     * Trim a path to its final segment for labels.
     * @param {string} path - Workspace directory.
     * @returns {string} basename.
     */
    function basename(path) {
      const parts = String(path).split(/[\\/]/).filter(Boolean)
      return parts.length === 0 ? String(path) : parts[parts.length - 1]
    }

    /**
     * Read the raw Workspace membership snapshot.
     * @param {object} ctx - client root context.
     * @returns {{items: readonly object[]}} current projection.
     */
    function snapshot(ctx) {
      return ctx.workspaces.list.getSnapshot()
    }

    /**
     * Find the Workspace that owns a session in the sidebar projection.
     * @param {object} ctx - client root context.
     * @param {string} sessionId - session identity.
     * @returns {string} owning Workspace id, or '' for ungrouped.
     */
    function ownerOf(ctx, sessionId) {
      const owner = snapshot(ctx).items.find((workspace) => workspace.sessionIds.includes(sessionId))
      return owner === undefined ? '' : owner.workspaceId
    }

    /**
     * Display label for one Workspace id.
     * @param {object} ctx - client root context.
     * @param {string} workspaceId - target Workspace.
     * @returns {string} label.
     */
    function labelOf(ctx, workspaceId) {
      const workspace = snapshot(ctx).items.find((item) => item.workspaceId === workspaceId)
      if (workspace === undefined) return workspaceId
      return workspace.title || basename(workspace.path)
    }

    /**
     * Human message for a Host failure.
     * @param {{code: string, message: string}} error - Remote failure.
     * @returns {string} toast text.
     */
    function failureText(error) {
      switch (error.code) {
        case 'session-mover/source-active':
          return 'Still running — stop this session, then drag it again.'
        case 'session-mover/empty':
          return 'This session has no history to copy.'
        case 'session-mover/target-missing':
        case 'session-mover/target-not-found':
          return 'That folder is no longer available.'
        case 'session-mover/already-there':
          return 'This session is already in that folder.'
        case 'session-mover/not-found':
          return 'The session was not found.'
        case 'session-mover/attach-failed':
          return 'The copy was created but could not be filed under that folder.'
        default:
          return `Move failed: ${error.message}`
      }
    }

    /**
     * Install the drag/drop behavior for this browser page.
     * @param {object} ctx - client root context.
     * @returns {() => void} disposer.
     */
    function install(ctx) {
      /** @type {{sessionId: string, ownerKey: string, targetKey: string}} */
      const state = { sessionId: '', ownerKey: '', targetKey: '' }
      let pending = false
      let toast = null
      let toastTimer = 0
      let toastHide = 0

      /** Show the plugin's single toast line. */
      function showToast(text, kind = 'info') {
        if (toast === null) {
          toast = document.createElement('div')
          toast.className = 'dsm-toast'
          toast.setAttribute('role', 'status')
          document.body.appendChild(toast)
        }
        clearTimeout(toastTimer)
        clearTimeout(toastHide)
        toast.dataset.kind = kind
        toast.textContent = text
        requestAnimationFrame(() => toast?.setAttribute('data-shown', ''))
        toastTimer = window.setTimeout(() => {
          toast?.removeAttribute('data-shown')
          toastHide = window.setTimeout(() => {
            toast?.remove()
            toast = null
          }, 160)
        }, kind === 'error' ? 5200 : 3200)
      }

      /** Remove drag affordances from every row. */
      function clearTargets() {
        document.documentElement.removeAttribute('data-dsh-mover-dragging')
        for (const row of document.querySelectorAll('[data-dsh-mover-target]')) {
          row.removeAttribute('data-dsh-mover-target')
          row.removeAttribute('data-dsh-mover-over')
        }
      }

      /** Mark every real Workspace header that is a valid drop target. */
      function markTargets() {
        document.documentElement.setAttribute('data-dsh-mover-dragging', '')
        for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
          const key = row.getAttribute('data-row-key').slice('workspace:'.length)
          if (key.length === 0 || key === state.ownerKey) continue
          row.setAttribute('data-dsh-mover-target', '')
        }
      }

      /**
       * The eligible target Workspace header under a pointer event.
       * @param {DragEvent} event - drag event.
       * @returns {HTMLElement | null} header row or null.
       */
      function targetRowOf(event) {
        const node = event.target
        if (!(node instanceof Element)) return null
        const row = node.closest('[data-row-key^="workspace:"]')
        if (row === null || !row.hasAttribute('data-dsh-mover-target')) return null
        return row
      }

      /** Reset one drag's state. */
      function reset() {
        state.sessionId = ''
        state.ownerKey = ''
        state.targetKey = ''
        clearTargets()
      }

      /**
       * Enable native dragging on rows the shipped browser leaves static.
       * Rows are only natively draggable in manual order mode; the plugin works
       * in every order mode by making the row draggable right before the drag
       * starts. Blank New Session and archived rows are excluded.
       */
      function onPointerDown(event) {
        if (event.button !== 0) return
        const node = event.target
        if (!(node instanceof Element)) return
        const row = node.closest('[data-row-key^="session:"]')
        if (row === null) return
        if (row.hasAttribute('aria-description')) return // archived
        if (row.querySelector('[class*="rowActions"]') === null) return // blank New Session
        row.setAttribute('draggable', 'true')
      }

      /** Begin tracking a session-row drag. */
      function onDragStart(event) {
        const node = event.target
        if (!(node instanceof Element)) return
        const row = node.closest('[data-row-key^="session:"]')
        if (row === null) return
        if (row.getAttribute('draggable') !== 'true') return
        if (row.hasAttribute('aria-description')) return
        if (row.querySelector('[class*="rowActions"]') === null) return
        const sessionId = row.getAttribute('data-row-key').slice('session:'.length)
        state.sessionId = sessionId
        state.ownerKey = ownerOf(ctx, sessionId)
        state.targetKey = ''
        if (event.dataTransfer !== null) {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(DRAG_MIME, sessionId)
          event.dataTransfer.setData('text/plain', sessionId)
        }
        markTargets()
      }

      /** Highlight the folder under the pointer. */
      function onDragOver(event) {
        if (state.sessionId === '') return
        const row = targetRowOf(event)
        if (row === null) {
          state.targetKey = ''
          for (const other of document.querySelectorAll('[data-dsh-mover-over]')) other.removeAttribute('data-dsh-mover-over')
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
        const key = row.getAttribute('data-row-key').slice('workspace:'.length)
        if (state.targetKey !== key) {
          state.targetKey = key
          for (const other of document.querySelectorAll('[data-dsh-mover-over]')) other.removeAttribute('data-dsh-mover-over')
          row.setAttribute('data-dsh-mover-over', '')
        }
      }

      /** Commit the drop: ask the Host to move the session. */
      function onDrop(event) {
        if (state.sessionId === '') return
        const row = targetRowOf(event)
        if (row === null) return
        event.preventDefault()
        event.stopPropagation()
        const sessionId = state.sessionId
        const targetWorkspaceId = row.getAttribute('data-row-key').slice('workspace:'.length)
        reset()
        void move(sessionId, targetWorkspaceId)
      }

      /** Drop outside a target: clear the affordances. */
      function onDragEnd() {
        if (state.sessionId === '') return
        reset()
      }

      /**
       * Ask the Host to move one session and report the result.
       * @param {string} sessionId - source session.
       * @param {string} targetWorkspaceId - target folder.
       */
      async function move(sessionId, targetWorkspaceId) {
        if (pending) return
        pending = true
        const label = labelOf(ctx, targetWorkspaceId)
        showToast(`Moving to ${label}…`)
        try {
          const result = await ctx.connection.rpc.call('/api', 'sessionMover/move', {
            args: { sessionId, targetWorkspaceId },
          })
          if (!result.ok) {
            showToast(failureText(result.error), 'error')
            return
          }
          showToast(`Moved to ${label} · original archived`)
          try {
            ctx.uiWorkspace.openSession(result.value.sessionId)
          } catch (error) {
            console.warn('dsh-session-mover: could not open the copy:', error)
          }
        } catch (error) {
          showToast(`Move failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
          pending = false
        }
      }

      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('dragover', onDragOver)
      document.addEventListener('drop', onDrop)
      document.addEventListener('dragend', onDragEnd, true)

      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('dragover', onDragOver)
        document.removeEventListener('drop', onDrop)
        document.removeEventListener('dragend', onDragEnd, true)
        clearTimeout(toastTimer)
        clearTimeout(toastHide)
        toast?.remove()
        toast = null
        clearTargets()
      }
    }

    /**
     * Client plugin body.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = NAME
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, `${NAME}: styles`)
      ctx.effect(() => install(ctx), `${NAME}: drag and drop`)
    }

    return {
      inject: ['connection', 'uiWorkspace', 'workspaces'],
      apply,
    }
  },
})
