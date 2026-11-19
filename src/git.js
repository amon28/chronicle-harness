/**
 * Git for a chat's workspace, without Linux (isomorphic-git): a commit after every reply that changed files, the
 * history with "restore this version", and clone / pull / push to GitHub (or any https git host) with a token.
 * The repository's data lives next to the workspace (IndexedDB "git:<chat>"), not inside it.
 */
import { makeFs } from './gitfs.js';

let lib = null;
async function git() {
  if (!lib) {
    const { Buffer } = await import('buffer');
    globalThis.Buffer ||= Buffer; // isomorphic-git expects it
    lib = await import('isomorphic-git');
  }
  return lib;
}
const DIR = '/work';
const GITDIR = '/git';

/** An isomorphic-git HTTP client from a function http({ url, method, headers, body: Uint8Array }) → { status, headers, body: Uint8Array }. */
export function httpClient(send) {
  return {
    async request({ url, method = 'GET', headers = {}, body }) {
      let bytes = null;
      if (body) {
        const parts = [];
        for await (const c of body) parts.push(c);
        const n = parts.reduce((k, c) => k + c.byteLength, 0);
        bytes = new Uint8Array(n);
        let o = 0;
        for (const c of parts) (bytes.set(c, o), (o += c.byteLength));
      }
      const r = await send({ url, method, headers, body: bytes });
      return { url, method, statusCode: r.status, statusMessage: String(r.status), headers: r.headers || {}, body: [r.body || new Uint8Array()] };
    },
  };
}

const AUTHOR = (name) => ({ name: name || 'Chronicle', email: 'chronicle@localhost' });
const IGNORE = (p) => p.startsWith('.out/') || p.startsWith('node_modules/') || p.startsWith('.cache/');

/** A repo handle for one workspace. store: { git: {path: bytes} } (persisted by the caller). */
export function repo(workspace, store) {
  const fs = makeFs({ work: workspace, git: (store.git ||= {}) });
  const base = { fs, dir: DIR, gitdir: GITDIR };
  const has = () => !!store.git.HEAD;
  return {
    has,
    async init(branch = 'main') {
      const g = await git();
      if (!has()) await g.init({ ...base, defaultBranch: branch });
    },
    /** Stage every change (new, changed, deleted) and commit. → oid, or null when nothing changed. */
    async commitAll(message, { author } = {}) {
      const g = await git();
      if (!has()) await g.init({ ...base, defaultBranch: 'main' });
      const rows = await g.statusMatrix({ ...base, filter: (p) => !IGNORE(p) });
      let changed = 0;
      for (const [p, head, wd, stage] of rows) {
        if (head === 1 && wd === 1 && stage === 1) continue;
        changed++;
        if (wd === 0) await g.remove({ ...base, filepath: p });
        else await g.add({ ...base, filepath: p });
      }
      if (!changed) return null;
      return g.commit({ ...base, message: String(message || 'Changes').slice(0, 500), author: AUTHOR(author) });
    },
    async log(depth = 30) {
      const g = await git();
      if (!has()) return [];
      try {
        return (await g.log({ ...base, depth })).map((c) => ({ oid: c.oid, message: c.commit.message.trim(), at: c.commit.author.timestamp * 1000, author: c.commit.author.name }));
      } catch {
        return [];
      }
    },
    /** Files changed by a commit compared with its parent: [{ path, change: 'added'|'modified'|'deleted' }] */
    async changes(oid) {
      const g = await git();
      const c = await g.readCommit({ ...base, oid });
      const parent = c.commit.parent[0];
      const trees = parent ? [g.TREE({ ref: parent }), g.TREE({ ref: oid })] : [g.TREE({ ref: oid })];
      const out = [];
      await g.walk({
        ...base,
        trees,
        map: async (path, [a, b]) => {
          if (path === '.') return;
          const ta = parent ? await a?.type() : undefined;
          const tb = parent ? await b?.type() : await a?.type();
          if (ta === 'tree' || tb === 'tree') return;
          const oa = parent ? await a?.oid() : undefined;
          const ob = parent ? await b?.oid() : await a?.oid();
          if (oa === ob) return;
          out.push({ path, change: !oa ? 'added' : !ob ? 'deleted' : 'modified' });
        },
      });
      return out;
    },
    /** Put the workspace back as it was at a commit (a new commit records it, so nothing is lost). */
    async restore(oid, label = '') {
      const g = await git();
      const want = new Map();
      await g.walk({
        ...base,
        trees: [g.TREE({ ref: oid })],
        map: async (path, [e]) => {
          if (path === '.' || (await e.type()) !== 'blob') return;
          want.set(path, await e.content());
        },
      });
      for (const p of Object.keys(workspace.files)) if (!IGNORE(p) && !want.has(p)) delete workspace.files[p];
      for (const [p, data] of want) workspace.files[p] = { ...(workspace.files[p] || {}), data, mtime: Date.now() };
      return this.commitAll(`Restore ${oid.slice(0, 7)}${label ? ` (${label})` : ''}`);
    },
    async clone(url, { http, token, onProgress } = {}) {
      const g = await git();
      await g.clone({ ...base, http, url, singleBranch: true, depth: 50, onAuth: () => (token ? { username: 'x-access-token', password: token } : undefined), onProgress: (e) => onProgress?.(e) });
    },
    async addRemote(url) {
      const g = await git();
      if (!has()) await g.init({ ...base, defaultBranch: 'main' });
      await g.addRemote({ ...base, remote: 'origin', url, force: true });
    },
    async remote() {
      const g = await git();
      if (!has()) return '';
      return (await g.listRemotes({ ...base })).find((r) => r.remote === 'origin')?.url || '';
    },
    async branch() {
      const g = await git();
      return has() ? (await g.currentBranch({ ...base })) || 'main' : 'main';
    },
    async push({ http, token }) {
      const g = await git();
      const ref = await this.branch();
      const r = await g.push({ ...base, http, remote: 'origin', ref, onAuth: () => ({ username: 'x-access-token', password: token }) });
      if (!r.ok) throw new Error(r.error || 'Push refused');
      return ref;
    },
    /** Fetch and fast-forward; refuses when both sides have new commits. */
    async pull({ http, token, author }) {
      const g = await git();
      const ref = await this.branch();
      await g.pull({ ...base, http, remote: 'origin', ref, singleBranch: true, fastForwardOnly: true, author: AUTHOR(author), onAuth: () => (token ? { username: 'x-access-token', password: token } : undefined) });
      return ref;
    },
  };
}
