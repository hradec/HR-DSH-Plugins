# dsh-sidebar-top-section

Pure client plugin for the DeepSeek Harness Web GUI. It groups the sidebar's
**New Session**, **Plugins**, and **Automation tasks** controls above Workspaces
under a **Quick access** section.

The section starts closed on each page load. Click its header to reveal or hide
the existing controls; their native actions, labels, focus behavior, and panel
selection remain unchanged. When the sidebar enters its compact rail, the
shipped New Session icon remains available and the global panel rows stay
hidden as they do in the native sidebar.

No Host service, network request, Session data, or localStorage setting is used.
The plugin observes the shipped sidebar DOM so it can recover after React
rerenders without replacing the sidebar component.

## Install

Add the package as a local dependency and include `@local/dsh-sidebar-top-section`
in the Web profile's selected bundles. The package's `dsh.bundle.patch` adds the
Loader row, and the `dsh.client` declaration exposes the browser bundle. With
`patchReload: live`, a page refresh is enough after the profile composes the row.
