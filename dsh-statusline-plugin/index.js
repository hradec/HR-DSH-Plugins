import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const PORT = 3082;
const HOST = '127.0.0.1';
// Same one-line command MiniMax Code runs, so editing the shell scripts updates both harnesses.
// ponytail: fixed default path, override with STATUSLINE_SCRIPT; add plugin config if a real need appears.
const SCRIPT = process.env.STATUSLINE_SCRIPT ?? path.join(process.env.HOME ?? '/home/rhradec', '.minimax/statusline/combined-status.sh');
const TIMEOUT = 2500;
const execFileAsync = promisify(execFile);

// Run the status-line script once. Its stdout may contain ANSI SGR codes; the client renders them.
async function statusLine() {
  try {
    const { stdout } = await execFileAsync(SCRIPT, [], {
      timeout: TIMEOUT,
      maxBuffer: 1 << 20,
      env: { ...process.env, STATUS_COLOR: 'ansi' },
    });
    return { line: stdout.replace(/\n+$/, ''), updatedAt: Date.now() };
  } catch (error) {
    const failure = error.killed ? 'timeout' : typeof error.code === 'number' ? `exit ${error.code}` : String(error.code ?? error.signal ?? error.message);
    return { line: '', error: `script failed (${failure})`, updatedAt: Date.now() };
  }
}

export function apply(ctx) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/status') {
      response.writeHead(404); response.end(); return;
    }
    const value = await statusLine();
    response.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value));
  });
  server.listen(PORT, HOST);
  ctx.effect(() => () => server.close());
}
