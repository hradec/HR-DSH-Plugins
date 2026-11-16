/** Soft-blue assistant messages and quoted replies through the native composer. */
window.__ModuleLoader__.load({
  id: '@local/dsh-chat-bubbles',
  factory() {
    const FLOW = '[data-chat-flow-kind="assistant-step"]'
    const OTHER_VIEW = '[data-sidebar-chat],[data-sidebar-right-session],[data-sidebar-right-panel],[data-panel-conversation],[data-plugin-panel]'
    const CSS = `
[data-dsh-chat-bubble] {
  --dcb-fill:color-mix(in srgb,#579be8 12%,var(--dsw-alias-bg-layer-1,#fff));
  --dcb-edge:color-mix(in srgb,#579be8 28%,transparent);
  gap:0!important;
  min-width:0;
}
body[data-ds-dark-theme] [data-dsh-chat-bubble] {
  --dcb-fill:color-mix(in srgb,#579be8 17%,var(--dsw-alias-bg-layer-1,#151517));
}
[data-dsh-chat-bubble]>:not([data-turn-process-inline]) {
  box-sizing:border-box;
  min-width:0;
  margin:0;
  padding:10px 16px;
  background:var(--dcb-fill);
  border-inline:1px solid var(--dcb-edge);
  overflow-wrap:anywhere;
}
[data-dsh-chat-bubble]>:nth-child(1 of :not([data-turn-process-inline])) {
  border-top:1px solid var(--dcb-edge);
  border-radius:4px 16px 0 0;
  padding-top:14px;
}
[data-dsh-chat-bubble]>[data-turn-process-inline] {margin-bottom:8px}
[data-dsh-chat-bubble]>[data-dsh-bubble-actions] {
  display:flex;
  justify-content:flex-end;
  border-bottom:1px solid var(--dcb-edge);
  border-radius:0 0 16px 16px;
  padding:2px 10px 8px;
}
[data-dsh-bubble-reply] {
  display:inline-flex;
  align-items:center;
  gap:5px;
  font:inherit;
  font-size:12px;
  line-height:22px;
  color:var(--dsw-alias-label-secondary,#426387);
  background:transparent;
  border:0;
  border-radius:6px;
  padding:1px 7px;
  cursor:pointer;
}
[data-dsh-bubble-reply]:hover {background:var(--dsw-alias-interactive-bg-hover,#579be824)}
[data-dsh-bubble-reply]:focus-visible {outline:2px solid var(--dsw-alias-state-business-primary,#579be8);outline-offset:2px}
`

    function apply(ctx) {
      const decorated = new Map()
      let frame
      let disposed = false

      function currentSession() {
        return Object.values(ctx.sessions.list.getSnapshot().byId)
          .find((row) => (row.retainedBy.mainView ?? 0) > 0)?.id
      }

      function nodeFor(sessionId, row) {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) return undefined
        return ctx.uiConversation.binding(binding).target('chat').getSnapshot()?.nodes.get(row.dataset.chatNodeKey)
      }

      // Message identity and speaker identity are separate; no extra agents are started.
      function messageFor(sessionId, row) {
        const node = nodeFor(sessionId, row)
        if (node?.kind !== 'assistant-step') return undefined
        const blocks = node.data.blocks.filter((block) => block.kind !== 'reasoning' && block.kind !== 'tool-call')
        if (!blocks.some((block) => block.kind !== 'text' || block.text.trim() !== '')) return undefined
        return {
          sessionId,
          authorId: sessionId,
          authorLabel: 'Assistant',
          messageId: node.data.finalNode?.messageId ?? node.key,
          blocks,
        }
      }

      function undecorate(row) {
        const previous = decorated.get(row)
        if (previous === undefined) return
        previous.actions.remove()
        previous.body.removeAttribute('data-dsh-chat-bubble')
        for (const name of ['session', 'author', 'message']) row.removeAttribute(`data-dsh-bubble-${name}`)
        decorated.delete(row)
      }

      function scan() {
        frame = undefined
        if (disposed) return
        const sessionId = currentSession()
        for (const row of decorated.keys()) {
          if (!row.isConnected || row.closest(OTHER_VIEW) || row.dataset.chatGroupPart === 'reasoning' || sessionId === undefined) undecorate(row)
        }
        if (sessionId === undefined) return
        // ponytail: O(n) in the loaded main transcript, batched once per DOM frame.
        // A future native per-message action slot can replace this DOM decoration.
        for (const row of document.querySelectorAll(FLOW)) {
          if (row.closest(OTHER_VIEW) || row.dataset.chatGroupPart === 'reasoning') continue
          const message = messageFor(sessionId, row)
          // Shipped AssistantMarkdown structure: slot > root > body. No React children are moved.
          const body = row.querySelector(':scope > [data-slot="conversation.chat.node"] > div > div')
          if (message === undefined || body === null) {
            undecorate(row)
            continue
          }
          if (decorated.get(row)?.body !== body) undecorate(row)
          let entry = decorated.get(row)
          if (entry === undefined) {
            const actions = document.createElement('div')
            actions.dataset.dshBubbleActions = ''
            const button = document.createElement('button')
            button.type = 'button'
            button.dataset.dshBubbleReply = ''
            button.textContent = '↩ Reply'
            button.setAttribute('aria-label', 'Reply to this assistant message')
            actions.appendChild(button)
            entry = { body, actions }
            decorated.set(row, entry)
            body.setAttribute('data-dsh-chat-bubble', '')
          }
          for (const [name, value] of Object.entries({ session: message.sessionId, author: message.authorId, message: message.messageId })) {
            if (row.getAttribute(`data-dsh-bubble-${name}`) !== value) row.setAttribute(`data-dsh-bubble-${name}`, value)
          }
          // Streaming can append new content after our footer; keep Reply last without reparenting native nodes.
          if (entry.actions.parentElement !== body || entry.actions.nextSibling !== null) body.appendChild(entry.actions)
        }
      }

      function scheduleScan() {
        if (!disposed && frame === undefined) frame = requestAnimationFrame(scan)
      }

      function onReply(event) {
        const button = event.target.closest?.('[data-dsh-bubble-reply]')
        if (button === undefined || button === null) return
        const row = button.closest(FLOW)
        const sessionId = currentSession()
        if (row === null || row.dataset.dshBubbleSession !== sessionId) return
        const message = messageFor(sessionId, row)
        if (message === undefined) return
        const binding = ctx.sessions.binding(sessionId)
        const input = ctx.conversation.input.for(binding.ctx)
        const text = message.blocks.map((block) => block.kind === 'text' ? block.text : block.kind === 'image' ? '[Image]' : JSON.stringify(block.block)).join('')
        const quote = `[Reply to ${message.authorLabel} message ${JSON.stringify(message.messageId)}]\n${text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`
        // Native insertion preserves the draft's text, reference chips, attachments, and undo history.
        const insertion = { ...input.actions.captureInsertion(), start: 0, end: 0 }
        if (!input.actions.insertText(quote, insertion)) {
          input.notify('error', 'The composer did not accept the reply. Try Reply again after the pending send finishes.')
          return
        }
        input.focus()
        document.querySelector('[data-composer-input]')?.scrollIntoView({ block: 'nearest' })
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.dshChatBubbles = ''
        style.textContent = CSS
        document.head.appendChild(style)
        const observer = new MutationObserver(scheduleScan)
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-chat-node-key', 'data-chat-group-part'],
        })
        document.addEventListener('click', onReply)
        const unsubscribe = ctx.sessions.list.subscribe(scheduleScan)
        scan()
        return () => {
          disposed = true
          if (frame !== undefined) cancelAnimationFrame(frame)
          observer.disconnect()
          unsubscribe()
          document.removeEventListener('click', onReply)
          for (const row of decorated.keys()) undecorate(row)
          style.remove()
        }
      }, 'dsh-chat-bubbles: assistant bubbles and replies')
    }

    return { inject: ['sessions', 'conversation', 'uiConversation'], apply }
  },
})
