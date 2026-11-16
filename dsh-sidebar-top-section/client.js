/**
 * dsh-sidebar-top-section — collapse the global controls above Workspaces.
 *
 * The shipped sidebar does not expose a slot around its New Session and global
 * panel rows, so this plugin makes the smallest DOM bridge possible: it moves
 * those existing controls into one section and never clones or replaces them.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-top-section',
  factory() {
    const STYLE_ID = 'dsh-sidebar-top-section-style'
    const GLOBAL_KEY = '__dshSidebarTopSection'
    const SECTION_LABEL = 'Quick access'
    const CSS = `
.dsh-sidebar-top-section{
  display:flex;
  flex-direction:column;
  flex:none;
}
.dsh-sidebar-top-section [data-dsh-sidebar-top-header]{
  align-items:center;
  background:transparent;
  border:0;
  border-radius:var(--dsw-radius-sm,6px);
  color:var(--dsw-alias-label-secondary);
  cursor:pointer;
  display:flex;
  flex:none;
  font:inherit;
  font-size:12px;
  gap:7px;
  justify-content:flex-start;
  margin:0 0 4px;
  min-height:28px;
  padding:4px 8px;
  text-align:left;
  width:100%;
}
.dsh-sidebar-top-section [data-dsh-sidebar-top-header]:hover{
  background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary);
}
.dsh-sidebar-top-section [data-dsh-sidebar-top-header]:focus-visible{
  box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary);
  outline:none;
}
.dsh-sidebar-top-section [data-dsh-sidebar-top-title]{
  flex:1;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dsh-sidebar-top-section [data-dsh-sidebar-top-chevron]{
  border-bottom:1.5px solid currentColor;
  border-right:1.5px solid currentColor;
  display:block;
  flex:none;
  height:6px;
  transform:rotate(-45deg);
  transition:transform 120ms ease;
  width:6px;
}
.dsh-sidebar-top-section[data-collapsed='false'] [data-dsh-sidebar-top-chevron]{
  transform:rotate(45deg);
}
.dsh-sidebar-top-section[data-collapsed='true'] [data-dsh-sidebar-top-body]{
  display:none;
}
.dsh-sidebar-top-section [data-dsh-sidebar-top-body]{
  display:flex;
  flex-direction:column;
  min-width:0;
}
.dsh-sidebar-top-section[data-dsh-sidebar-rail='true']{
  display:contents;
}
.dsh-sidebar-top-section[data-dsh-sidebar-rail='true'] [data-dsh-sidebar-top-header]{
  display:none;
}
.dsh-sidebar-top-section[data-dsh-sidebar-rail='true'] [data-dsh-sidebar-top-body]{
  display:contents !important;
}
@media (prefers-reduced-motion:reduce){
  .dsh-sidebar-top-section [data-dsh-sidebar-top-chevron]{transition:none}
}
`

    function installStyle() {
      if (document.querySelector(`style[data-${STYLE_ID}]`)) return
      const style = document.createElement('style')
      style.dataset.dshSidebarTopSectionStyle = 'true'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function hasWorkspaceSlot(root) {
      return root?.querySelector('[data-slot="sidebar.workspaces"]') !== null
    }

    function findSidebarRoot() {
      const nav = document.querySelector('nav[aria-label="Global panels"]')
      if (!nav) return null
      const marked = nav.closest('[data-dsh-sidebar-top-root]')
      if (marked && hasWorkspaceSlot(marked)) return marked
      const parent = nav.parentElement
      if (parent && hasWorkspaceSlot(parent) && parent.querySelector('button[aria-label="New session"]')) return parent
      return null
    }

    function findNewSession(root) {
      return [...root.querySelectorAll('button[aria-label="New session"]')]
        .find((button) => button.closest('[data-window-drag]') === null)
        ?? null
    }

    function setCollapsed(section, collapsed) {
      section.dataset.collapsed = collapsed ? 'true' : 'false'
      section.querySelector('[data-dsh-sidebar-top-header]')?.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    }

    function syncRail(root, section) {
      const rail = root.querySelector('button[aria-label="Open sidebar"]') !== null
      section.dataset.dshSidebarRail = rail ? 'true' : 'false'
    }

    function makeSection(newSession, nav) {
      const section = document.createElement('section')
      section.className = 'dsh-sidebar-top-section'
      section.dataset.dshSidebarTopSection = 'true'
      section.dataset.collapsed = 'true'

      const header = document.createElement('button')
      header.type = 'button'
      header.dataset.dshSidebarTopHeader = 'true'
      header.setAttribute('aria-expanded', 'false')
      header.setAttribute('aria-label', SECTION_LABEL)
      header.setAttribute('aria-controls', 'dsh-sidebar-top-section-content')
      const chevron = document.createElement('span')
      chevron.dataset.dshSidebarTopChevron = 'true'
      chevron.setAttribute('aria-hidden', 'true')
      const title = document.createElement('span')
      title.dataset.dshSidebarTopTitle = 'true'
      title.textContent = SECTION_LABEL
      header.append(chevron, title)

      const body = document.createElement('div')
      body.id = 'dsh-sidebar-top-section-content'
      body.dataset.dshSidebarTopBody = 'true'
      body.append(newSession, nav)
      section.append(header, body)
      header.onclick = () => setCollapsed(section, section.dataset.collapsed === 'false')
      return section
    }

    function ensureSection(root) {
      root.dataset.dshSidebarTopRoot = 'true'
      const newSession = findNewSession(root)
      const nav = root.querySelector('nav[aria-label="Global panels"]')
      if (!newSession || !nav) return null

      let section = root.querySelector('[data-dsh-sidebar-top-section]')
      if (!section) {
        section = makeSection(newSession, nav)
        root.insertBefore(section, root.querySelector('[data-slot="sidebar.workspaces"]')?.parentElement ?? root.children[1] ?? null)
      } else {
        const header = section.querySelector('[data-dsh-sidebar-top-header]')
        if (header) header.onclick = () => setCollapsed(section, section.dataset.collapsed === 'false')
        const body = section.querySelector('[data-dsh-sidebar-top-body]')
        if (body) {
          if (!body.contains(newSession)) body.append(newSession)
          if (!body.contains(nav)) body.append(nav)
        }
      }
      if (section.dataset.collapsed !== 'true' && section.dataset.collapsed !== 'false') setCollapsed(section, true)
      syncRail(root, section)
      return section
    }

    function start() {
      window[GLOBAL_KEY]?.dispose?.()
      installStyle()

      let disposed = false
      let observer = null
      let scheduled = false
      let frame = 0
      const scan = () => {
        scheduled = false
        frame = 0
        if (disposed) return
        const root = findSidebarRoot()
        if (root) ensureSection(root)
      }
      const schedule = () => {
        if (disposed || scheduled) return
        scheduled = true
        frame = window.requestAnimationFrame(scan)
      }
      const observe = () => {
        if (disposed || !document.body) return
        scan()
        observer = new MutationObserver(schedule)
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ['aria-label', 'class'],
          childList: true,
          subtree: true,
        })
      }
      const dispose = () => {
        disposed = true
        observer?.disconnect()
        if (frame) window.cancelAnimationFrame(frame)
      }
      window[GLOBAL_KEY] = { dispose }

      if (document.body) observe()
      else document.addEventListener('DOMContentLoaded', observe, { once: true })
    }

    return { inject: [], apply() { start() } }
  },
})
