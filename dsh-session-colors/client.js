/**
 * dsh-session-colors — per-session row colors and folder-panel tints.
 *
 * The Host owns the shared copy in `~/.dsh/session-colors.json`; each browser
 * keeps a localStorage cache for an instant first paint and syncs the shared
 * copy on load and whenever it becomes visible again. Session actions use the
 * official Session-menu slot. DSH exposes no folder-menu slot, so the folder
 * actions are inserted into the shipped menu without replacing or forking the
 * sidebar.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-colors',
  factory(require) {
    const React = require('react')
    const {
      IconCloseOutlineRegular,
      MenuItemButton,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const NAME = 'dsh-session-colors'
    const SESSION_STORAGE_KEY = 'dsh-session-colors.v1'
    const FOLDER_STORAGE_KEY = 'dsh-folder-colors.v1'
    const SESSION_COLORS_EVENT = 'dsh-session-colors:change'
    const RUNTIME_API_NAME = '__dshSessionColors'
    const RUNTIME_API_VERSION = 1
    const HOST_NAMESPACE = 'sessionColors'
    const DEFAULT_COLOR = '#7c83ff'
    const COLOR_PATTERN = /^#[0-9a-f]{6}$/i
    // The status pulse follows the yellow/green dot in a 1.8 s cosine cycle.
    const PULSE_PERIOD = 1800
    const PULSE_PEAK = 42
    const PULSE_REST = 20
    const sessionListeners = new Set()
    let sessionColors = readColors(SESSION_STORAGE_KEY)
    let folderColors = readColors(FOLDER_STORAGE_KEY)
    let connection = null
    let applyFrame = 0
    let pulseFrame = 0
    let pulseStart = 0
    let picker = null
    let pickerTimer = 0
    let pendingFolderMenu = null
    let pendingFolderMenuTimer = 0
    let activeFolderMenu = null
    let closingFolderMenu = false
    // Safari only shipped `@property` in 16.4, so iOS 16.3 cannot interpolate a
    // registered percentage; there the pulse is driven from script instead.
    const smoothPulse = typeof window.CSS !== 'undefined' && typeof window.CSS.registerProperty === 'function'

    const CSS = `
@property --dsc-session-layer-color{
  syntax:'<color>';
  inherits:false;
  initial-value:transparent;
}
@property --dsc-status-mix{
  syntax:'<percentage>';
  inherits:false;
  initial-value:0%;
}
[data-row-key^='session:']{
  --dsc-state-base:transparent;
  --dsc-status-mix:0%;
  --dsc-status-color:transparent;
  --dsc-session-paint-color:color-mix(in srgb,var(--dsc-session-layer-color) calc(100% - var(--dsc-status-mix)),var(--dsc-status-color) var(--dsc-status-mix));
}
[data-row-key^='session:']:hover,[data-row-key^='session:'][aria-selected='true']{
  --dsc-state-base:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055));
  --dsc-session-layer-color:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055));
}
[data-row-key^='session:'][role='treeitem']:hover,
[data-row-key^='session:'][role='treeitem'][aria-selected='true'],
[data-row-key^='session:'][data-dsh-session-color],
[data-row-key^='session:'][data-dsh-session-state='ongoing'],
[data-row-key^='session:'][data-dsh-session-state='warning'],
[data-row-key^='session:'][data-dsh-session-state='done']{
  background-color:transparent;
  background-image:linear-gradient(to right,var(--dsc-edge,var(--dsc-session-paint-color)) 0 3px,var(--dsc-session-paint-color) 3px);
  background-position:var(--dsh-workspace-indent,0px) 0;
  background-size:calc(100% - var(--dsh-workspace-indent,0px)) 100%;
  background-repeat:no-repeat;
  transition:--dsc-session-layer-color 120ms ease;
}
[data-row-key^='session:'][data-dsh-session-color]{
  --dsc-state-base:var(--dsc-bg);
  --dsc-session-layer-color:var(--dsc-bg);
}
[data-row-key^='session:'][data-dsh-session-color]:hover{
  --dsc-state-base:var(--dsc-hover);
  --dsc-session-layer-color:var(--dsc-hover);
}
[data-row-key^='session:'][data-dsh-session-color][aria-selected='true']{
  --dsc-state-base:var(--dsc-selected);
  --dsc-session-layer-color:var(--dsc-selected);
}
[data-row-key^='session:'][data-dsh-session-state='ongoing']{
  --dsc-session-layer-color:var(--dsc-working-bg,color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 26%,transparent));
}
[data-row-key^='session:'][data-dsh-session-state='ongoing']:hover{
  --dsc-session-layer-color:var(--dsc-working-hover,color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 34%,transparent));
}
[data-row-key^='session:'][data-dsh-session-state='ongoing'][aria-selected='true']{
  --dsc-session-layer-color:var(--dsc-working-selected,color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 42%,transparent));
}
[data-row-key^='session:'][data-dsh-session-state='warning']{
  --dsc-status-color:var(--dsw-alias-state-warn-primary,#e0a43c);
  --dsc-status-peak:color-mix(in srgb,var(--dsc-status-color) 42%,transparent);
  --dsc-status-rest:color-mix(in srgb,var(--dsc-status-color) 20%,transparent);
  animation:dsc-session-status-oscillate 1.8s ease-in-out infinite;
}
[data-row-key^='session:'][data-dsh-session-state='done']{
  --dsc-status-color:var(--dsw-alias-state-success-primary,#35a66f);
  --dsc-status-peak:color-mix(in srgb,var(--dsc-status-color) 42%,transparent);
  --dsc-status-rest:color-mix(in srgb,var(--dsc-status-color) 20%,transparent);
  animation:dsc-session-status-oscillate 1.8s ease-in-out infinite;
}
@keyframes dsc-session-status-oscillate{
  0%,100%{--dsc-status-mix:0%}
  50%{--dsc-status-mix:42%}
}
@media (prefers-reduced-motion:reduce){
  [data-row-key^='session:'][data-dsh-session-state='warning'],
  [data-row-key^='session:'][data-dsh-session-state='done']{
    animation:none;
    --dsc-status-mix:20%;
  }
}
[data-row-key^='session:'][role='treeitem'][aria-selected='true']{
  --dsc-selected-outline:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 78%,white 22%);
  background-image:
    linear-gradient(var(--dsc-selected-outline),var(--dsc-selected-outline)),
    linear-gradient(var(--dsc-selected-outline),var(--dsc-selected-outline)),
    linear-gradient(var(--dsc-selected-outline),var(--dsc-selected-outline)),
    linear-gradient(var(--dsc-selected-outline),var(--dsc-selected-outline)),
    linear-gradient(to right,var(--dsc-edge,var(--dsc-session-paint-color)) 0 3px,var(--dsc-session-paint-color) 3px);
  background-position:
    var(--dsh-workspace-indent,0px) 0,
    var(--dsh-workspace-indent,0px) 100%,
    var(--dsh-workspace-indent,0px) 0,
    100% 0,
    var(--dsh-workspace-indent,0px) 0;
  background-size:
    calc(100% - var(--dsh-workspace-indent,0px)) 2px,
    calc(100% - var(--dsh-workspace-indent,0px)) 2px,
    2px 100%,
    2px 100%,
    calc(100% - var(--dsh-workspace-indent,0px)) 100%;
}
[data-row-key^='workspace:'][role='treeitem']:hover{
  background-color:transparent;
  background-image:linear-gradient(var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055)),var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055)));
  background-position:var(--dsh-workspace-indent,0px) 0;
  background-size:calc(100% - var(--dsh-workspace-indent,0px)) 100%;
  background-repeat:no-repeat;
}
[data-dsh-folder-color]{
  background-image:
    linear-gradient(to right,var(--dsc-folder-edge),var(--dsc-folder-edge)),
    linear-gradient(to right,var(--dsc-folder-edge),var(--dsc-folder-edge)),
    linear-gradient(to right,var(--dsc-folder-bg),var(--dsc-folder-bg));
  background-position:
    var(--dsh-workspace-indent,0px) 0,
    var(--dsh-workspace-indent,0px) 100%,
    var(--dsh-workspace-indent,0px) 0;
  background-size:
    calc(100% - var(--dsh-workspace-indent,0px)) 1px,
    calc(100% - var(--dsh-workspace-indent,0px)) 1px,
    calc(100% - var(--dsh-workspace-indent,0px)) 100%;
  background-repeat:no-repeat;
}
.dsc-menu-swatch{
  width:14px;height:14px;box-sizing:border-box;display:inline-block;
  border-radius:4px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));
  background:conic-gradient(from 30deg,#f66,#fc6,#7c7,#6cf,#86f,#f6c,#f66);
}
.dsc-folder-menu-separator{
  height:.5px;margin:3px 4px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.28));
}
.dsc-folder-menu-button{
  display:flex;align-items:center;gap:6px;width:100%;min-height:34px;
  box-sizing:border-box;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md,6px);
  background:transparent;cursor:pointer;color:var(--dsw-alias-label-primary,#111);
  font:13px/20px inherit;text-align:left;
}
.dsc-folder-menu-button:hover,.dsc-folder-menu-button:focus-visible{
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.055));outline:none;
}
.dsc-folder-menu-icon{
  display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;
  color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-secondary,#61666b));
}
.dsc-folder-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-folder-menu-clear-icon{font-size:17px;line-height:14px;font-weight:300}
`

    /** Parse only plain id -> #rrggbb records from an untrusted value. */
    function sanitizeColors(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
      const next = {}
      for (const [id, color] of Object.entries(value)) {
        if (id.length > 0 && typeof color === 'string' && COLOR_PATTERN.test(color)) {
          next[id] = color.toLowerCase()
        }
      }
      return next
    }

    /** Parse one stored JSON map. */
    function parseColors(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return {}
      try {
        return sanitizeColors(JSON.parse(raw))
      } catch {
        return {}
      }
    }

    /** True when both maps hold exactly the same records. */
    function sameColors(left, right) {
      const keys = Object.keys(left)
      if (keys.length !== Object.keys(right).length) return false
      return keys.every((key) => left[key] === right[key])
    }

    /** Read one browser-local color map without making storage availability fatal. */
    function readColors(key) {
      try {
        return parseColors(window.localStorage.getItem(key))
      } catch {
        return {}
      }
    }

    /** Persist one browser-local color map; private mode may remain page-local. */
    function writeColors(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* ponytail: visual state remains useful even when storage is blocked. */
      }
    }

    /** Read the Host-owned shared maps, or null when that endpoint is unavailable. */
    async function readSharedColors() {
      if (connection === null) return null
      try {
        const result = await connection.rpc.call('/api', `${HOST_NAMESPACE}/read`, { args: {} })
        if (result?.ok !== true) return null
        return { sessions: sanitizeColors(result.value?.sessions), folders: sanitizeColors(result.value?.folders) }
      } catch {
        /* ponytail: an unreachable Host keeps this browser on its local cache. */
        return null
      }
    }

    /** Copy this browser's two maps to the shared Host file. */
    function writeSharedColors() {
      if (connection === null) return
      // The Gateway matches args against the Host method's parameter names.
      connection.rpc.call('/api', `${HOST_NAMESPACE}/write`, {
        args: { request: { sessions: sessionColors, folders: folderColors } },
      }).catch(() => {})
    }

    /** Adopt the shared maps, migrating this browser's local records on first run. */
    async function syncSharedColors() {
      const shared = await readSharedColors()
      if (shared === null) return
      const empty = Object.keys(shared.sessions).length === 0 && Object.keys(shared.folders).length === 0
      if (empty && (Object.keys(sessionColors).length > 0 || Object.keys(folderColors).length > 0)) {
        writeSharedColors()
        return
      }
      if (!sameColors(shared.sessions, sessionColors)) replaceSessionColors(shared.sessions, true)
      if (!sameColors(shared.folders, folderColors)) replaceFolderColors(shared.folders, true)
    }

    /** Convert one validated hex color to RGB channels. */
    function rgb(color) {
      return [
        Number.parseInt(color.slice(1, 3), 16),
        Number.parseInt(color.slice(3, 5), 16),
        Number.parseInt(color.slice(5, 7), 16),
      ]
    }

    /** Format RGB channels as a transparent CSS color. */
    function rgbaChannels(channels, alpha) {
      return `rgba(${channels[0]},${channels[1]},${channels[2]},${alpha})`
    }

    /** Convert one validated hex color to a transparent Session-row tint. */
    function rgba(color, alpha) {
      return rgbaChannels(rgb(color), alpha)
    }

    /** Darken and desaturate a chosen color for the quiet folder backdrop. */
    function mutedFolderChannels(color) {
      const channels = rgb(color)
      const average = (channels[0] + channels[1] + channels[2]) / 3
      return channels.map((channel) => Math.round((average + (channel - average) * 0.55) * 0.78))
    }

    /** Build one tab's four base tint strings from a channel set. */
    function baseTints(channels, idle, hover, selected, edge) {
      return {
        idle: rgbaChannels(channels, idle),
        hover: rgbaChannels(channels, hover),
        selected: rgbaChannels(channels, selected),
        edge: rgbaChannels(channels, edge),
      }
    }

    /** Build one tab's three working tint strings from a channel set. */
    function workingTints(channels, idle, hover, selected) {
      return {
        idle: rgbaChannels(channels, idle),
        hover: rgbaChannels(channels, hover),
        selected: rgbaChannels(channels, selected),
      }
    }

    /**
     * Exact tint strings for one tab, derived from the live Session/folder maps.
     * Session tints mirror the sidebar row palette; folder tints use the same
     * alphas on the muted folder channels. Undefined means "no stored color".
     * @param sessionId - Session whose tab is being painted.
     * @param workspaceId - owning Workspace for the folder fallback.
     * @returns base and working tint strings, or undefined.
     */
    function tabTints(sessionId, workspaceId) {
      const color = sessionColors[sessionId]
      if (color !== undefined) {
        const channels = rgb(color)
        return {
          source: 'session',
          base: baseTints(channels, 0.24, 0.33, 0.42, 0.88),
          working: workingTints(channels, 0.38, 0.46, 0.52),
        }
      }
      const folder = workspaceId === undefined ? undefined : folderColors[workspaceId]
      if (folder === undefined) return undefined
      const channels = mutedFolderChannels(folder)
      return {
        source: 'folder',
        base: baseTints(channels, 0.24, 0.33, 0.42, 0.88),
        working: workingTints(channels, 0.29, 0.37, 0.44),
      }
    }

    /** Remove only one Session's explicitly assigned color. */
    function clearSessionColor(row) {
      row.removeAttribute('data-dsh-session-color')
      row.style.removeProperty('--dsc-bg')
      row.style.removeProperty('--dsc-hover')
      row.style.removeProperty('--dsc-selected')
      row.style.removeProperty('--dsc-edge')
    }

    /** Remove every inline Session decoration owned by this plugin. */
    function clearSessionRow(row) {
      clearSessionColor(row)
      row.removeAttribute('data-dsh-session-state')
      row.style.removeProperty('--dsc-working-bg')
      row.style.removeProperty('--dsc-working-hover')
      row.style.removeProperty('--dsc-working-selected')
      row.style.removeProperty('--dsc-status-mix')
      row.style.removeProperty('animation')
    }

    /** Remove inline folder-panel decoration owned by this plugin. */
    function clearFolderPanel(panel) {
      panel.removeAttribute('data-dsh-folder-color')
      panel.style.removeProperty('--dsc-folder-bg')
      panel.style.removeProperty('--dsc-folder-edge')
    }

    /** Apply explicit colors, brighter working tints, and the visible DSH status. */
    function applySessionRows() {
      for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
        const key = row.getAttribute('data-row-key')
        const sessionId = key === null ? '' : key.slice('session:'.length)
        const color = sessionColors[sessionId]
        if (color === undefined) clearSessionColor(row)
        else {
          row.setAttribute('data-dsh-session-color', '')
          row.style.setProperty('--dsc-bg', rgba(color, 0.24))
          row.style.setProperty('--dsc-hover', rgba(color, 0.33))
          row.style.setProperty('--dsc-selected', rgba(color, 0.42))
          row.style.setProperty('--dsc-edge', rgba(color, 0.88))
        }

        const panel = row.closest('[data-dsh-folder-color]')
        const workspaceId = panel?.getAttribute('data-dsh-folder-color') ?? ''
        const folderColor = folderColors[workspaceId]
        const workingChannels = color === undefined
          ? folderColor === undefined ? null : mutedFolderChannels(folderColor)
          : rgb(color)
        if (workingChannels === null) {
          row.style.removeProperty('--dsc-working-bg')
          row.style.removeProperty('--dsc-working-hover')
          row.style.removeProperty('--dsc-working-selected')
        } else {
          const alphas = color === undefined ? [0.29, 0.37, 0.44] : [0.38, 0.46, 0.52]
          row.style.setProperty('--dsc-working-bg', rgbaChannels(workingChannels, alphas[0]))
          row.style.setProperty('--dsc-working-hover', rgbaChannels(workingChannels, alphas[1]))
          row.style.setProperty('--dsc-working-selected', rgbaChannels(workingChannels, alphas[2]))
        }

        const dot = row.firstElementChild?.querySelector('[data-state]') ?? null
        const state = dot?.getAttribute('data-state') ?? ''
        if (state === 'ongoing' || state === 'warning' || state === 'done' || state === 'error') {
          if (row.getAttribute('data-dsh-session-state') !== state) row.setAttribute('data-dsh-session-state', state)
        } else if (row.hasAttribute('data-dsh-session-state')) {
          row.removeAttribute('data-dsh-session-state')
        }
      }
    }

    /** Find the rendered tree section identified by DSH's indentation variable. */
    function folderPanelFor(row) {
      let candidate = row.parentElement
      while (candidate !== null && candidate !== document.body) {
        if (candidate.style.getPropertyValue('--dsh-workspace-indent') !== '') return candidate
        candidate = candidate.parentElement
      }
      return null
    }

    /** Tint the existing group wrapper behind a folder header and its subtree. */
    function applyFolderPanels() {
      const mounted = new Set()
      for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
        const key = row.getAttribute('data-row-key')
        const workspaceId = key === null ? '' : key.slice('workspace:'.length)
        const panel = folderPanelFor(row)
        if (workspaceId.length === 0 || panel === null) continue
        mounted.add(panel)
        const color = folderColors[workspaceId]
        if (color === undefined) {
          clearFolderPanel(panel)
          continue
        }
        const muted = mutedFolderChannels(color)
        panel.setAttribute('data-dsh-folder-color', workspaceId)
        panel.style.setProperty('--dsc-folder-bg', rgbaChannels(muted, 0.21))
        panel.style.setProperty('--dsc-folder-edge', rgbaChannels(muted, 0.32))
      }
      for (const panel of document.querySelectorAll('[data-dsh-folder-color]')) {
        if (!mounted.has(panel)) clearFolderPanel(panel)
      }
    }

    /** Every row currently showing a yellow or green dot's pulsing background. */
    function pulsingRows() {
      return Array.from(document.querySelectorAll('[data-row-key^="session:"][data-dsh-session-state]'))
        .filter((row) => {
          const state = row.getAttribute('data-dsh-session-state')
          return state === 'warning' || state === 'done'
        })
    }

    /**
     * Drive the status pulse from script where `@property` is unavailable
     * (Safari/iOS 16.3), writing the same 0%→42%→0% percentage the CSS
     * keyframes would have interpolated.
     */
    function runPulse() {
      const rows = pulsingRows()
      if (rows.length === 0) {
        pulseFrame = 0
        pulseStart = 0
        return
      }
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        for (const row of rows) {
          row.style.setProperty('--dsc-status-mix', `${PULSE_REST}%`)
          row.style.setProperty('animation', 'none')
        }
        pulseFrame = 0
        return
      }
      if (pulseStart === 0) pulseStart = performance.now()
      const phase = ((performance.now() - pulseStart) % PULSE_PERIOD) / PULSE_PERIOD
      const mix = (PULSE_PEAK / 2) * (1 - Math.cos(phase * 2 * Math.PI))
      for (const row of rows) {
        row.style.setProperty('--dsc-status-mix', `${mix.toFixed(2)}%`)
        row.style.setProperty('animation', 'none')
      }
      pulseFrame = window.requestAnimationFrame(runPulse)
    }

    /** (Re)start the script pulse when this browser cannot animate the property. */
    function ensurePulse() {
      if (smoothPulse || pulseFrame !== 0) return
      if (pulsingRows().length === 0) return
      pulseFrame = window.requestAnimationFrame(runPulse)
    }

    /** Apply both presentation layers and then derive each Session's live state. */
    function applyColors() {
      applyFrame = 0
      applyFolderPanels()
      applySessionRows()
      ensurePulse()
      syncFolderMenu()
    }

    /** Coalesce storage updates and React/sidebar rerenders into one DOM pass. */
    function scheduleApply() {
      if (applyFrame !== 0) return
      applyFrame = window.requestAnimationFrame(applyColors)
    }

    /** Announce changed Session/folder color maps to other browser plugins. */
    function announceSessionColors() {
      window.dispatchEvent(new Event(SESSION_COLORS_EVENT))
    }

    /** Publish a new Session map to official menu components and row decoration. */
    function replaceSessionColors(next, persist) {
      sessionColors = next
      if (persist) writeColors(SESSION_STORAGE_KEY, sessionColors)
      scheduleApply()
      for (const listener of sessionListeners) listener()
      announceSessionColors()
    }

    /** Publish a new folder map without changing any Session color record. */
    function replaceFolderColors(next, persist) {
      folderColors = next
      if (persist) writeColors(FOLDER_STORAGE_KEY, folderColors)
      scheduleApply()
      syncFolderMenu()
      announceSessionColors()
    }

    /** Set or clear one explicit Session color. */
    function setSessionColor(sessionId, color) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const next = { ...sessionColors }
      if (color === undefined) delete next[sessionId]
      else if (COLOR_PATTERN.test(color)) next[sessionId] = color.toLowerCase()
      else return
      replaceSessionColors(next, true)
      writeSharedColors()
    }

    /** Set or clear one folder-panel color. */
    function setFolderColor(workspaceId, color) {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return
      const next = { ...folderColors }
      if (color === undefined) delete next[workspaceId]
      else if (COLOR_PATTERN.test(color)) next[workspaceId] = color.toLowerCase()
      else return
      replaceFolderColors(next, true)
      writeSharedColors()
    }

    /** React hook for the current explicit color of one Session menu occurrence. */
    function useSessionColor(sessionId) {
      return React.useSyncExternalStore(
        (listener) => {
          sessionListeners.add(listener)
          return () => sessionListeners.delete(listener)
        },
        () => sessionColors[sessionId],
        () => sessionColors[sessionId],
      )
    }

    /** Remove the temporary native picker input. */
    function closePicker() {
      window.clearTimeout(pickerTimer)
      pickerTimer = 0
      picker?.remove()
      picker = null
    }

    /** Open the browser's native picker and commit its chosen value. */
    function openPicker(label, current, onPick) {
      closePicker()
      const input = document.createElement('input')
      input.type = 'color'
      input.value = current ?? DEFAULT_COLOR
      input.setAttribute('aria-label', label)
      input.style.cssText = 'position:fixed;left:-20px;top:-20px;width:1px;height:1px;opacity:0;pointer-events:none'
      input.addEventListener('change', () => {
        onPick(input.value)
        closePicker()
      }, { once: true })
      document.body.appendChild(input)
      picker = input
      pickerTimer = window.setTimeout(closePicker, 60000)
      try {
        if (typeof input.showPicker === 'function') input.showPicker()
        else input.click()
      } catch {
        input.click()
      }
    }

    /** Color-menu icon: chosen color, or a spectrum before first use. */
    function ColorSwatch({ color }) {
      return h('span', {
        className: 'dsc-menu-swatch',
        style: color === undefined ? undefined : { background: color },
        'aria-hidden': true,
      })
    }

    /** Session menu row that opens the native picker. */
    function SetColorMenuItem({ sessionId, useMenuOpenState }) {
      const color = useSessionColor(sessionId)
      const [, setMenuOpen] = useMenuOpenState()
      return h(MenuItemButton, {
        separatorBefore: true,
        icon: h(ColorSwatch, { color }),
        onSelect: () => {
          setMenuOpen(false)
          openPicker('Session background color', color, (chosen) => setSessionColor(sessionId, chosen))
        },
      }, color === undefined ? 'Set background color…' : 'Change background color…')
    }

    /** Session menu row shown only when there is a color to remove. */
    function ClearColorMenuItem({ sessionId, useMenuOpenState }) {
      const color = useSessionColor(sessionId)
      const [, setMenuOpen] = useMenuOpenState()
      if (color === undefined) return null
      return h(MenuItemButton, {
        icon: h(IconCloseOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false)
          setSessionColor(sessionId, undefined)
        },
      }, 'Clear background color')
    }

    /** Build one keyboard-accessible row for the folder menu bridge. */
    function folderMenuButton(label, icon, onSelect) {
      const wrap = document.createElement('div')
      wrap.dataset.dscFolderMenuItem = ''
      const button = document.createElement('button')
      button.type = 'button'
      button.role = 'menuitem'
      button.className = 'dsc-folder-menu-button'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onSelect()
      })
      const iconSeat = document.createElement('span')
      iconSeat.className = 'dsc-folder-menu-icon'
      iconSeat.setAttribute('aria-hidden', 'true')
      iconSeat.appendChild(icon)
      const text = document.createElement('span')
      text.className = 'dsc-folder-menu-label'
      text.textContent = label
      button.append(iconSeat, text)
      wrap.appendChild(button)
      return wrap
    }

    /** Close the owning React menu through its own trigger. */
    function closeFolderMenu(record) {
      activeFolderMenu = null
      closingFolderMenu = true
      try {
        record.anchor.click()
      } finally {
        closingFolderMenu = false
      }
    }

    /** Insert or refresh the Set/Change/Clear rows in one open folder menu. */
    function ensureFolderMenu(record) {
      const viewport = Array.from(record.menu.children).find((child) => child.getAttribute('role') === 'presentation')
      if (viewport === undefined) return
      const color = folderColors[record.workspaceId]
      const state = color ?? ''
      const injected = viewport.querySelectorAll('[data-dsc-folder-menu-item]')
      if (record.menu.dataset.dscFolderColorState === state && injected.length === (color === undefined ? 2 : 3)) return
      for (const item of injected) item.remove()
      record.menu.dataset.dscFolderColorState = state

      const separator = document.createElement('div')
      separator.dataset.dscFolderMenuItem = ''
      separator.className = 'dsc-folder-menu-separator'
      separator.role = 'separator'
      viewport.appendChild(separator)

      const swatch = document.createElement('span')
      swatch.className = 'dsc-menu-swatch'
      if (color !== undefined) swatch.style.background = color
      viewport.appendChild(folderMenuButton(
        color === undefined ? 'Set folder color…' : 'Change folder color…',
        swatch,
        () => {
          closeFolderMenu(record)
          openPicker('Folder panel color', color, (chosen) => setFolderColor(record.workspaceId, chosen))
        },
      ))

      if (color === undefined) return
      const clearIcon = document.createElement('span')
      clearIcon.className = 'dsc-folder-menu-clear-icon'
      clearIcon.textContent = '×'
      viewport.appendChild(folderMenuButton('Clear folder color', clearIcon, () => {
        closeFolderMenu(record)
        setFolderColor(record.workspaceId, undefined)
      }))
    }

    /** Select the visible menu nearest the folder's ellipsis trigger. */
    function nearestMenu(anchor) {
      const anchorRect = anchor.getBoundingClientRect()
      let best = null
      let bestDistance = Infinity
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        const rect = menu.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0 || menu.querySelector('button[role="menuitem"]') === null) continue
        const x = Math.max(rect.left - anchorRect.right, anchorRect.left - rect.right, 0)
        const y = Math.max(rect.top - anchorRect.bottom, anchorRect.top - rect.bottom, 0)
        const distance = x * x + y * y
        if (distance >= bestDistance) continue
        best = menu
        bestDistance = distance
      }
      return best
    }

    /** Follow menu mounting/unmounting without owning the shipped React tree. */
    function syncFolderMenu() {
      if (activeFolderMenu !== null && !activeFolderMenu.menu.isConnected) activeFolderMenu = null
      if (activeFolderMenu !== null) {
        ensureFolderMenu(activeFolderMenu)
        return
      }
      if (pendingFolderMenu === null || !pendingFolderMenu.anchor.isConnected) return
      const menu = nearestMenu(pendingFolderMenu.anchor)
      if (menu === null) return
      window.clearTimeout(pendingFolderMenuTimer)
      pendingFolderMenuTimer = 0
      activeFolderMenu = { ...pendingFolderMenu, menu }
      pendingFolderMenu = null
      ensureFolderMenu(activeFolderMenu)
    }

    /** Notice the first action button in a real Workspace row: its ellipsis. */
    function onDocumentClick(event) {
      if (closingFolderMenu || !(event.target instanceof Element)) return
      const button = event.target.closest('[data-row-key^="workspace:"] [class*="rowActions"] button')
      if (button === null) return
      const row = button.closest('[data-row-key^="workspace:"]')
      const actions = button.closest('[class*="rowActions"]')
      const key = row?.getAttribute('data-row-key')
      const workspaceId = key === null || key === undefined ? '' : key.slice('workspace:'.length)
      if (workspaceId.length === 0 || actions?.querySelector('button') !== button) return
      window.clearTimeout(pendingFolderMenuTimer)
      if (activeFolderMenu?.anchor === button && activeFolderMenu.menu.isConnected) {
        pendingFolderMenu = null
        pendingFolderMenuTimer = 0
        activeFolderMenu = null
        return
      }
      pendingFolderMenu = { workspaceId, anchor: button }
      activeFolderMenu = null
      pendingFolderMenuTimer = window.setTimeout(() => {
        pendingFolderMenu = null
        pendingFolderMenuTimer = 0
      }, 1000)
      scheduleApply()
    }

    /** Browser plugin body. */
    function apply(ctx) {
      connection = typeof ctx.connection?.rpc?.call === 'function' ? ctx.connection : null

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = NAME
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, `${NAME}: styles`)

      // Runtime contract for other browser plugins (session tabs): the color
      // plugin owns every tint value, so consumers never read its storage keys.
      ctx.effect(() => {
        const api = { version: RUNTIME_API_VERSION, getTabTints: tabTints }
        window[RUNTIME_API_NAME] = api
        return () => {
          if (window[RUNTIME_API_NAME] === api) delete window[RUNTIME_API_NAME]
        }
      }, `${NAME}: runtime color API`)

      ctx.effect(() => {
        const observer = new MutationObserver(scheduleApply)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
        const onStorage = (event) => {
          if (event.key === SESSION_STORAGE_KEY) replaceSessionColors(parseColors(event.newValue), false)
          if (event.key === FOLDER_STORAGE_KEY) replaceFolderColors(parseColors(event.newValue), false)
        }
        // A second browser (or the same one after a long pause) may have saved
        // since this page loaded, so adopt the shared copy when it returns.
        const onVisible = () => {
          if (document.visibilityState === 'visible') void syncSharedColors()
        }
        window.addEventListener('storage', onStorage)
        window.addEventListener('focus', onVisible)
        document.addEventListener('visibilitychange', onVisible)
        document.addEventListener('click', onDocumentClick, true)
        scheduleApply()
        // Announce once so plugins that mounted earlier learn the current map.
        announceSessionColors()
        void syncSharedColors()
        return () => {
          observer.disconnect()
          window.removeEventListener('storage', onStorage)
          window.removeEventListener('focus', onVisible)
          document.removeEventListener('visibilitychange', onVisible)
          document.removeEventListener('click', onDocumentClick, true)
          if (applyFrame !== 0) window.cancelAnimationFrame(applyFrame)
          applyFrame = 0
          if (pulseFrame !== 0) window.cancelAnimationFrame(pulseFrame)
          pulseFrame = 0
          pulseStart = 0
          connection = null
          window.clearTimeout(pendingFolderMenuTimer)
          pendingFolderMenuTimer = 0
          pendingFolderMenu = null
          activeFolderMenu = null
          closePicker()
          for (const item of document.querySelectorAll('[data-dsc-folder-menu-item]')) item.remove()
          for (const row of document.querySelectorAll('[data-dsh-session-color],[data-dsh-session-state]')) clearSessionRow(row)
          for (const panel of document.querySelectorAll('[data-dsh-folder-color]')) clearFolderPanel(panel)
        }
      }, `${NAME}: sidebar colors`)

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: `${NAME}:set`,
        order: 425,
      }, SetColorMenuItem))
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: `${NAME}:clear`,
        order: 426,
      }, ClearColorMenuItem))
    }

    return {
      inject: ['slots', 'connection'],
      apply,
    }
  },
})
