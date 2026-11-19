// A stand-in Linux shell for the Files › Linux files browser: answers the browser's commands (src/linuxfiles.js:
// the first line "# ocm-files <op> <base64 path> [arg]") from a small in-memory disk, the way the real scripts do.
export function installFakeLinux() {
  const enc = (s) => new TextEncoder().encode(s);
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const disk = {
    '/root/demogame/README.md': enc('# Demo Game\n\nA game.\n'),
    '/root/demogame/src/main.js': enc('export const answer = 42;\n'),
    '/root/demogame/src/world/map.js': enc('export default {};\n'),
    "/root/demogame/notes with 'quotes' é.txt": enc('odd name works'),
    '/root/demogame/logo.png': png,
    '/root/demogame/node_modules/left-pad/index.js': enc('module.exports = 1;'),
    '/root/keys/deploy': enc('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n'),
    '/root/.config/chronicle/gh-token': enc('gho_secret_token_value'),
    '/root/.config/chronicle/ssh/id_ed25519': enc('-----BEGIN OPENSSH PRIVATE KEY-----\nzz\n'),
    '/root/.config/git/config': enc('[user]\n'),
    '/tmp/build.log': enc('ok\n'),
  };
  for (let i = 0; i < 40; i++) disk[`/root/demogame/.git/objects/${String(i).padStart(2, '0')}/abc`] = enc('x'.repeat(100));
  const H = '/root/.config/chronicle';
  const T = 1700000000;
  const dirs = new Set(['/']);
  for (const p of Object.keys(disk)) {
    const parts = p.split('/');
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
  const b64 = (u8) => {
    let s = '';
    for (const x of u8) s += String.fromCharCode(x);
    return btoa(s);
  };
  const norm = (p) => {
    const out = [];
    for (const x of p.split('/')) {
      if (!x || x === '.') continue;
      if (x === '..') out.pop();
      else out.push(x);
    }
    return '/' + out.join('/');
  };
  const kids = (d) => {
    const pre = d === '/' ? '/' : d + '/';
    const names = new Set();
    for (const p of [...Object.keys(disk), ...dirs]) if (p.startsWith(pre) && p !== d) names.add(p.slice(pre.length).split('/')[0]);
    return [...names];
  };
  const hidden = (r) => r === H || r.startsWith(H + '/');
  const sizeOf = (d) => Object.entries(disk).filter(([p]) => p.startsWith(d + '/')).reduce((t, [, v]) => t + v.length, 0);
  globalThis.__linuxDisk = disk;
  globalThis.__linuxCalls = [];
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true }),
    install: async () => {},
    uninstall: async () => {},
    kill: async () => {},
    addListener: async () => ({ remove() {} }),
    exec: async ({ id, cmd }) => {
      const m = /^# ocm-files (\w+) (\S+)(?: (\S+))?/.exec(cmd);
      globalThis.__linuxCalls.push({ id, op: m?.[1] || cmd.slice(0, 40) });
      if (!m) return { output: '', exit: 0 };
      const [, op, pb, arg] = m;
      const r = norm(dec(pb));
      const isDir = dirs.has(r);
      const out = [];
      const done = () => ({ output: out.join('\n') + '\n', exit: 0 });
      if (!isDir && !disk[r]) return (out.push('@@ERR missing'), done());
      if (hidden(r)) return (out.push('@@ERR hidden'), done());
      out.push('@@REAL', r);
      const pre = r === '/' ? '/' : r + '/';
      if (op === 'list') {
        if (!isDir) return (out.push('@@ERR notdir'), done());
        out.push('@@STAT');
        const ks = kids(r);
        for (const k of ks) out.push(dirs.has(pre + k) ? `41ed|4096|${T}|${k}` : `81a4|${disk[pre + k].length}|${T}|${k}`);
        out.push('@@LINKDIRS', '@@COUNT');
        for (const k of ks) if (dirs.has(pre + k) && k !== '.git' && k !== 'node_modules') out.push(`${kids(pre + k).length}|${k}`);
        out.push('@@END');
      } else if (op === 'read') {
        if (isDir) return (out.push('@@DIR'), done());
        const d = disk[r];
        out.push('@@SIZE', `${d.length}|${T}`);
        const chunk = Number(arg);
        if (chunk >= 0) out.push('@@B64', b64(d.subarray(chunk * 1048576, (chunk + 1) * 1048576)));
        out.push('@@END');
      } else if (op === 'du') {
        out.push('@@DU');
        for (const n of String(arg || '').split(',').filter(Boolean).map(dec)) out.push(`${Math.ceil(sizeOf(pre + n) / 1024)}\t${n}`);
        out.push('@@END');
      } else if (op === 'tree') {
        out.push('@@FILES');
        for (const [p, d] of Object.entries(disk)) if (p.startsWith(pre) && !hidden(p) && !/\/(\.git|node_modules)\//.test(p.slice(r.length))) out.push(`${d.length}|${p}`);
        out.push('@@SKIPPED');
        for (const d of dirs) if (d.startsWith(pre) && /\/(\.git|node_modules)$/.test(d) && !/\/(\.git|node_modules)\/./.test(d)) out.push(d);
        out.push('@@END');
      }
      return done();
    },
  };
}
