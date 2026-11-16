/**
 * dsh-session-agent-preset — replace the read-only header label with a picker.
 *
 * The option rows and menu behavior mirror the shipped new-session preset seat.
 * The Host owns validation, idle serialization, composition changes, and logging.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-agent-preset',
  factory(require) {
    const React = require('react')
    const { Menu, IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NAME = 'dsh-session-agent-preset'
    const BUILTIN_COPY = {
      standard: ['presetStandardName', 'presetStandardDescription'],
      ptc: ['presetPtcName', 'presetPtcDescription'],
      minimal: ['presetMinimalName', 'presetMinimalDescription'],
      cordis: ['presetCordisName', 'presetCordisDescription'],
    }

    /** Match the shipped seat's localized labels for built-in modes. */
    function displayText(preset, t) {
      const keys = preset.name === undefined ? BUILTIN_COPY[preset.id] : undefined
      if (keys !== undefined) return { name: t(keys[0]), description: t(keys[1]) }
      return { name: preset.name ?? preset.id, description: preset.description ?? t('noDescription') }
    }

    const CSS = `
/* Keep the shipped mode label as a fallback if our dropdown cannot mount. */
body:has(.dsap-seat) .SVAs4q_label{display:none!important}
.dsap-menu-anchor{display:inline-flex;max-width:180px}
.dsap-seat{
  display:inline-flex;align-items:center;gap:4px;max-width:180px;height:22px;box-sizing:border-box;
  padding:0 5px;border:0;border-radius:var(--dsw-radius-xs,4px);
  background:var(--dsw-alias-fill-tsp-secondary,rgba(0,0,0,.06));
  color:var(--dsw-alias-label-tertiary,#777);font-family:inherit;font-size:12px;line-height:22px;white-space:nowrap;cursor:pointer;
}
.dsap-seat:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));color:var(--dsw-alias-label-primary,#222)}
.dsap-seat:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}
.dsap-seat:disabled{opacity:.55;cursor:wait}
.dsap-seat-label{overflow:hidden;text-overflow:ellipsis}
.dsap-seat-icon,.dsap-chevron{flex:none;opacity:.75}
.dsap-item{display:flex;min-width:180px;flex-direction:column;gap:2px;white-space:normal}
.dsap-item-name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#222)}
.dsap-item-description{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#777)}
.dsap-error{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@container (width<=540px){.dsap-menu-anchor{max-width:140px}.dsap-seat{max-width:140px}}
`

    /** Ask the Host for the current preset roster once per mounted control. */
    async function readPresets(ctx) {
      const response = await ctx.connection.rpc.call('/api', 'agentPresets/list', { args: {} })
      if (!response.ok) throw new Error(response.error?.message ?? 'Could not load Agent presets')
      return Array.isArray(response.value?.presets) ? response.value.presets : []
    }

    /** Render the active session's preset control in the header actions slot. */
    function SessionPresetControl({ sessionId, useSessions, roster, change, t }) {
      const current = useSessions((state) => {
        const id = state.byId[sessionId]?.projectionValues?.agentPreset
        return typeof id === 'string' ? id : ''
      })
      const [open, setOpen] = React.useState(false)
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState('')
      const selected = roster.find((preset) => preset.id === current)
      const label = selected === undefined ? current : displayText(selected, t).name
      const items = roster.filter((preset) => preset.broken === undefined).map((preset) => {
        const text = displayText(preset, t)
        return {
          id: preset.id,
          label: h('span', { className: 'dsap-item' },
            h('span', { className: 'dsap-item-name' }, text.name),
            h('span', { className: 'dsap-item-description' }, text.description)),
        }
      })

      return h(React.Fragment, null,
        h(Menu, {
          open: open && items.length > 0,
          onClose: () => setOpen(false),
          items,
          selectedId: current,
          onSelect: async (id) => {
            setOpen(false)
            if (pending || id === current) return
            setPending(true)
            setError('')
            try {
              await change(sessionId, id)
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure))
            } finally {
              setPending(false)
            }
          },
          align: 'start',
          portal: true,
          className: 'dsap-menu-anchor',
          anchor: h('button', {
            type: 'button',
            className: 'dsap-seat',
            'aria-haspopup': 'menu',
            'aria-expanded': open && items.length > 0,
            'aria-label': `Agent preset: ${label || 'not set'}`,
            title: error || (selected === undefined ? t('seatHint') : displayText(selected, t).description),
            disabled: pending || items.length === 0,
            onClick: () => setOpen((value) => !value),
          },
          h(IconAgentPresetOutlineRegular, { size: 14, className: 'dsap-seat-icon' }),
          h('span', { className: 'dsap-seat-label' }, pending ? 'Switching…' : (label || 'Preset')),
          h(IconChevronDownOutlineRegular, { size: 12, className: 'dsap-chevron' })),
        }),
        error ? h('span', { className: 'dsap-error', role: 'status', 'aria-live': 'polite' }, error) : null)
    }

    /** Bind stable Host callbacks and the current preset roster. */
    function apply(ctx) {
      let roster = []
      let loading = false
      let loaded = false
      let rosterPromise

      async function ensureRoster() {
        if (loaded) return roster
        if (loading) return rosterPromise
        loading = true
        rosterPromise = readPresets(ctx).then((value) => {
          roster = value
          loaded = true
          return roster
        }).finally(() => { loading = false })
        return rosterPromise
      }

      const change = async (sessionId, agentPreset) => {
        const response = await ctx.connection.rpc.call('/api', 'sessionAgentPreset/change', {
          args: { sessionId, agentPreset },
        })
        if (!response.ok) throw new Error(response.error?.message ?? 'Preset switch was refused')
        return response.value
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = NAME
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, `${NAME}: styles`)

      function BoundControl(props) {
        const [, setRevision] = React.useState(0)
        React.useEffect(() => {
          let live = true
          ensureRoster().then(() => { if (live) setRevision((n) => n + 1) }).catch((error) => {
            console.warn(`${NAME}: could not load preset roster:`, error)
          })
          return () => { live = false }
        }, [])
        if (!loaded) return null
        return h(SessionPresetControl, { ...props, roster, change, t: props.t })
      }

      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: NAME,
        order: -10,
        locale: 'settings.agentPreset',
      }, BoundControl))
    }

    return { inject: ['slots', 'connection'], apply }
  },
})
