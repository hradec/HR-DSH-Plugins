/**
 * dsh-session-tabs — browser-style session tab strip for the DSH Web GUI.
 *
 * Pure client plugin: it registers one occupant of the root-scoped
 * `shell.overlay` slot, renders a fixed strip above the conversation column,
 * and reserves its height by padding that column's top edge. The sidebar and
 * right column are measured live, so dragging or collapsing the sidebar and
 * opening the right panel keep the strip aligned.
 *
 * Navigation uses only public surfaces:
 *   - `ctx.uiWorkspace.openSession(id)` and `ctx.uiWorkspace.startSession()`
 *   - root standard props `useSessions`, `useSessionStatus`, `useWorkspaces`
 *
 * Tabs are the sessions the user has opened in this browser. Their display
 * order follows the sidebar's rendered Session-row order; the persisted list
 * only records membership (and orders tabs the sidebar currently hides).
 * Dragging a tab is a temporary override until the sidebar order changes.
 * The active tab is derived from the main-view Session retention count
 * (`retainedBy.mainView`), the same fact the shipped Workspace browser uses
 * for its selected row.
 *
 * When the optional dsh-session-colors plugin is active, each tab inherits its
 * Session's sidebar color. The color plugin owns the tint values and exposes
 * them at runtime through `window.__dshSessionColors.getTabTints(...)`; an
 * explicit Session color wins, otherwise the muted folder color is used. With
 * the plugin (or its API) absent, tabs render unchanged.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-tabs',
  factory(require) {
    const React = require('react')
    const { StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const BAR_HEIGHT = 34
    const STORAGE_KEY = 'dsh-session-tabs.order.v1'
    const COLORS_EVENT = 'dsh-session-colors:change'
    const RUNTIME_API = '__dshSessionColors'

    const CSS = `
.dst-bar{
  position:fixed;top:0;right:0;height:${BAR_HEIGHT}px;box-sizing:border-box;z-index:40;
  display:flex;align-items:center;gap:6px;padding:0 8px;
  background:var(--dsw-alias-bg-base,#fff);
  border-bottom:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l1,rgba(0,0,0,.1)));
  pointer-events:auto;color:var(--dsw-alias-label-secondary,#61666b);
  font-size:13px;line-height:20px;font-family:inherit;
  -webkit-app-region:no-drag;
}
html[data-platform='darwin'] .dst-bar{background:var(--dsw-alias-bg-base,#fff)}
html[data-windows-titlebar] .dst-bar{top:var(--dsh-windows-titlebar-height,40px)}
.dst-scroll{
  flex:1 1 auto;min-width:0;height:100%;display:flex;align-items:center;gap:2px;
  overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-x:contain;
}
.dst-scroll::-webkit-scrollbar{display:none}
.dst-tab{
  position:relative;display:flex;align-items:center;gap:6px;flex:0 0 auto;
  height:26px;min-width:104px;max-width:220px;box-sizing:border-box;
  padding:0 3px 0 9px;border-radius:7px;cursor:pointer;user-select:none;
  color:var(--dsw-alias-label-secondary,#61666b);outline:none;white-space:nowrap;
}
.dst-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055));color:var(--dsw-alias-label-primary,#111)}
.dst-tab:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4d6bfe)}
.dst-tab[data-active]{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)));color:var(--dsw-alias-label-primary,#111);box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary,#4d6bfe)}
.dst-tab[data-active]:focus-visible{box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary,#4d6bfe),0 0 0 2px var(--dsw-alias-state-business-primary,#4d6bfe)}
.dst-tab[data-session-color]{background-color:var(--dst-bg)}
.dst-tab[data-session-color]:hover{background-color:var(--dst-hover)}
.dst-tab[data-session-color][data-active]{background-color:var(--dst-selected);box-shadow:inset 0 -2px 0 var(--dst-edge)}
.dst-tab[data-session-color][data-active]:focus-visible{box-shadow:inset 0 -2px 0 var(--dst-edge),0 0 0 2px var(--dsw-alias-state-business-primary,#4d6bfe)}
.dst-tab[data-tab-status]{background-color:var(--dst-bg,transparent)}
.dst-tab[data-tab-status]:hover{background-color:var(--dst-hover,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055)))}
.dst-tab[data-tab-status][data-active]{background-color:var(--dst-selected,var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))));box-shadow:inset 0 -2px 0 var(--dst-edge,var(--dsw-alias-state-business-primary,#4d6bfe))}
.dst-tab[data-tab-status='warning'],.dst-tab[data-tab-status='done']{
  --dst-rest-bg:var(--dst-bg,transparent);
  --dst-rest-hover:var(--dst-hover,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055)));
  --dst-rest-selected:var(--dst-selected,var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))));
  animation:dst-status-oscillate 1.8s ease-in-out infinite;
  background-color:var(--dst-rest-bg);
}
.dst-tab[data-tab-status='warning']:hover,.dst-tab[data-tab-status='done']:hover{--dst-rest-bg:var(--dst-rest-hover)}
.dst-tab[data-tab-status='warning'][data-active],.dst-tab[data-tab-status='done'][data-active]{--dst-rest-bg:var(--dst-rest-selected)}
.dst-tab[data-tab-status='warning']{--dst-status-peak:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a43c) 42%,transparent)}
.dst-tab[data-tab-status='done']{--dst-status-peak:color-mix(in srgb,var(--dsw-alias-state-success-primary,#35a66f) 42%,transparent)}
@keyframes dst-status-oscillate{0%,100%{background-color:var(--dst-rest-bg)}50%{background-color:var(--dst-status-peak)}}
@media (prefers-reduced-motion:reduce){
  .dst-tab[data-tab-status='warning'],.dst-tab[data-tab-status='done']{animation:none}
  .dst-tab[data-tab-status='warning']{background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a43c) 20%,transparent)}
  .dst-tab[data-tab-status='done']{background-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#35a66f) 20%,transparent)}
}
.dst-tab[data-dragging]{opacity:.45}
.dst-tab[data-drop='before']::before,.dst-tab[data-drop='after']::after{
  content:'';position:absolute;top:3px;bottom:3px;width:2px;border-radius:2px;
  background:var(--dsw-alias-state-business-primary,#4d6bfe);
}
.dst-tab[data-drop='before']::before{left:-2px}
.dst-tab[data-drop='after']::after{right:-2px}
.dst-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dst-close{
  flex:none;width:18px;height:18px;padding:0;border:none;border-radius:5px;
  display:grid;place-items:center;background:transparent;color:inherit;cursor:pointer;
  opacity:0;transition:opacity 120ms ease,background 120ms ease;outline:none;
}
.dst-tab:hover .dst-close,.dst-tab[data-active] .dst-close,.dst-tab:focus-within .dst-close{opacity:.62}
.dst-close:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08))}
.dst-close:focus-visible{opacity:1;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4d6bfe)}
.dst-close:disabled{cursor:default;opacity:.18}
.dst-tab:hover .dst-close:disabled{opacity:.18}
.dst-new{
  flex:none;width:26px;height:26px;padding:0;border:none;border-radius:7px;
  display:grid;place-items:center;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#61666b);outline:none;
}
.dst-new:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.dst-new:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4d6bfe)}
.dst-empty{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,#8a8f95);padding-left:4px;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (hover:none){.dst-close{opacity:.62}}
`

    const EMPTY = Object.freeze([])

    /** X glyph used by each tab's close control. */
    function CloseIcon() {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }

    /** Plus glyph for the New session action. */
    function PlusIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M8 3v10M3 8h10' }))
    }

    /** True when both arrays contain the same ids in the same order. */
    function sameOrder(left, right) {
      if (left === right) return true
      if (left.length !== right.length) return false
      for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false
      return true
    }

    /** Read the persisted open-tab list, tolerating absent or corrupt storage. */
    function readOrder() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const seen = new Set()
        const result = []
        for (const id of parsed) {
          if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
          seen.add(id)
          result.push(id)
        }
        return result
      } catch {
        return []
      }
    }

    /**
     * Persist the open-tab list. The array only records which tabs are open
     * (plus the fallback order for Sessions the sidebar hides); the visible
     * order is derived from the sidebar.
     */
    function writeOrder(order) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
      } catch {
        /* private mode or quota: tabs still work for this page session */
      }
    }

    /**
     * Read the final tab tint strings from the color plugin's runtime API.
     * No API means the plugin is absent (or an older build): tabs stay neutral.
     */
    function readTabTints(sessionId, workspaceId) {
      const api = typeof window === 'undefined' ? undefined : window[RUNTIME_API]
      if (api === undefined || typeof api.getTabTints !== 'function') return undefined
      try {
        return api.getTabTints(sessionId, workspaceId)
      } catch {
        return undefined
      }
    }

    /** Theme business tint for a running tab with no stored color. */
    function businessTint(alpha) {
      const percent = Math.round(alpha * 100)
      return `color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) ${percent}%,transparent)`
    }

    /** Sidebar status class for one tab dot kind. */
    function tabStatusOf(kind) {
      if (kind === 'running') return 'ongoing'
      if (kind === 'pending') return 'warning'
      if (kind === 'done') return 'done'
      return undefined
    }

    /**
     * One tab's color layers: the color plugin returns the base tints and the
     * brighter working tints; warning/done tabs let the CSS animation pulse
     * towards the dot color. With no owner colors, a running tab uses the
     * theme's business tint.
     */
    function tabDecoration(statusKind, tints) {
      if (statusKind === 'ongoing') {
        if (tints === undefined) {
          return {
            idle: businessTint(0.26),
            hover: businessTint(0.34),
            selected: businessTint(0.42),
            edge: 'var(--dsw-alias-state-business-primary,#4d6bfe)',
          }
        }
        return {
          idle: tints.working.idle,
          hover: tints.working.hover,
          selected: tints.working.selected,
          edge: tints.base.edge,
        }
      }
      return tints === undefined ? undefined : {
        idle: tints.base.idle,
        hover: tints.base.hover,
        selected: tints.base.selected,
        edge: tints.base.edge,
      }
    }

    /**
     * Current main-view Session: the one row carrying a main-view reference.
     * This is the same retention fact the shipped Workspace browser reads.
     */
    function currentSessionId(list) {
      if (list === undefined || list.byId === undefined) return undefined
      for (const row of Object.values(list.byId)) {
        if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return row.id
      }
      return undefined
    }

    /** Map one Session's live status to the tab dot kind. */
    function dotState(status, row) {
      if (status?.pendingInteraction !== undefined) return 'pending'
      if (status?.running === true || row?.running === true) return 'running'
      if (status?.completionUnread === true) return 'done'
      return undefined
    }

    /** Label read by the status dot's tooltip and accessible description. */
    function dotLabel(kind) {
      if (kind === 'pending') return 'Waiting for you'
      if (kind === 'running') return 'Running'
      if (kind === 'done') return 'Finished, not viewed yet'
      return undefined
    }

    /**
     * Strip left offset: the sidebar column's width, with the macOS desktop
     * clearance while that column is hidden.
     */
    function stripLeft(insetLeft) {
      const darwin = typeof document !== 'undefined'
        && document.documentElement.getAttribute('data-platform') === 'darwin'
      return darwin && insetLeft < 100 ? 160 : insetLeft
    }

    /**
     * The tab strip. Standard props come from the slot outlet; the two
     * navigation callbacks are supplied by `apply` from `ctx.uiWorkspace`.
     */
    function SessionTabs(props) {
      const {
        useSessions, useSessionStatus, useWorkspaces,
        openSession, startSession,
      } = props

      const list = useSessions((state) => state)
      const statuses = useSessionStatus((state) => state)
      const archivedSource = useWorkspaces((state) => state.archivedSessionIds)
      const archived = Array.isArray(archivedSource) ? archivedSource : EMPTY
      const workspaceItems = useWorkspaces((state) => state.items)
      const workspaceBySession = Object.create(null)
      for (const view of Array.isArray(workspaceItems) ? workspaceItems : EMPTY) {
        for (const id of view.sessionIds ?? EMPTY) workspaceBySession[id] = view.workspaceId
      }

      const byId = list?.byId ?? {}
      const current = currentSessionId(list)

      const [order, setOrderState] = React.useState(() => {
        const saved = readOrder()
        if (saved.length > 0) return saved
        return current === undefined ? [] : [current]
      })
      const [dragId, setDragId] = React.useState(null)
      const [drop, setDrop] = React.useState(null)
      const [dragOrder, setDragOrder] = React.useState(null)
      const [sidebarOrder, setSidebarOrder] = React.useState(EMPTY)
      const [insets, setInsets] = React.useState({ left: 0, right: 0 })
      // Bumped when the optional color plugin announces a color change.
      const [, setColorRevision] = React.useState(0)

      const barRef = React.useRef(null)
      const tabRefs = React.useRef({})

      const setOrder = (updater) => {
        setOrderState((previous) => {
          const next = typeof updater === 'function' ? updater(previous) : updater
          return sameOrder(previous, next) ? previous : next
        })
      }

      // A newly selected Session joins the strip once, at the end.
      React.useEffect(() => {
        if (current === undefined) return
        setOrder((previous) => previous.includes(current) ? previous : previous.concat(current))
      }, [current])

      // Archived Sessions cannot be opened; drop their tabs.
      const archivedKey = archived.join('\u0000')
      React.useEffect(() => {
        if (archived.length === 0) return
        const dead = new Set(archived)
        setOrder((previous) => previous.filter((id) => !dead.has(id)))
      }, [archivedKey])

      // Once the catalog is ready, forget ids that no longer exist. The
      // current Session is kept even if its row arrives a frame later.
      React.useEffect(() => {
        if (list?.phase !== 'ready') return
        setOrder((previous) => previous.filter((id) => id === current || byId[id] !== undefined))
      }, [list?.phase, byId, current])

      // Persist the tab order for the next page load. The first effect run is
      // the hydrated state from storage (or the single current Session), and
      // writing it would let a freshly opened page clobber a newer order that
      // another window already saved; only changes after hydration are written.
      const persisted = React.useRef(false)
      React.useEffect(() => {
        if (!persisted.current) {
          persisted.current = true
          return
        }
        writeOrder(order)
      }, [order])

      // Follow another DSH window in the same browser.
      React.useEffect(() => {
        const onStorage = (event) => {
          if (event.key !== STORAGE_KEY || event.newValue === null) return
          const next = readOrder()
          if (next.length > 0) setOrder(next)
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, [])

      // A tab drag only overrides the sidebar order until the sidebar changes.
      React.useEffect(() => {
        setDragOrder(null)
      }, [sidebarOrder])

      // Re-read the color plugin's runtime tints whenever it announces a
      // change (picker, clear, folder edit, cross-window/shared sync).
      React.useEffect(() => {
        const refresh = () => setColorRevision((revision) => revision + 1)
        window.addEventListener(COLORS_EVENT, refresh)
        return () => window.removeEventListener(COLORS_EVENT, refresh)
      }, [])

      // Keep the active tab inside the scrollport.
      React.useEffect(() => {
        const bar = barRef.current
        const element = current === undefined ? undefined : tabRefs.current[current]
        if (bar === null || element === undefined) return
        const left = element.offsetLeft
        const right = left + element.offsetWidth
        if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left - 8)
        else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 8
      }, [current, order, sidebarOrder, dragOrder])

      // Horizontal wheel scrolling without also scrolling the page.
      React.useEffect(() => {
        const bar = barRef.current
        if (bar === null) return
        const onWheel = (event) => {
          if (event.deltaY === 0 || bar.scrollWidth <= bar.clientWidth) return
          event.preventDefault()
          bar.scrollLeft += event.deltaY
        }
        bar.addEventListener('wheel', onWheel, { passive: false })
        return () => bar.removeEventListener('wheel', onWheel)
      }, [])

      // Align the strip with the center column and reserve its height there.
      // The sidebar and right column keep their own geometry untouched.
      React.useLayoutEffect(() => {
        if (typeof document === 'undefined') return undefined
        const overlay = document.querySelector('[data-shell-overlay]')
        const frame = overlay?.parentElement
        if (frame === null || frame === undefined) return undefined

        const rightbar = frame.querySelector('[data-rightbar-col]')
        const center = rightbar?.previousElementSibling ?? frame.children[1]
        const sidebar = center?.previousElementSibling ?? frame.children[0]
        if (center === null || center === undefined || sidebar === null || sidebar === undefined) return undefined

        const previousPadding = center.style.paddingTop
        center.style.paddingTop = `${BAR_HEIGHT}px`

        // The right panel (normal AND fullscreen) is a position:absolute sheet
        // pinned at the column top; park it under the strip so the tabs span
        // the full width and never lose space to the panel header (user:
        // "when NOT IN FULLSCREEN, it's still covering the tabs"). The hashed
        // CSS-module class prefix is matched by suffix.
        let parkedPanel = null
        const findParkedPanel = () => {
          if (rightbar === null || rightbar === undefined) return null
          for (const node of rightbar.querySelectorAll('[class]')) {
            const tokens = typeof node.className === 'string' ? node.className.split(' ') : []
            if (tokens.some((token) => token.endsWith('_panel'))) return node
          }
          return null
        }

        const update = () => {
          const fullscreen = frame.hasAttribute('data-rightbar-fullscreen')
          if (parkedPanel === null || !parkedPanel.isConnected) parkedPanel = findParkedPanel()
          if (parkedPanel !== null) parkedPanel.style.top = `${BAR_HEIGHT}px`
          const sidebarWidth = fullscreen ? 0 : sidebar.getBoundingClientRect().width
          // ponytail: write the strip's offsets on the same frame the column
          // moved. The React insets state only seeds the first render; a React
          // commit lags the column animation by a frame and the strip then
          // overlaps the opening sidebar (user-reported collision).
          const bar = document.querySelector('[data-dsh-session-tabs]')
          if (bar !== null) {
            bar.style.left = `${stripLeft(sidebarWidth)}px`
            bar.style.right = '0px'
          }
          setInsets((previous) => (
            previous.left === sidebarWidth && previous.right === 0
              ? previous
              : { left: sidebarWidth, right: 0 }
          ))
        }

        update()
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
        observer?.observe(sidebar)
        if (rightbar !== null && rightbar !== undefined) observer?.observe(rightbar)
        observer?.observe(frame)

        const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update)
        mutations?.observe(frame, {
          attributes: true,
          attributeFilter: ['data-rightbar-fullscreen', 'data-sidebar-collapsed', 'data-rightbar-collapsed'],
        })
        window.addEventListener('resize', update)

        // Mirror the sidebar's rendered Session order. Rows hidden by the
        // watermark, a folded group, or a collapsed sidebar keep the fallback.
        let orderFrame = 0
        const refreshOrder = () => {
          if (orderFrame !== 0) return
          orderFrame = window.requestAnimationFrame(() => {
            orderFrame = 0
            const ids = []
            for (const row of sidebar.querySelectorAll('[data-row-key^="session:"]')) {
              const key = row.getAttribute('data-row-key')
              if (key !== null) ids.push(key.slice('session:'.length))
            }
            if (ids.length === 0) return
            setSidebarOrder((previous) => sameOrder(previous, ids) ? previous : ids)
          })
        }
        const orderObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(refreshOrder)
        orderObserver?.observe(sidebar, { childList: true, subtree: true })
        refreshOrder()

        return () => {
          observer?.disconnect()
          mutations?.disconnect()
          orderObserver?.disconnect()
          if (orderFrame !== 0) window.cancelAnimationFrame(orderFrame)
          window.removeEventListener('resize', update)
          center.style.paddingTop = previousPadding
          if (parkedPanel !== null && parkedPanel.isConnected) parkedPanel.style.top = ''
        }
      }, [])

      // Display order: the sidebar's order for every tab it renders, then the
      // remaining open tabs in their persisted fallback order. A drag is a
      // temporary override until the sidebar order changes.
      const openSet = new Set(order)
      const ranked = sidebarOrder.filter((id) => openSet.has(id))
      const rankedSet = new Set(ranked)
      let displayIds = ranked.concat(order.filter((id) => !rankedSet.has(id)))
      if (dragOrder !== null) {
        const overrideSet = new Set(dragOrder)
        displayIds = dragOrder.filter((id) => openSet.has(id)).concat(displayIds.filter((id) => !overrideSet.has(id)))
      }
      const visibleIds = displayIds.filter((id) => byId[id] !== undefined || id === current || list?.phase !== 'ready')

      const select = (id) => {
        if (id === current) return
        try {
          openSession(id)
        } catch (error) {
          console.warn('[dsh-session-tabs] could not open session', error)
        }
      }

      const close = (id) => {
        if (visibleIds.length <= 1) return
        const index = order.indexOf(id)
        if (index < 0) return
        const next = order.filter((candidate) => candidate !== id)
        setOrderState(next)
        if (id !== current) return
        const at = visibleIds.indexOf(id)
        const neighbor = visibleIds[at + 1] ?? visibleIds[at - 1]
        if (neighbor !== undefined) select(neighbor)
      }

      const create = () => {
        try {
          startSession()
        } catch (error) {
          console.warn('[dsh-session-tabs] could not start a session', error)
        }
      }

      const onTabKeyDown = (event, id) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          select(id)
          return
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          close(id)
          return
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const at = visibleIds.indexOf(id)
        const neighbor = visibleIds[at + (event.key === 'ArrowRight' ? 1 : -1)]
        if (neighbor !== undefined) tabRefs.current[neighbor]?.focus()
      }

      const onDragStart = (event, id) => {
        setDragId(id)
        try {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', id)
        } catch {
          /* some browsers refuse data access on synthetic drags */
        }
      }

      // The handlers below read the render's filtered list, so a stale id can
      // never be closed, focused, or dropped onto.
      const onDragOver = (event, id) => {
        if (dragId === null || dragId === id) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const before = event.clientX < rect.left + rect.width / 2
        setDrop((previous) => (
          previous !== null && previous.id === id && previous.before === before
            ? previous
            : { id, before }
        ))
      }

      const onDrop = (event, id) => {
        event.preventDefault()
        const source = dragId
        const rect = event.currentTarget.getBoundingClientRect()
        const before = event.clientX < rect.left + rect.width / 2
        setDragId(null)
        setDrop(null)
        if (source === null || source === id) return
        if (!visibleIds.includes(source) || !visibleIds.includes(id)) return
        const next = visibleIds.filter((candidate) => candidate !== source)
        const target = next.indexOf(id)
        next.splice(before ? target : target + 1, 0, source)
        setDragOrder(next)
      }

      const endDrag = () => {
        setDragId(null)
        setDrop(null)
      }

      const left = stripLeft(insets.left)

      const tabs = visibleIds.map((id) => {
        const row = byId[id]
        const active = id === current
        const fallback = id.length > 12 ? `${id.slice(0, 8)}…` : id
        // A blank Session has no title yet; the Workspace browser calls that
        // row "New Session", so the tab uses the same word instead of the
        // Workspace basename the row projects as `displayTitle`.
        const title = row?.blank === true ? 'New Session' : (row?.displayTitle ?? fallback)
        const kind = dotState(statuses?.get(id), row)
        const label = dotLabel(kind)
        const canClose = visibleIds.length > 1
        // The color plugin owns the Session/folder tint palette; the status
        // dot then layers the same working/oscillating background as the row.
        const workspaceId = workspaceBySession[id]
        const tints = readTabTints(id, workspaceId)
        const statusKind = tabStatusOf(kind)
        const decoration = tabDecoration(statusKind, tints)
        return h('div', {
          key: id,
          role: 'tab',
          tabIndex: active ? 0 : -1,
          'aria-selected': active,
          'data-active': active ? 'true' : undefined,
          'data-session-id': id,
          'data-session-color': tints === undefined ? undefined : '',
          'data-tab-status': statusKind,
          'data-dragging': dragId === id ? 'true' : undefined,
          'data-drop': drop?.id === id ? (drop.before ? 'before' : 'after') : undefined,
          className: 'dst-tab',
          title: label === undefined ? title : `${title} — ${label}`,
          draggable: true,
          style: decoration === undefined ? undefined : {
            '--dst-bg': decoration.idle,
            '--dst-hover': decoration.hover,
            '--dst-selected': decoration.selected,
            '--dst-edge': decoration.edge,
          },
          ref: (element) => {
            if (element === null) delete tabRefs.current[id]
            else tabRefs.current[id] = element
          },
          onClick: () => select(id),
          onKeyDown: (event) => onTabKeyDown(event, id),
          onAuxClick: (event) => {
            if (event.button !== 1) return
            event.preventDefault()
            close(id)
          },
          onDragStart: (event) => onDragStart(event, id),
          onDragOver: (event) => onDragOver(event, id),
          onDrop: (event) => onDrop(event, id),
          onDragEnd: endDrag,
        },
        statusKind === undefined
          ? null
          : h(StateDot, { state: statusKind }),
        h('span', { className: 'dst-title' }, title),
        h('button', {
          type: 'button',
          className: 'dst-close',
          tabIndex: -1,
          disabled: !canClose,
          'aria-label': `Close ${title}`,
          title: canClose ? `Close ${title}` : 'The last tab stays open',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.stopPropagation()
            close(id)
          },
        }, h(CloseIcon)))
      })

      return h('div', {
        className: 'dst-bar',
        'data-dsh-session-tabs': '',
        role: 'tablist',
        'aria-label': 'Open sessions',
        style: { left: `${left}px`, right: `${insets.right}px` },
      },
      visibleIds.length === 0
        ? h('span', { className: 'dst-empty' }, current === undefined ? 'No session open' : 'Open a session to add a tab')
        : h('div', { className: 'dst-scroll', ref: barRef }, tabs),
      h('button', {
        type: 'button',
        className: 'dst-new',
        title: 'New session',
        'aria-label': 'New session',
        onClick: create,
      }, h(PlusIcon)))
    }

    const NAME = 'dsh-session-tabs'

    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = NAME
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, `${NAME}: styles`)

      // Bind the navigation service to the component once per activation, so
      // the occupant receives stable callbacks rather than a fresh closure.
      const openSession = (id) => ctx.uiWorkspace.openSession(id)
      const startSession = () => ctx.uiWorkspace.startSession()

      function BoundSessionTabs(props) {
        return h(SessionTabs, {
          ...props,
          openSession,
          startSession,
        })
      }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: NAME,
        order: 60,
      }, BoundSessionTabs))
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply,
    }
  },
})
