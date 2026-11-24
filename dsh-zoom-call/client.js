/**
 * dsh-zoom-call — browser half.
 *
 * Two things:
 *  1. A 🎥 Cast action in the conversation header: live roster, call members
 *     in, say something to them (human -> teammate inbox, through the Lead's
 *     authority), dismiss, and a full cast editor (system prompt, mode
 *     template, color, emoji, permission, model) saved to the workspace
 *     `.zoom-call.cast.json` by the Host.
 *  2. Chat-bubble identity: teammate peer messages in the Lead's chat get the
 *     dsh-chat-bubbles bubble look with that member's color — we reuse the
 *     bubbles plugin's own `[data-dsh-chat-bubble]` + `--dcb-fill/--dcb-edge`
 *     vocabulary instead of re-inventing a bubble. Inside a called member's
 *     own conversation, its assistant bubbles take its color too.
 *
 * No React beyond the header slot shell; panels are plain DOM like
 * dsh-chat-bubbles' pickers.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-zoom-call',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NAME = 'dsh-zoom-call'
    const API = '/zoom-call/api'
    // Mirror of dsh-chat-bubbles' exclusion: never decorate side-view chats.
    const OTHER_VIEW = '[data-sidebar-chat],[data-sidebar-right-session],[data-sidebar-right-panel],[data-panel-conversation],[data-plugin-panel]'

    const CSS = `
[data-zc-chip]{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--zc-color,#888);font-weight:600;padding:8px 16px 2px}
/* Peer-message rows borrow dsh-chat-bubbles' bubble via its own attribute; we only
   supply the per-member --dcb-* overrides it already reads. */
