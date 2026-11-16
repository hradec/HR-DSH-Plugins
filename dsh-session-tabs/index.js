/**
 * Host half of @local/dsh-session-tabs.
 *
 * The plugin is pure browser UI: all of its behavior lives in `client.js`.
 * This entry exists so the profile can enable the package through an ordinary
 * Loader row, which is also what makes the Web module graph pick up the
 * declared `dsh.client` bundle.
 */

export const name = 'dsh-session-tabs'

/** No Host services, no configuration, no model-visible effect. */
export function apply() {}
