// The chat files sheet's 🌿 Git section, and the commit after every reply that changed files.
import { $, el, hooks, state, toast } from './core.js';
import { gitData } from '../store.js';
import { bytesRequest } from '../api.js';
import { repo, httpClient } from '../git.js';
import { saveWorkspace, sessionChanges } from '../sandbox.js';
import { changeList } from '../planmode.js';
import { lineDiff, collapseDiff } from '../diff.js';
import { changesCard } from './render.js';
import { persist } from './chatlist.js';
import { loadWs } from './extras.js';
import { askText } from './choose.js';

const stores = new Map(); // conv id → { git: {…} }
async function storeFor(id) {
  if (!stores.has(id)) stores.set(id, (await gitData.get(id)) || { git: {} });
  return stores.get(id);
}
const saveStore = (id) => gitData.put(id, stores.get(id)).catch((e) => toast(`Couldn’t save the git history: ${e.message}`));
const http = httpClient(bytesRequest);
// the GitHub sign-in (Settings › Connections › GitHub); the older update-check token still works on its own
const token = () => (state.settings.githubToken || state.settings.ghToken || '').trim();
const who = () => state.settings.prefs?.userName || 'Chronicle';

async function repoFor(conv) {
  const w = await loadWs(conv.id);
  const st = await storeFor(conv.id);
  return { r: repo(w, st), w, st };
}
const status = (t) => ($('#git-status').textContent = t);

