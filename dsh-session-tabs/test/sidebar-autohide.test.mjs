import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

// ponytail: reuse the workspace's already locked DOM test environment, not a new runtime dependency.
const { JSDOM } = createRequire(new URL('../../dsh-chat-bubbles/package.json', import.meta.url))('jsdom')
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const LEGACY_MAP = 'dsh.sessionTabs.sidebarCollapsed.v1'
const GLOBAL = 'dsh.sidebarCollapsed'

function fixture(t, { width = 360, viewport = 1440, storage = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="frame"><div id="sidebar"><div id="logo" data-window-drag></div><div data-row-key="session:a">Real session row</div></div><div id="center"></div><div data-rightbar-col></div><div data-shell-overlay></div></div><div data-dsh-session-tabs></div></body></html>', { url: 'http://127.0.0.1:3081/', runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  const { document } = window
  Object.defineProperty(window, 'innerWidth', { writable: true, value: viewport })
  window.ResizeObserver = class { observe() {} disconnect() {} }
  const frame = document.getElementById('frame')
  const sidebar = document.getElementById('sidebar')
  const center = document.getElementById('center')
  const nativeGrid = `${width}px minmax(0px, 1fr) minmax(0px, 420px)`
  frame.style.gridTemplateColumns = nativeGrid
  window.localStorage.setItem('dsh.sidebarWidth', String(width))
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value)
  const box = size => ({ x: 0, y: 0, top: 0, left: 0, width: size, right: size, height: 1000, bottom: 1000 })
  frame.getBoundingClientRect = () => box(viewport)
  sidebar.getBoundingClientRect = () => box(Number.parseFloat(sidebar.style.width || frame.style.gridTemplateColumns))
  let button
  let nativeClicks = 0
  let defer = false
  const commits = []
  const commitNative = collapsed => {
    frame.style.gridTemplateColumns = collapsed ? '56px minmax(0px, 1fr) minmax(0px, 420px)' : nativeGrid
    frame.toggleAttribute('data-sidebar-collapsed', collapsed)
    button.setAttribute('aria-label', collapsed ? 'Open sidebar' : 'Collapse sidebar')
    window.localStorage.setItem('dsh.sidebarCollapsed', collapsed ? '1' : '0')
  }
  const remount = () => {
    button = document.createElement('button')
    button.type = 'button'
    button.className = 'native_toggle'
    button.setAttribute('aria-label', frame.hasAttribute('data-sidebar-collapsed') ? 'Open sidebar' : 'Collapse sidebar')
    button.setAttribute('aria-keyshortcuts', 'Ctrl+Alt+B')
    button.innerHTML = '<svg data-native-icon></svg>'
    button.addEventListener('click', () => {
      nativeClicks++
      const next = !frame.hasAttribute('data-sidebar-collapsed')
      if (defer) commits.push(() => commitNative(next))
      else commitNative(next)
    })
    document.getElementById('logo').replaceChildren(button)
    return button
  }
  remount()
  if (window.localStorage.getItem(GLOBAL) === '1') commitNative(true)
  const hooks = []
  let hook = 0
  let effects = []
  let registered
  let plugin
  const disposals = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef(value) { const index = hook++; return hooks[index] ??= { current: value } },
    useState(value) {
      const index = hook++
      if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next }]
    },
    useEffect: effect,
    useLayoutEffect: effect,
  }
  function effect(run, deps) {
    const index = hook++
    const previous = hooks[index]
    if (previous !== undefined && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    previous?.cleanup?.()
    hooks[index] = { deps }
    effects.push(() => { hooks[index].cleanup = run() })
  }
  window.__ModuleLoader__ = { load(registration) { plugin = registration.factory(name => name === 'react' ? React : { StateDot: () => null }) } }
  window.eval(source)
  const ctx = {
    effect(run) { disposals.push(run()) },
    slots: {
      inject(_name, register) { disposals.push(register()) },
      register(_options, component) { registered = component; return () => {} },
    },
    uiWorkspace: { openSession() { assert.fail('Sidebar toggle must not navigate') }, startSession() { assert.fail('Sidebar toggle must not create a session') } },
    reflect: { get() { return undefined } },
    sessions: { using() { assert.fail('Sidebar toggle must not rename a session') } },
  }
  let current = 'a'
  const render = () => {
    hook = 0
    effects = []
    const bound = registered({
      useSessions: select => select({ phase: 'ready', byId: current === undefined ? {} : { [current]: { id: current, displayTitle: current, retainedBy: { mainView: 1 } } } }),
      useSessionStatus: select => select(new Map()),
      useWorkspaces: select => select({ archivedSessionIds: [], items: [] }),
    })
    bound.type(bound.props)
    for (const run of effects) run()
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const value of [...hooks].reverse()) value?.cleanup?.()
    for (const cleanup of disposals.reverse()) cleanup?.()
  }
  t.after(() => { dispose(); window.close() })
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => window.requestAnimationFrame(resolve)) }
  const move = (x, pointerType = 'mouse', buttons = 0) => {
    const event = new window.MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 200, buttons })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    document.dispatchEvent(event)
  }
  return {
    window, document, frame, sidebar, center, nativeGrid, flush, move, dispose, remount,
    get button() { return button }, get clicks() { return nativeClicks },
    get choice() { return window.localStorage.getItem(GLOBAL) },
    snapshot() { return Object.fromEntries(Object.entries(window.localStorage)) },
    set defer(value) { defer = value },
    commit() { while (commits.length) commits.shift()() },
    start() { plugin.apply(ctx); render() },
    select(id) { current = id; render() },
  }
}