[data-dsh-chat-bubble][data-zc-agent]{--dcb-fill:color-mix(in srgb,var(--zc-color) 12%,var(--dsw-alias-bg-layer-1,#fff));--dcb-edge:color-mix(in srgb,var(--zc-color) 34%,transparent)}
body[data-ds-dark-theme] [data-dsh-chat-bubble][data-zc-agent]{--dcb-fill:color-mix(in srgb,var(--zc-color) 17%,var(--dsw-alias-bg-layer-1,#151517))}
[data-dsh-chat-bubble][data-zc-peer-body]>:nth-child(2){border-radius:0}
/* The called member's own conversation: tint its assistant bubbles. */
body[data-zc-self] [data-dsh-chat-bubble]:not([data-zc-agent]){--dcb-fill:color-mix(in srgb,var(--zc-self-color) 12%,var(--dsw-alias-bg-layer-1,#fff));--dcb-edge:color-mix(in srgb,var(--zc-self-color) 34%,transparent)}
body[data-ds-dark-theme][data-zc-self] [data-dsh-chat-bubble]:not([data-zc-agent]){--dcb-fill:color-mix(in srgb,var(--zc-self-color) 17%,var(--dsw-alias-bg-layer-1,#151517))}
.zc-cast-panel{position:fixed;z-index:120;width:360px;max-height:70vh;overflow:auto;box-sizing:border-box;
  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:10px;
  padding:10px;font-size:13px;color:var(--dsw-alias-label-primary,#222);display:flex;flex-direction:column;gap:8px}
body[data-ds-dark-theme] .zc-cast-panel{background:#17181c}
.zc-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px}
.zc-dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--zc-color,#888)}
.zc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zc-chip-status{font-size:11px;padding:1px 7px;border-radius:9px;background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.07));color:var(--dsw-alias-label-secondary,#666)}
.zc-chip-status[data-phase="running"],.zc-chip-status[data-phase="active"]{background:color-mix(in srgb,#3ecf8e 22%,transparent);color:#1d7a52}
.zc-chip-status[data-phase="failed"]{background:color-mix(in srgb,#e8584f 22%,transparent);color:#a33}
.zc-btn{font:inherit;font-size:12px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#bbb);background:transparent;color:inherit;cursor:pointer}
.zc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.zc-say{display:flex;gap:6px}
.zc-say input{flex:1;min-width:0;font:inherit;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#bbb);background:var(--dsw-alias-bg-layer-2,#fff);color:inherit}
.zc-editor{display:flex;flex-direction:column;gap:6px;border:1px dashed var(--dsw-alias-border-l2,#bbb);border-radius:8px;padding:8px}
.zc-editor input,.zc-editor select,.zc-editor textarea{font:inherit;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#bbb);background:var(--dsw-alias-bg-layer-2,#fff);color:inherit}
.zc-editor textarea{min-height:64px;resize:vertical}
.zc-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.zc-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#777)}
.zc-error{font-size:12px;color:#c33}
`

    /** Cached view of the Host cast document: members, roster, options. */
    const state = { cast: [], roster: [], defaults: {}, permissionOptions: [], byName: new Map(), bySession: new Map(), selfColor: null, loaded: false }
    let panelRender = null

    function refresh(index) {
      state.selfColor = null
      for (const member of index.cast ?? []) state.byName.set(member.name, member)
      for (const row of index.roster ?? []) {
        const member = state.byName.get(row.name)
        if (member !== undefined) state.bySession.set(row.sessionId, member)
      }
      if (index.self !== undefined && index.self !== null && state.byName.has(index.self)) state.selfColor = state.byName.get(index.self)
      state.permissionOptions = index.permissionOptions ?? []
      state.defaults = index.defaults ?? {}
      state.cast = index.cast ?? []
      state.roster = index.roster ?? []
      state.loaded = true
      paintSelf(index)
      paintRows(true)
      if (panelRender !== null) panelRender()
    }

    /** Tint this whole conversation when it IS a called-in cast member. */
    function paintSelf(index) {
      const member = state.selfColor
      if (member === undefined) {
        document.body.removeAttribute('data-zc-self')
        document.body.style.removeProperty('--zc-self-color')
        return
      }
      document.body.setAttribute('data-zc-self', member.name)
      document.body.style.setProperty('--zc-self-color', member.color)
    }

    async function api(path, body) {
      const response = await fetch(API + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok || value.error !== undefined) throw new Error(value.error ?? `zoom-call ${path} failed`)
      return value
    }

    // ---------- bubble tinting ----------
    let scanTimer
    function scheduleScan() {
      if (scanTimer !== undefined) return
      scanTimer = setTimeout(() => { scanTimer = undefined; paintRows(false) }, 150)
    }

    function peerContentName(node) {
      // Fallback identity when source metadata is unavailable: the Host wraps
      // every Team message as "Team message from <name>:".
      const first = node?.data?.content?.find?.((part) => part.type === 'text')
      const match = typeof first?.text === 'string' ? first.text.match(/^Team message from ([a-z][a-z0-9-]*):/) : undefined
      return match?.[1]
    }

    function paintRows(force) {
      const chat = window.__dzcConversation
      for (const row of document.querySelectorAll('[data-chat-node-key]')) {
        if (row.closest(OTHER_VIEW) !== null) continue
        const node = chat?.nodes?.get?.(row.dataset.chatNodeKey)
        if (node === undefined) continue
        let member
        if (node.data?.source?.kind === 'agent-message') member = state.bySession.get(node.data.source.senderSessionId)
        if (member === undefined && ['user', 'steering'].includes(node.kind)) member = state.byName.get(peerContentName(node) ?? '')
        if (member === undefined) {
          if (force && row.dataset.zcAgent !== undefined) {
            row.removeAttribute('data-zc-agent')
            row.removeAttribute('data-dsh-chat-bubble')
            row.querySelector('[data-zc-chip]')?.remove()
          }
          continue
        }
        if (row.dataset.zcAgent === member.name) continue
        row.setAttribute('data-zc-agent', member.name)
        row.style.setProperty('--zc-color', member.color)
        // Reuse dsh-chat-bubbles' bubble: claim its row attribute ourselves.
        row.setAttribute('data-dsh-chat-bubble', '')
        const chip = document.createElement('div')
        chip.setAttribute('data-zc-chip', '')
        chip.textContent = `${member.emoji} ${member.display || member.name}`
        row.insertBefore(chip, row.firstChild)
      }
    }

    // ---------- panel ----------
    let panel
    function closePanel() {
      panel?.remove()
      panel = undefined
      panelRender = null
    }

    function statusOf(name) {
      const row = state.roster.find((entry) => entry.name === name)
      if (row === undefined) return { label: 'off call', phase: 'off' }
      return { label: row.phase, phase: row.phase }
    }

    async function run(action, body, noteEl) {
      try {
        await api(action, body)
        if (noteEl !== undefined) noteEl.textContent = ''
      } catch (error) {
        if (noteEl !== undefined) noteEl.textContent = error instanceof Error ? error.message : String(error)
      }
    }

    function openPanel(sessionId, rootButton) {
      if (panel !== undefined) closePanel()
      panel = document.createElement('div')
      panel.className = 'zc-cast-panel'
      panel.dataset.plugin = NAME
      const note = document.createElement('div')
      note.className = 'zc-error'
      const list = document.createElement('div')
      list.style.display = 'flex'
      list.style.flexDirection = 'column'
      list.style.gap = '6px'
      const footer = document.createElement('div')
      footer.style.display = 'flex'
      footer.style.gap = '6px'
      const all = document.createElement('button')
      all.className = 'zc-btn'
      all.textContent = 'Call in all'
      all.onclick = async () => { await run('assemble', { session_id: sessionId, all: true }, note); await reload(sessionId) }
      const add = document.createElement('button')
      add.className = 'zc-btn'
      add.textContent = '+ member'
      add.onclick = () => { editMember(null, list, sessionId, note) }
      footer.append(all, add, note)
      panel.append(list, footer)
      document.body.appendChild(panel)
      const rect = rootButton.getBoundingClientRect()
      panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - 380)) + 'px'
      panel.style.top = rect.bottom + 6 + 'px'
      panelRender = () => renderRows(list, sessionId, note)
      renderRows(list, sessionId, note)
      reload(sessionId)
    }

    async function reload(sessionId) {
      try {
        const index = await api('/cast?session_id=' + encodeURIComponent(sessionId))
        refresh(index)
      } catch (error) {
        state.loaded = false
      }
    }

    function renderRows(list, sessionId, note) {
      list.textContent = ''
      if (!state.loaded) {
        const wait = document.createElement('div')
        wait.className = 'zc-note'
        wait.textContent = 'Loading cast… (if this never resolves, the Host plugin is not mounted in this profile)'
        list.append(wait)
        return
      }
      for (const member of state.cast) {
        const row = document.createElement('div')
        row.className = 'zc-row'
        row.style.setProperty('--zc-color', member.color)
        const dot = document.createElement('span')
        dot.className = 'zc-dot'
        const name = document.createElement('span')
        name.className = 'zc-name'
        name.textContent = `${member.emoji} `
        const strong = document.createElement('b')
        strong.textContent = member.display || member.name
        name.append(strong)
        const status = statusOf(member.name)
        const chip = document.createElement('span')
        chip.className = 'zc-chip-status'
        chip.dataset.phase = status.phase
        chip.textContent = status.label
        row.append(dot, name, chip)
        const call = document.createElement('button')
        call.className = 'zc-btn'
        call.textContent = '▶'
        call.title = 'Call this member in'
        call.onclick = async () => { await run('assemble', { session_id: sessionId, name: member.name }, note); reload(sessionId) }
        row.append(call)
        if (status.phase !== 'off') {
          const say = document.createElement('button')
          say.className = 'zc-btn'
          say.textContent = '💬'
          say.title = 'Say something (as the human)'
          say.onclick = () => openSay(row, member, sessionId, note)
          row.append(say)
          const dismiss = document.createElement('button')
          dismiss.className = 'zc-btn'
          dismiss.textContent = '⏸'
          dismiss.title = 'Interrupt their current turn'
          dismiss.onclick = async () => { await run('dismiss', { session_id: sessionId, name: member.name }, note); reload(sessionId) }
          row.append(dismiss)
        }
        const pen = document.createElement('button')
        pen.className = 'zc-btn'
        pen.textContent = '✎'
        pen.title = 'Edit this cast member'
        pen.onclick = () => editMember(member, list, sessionId, note)
        row.append(pen)
        list.append(row)
      }
    }

    function openSay(row, member, sessionId, note) {
      if (row.querySelector('.zc-say') !== null) return
      const line = document.createElement('div')
      line.className = 'zc-say'
      const input = document.createElement('input')
      input.placeholder = `Say to ${member.display || member.name}…`
      const send = document.createElement('button')
      send.className = 'zc-btn'
      send.textContent = 'Send'
      const submit = async () => {
        if (input.value.trim() === '') return
        await run('say', { session_id: sessionId, name: member.name, text: input.value }, note)
        line.remove()
      }
      send.onclick = submit
      input.onkeydown = (event) => { if (event.key === 'Enter') submit() }
      line.append(input, send)
      row.after(line)
      input.focus()
    }

    /** Cast editor for one member (or a new one); saving POSTs the whole doc. */
    function editMember(member, list, sessionId, note) {
      const editor = document.createElement('div')
      editor.className = 'zc-editor'
      const fields = {}
      const field = (key, label, kind, placeholder) => {
        const el = document.createElement(kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'input')
        el.placeholder = placeholder ?? ''
        if (kind === 'color') el.type = 'color'
        if (kind === 'select') {
          const options = ['', ...state.permissionOptions]
          for (const value of options) {
            const option = document.createElement('option')
            option.value = value
            option.textContent = value === '' ? '(inherit)' : value
            el.append(option)
          }
        }
        const labelEl = document.createElement('label')
        labelEl.textContent = label
        labelEl.style.fontSize = '11px'
        labelEl.style.color = 'var(--dsw-alias-label-tertiary,#777)'
        editor.append(labelEl, el)
        fields[key] = el
        return el
      }
      field('name', 'name (lower-kebab, permanent)', 'text')
      field('display', 'display name', 'text')
      field('emoji', 'emoji', 'text')
      field('color', 'bubble color', 'color')
      field('context', 'context', 'select')
      const ctx = fields.context
      ctx.textContent = ''
      for (const value of ['fresh', 'fork']) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        ctx.append(option)
      }
      field('permission', 'permission preset', 'select')
      field('model', 'model  provider/model[/effort]', 'text', 'inherit')
      field('systemPrompt', 'system prompt (persona)', 'textarea', '(standard base only)')
      field('modeTemplate', 'mode template (behavior)', 'textarea', '(standard mode)')
      field('kickoff', 'kickoff extra', 'textarea', '')
      if (member !== null) {
        fields.name.value = member.name
        fields.display.value = member.display
        fields.emoji.value = member.emoji
        fields.color.value = member.color
        fields.context.value = member.context
        fields.permission.value = member.permission
        fields.model.value = member.model
        fields.systemPrompt.value = member.systemPrompt
        fields.modeTemplate.value = member.modeTemplate
        fields.kickoff.value = member.kickoff
      } else {
        fields.color.value = '#888888'
        fields.context.value = 'fresh'
      }
      const buttons = document.createElement('div')
      buttons.style.display = 'flex'
      buttons.style.gap = '6px'
      const save = document.createElement('button')
      save.className = 'zc-btn'
      save.textContent = 'Apply'
      const cancel = document.createElement('button')
      cancel.className = 'zc-btn'
      cancel.textContent = 'Cancel'
      save.onclick = async () => {
        const next = state.cast.filter((entry) => entry.name !== member?.name)
        next.push(Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, el.value])))
        try {
          await api('/save', { session_id: sessionId, doc: { version: 1, defaults: state.defaults, cast: next } })
          note.textContent = ''
          editor.remove()
          await reload(sessionId)
        } catch (error) {
          note.textContent = error instanceof Error ? error.message : String(error)
        }
      }
      cancel.onclick = () => editor.remove()
      buttons.append(save, cancel)
      editor.append(buttons)
      list.append(editor)
      fields.name.focus()
    }

    // ---------- header slot shell ----------
    function apply(ctx) {
      const { slots, conversation } = ctx
      window.__dzcConversation = conversation

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = NAME
        style.textContent = CSS
        document.head.appendChild(style)
        const observer = new MutationObserver(scheduleScan)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
          style.remove()
          closePanel()
          document.body.removeAttribute('data-zc-self')
        }
      }, `${NAME}: styles + observer`)

      function CastButton({ sessionId }) {
        const ref = React.useRef(null)
        const [open, setOpen] = React.useState(false)
        // Prime colors for this conversation even if the panel never opens.
        React.useEffect(() => {
          api('/cast?session_id=' + encodeURIComponent(sessionId)).then(refresh, () => {})
        }, [sessionId])
        return h('button', {
          ref,
          type: 'button',
          className: 'zc-btn',
          title: 'Zoom-Call cast: personas with their own system prompts, colors and inboxes in this session',
          'aria-expanded': open,
          onClick: (event) => {
            if (open) {
              closePanel()
              setOpen(false)
              return
            }
            setOpen(true)
            openPanel(sessionId, event.currentTarget)
            const onDoc = (e) => {
              if (panel !== undefined && !panel.contains(e.target) && e.target !== event.currentTarget) {
                closePanel()
                setOpen(false)
                document.removeEventListener('pointerdown', onDoc)
              }
            }
            document.addEventListener('pointerdown', onDoc)
          },
        }, '🎥')
      }

      ctx.effect(() => slots.register({
        name: 'conversation.session.header.actions',
        id: NAME,
        order: 5,
      }, CastButton), `${NAME}: header action`)
    }

    return { inject: ['slots', 'conversation'], apply }
  },
})