async function render() {
  const conv = state.current;
  if (!conv) return;
  const { r } = await repoFor(conv);
  $('#git-auto').checked = !!conv.git?.auto;
  const log = await r.log(15);
  const remote = await r.remote().catch(() => '');
  if (remote && !$('#git-remote').value) $('#git-remote').value = remote;
  $('#git-sum').textContent = r.has() ? `· ${log.length}${log.length === 15 ? '+' : ''} commit${log.length === 1 ? '' : 's'}${remote ? ' · ' + remote.replace(/^https:\/\/(www\.)?/, '').replace(/\.git$/, '') : ''}` : '· off';
  const box = $('#git-log');
  box.innerHTML = '';
  for (const [i, c] of log.entries()) {
    const row = el('div', 'git-row');
    row.append(el('code', null, c.oid.slice(0, 7)), el('span', 'git-msg', c.message.split('\n')[0].slice(0, 80)), el('span', 'dim', new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    if (i > 0) {
      const back = el('button', 'act', 'Restore');
      back.title = 'Put the files back as they were then (recorded as a new commit)';
      back.onclick = async () => {
        if (!confirm(`Put this chat's files back as they were at “${c.message.split('\n')[0].slice(0, 60)}”? It is recorded as a new commit, so nothing is lost.`)) return;
        try {
          const { r: rr, w } = await repoFor(conv);
          await rr.restore(c.oid, c.message.split('\n')[0].slice(0, 40));
          saveWorkspace(w);
          await saveStore(conv.id);
          hooks.filesChanged?.();
          toast(`Restored ${c.oid.slice(0, 7)}`);
          render();
        } catch (e) {
          toast(e.message, 4000);
        }
      };
      row.append(back);
    }
    box.append(row);
  }
}
hooks.renderGit = render;

/** After a reply that changed files: one commit, named after what you asked. */
hooks.gitAutoCommit = async (conv, msg) => {
  if (!conv.git?.auto) return;
  try {
    const ask = [...conv.messages].reverse().find((m) => m.role === 'user' && m.content)?.content || 'Changes';
    const { r } = await repoFor(conv);
    const oid = await r.commitAll(`${String(ask).split('\n')[0].slice(0, 72)}\n\nMade by ${msg.model || 'the assistant'} in Chronicle.`, { author: who() });
    if (oid) {
      msg.commit = oid;
      await saveStore(conv.id);
      persist(conv);
    }
  } catch (e) {
    console.warn('git auto-commit', e);
  }
};

$('#git-auto').onchange = async (e) => {
  const conv = state.current;
  conv.git = { ...(conv.git || {}), auto: e.target.checked };
  persist(conv);
  if (e.target.checked) {
    const { r } = await repoFor(conv);
    const oid = await r.commitAll('Start of the history', { author: who() }).catch((x) => (toast(x.message), null));
    await saveStore(conv.id);
    status(oid ? 'History on – the files as they are now are the first commit.' : 'History on.');
  }
  render();
};
$('#git-commit').onclick = async () => {
  const conv = state.current;
  const m = await askText('Commit message', 'Changes', { ok: 'Commit' });
  if (m == null) return;
  const { r } = await repoFor(conv);
  const oid = await r.commitAll(m, { author: who() });
  await saveStore(conv.id);
  status(oid ? `Committed ${oid.slice(0, 7)}` : 'Nothing changed since the last commit.');
  render();
};
const remoteUrl = () => {
  const u = $('#git-remote').value.trim().replace(/\/$/, '');
  if (!/^https:\/\/[^\s]+$/.test(u)) throw new Error('Enter an https:// repository address');
  return /\.git$/.test(u) ? u : u + '.git';
};
$('#git-clone').onclick = async () => {
  const conv = state.current;
  try {
    const url = remoteUrl();
    const { r, w } = await repoFor(conv);
    if (Object.keys(w.files).length || r.has()) throw new Error('Clone into a chat whose workspace is empty (start a new chat for it)');
    status('Cloning…');
    await r.clone(url, { http, token: token(), onProgress: (p) => status(`Cloning… ${p.phase}${p.total ? ` ${Math.round((p.loaded / p.total) * 100)}%` : ''}`) });
    saveWorkspace(w);
    await saveStore(conv.id);
    conv.git = { ...(conv.git || {}), auto: true };
    persist(conv);
    hooks.filesChanged?.();
    status(`Cloned ${Object.keys(w.files).length} files. History is on.`);
    render();
  } catch (e) {
    status('✗ ' + e.message);
  }
};
$('#git-push').onclick = async () => {
  const conv = state.current;
  try {
    if (!token()) throw new Error('Pushing needs a GitHub token – Settings › Updates › GitHub token (with repo access)');
    const url = remoteUrl();
    const { r } = await repoFor(conv);
    if (!r.has()) throw new Error('Turn on the history first (nothing has been committed)');
    await r.commitAll('Changes', { author: who() });
    if ((await r.remote()) !== url) await r.addRemote(url);
    status('Pushing…');
    const ref = await r.push({ http, token: token() });
    await saveStore(conv.id);
    status(`✓ Pushed ${ref} to ${url.replace(/^https:\/\//, '')}`);
    render();
  } catch (e) {
    status('✗ ' + e.message);
  }
};
$('#git-pull').onclick = async () => {
  const conv = state.current;
  try {
    const url = remoteUrl();
    const { r, w } = await repoFor(conv);
    if (!r.has()) throw new Error('Clone first, or turn on the history');
    if ((await r.remote()) !== url) await r.addRemote(url);
    await r.commitAll('Changes before pulling', { author: who() });
    status('Pulling…');
    await r.pull({ http, token: token(), author: who() });
    saveWorkspace(w);
    await saveStore(conv.id);
    hooks.filesChanged?.();
    status('✓ Up to date');
    render();
  } catch (e) {
    status('✗ ' + (/fast-forward|FastForward/i.test(e.message) ? 'Both sides have new commits – pull is only done when it can fast-forward' : e.message));
  }
};
$('#git-box').addEventListener('toggle', () => $('#git-box').open && render());

// ---------- 📝 What this chat changed: every file as it was before the chat's first (remembered) change, against now ----------
$('#ws-changes').onclick = async () => {
  const box = $('#ws-changes-box');
  box.innerHTML = '';
  const w = await loadWs(state.current.id);
  const files = changeList(sessionChanges(w), w.files, (a, b) => collapseDiff(lineDiff(a, b), 2), { maxFiles: 60, maxOps: 200 });
  if (!files.length) return box.append(el('p', 'hint', 'Nothing has changed in this chat’s files (or the changes are too old to compare – the app remembers the last replies’ changes).'));
  const card = changesCard(files);
  card.open = true;
  box.append(card);
};