async function hoverOpen(f) {
  f.button.click()
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), true)
  f.move(2)
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), true)
  assert.equal(f.button.getAttribute('aria-label'), 'Pin sidebar open')
}

test('hover drawer shows a distinct pin action and clicking it stops auto-hide without another native collapse', async t => {
  const f = fixture(t)
  f.start()
  await hoverOpen(f)
  assert.equal(f.clicks, 2)
  assert.equal(f.button.hasAttribute('data-dst-sidebar-autohide'), true)
  assert.equal(f.button.querySelectorAll('[data-dst-sidebar-pin]').length, 1)
  assert.equal(f.button.title, 'Auto-hide is on — pin sidebar open')
  assert.equal(f.document.querySelector('[data-dsh-session-tabs]').style.left, `${f.sidebar.getBoundingClientRect().width}px`, 'The tab strip must not cover the pin control')
  f.button.querySelector('[data-dst-sidebar-pin] path').dispatchEvent(new f.window.MouseEvent('click', { bubbles: true }))
  await f.flush()
  assert.equal(f.clicks, 2)
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), false)
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), false)
  assert.equal(f.frame.style.gridTemplateColumns, f.nativeGrid)
  assert.equal(f.sidebar.style.position, '')
  assert.equal(f.sidebar.style.transform, '')
  assert.equal(f.button.getAttribute('aria-label'), 'Collapse sidebar')
  assert.equal(f.button.getAttribute('aria-keyshortcuts'), 'Ctrl+Alt+B')
  assert.equal(f.button.querySelector('[data-dst-sidebar-pin]'), null)
  assert.equal(f.choice, '0')
  f.move(900)
  await f.flush()
  assert.equal(f.clicks, 2)
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), false)
})

test('the same button can enable auto-hide again and internal close clicks are not treated as pin clicks', async t => {
  const f = fixture(t)
  f.start()
  await hoverOpen(f)
  f.button.click()
  await f.flush()
  await hoverOpen(f)
  assert.equal(f.choice, '1')
  f.move(900)
  await new Promise(resolve => f.window.setTimeout(resolve, 240))
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), true)
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), false)
  assert.equal(f.choice, '1')
  assert.equal(f.button.hasAttribute('data-dst-sidebar-autohide'), false)
})

test('one pinned or auto-hide choice applies across all session switches despite conflicting old tab values', async t => {
  const legacy = JSON.stringify({ a: 1, b: 0 })
  const f = fixture(t, { storage: { [GLOBAL]: '0', [LEGACY_MAP]: legacy } })
  f.start()
  f.select('b')
  f.select('a')
  await f.flush()
  assert.equal(f.clicks, 0, 'Switching sessions must not click the sidebar control')
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), false)
  await hoverOpen(f)
  const clicks = f.clicks
  f.select('b')
  await f.flush()
  f.select('a')
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), true)
  assert.equal(f.button.getAttribute('aria-label'), 'Pin sidebar open')
  assert.equal(f.choice, '1', 'Hovering is not a global pinned-open choice')
  assert.equal(f.clicks, clicks)
  f.button.click()
  await f.flush()
  f.select('b')
  f.select('a')
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), false)
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), false)
  assert.equal(f.choice, '0')
  assert.equal(f.clicks, clicks)
  assert.equal(f.window.localStorage.getItem(LEGACY_MAP), legacy, 'Retired choices are ignored, not destroyed')
})

test('a remounted native button is decorated once and remains pinnable', async t => {
  const f = fixture(t)
  f.start()
  await hoverOpen(f)
  const original = f.button
  f.remount()
  await f.flush()
  assert.equal(original.hasAttribute('data-dst-sidebar-autohide'), false)
  assert.equal(original.querySelector('[data-dst-sidebar-pin]'), null)
  assert.equal(f.button.querySelectorAll('[data-dst-sidebar-pin]').length, 1)
  f.button.click()
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), false)
  assert.equal(f.frame.style.gridTemplateColumns, f.nativeGrid)
})

