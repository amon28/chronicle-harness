/**
 * stdio MCP servers ("npx -y @modelcontextprotocol/server-…", "uvx mcp-server-…", "python3 server.py") run in the
 * app's Linux behind mcp-bridge (src/toolkit/mcp-bridge), which serves them as Streamable HTTP on 127.0.0.1 with a
 * per-server secret. The normal MCP client then talks to that address, so caching, tool lists and calls are shared.
 */
import { ensureCmd, pkgInstall } from './pkg.js';
import { canUseShell, ensureShellToolkit, runShell } from './shell.js';
import { httpRequest } from './api.js';

export const isStdio = (s) => s?.transport === 'stdio';
/** A port per server, stable across restarts: 39100–39899. */
export function bridgePort(server) {
  let h = 0;
  for (const c of String(server.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 39100 + (h % 800);
}
export const bridgeUrl = (server) => `http://127.0.0.1:${bridgePort(server)}/mcp`;
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** What the command needs installed in Linux first (Debian or Alpine, decision 190). */
export function needs(command) {
  const c = String(command || '').trim().split(/\s+/)[0];
  if (/^(npx|node|npm|pnpm)$/.test(c)) return ensureCmd('node', { apt: 'nodejs npm', apk: 'nodejs npm' });
  // Debian has no uv package: pip puts it in /usr/local/bin
  if (/^(uvx|uv)$/.test(c)) return `{ command -v uvx >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 && ${pkgInstall({ apt: 'python3-pip', apk: 'py3-pip' })} && pip3 install -q --break-system-packages uv >/dev/null 2>&1; } || apk add --no-cache uv >/dev/null 2>&1; }`;
  return '';
}

/** The shell command that starts the bridge in the background (detached, logging to /tmp). */
export function startCommand(server) {
  const log = `/tmp/mcp-${String(server.id).replace(/[^\w-]/g, '')}.log`;
  return [
    ensureCmd('python3', { apt: 'python3', apk: 'python3' }),
    needs(server.command),
    `setsid nohup mcp-bridge --port ${bridgePort(server)} --secret ${q(server.bridgeSecret)} ${server.cwd ? `--cwd ${q(server.cwd)} ` : ''}-- sh -c ${q(server.command)} > ${log} 2>&1 < /dev/null &`,
    'echo started',
  ]
    .filter(Boolean)
    .join('\n');
}

async function health(server) {
  try {
    const r = await httpRequest(bridgeUrl(server).replace(/\/mcp$/, '/health'), { method: 'GET', headers: { Authorization: `Bearer ${server.bridgeSecret}` }, timeoutMs: 3000 });
    return r.status === 200 ? 'up' : r.status === 503 ? 'exited' : r.status === 401 ? 'other' : 'down';
  } catch {
    return 'down';
  }
}

const starting = new Map();
/** Make sure the bridge for this server is up (start it, or start it again after the app or the server stopped). */
export function ensureBridge(server, { exec = runShell, wait = 60000 } = {}) {
  if (starting.has(server.id)) return starting.get(server.id);
  const job = (async () => {
    if ((await health(server)) === 'up') return;
    if (!globalThis.__ocmShell && !canUseShell()) throw new Error(`${server.name}: stdio servers need the built-in Linux (Settings › Linux terminal)`);
    await ensureShellToolkit('mcp').catch(() => {});
    const kill = `pkill -f ${q(`mcp-bridge --port ${bridgePort(server)} `)} 2>/dev/null; true`;
    await exec(`${kill}\n${startCommand(server)}`, { id: 'mcp', timeoutMs: 300000 });
    const until = Date.now() + wait;
    for (;;) {
      const h = await health(server);
      if (h === 'up') return;
      if (h === 'exited' || h === 'other' || Date.now() > until) {
        const log = await exec(`tail -n 15 /tmp/mcp-${String(server.id).replace(/[^\w-]/g, '')}.log 2>/dev/null`, { id: 'mcp', timeoutMs: 10000 }).catch(() => ({ output: '' }));
        throw new Error(`${server.name}: the server did not start${log?.output ? `:\n${String(log.output).slice(-800)}` : ''}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  })().finally(() => starting.delete(server.id));
  starting.set(server.id, job);
  return job;
}
