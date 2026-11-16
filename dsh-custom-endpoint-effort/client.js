/**
 * custom-endpoint-effort — client half.
 *
 * Two jobs, both on the model-selection service:
 *
 * 1. The shared model catalog is cached per Host generation, so opening the
 *    picker normally reuses it. Invalidating it when a directory loads makes
 *    the Host re-read its catalog, which lets the Host half notice the weekly
 *    cache expiry. Inside the week this costs one local Host call, no fetch.
 *
 * 2. The picker sends a model's default effort when the model changes, so a
 *    switch forgot what was selected last time. For custom routes this wraps
 *    `directory.select`: a model switch restores that model's remembered
 *    effort, and an explicit effort choice remembers it. Built-in
 *    `deepseek-account` models keep their native behaviour.
 *
 * No network access, no credentials, no UI.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-custom-endpoint-effort',
  factory(require) {
    const LOAD_WRAPPED = '__customEndpointEffortLoad'
    const SELECT_WRAPPED = '__customEndpointEffortSelect'
    const EFFORT_STORE = 'dsh.custom-endpoint-effort.effortByModel'
    const BUILT_IN_PROVIDER = 'deepseek-account'

    const readEfforts = () => {
      try {
        const parsed = JSON.parse(localStorage.getItem(EFFORT_STORE) ?? '{}')
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }
    const writeEffort = (key, effort) => {
      try {
        const efforts = readEfforts()
        efforts[key] = effort
        localStorage.setItem(EFFORT_STORE, JSON.stringify(efforts))
      } catch {
        /* private mode or quota: selection still works, memory is lost */
      }
    }
    const modelKey = (selection) => `${selection.provider}/${selection.model}`
    const reasoningOf = (resolver, selection) => {
      try {
        return resolver.catalog?.reasoningFor?.(selection) ?? undefined
      } catch {
        return undefined
      }
    }

    const wrap = (resolver, directory) => {
      if (directory === null || typeof directory !== 'object') return directory

      if (directory[LOAD_WRAPPED] !== true && typeof directory.load === 'function') {
        const load = directory.load
        Object.defineProperty(directory, LOAD_WRAPPED, { value: true, enumerable: false, configurable: true })
        directory.load = function (...args) {
          // Invalidate, never load here: the caller's own load then performs the
          // single fresh Host read, and its store keeps driving the menu.
          try {
            const catalog = resolver.catalog
            if (catalog !== undefined && typeof catalog.invalidate === 'function') catalog.invalidate()
          } catch {
            /* a catalog that cannot be invalidated still gets its normal load */
          }
          return load.apply(this, args)
        }
      }

      if (directory[SELECT_WRAPPED] !== true && typeof directory.select === 'function') {
        const select = directory.select
        Object.defineProperty(directory, SELECT_WRAPPED, { value: true, enumerable: false, configurable: true })
        directory.select = function (selection) {
          if (
            selection === null ||
            typeof selection !== 'object' ||
            typeof selection.provider !== 'string' ||
            typeof selection.model !== 'string' ||
            selection.provider === BUILT_IN_PROVIDER
          ) {
            return select.call(this, selection)
          }

          const current = this.store?.getSnapshot?.().current
          const switching = current?.provider !== selection.provider || current?.model !== selection.model
          const reasoning = reasoningOf(resolver, selection)
          const levels = (reasoning?.efforts ?? []).map((level) => level.id)
          const defaultEffort = reasoning?.defaultEffort
          const explicit = selection.reasoningEffort !== undefined && selection.reasoningEffort !== defaultEffort
          let effort = selection.reasoningEffort
          if (switching && !explicit) {
            const remembered = readEfforts()[modelKey(selection)]
            if (remembered !== undefined && levels.includes(remembered)) effort = remembered
          } else if (!switching && effort === undefined) {
            effort = current?.reasoningEffort
          }

          const next = effort === selection.reasoningEffort ? selection : { ...selection, reasoningEffort: effort }
          return select.call(this, next).then((result) => {
            if (result?.ok === true && effort !== undefined && levels.includes(effort)) writeEffort(modelKey(selection), effort)
            return result
          })
        }
      }

      return directory
    }

    function apply(ctx) {
      const resolver = ctx.modelDirectories
      if (resolver === null || typeof resolver !== 'object' || typeof resolver.directoryFor !== 'function') return

      const original = resolver.directoryFor
      const replaced = function (sessionId) {
        return wrap(resolver, original.call(this, sessionId))
      }
      resolver.directoryFor = replaced

      // Directories created before this plugin ran keep their methods unwrapped,
      // so wrap every live one too; later ones are covered by directoryFor.
      const live = resolver.live?.directories?.values
      if (live !== undefined) for (const directory of live) wrap(resolver, directory)

      ctx.effect(() => () => {
        if (resolver.directoryFor === replaced) resolver.directoryFor = original
      }, 'custom-endpoint-effort: directoryFor')
    }

    return { inject: ['modelDirectories'], apply }
  },
})
