import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

function fixture(t) {
  const dom = new JSDOM('<!doctype html><body><main data-chat-flow></main><div data-composer-input contenteditable="true"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  const { document } = window
  const nodes = new Map()
  const cleanups = []
  const subscribers = new Set()
  const calls = []
  let sessionId = 'session-a'
  let draft = ''
  let revision = 0
  let accepts = true
  let focused = 0
  let plugin
  const sessionCtx = {}
  const binding = { sessionId, ctx: sessionCtx }
  const input = {
    actions: {
      captureInsertion(...args) {
        assert.deepEqual(args, [])
        return { start: 8, end: 10, draftRev: revision }
      },
      insertText(text, span) {
        assert.deepEqual(Object.keys(span).sort(), ['draftRev', 'end', 'start'])
        assert.equal(span.start, 0)
        assert.equal(span.end, 0)
        assert.equal(span.draftRev, revision)
        calls.push({ kind: 'insert', text, span: { ...span } })
        if (!accepts) return false
        draft = text + draft
        revision += 1
        return true
      },
      submit() { assert.fail('Reply must never submit a message') },
    },
    focus(...args) { assert.deepEqual(args, []); focused += 1 },
    notify(...args) { calls.push({ kind: 'notice', args }) },
  }
  const ctx = {
    sessions: {
      list: {
        getSnapshot() { return { byId: sessionId === undefined ? {} : { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } } } },
        subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) },
      },
      binding(id) { assert.equal(id, sessionId); return binding },
    },
    uiConversation: {
      binding(value) {
        assert.equal(value, binding)
        return { target(name) { assert.equal(name, 'chat'); return { getSnapshot() { return { nodes } } } } }
      },
    },
    conversation: { input: { for(value) { assert.equal(value, sessionCtx); return input } } },
    effect(callback, label) {
      assert.equal(typeof label, 'string')
      cleanups.push(callback())
    },
  }
  window.HTMLElement.prototype.scrollIntoView = function (options) { assert.equal(options.block, 'nearest') }
  window.__ModuleLoader__ = { load(registration) { assert.equal(registration.id, manifest.name); plugin = registration.factory() } }
  window.eval(source)
  t.after(() => { dispose(); dom.window.close() })

  function dispose() { while (cleanups.length) cleanups.pop()() }
  function addMessage(key, text, { groupPart, parent, blocks, messageId = key, reasoning = false } = {}) {
    nodes.set(key, { key, kind: 'assistant-step', data: { blocks: blocks ?? [{ kind: 'text', text }], finalNode: { messageId } } })
    const row = document.createElement('div')
    row.dataset.chatFlowKind = 'assistant-step'
    row.dataset.chatNodeKey = key
    if (groupPart !== undefined) row.dataset.chatGroupPart = groupPart
    row.innerHTML = `<div data-slot="conversation.chat.node"><div><div>${reasoning ? '<div data-turn-process-inline>Private reasoning</div>' : ''}<div class="markdown"><p>Rendered content</p><button>Copy</button></div></div></div></div>`
    ;(parent ?? document.querySelector('main')).appendChild(row)
    return row
  }
  async function flush() {
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
  }
  return {
    window, document, plugin, ctx, nodes, calls, addMessage, flush, dispose,
    start() { plugin.apply(ctx) },
    get draft() { return draft }, set draft(value) { draft = value; revision += 1 },
    get focused() { return focused },
    set accepts(value) { accepts = value },
    select(id) { sessionId = id; binding.sessionId = id; for (const listener of subscribers) listener() },
    get subscriptions() { return subscribers.size },
  }
}

test('manifest and browser entry declare every native service they use', (t) => {
  const f = fixture(t)
  assert.deepEqual(Array.from(f.plugin.inject), ['sessions', 'conversation', 'uiConversation'])
  assert.deepEqual(manifest.dsh.client.inject, Array.from(f.plugin.inject))
  assert.equal(manifest.dependencies, undefined)
})

