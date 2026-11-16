/**
 * dsh-chat-wide — full-width conversation layout and terminal color rendering.
 *
 * The plugin is intentionally DOM-only: it does not change session data or send
 * network requests. CSS removes the shipped conversation column ceiling, while
 * a small MutationObserver decorates ANSI/IRC color controls as spans.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-chat-wide',
  factory() {
    const ANSI_COLORS = [
      '#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa',
      '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff',
    ]
    const IRC_COLORS = [
      '#ffffff', '#000000', '#00007f', '#009300', '#ff0000', '#7f0000', '#9c009c', '#fc7f00',
      '#ffff00', '#00fc00', '#009393', '#00ffff', '#0000fc', '#ff00ff', '#7f7f7f', '#d2d2d2',
    ]

    const CSS = `
/* ponytail: override only the shipped chat width hooks; side panels remain intact. */
.EvIC1a_scroll{--dsh-chat-content-width:100%}
.EvIC1a_column{max-width:none!important}
.Sixlwa_userStack{max-width:100%!important}
.dsh-chat-wide-color{font:inherit}
.dsh-chat-wide-color[data-dsh-fg]{color:var(--dsh-chat-wide-fg)}
.dsh-chat-wide-color[data-dsh-bg]{background-color:var(--dsh-chat-wide-bg)}
.dsh-chat-wide-color[data-dsh-bold]{font-weight:700}
.dsh-chat-wide-color[data-dsh-underline]{text-decoration:underline}
.dsh-chat-wide-color[data-dsh-reverse]{filter:invert(1)}
`

    function injectStyle() {
      if (document.querySelector('style[data-dsh-chat-wide]')) return
      const style = document.createElement('style')
      style.dataset.dshChatWide = 'true'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function parseControls(value) {
      if (!/[\x1b\x03\x0f\x02\x1f\x16]/.test(value)) return null
      const fragment = document.createDocumentFragment()
      let state = { fg: null, bg: null, bold: false, underline: false, reverse: false }
      let text = ''
      let changed = false

      const flush = () => {
        if (!text) return
        const span = document.createElement('span')
        span.className = 'dsh-chat-wide-color'
        span.dataset.dshAnsi = 'true'
        if (state.fg !== null) { span.dataset.dshFg = ''; span.style.setProperty('--dsh-chat-wide-fg', state.fg) }
        if (state.bg !== null) { span.dataset.dshBg = ''; span.style.setProperty('--dsh-chat-wide-bg', state.bg) }
        if (state.bold) span.dataset.dshBold = ''
        if (state.underline) span.dataset.dshUnderline = ''
        if (state.reverse) span.dataset.dshReverse = ''
        span.textContent = text
        fragment.appendChild(span)
        text = ''
      }

      const reset = () => { state = { fg: null, bg: null, bold: false, underline: false, reverse: false } }
      const ansi = (code, target) => {
        if (code === 0) reset()
        else if (code === 1) state.bold = true
        else if (code === 22) state.bold = false
        else if (code === 4) state.underline = true
        else if (code === 24) state.underline = false
        else if (code === 7) state.reverse = true
        else if (code === 27) state.reverse = false
        else if (code === 39) state.fg = null
        else if (code === 49) state.bg = null
        else if (code >= 30 && code <= 37) state.fg = ANSI_COLORS[code - 30]
        else if (code >= 90 && code <= 97) state.fg = ANSI_COLORS[code - 90 + 8]
        else if (code >= 40 && code <= 47) state.bg = ANSI_COLORS[code - 40]
        else if (code >= 100 && code <= 107) state.bg = ANSI_COLORS[code - 100 + 8]
        else if (code === 38 || code === 48) {
          const extended = target.slice(0, 2)
          if (extended[0] === 5 && Number.isFinite(Number(extended[1]))) {
            const n = Math.max(0, Math.min(255, Number(extended[1])))
            const color = `rgb(${n < 16 ? (n & 1 ? 255 : 0) : Math.round((n - 16) / 36) * 51},${n < 16 ? (n & 2 ? 255 : 0) : Math.round(((n - 16) % 36) / 6) * 51},${n < 16 ? (n & 4 ? 255 : 0) : (n >= 232 ? (n - 232) * 10 + 8 : (n % 6) * 51)})`
            if (code === 38) state.fg = color
            else state.bg = color
          }
        }
      }

      for (let i = 0; i < value.length;) {
        if (value[i] === '\x1b' && value[i + 1] === '[') {
          const end = value.indexOf('m', i + 2)
          if (end !== -1) {
            flush()
            const params = value.slice(i + 2, end).split(';').map((v) => v === '' ? 0 : Number(v))
            for (let p = 0; p < params.length; p += 1) ansi(params[p], params.slice(p + 1))
            changed = true
            i = end + 1
            continue
          }
        }
        if (value[i] === '\x03') {
          flush()
          let end = i + 1
          let fg = ''
          while (end < value.length && fg.length < 2 && /\d/.test(value[end])) fg += value[end++]
          let bg = ''
          if (value[end] === ',') {
            end += 1
            while (end < value.length && bg.length < 2 && /\d/.test(value[end])) bg += value[end++]
          }
          if (fg) state.fg = IRC_COLORS[Number(fg) % IRC_COLORS.length]
          if (bg) state.bg = IRC_COLORS[Number(bg) % IRC_COLORS.length]
          changed = true
          i = end
          continue
        }
        if (value[i] === '\x0f') { flush(); reset(); changed = true; i += 1; continue }
        if (value[i] === '\x02') { flush(); state.bold = !state.bold; changed = true; i += 1; continue }
        if (value[i] === '\x1f') { flush(); state.underline = !state.underline; changed = true; i += 1; continue }
        if (value[i] === '\x16') { flush(); state.reverse = !state.reverse; changed = true; i += 1; continue }
        text += value[i++]
      }
      flush()
      return changed ? fragment : null
    }

    function colorize(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes = []
      let node
      while ((node = walker.nextNode())) {
        const parent = node.parentElement
        if (parent?.closest('[data-dsh-ansi],script,style,textarea,input')) continue
        if (/[\x1b\x03\x0f\x02\x1f\x16]/.test(node.nodeValue)) nodes.push(node)
      }
      for (const textNode of nodes) {
        const replacement = parseControls(textNode.nodeValue)
        if (replacement) textNode.replaceWith(replacement)
      }
    }

    function start() {
      const boot = () => {
        injectStyle()
        const scan = () => document.querySelectorAll('.EvIC1a_scroll,[data-conversation-scroll]').forEach(colorize)
        scan()
        const observer = new MutationObserver((records) => {
          for (const record of records) for (const added of record.addedNodes) {
            if (added.nodeType === Node.ELEMENT_NODE || added.nodeType === Node.TEXT_NODE) {
              const parent = added.nodeType === Node.TEXT_NODE ? added.parentElement : added
              if (parent) colorize(parent)
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
      }
      if (document.body) boot()
      else document.addEventListener('DOMContentLoaded', boot, { once: true })
    }

    return { inject: [], apply() { start() } }
  },
})
