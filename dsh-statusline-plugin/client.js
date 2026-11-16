window.__ModuleLoader__.load({
  id: '@local/dsh-statusline',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // Localhost keeps the direct Host endpoint; remote browsers (iPad on the LAN)
    // reach the same data through the 3083 socat bridge, since 127.0.0.1 is their own device.
    const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);
    const ENDPOINT = LOOPBACK ? 'http://127.0.0.1:3082/status' : `http://${location.hostname}:3083/status`;

    // ANSI SGR foreground/background codes → CSS colours. Only the codes a shell
    // status line realistically emits are handled; anything else is ignored.
    const FOREGROUND = {
      30: '#3b4048', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef',
      35: '#c678dd', 36: '#56b6c2', 37: '#dcdfe4',
      90: '#5c6370', 91: '#ef6a75', 92: '#50d890', 93: '#e7be4f', 94: '#61afef',
      95: '#c678dd', 96: '#56b6c2', 97: '#ffffff',
    };
    const BACKGROUND = {
      40: '#3b4048', 41: '#e06c75', 42: '#98c379', 43: '#e5c07b', 44: '#61afef',
      45: '#c678dd', 46: '#56b6c2', 47: '#dcdfe4',
      100: '#5c6370', 101: '#ef6a75', 102: '#50d890', 103: '#e7be4f', 104: '#61afef',
      105: '#c678dd', 106: '#56b6c2', 107: '#ffffff',
    };

    // Split a string with SGR escapes into styled text runs.
    function segments(text) {
      const parts = [];
      const pattern = /\x1b\[([0-9;]*)m/g;
      let style = {};
      let index = 0;
      let match;
      const push = (chunk) => {
        if (chunk) parts.push({ text: chunk, style: { ...style } });
      };
      while ((match = pattern.exec(text))) {
        push(text.slice(index, match.index));
        index = pattern.lastIndex;
        const params = match[1] === '' ? [0] : match[1].split(';').map(Number);
        for (const code of params) {
          if (code === 0) style = {};
          else if (code === 1) style.fontWeight = 700;
          else if (code === 2) style.opacity = 0.6;
          else if (code === 4) style.textDecoration = 'underline';
          else if (code === 7) style.filter = 'invert(1)';
          else if (code === 22) { delete style.fontWeight; delete style.opacity; }
          else if (code === 24) delete style.textDecoration;
          else if (code === 27) delete style.filter;
          else if (code === 39) delete style.color;
          else if (code === 49) delete style.background;
          else if (FOREGROUND[code]) style.color = FOREGROUND[code];
          else if (BACKGROUND[code]) style.background = BACKGROUND[code];
        }
      }
      push(text.slice(index));
      return parts;
    }

    function Status() {
      const [data, setData] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const update = () => fetch(ENDPOINT).then((r) => r.json()).then((v) => alive && setData(v)).catch(() => {});
        update();
        const timer = setInterval(update, 30000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const shell = { display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto', order: 2, padding: '3px 10px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', whiteSpace: 'nowrap' };
      if (data?.error) return h('div', { style: shell }, h('span', { style: { color: '#ef6a75' } }, data.error));
      // One flex child holding all runs: colour changes must not inherit the dock gap.
      return h('div', { style: shell }, h('span', null, segments(data?.line ?? '').map((part, index) => h('span', { key: index, style: part.style }, part.text))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'dsh-statusline', order: 90,
        }, Status));
      },
    };
  },
});