test('decorates assistant replies, retaining native content and separate message/speaker identity', (t) => {
  const f = fixture(t)
  const row = f.addMessage('step-1', '**Hello**', { messageId: 'message-1', reasoning: true })
  const content = row.querySelector('.markdown')
  const reasoning = row.querySelector('[data-turn-process-inline]')
  f.start()
  assert.equal(row.querySelectorAll('[data-dsh-chat-bubble]').length, 1)
  assert.equal(row.querySelectorAll('[data-dsh-bubble-reply]').length, 1)
  assert.equal(row.querySelector('.markdown'), content)
  assert.equal(row.querySelector('[data-turn-process-inline]'), reasoning)
  assert.equal(reasoning.getAttribute('style'), null)
  assert.equal(row.dataset.dshBubbleSession, 'session-a')
  assert.equal(row.dataset.dshBubbleAuthor, 'session-a')
  assert.equal(row.dataset.dshBubbleMessage, 'message-1')
})

test('Reply quotes only the chosen original message and preserves the existing draft without sending', (t) => {
  const f = fixture(t)
  f.addMessage('wrong', 'Do not quote me')
  const row = f.addMessage('right', '**Original**\n\nSecond line', { messageId: 'id-2', reasoning: true })
  f.draft = 'My existing reply'
  f.start()
  row.querySelector('[data-dsh-bubble-reply]').click()
  assert.equal(f.draft, '[Reply to Assistant message "id-2"]\n> **Original**\n> \n> Second line\n\nMy existing reply')
  assert.equal(f.focused, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.draft.includes('Copy'), false)
  assert.equal(f.draft.includes('Private reasoning'), false)
})

test('reasoning-only, protocol-only, user/tool rows, and sidebar conversations remain untouched', (t) => {
  const f = fixture(t)
  const reasoning = f.addMessage('reasoning', '', { groupPart: 'reasoning', blocks: [{ kind: 'reasoning', text: 'Secret' }] })
  const toolOnly = f.addMessage('tool-only', '', { blocks: [{ kind: 'tool-call', id: 'tool' }] })
  const blank = f.addMessage('blank', '  \n')
  const aside = f.document.createElement('aside')
  aside.dataset.sidebarRightSession = 'side-session'
  f.document.body.appendChild(aside)
  const sidebar = f.addMessage('sidebar', 'Sidebar reply', { parent: aside })
  f.document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-chat-flow-kind="user">Human</div><div data-chat-flow-kind="tool">Result</div>')
  f.start()
  for (const row of [reasoning, toolOnly, blank, sidebar, ...f.document.querySelectorAll('[data-chat-flow-kind="user"],[data-chat-flow-kind="tool"]')]) {
    assert.equal(row.querySelector('[data-dsh-bubble-reply]'), null)
    assert.equal(row.querySelector('[data-dsh-chat-bubble]'), null)
  }
})

test('streaming and late-mounted messages get one footer; Reply uses the latest content', async (t) => {
  const f = fixture(t)
  f.start()
  const row = f.addMessage('stream', 'First')
  delete f.nodes.get('stream').data.finalNode
  await f.flush()
  assert.equal(row.dataset.dshBubbleMessage, 'stream')
  const body = row.querySelector('[data-dsh-chat-bubble]')
  const image = f.document.createElement('img')
  body.appendChild(image)
  f.nodes.get('stream').data.blocks[0].text = 'First and final'
  f.nodes.get('stream').data.finalNode = { messageId: 'settled' }
  await f.flush()
  assert.equal(body.lastElementChild.hasAttribute('data-dsh-bubble-actions'), true)
  assert.equal(body.contains(image), true)
  assert.equal(row.querySelectorAll('[data-dsh-bubble-reply]').length, 1)
  assert.equal(row.dataset.dshBubbleMessage, 'settled')
  row.querySelector('[data-dsh-bubble-reply]').click()
  assert.match(f.draft, /> First and final\n\n$/)
})

test('rich GenUI, media controls, and code retain their DOM nodes and event handlers', (t) => {
  const f = fixture(t)
  const row = f.addMessage('rich', 'Original fence and code')
  const content = row.querySelector('.markdown')
  content.innerHTML = '<section class="genui-dom-fence"><button>Interactive</button></section><video controls></video><pre><code>const x = 1</code></pre>'
  const originals = [...content.children]
  let clicked = 0
  content.querySelector('button').addEventListener('click', () => { clicked += 1 })
  f.start()
  assert.deepEqual([...content.children], originals)
  content.querySelector('button').click()
  assert.equal(clicked, 1)
  assert.equal(f.draft, '')
})

