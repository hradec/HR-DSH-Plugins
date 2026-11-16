# dsh-chat-wide

A pure client plugin for the DSH Web GUI.

- Removes the centered conversation-column width ceiling.
- Applies the available width to the chat flow and user message stack.
- Renders ANSI SGR controls such as `\x1b[31mred\x1b[0m`.
- Renders IRC controls such as `\x0304red` and `\x0304,01red`.
- Supports reset, bold, underline, and reverse-video controls.

The plugin has no Host services and makes no network requests.