test('pin during a pending native open lets its commit finish as a normal pinned sidebar', async t => {
  const f = fixture(t)
  f.start()
  f.button.click()
  await f.flush()
  f.defer = true
  f.move(2)
  f.button.click()
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), false)
  f.commit()
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), false)
  assert.equal(f.frame.style.gridTemplateColumns, f.nativeGrid)
  f.move(900)
  await f.flush()
  assert.equal(f.clicks, 2)
  assert.equal(f.choice, '0')
})

test('switching sessions during slide-out leaves the global auto-hide choice enabled', async t => {
  const f = fixture(t, { storage: { [LEGACY_MAP]: JSON.stringify({ a: 0, b: 0 }) } })
  f.start()
  await hoverOpen(f)
  f.move(900)
  f.select('b')
  await new Promise(resolve => f.window.setTimeout(resolve, 240))
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), true)
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), false)
  assert.equal(f.choice, '1')
})

test('closed auto-hide remains global when switching through old pinned tabs', async t => {
  const f = fixture(t, { storage: { [GLOBAL]: '1', [LEGACY_MAP]: JSON.stringify({ a: 0, b: 0 }) } })
  f.start()
  f.select('b')
  f.select('a')
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), true)
  assert.equal(f.choice, '1')
  assert.equal(f.clicks, 0)
})

test('a reload during a hover preview restores auto-hide rather than pinning the sidebar', async t => {
  const f = fixture(t)
  f.start()
  await hoverOpen(f)
  const reloaded = fixture(t, { storage: f.snapshot() })
  reloaded.start()
  await reloaded.flush()
  assert.equal(reloaded.choice, '1')
  assert.equal(reloaded.frame.hasAttribute('data-sidebar-collapsed'), true)
  assert.equal(reloaded.frame.hasAttribute('data-dsh-drawer'), false)
  assert.equal(reloaded.clicks, 0)
})

test('a pinned choice survives reload and ignores malformed retired per-tab storage', async t => {
  const f = fixture(t, { storage: { [LEGACY_MAP]: '{broken old tab data' } })
  f.start()
  await hoverOpen(f)
  f.button.click()
  await f.flush()
  const reloaded = fixture(t, { storage: f.snapshot() })
  reloaded.start()
  reloaded.select('b')
  await reloaded.flush()
  assert.equal(reloaded.choice, '0')
  assert.equal(reloaded.frame.hasAttribute('data-sidebar-collapsed'), false)
  assert.equal(reloaded.window.localStorage.getItem(LEGACY_MAP), '{broken old tab data')
  assert.equal(reloaded.clicks, 0)
})

test('the global choice does not require an active session', async t => {
  const f = fixture(t)
  f.start()
  f.select(undefined)
  await hoverOpen(f)
  assert.equal(f.choice, '1')
  f.button.click()
  await f.flush()
  assert.equal(f.choice, '0')
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), false)
})

test('pinning preserves the exact native expanded grid and unusual saved width', async t => {
  const f = fixture(t, { width: 777.25 })
  f.start()
  await hoverOpen(f)
  f.button.click()
  await f.flush()
  assert.equal(f.frame.style.gridTemplateColumns, f.nativeGrid)
  assert.equal(f.window.localStorage.getItem('dsh.sidebarWidth'), '777.25')
  assert.equal(f.document.querySelector('[data-dsh-session-tabs]').style.left, '777.25px')
})

test('narrow, touch and dragging interactions keep their existing native behavior', async t => {
  const f = fixture(t, { viewport: 800 })
  f.start()
  f.button.click()
  await f.flush()
  f.move(2)
  await f.flush()
  assert.equal(f.clicks, 1)
  f.window.innerWidth = 1440
  f.move(2, 'touch')
  f.move(2, 'mouse', 1)
  await f.flush()
  assert.equal(f.clicks, 1)
  assert.equal(f.button.hasAttribute('data-dst-sidebar-autohide'), false)
  f.button.click()
  await f.flush()
  assert.equal(f.frame.hasAttribute('data-sidebar-collapsed'), false)
})

test('disposal removes pin UI and handlers and restores the native sidebar controls', async t => {
  const f = fixture(t)
  f.start()
  await hoverOpen(f)
  f.dispose()
  assert.equal(f.frame.hasAttribute('data-dsh-drawer'), false)
  assert.equal(f.button.querySelector('[data-dst-sidebar-pin]'), null)
  assert.equal(f.button.hasAttribute('data-dst-sidebar-autohide'), false)
  assert.equal(f.button.getAttribute('aria-label'), 'Open sidebar')
  assert.equal(f.button.hasAttribute('title'), false)
  assert.equal(f.center.style.paddingTop, '')
  const before = f.clicks
  f.move(2)
  assert.equal(f.clicks, before)
  f.button.click()
  assert.equal(f.clicks, before + 1)
})