test('session changes resolve current message content and never reuse an old session draft', async (t) => {
  const f = fixture(t)
  const row = f.addMessage('same-key', 'Session A')
  f.start()
  f.select('session-b')
  // The catalogue can change before the replacement transcript is committed.
  row.querySelector('[data-dsh-bubble-reply]').click()
  assert.equal(f.draft, '')
  f.nodes.set('same-key', { key: 'same-key', kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'Session B' }], finalNode: { messageId: 'message-b' } } })
  await f.flush()
  row.querySelector('[data-dsh-bubble-reply]').click()
  assert.equal(f.draft, '[Reply to Assistant message "message-b"]\n> Session B\n\n')
  assert.equal(row.dataset.dshBubbleAuthor, 'session-b')
})

test('large quotes are not truncated and repeated replies preserve earlier draft content', (t) => {
  const f = fixture(t)
  const text = 'Long original message\n'.repeat(2000)
  const row = f.addMessage('long', text)
  f.start()
  const button = row.querySelector('[data-dsh-bubble-reply]')
  button.click()
  const first = f.draft
  assert.equal(first, `[Reply to Assistant message "long"]\n${text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`)
  button.click()
  assert.equal(f.draft, first + first)
})

test('image-only replies retain their message identity without copying toolbar text', (t) => {
  const f = fixture(t)
  const row = f.addMessage('image', '', { blocks: [{ kind: 'image', attachment: { id: 'image-1' } }] })
  f.start()
  row.querySelector('[data-dsh-bubble-reply]').click()
  assert.equal(f.draft, '[Reply to Assistant message "image"]\n> [Image]\n\n')
})

test('native insertion refusal is surfaced without draft loss', (t) => {
  const f = fixture(t)
  const row = f.addMessage('busy', 'Original')
  f.draft = 'Keep me'
  f.accepts = false
  f.start()
  row.querySelector('[data-dsh-bubble-reply]').click()
  assert.equal(f.draft, 'Keep me')
  assert.equal(f.focused, 0)
  assert.equal(f.calls[1].kind, 'notice')
  assert.equal(f.calls[1].args[0], 'error')
})

test('cleanup removes only plugin decorations and stops observing new content', async (t) => {
  const f = fixture(t)
  const row = f.addMessage('first', 'Hello')
  const content = row.querySelector('.markdown')
  f.start()
  const button = row.querySelector('[data-dsh-bubble-reply]')
  assert.equal(f.subscriptions, 1)
  f.dispose()
  assert.equal(f.subscriptions, 0)
  assert.equal(f.document.querySelector('style[data-dsh-chat-bubbles]'), null)
  assert.equal(f.document.querySelector('[data-dsh-chat-bubble],[data-dsh-bubble-reply],[data-dsh-bubble-author]'), null)
  assert.equal(row.querySelector('.markdown'), content)
  button.click()
  const late = f.addMessage('late', 'After disable')
  await f.flush()
  assert.equal(late.querySelector('[data-dsh-bubble-reply]'), null)
  assert.equal(f.draft, '')
})

test('removed, emptied, or reclassified messages lose stale controls', async (t) => {
  const f = fixture(t)
  const removed = f.addMessage('removed', 'A')
  const emptied = f.addMessage('emptied', 'B')
  const reclassified = f.addMessage('reclassified', 'C')
  f.start()
  removed.remove()
  f.nodes.get('emptied').data.blocks = []
  emptied.querySelector('.markdown').textContent = ''
  reclassified.dataset.chatGroupPart = 'reasoning'
  await f.flush()
  for (const row of [removed, emptied, reclassified]) assert.equal(row.querySelector('[data-dsh-bubble-reply]'), null)
})

test('the stylesheet uses native theme tokens, keeps reasoning outside, and never hides overflow content', (t) => {
  const f = fixture(t)
  f.addMessage('theme', 'Themed')
  f.start()
  const css = f.document.querySelector('style[data-dsh-chat-bubbles]').textContent
  assert.match(css, /body\[data-ds-dark-theme\]/)
  assert.match(css, /var\(--dsw-alias-bg-layer-1/)
  assert.match(css, /:not\(\[data-turn-process-inline\]\)/)
  assert.doesNotMatch(css, /overflow\s*:\s*hidden|max-height|line-clamp/)
})
