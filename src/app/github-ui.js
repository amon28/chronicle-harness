// Settings › Connections › GitHub: sign in (device flow) or paste a token, commit name and email, test, sign out.
import { ensureCmd } from '../pkg.js';
import { $, copyText, hooks, state, toast } from './core.js';
import { saveSettings } from '../store.js';
import { DEFAULT_CLIENT_ID, KIND_LABEL, appRepos, setGithubSsh, sshOn, sshRepos, syncShellSsh, deviceStart, devicePoll, githubUser, latestRepo, scrubToken, setGithubAuth, syncShellGithub, tokenKind } from '../github.js';
import { browserFor, canControlBrowser } from '../browsercontrol.js';
import { canUseShell, runShell, shellStatus } from '../shell.js';

const S = state.settings;
setGithubAuth(S, (s) => {
  saveSettings(s);
  render();
});
const clientId = () => (S.githubClientId || DEFAULT_CLIENT_ID || '').trim();
const BROWSER = 'github-signin';
let signing = null; // { cancelled }

function save() {
  setGithubAuth(S, (s) => {
    saveSettings(s);
    render();
  });
  saveSettings(S);
  render();
}

function renderSsh() {
  setGithubSsh(S);
  const has = !!S.githubSshKey;
  const on = sshOn();
  $('#gh-ssh-make').hidden = has;
  for (const id of ['#gh-ssh-copy', '#gh-ssh-add', '#gh-ssh-delete']) $(id).hidden = !has;
  $('#gh-ssh-use').hidden = !has;
  if (document.activeElement !== $('#gh-ssh-repos')) $('#gh-ssh-repos').value = (S.githubSshRepos || []).join('\n');
  $('#gh-ssh-ask').checked = S.githubSshAskPush !== false;
  $('#gh-ssh-for').value = on ? (S.githubSshUntil === -1 ? '-1' : $('#gh-ssh-for').value === '0' ? '60' : $('#gh-ssh-for').value) : '0';
  $('#gh-ssh-status').textContent = !has
    ? 'No key.'
    : `Key ${S.githubSshFingerprint || ''} (made ${S.githubSshMade ? new Date(S.githubSshMade).toLocaleDateString() : '?'}) – ${on ? `ON for ${S.githubSshRepos.join(', ')}${S.githubSshUntil === -1 ? ' until you switch it off' : ` until ${new Date(S.githubSshUntil).toLocaleTimeString()}`}` : !(S.githubSshRepos || []).length ? 'off: list the repos it may be used for first' : 'off'}.`;
}
hooks.githubSshTick = renderSsh;
setInterval(() => S.githubSshKey && S.githubSshUntil > 0 && renderSsh(), 60000); // the card says "off" when the time is up

async function applySsh(note) {
  saveSettings(S);
  renderSsh();
  const exec = await testShell();
  if (exec) await syncShellSsh(exec).catch(() => {}); // in, or out, right away – not only at the next command
  if (note) toast(note);
}

$('#gh-ssh-make').onclick = async () => {
  const exec = await testShell();
  if (!exec) return toast('Install the Linux terminal first (Settings › Connections › Linux terminal)');
  $('#gh-ssh-status').textContent = 'Making a key…';
  // made in a temporary folder and read back; nothing stays on the shell's disk
  const r = await exec(`(umask 077; ${ensureCmd('ssh-keygen', { apt: 'openssh-client', apk: 'openssh-keygen' })}; d=$(mktemp -d); ssh-keygen -q -t ed25519 -N '' -C 'chronicle-phone' -f "$d/k" >/dev/null 2>&1 && { echo KEYSTART; cat "$d/k"; echo PUBSTART; cat "$d/k.pub"; echo FPSTART; ssh-keygen -lf "$d/k.pub"; echo KEYEND; }; rm -rf "$d")`, 120000).catch((e) => ({ output: String(e?.message || e) }));
  const o = String(r.output || '');
  const key = /KEYSTART\n([\s\S]*?)\nPUBSTART/.exec(o)?.[1];
  const pub = /PUBSTART\n([\s\S]*?)\nFPSTART/.exec(o)?.[1]?.trim();
  const fp = /FPSTART\n\S+ (\S+)/.exec(o)?.[1] || '';
  if (!key || !/PRIVATE KEY/.test(key) || !pub) {
    renderSsh();
    return toast('The key could not be made (is the shell online to install ssh-keygen?)');
  }
  Object.assign(S, { githubSshKey: key, githubSshPub: pub, githubSshFingerprint: fp, githubSshMade: Date.now(), githubSshRepos: S.githubSshRepos || [], githubSshUntil: 0, githubSshAskPush: true });
  await applySsh('Key made. Copy the public key, add it on GitHub, list the repos, then switch it on.');
};
$('#gh-ssh-copy').onclick = () => copyText(S.githubSshPub || '').then(() => toast('Public key copied'));
$('#gh-ssh-add').onclick = () => {
  copyText(S.githubSshPub || '').catch(() => {});
  window.open('https://github.com/settings/ssh/new', '_blank');
  toast('Public key copied – paste it as the key, any title (e.g. Chronicle phone)');
};
$('#gh-ssh-delete').onclick = async () => {
  if (!confirm('Delete the SSH key from this phone? Also delete it on GitHub (Settings › SSH and GPG keys), or it keeps working anywhere a copy exists.')) return;
  for (const k of ['githubSshKey', 'githubSshPub', 'githubSshFingerprint', 'githubSshMade', 'githubSshUntil']) delete S[k];
  await applySsh('Key deleted here and taken out of the shell. Now delete it on GitHub too.');
  window.open('https://github.com/settings/keys', '_blank');
};
$('#gh-ssh-repos').onchange = () => {
  S.githubSshRepos = sshRepos($('#gh-ssh-repos').value);
  applySsh();
};
$('#gh-ssh-for').onchange = () => {
  const v = Number($('#gh-ssh-for').value);
  if (v && !(S.githubSshRepos || []).length) {
    $('#gh-ssh-for').value = '0';
    return toast('List the repos it may be used for first');
  }
  S.githubSshUntil = v === -1 ? -1 : v > 0 ? Date.now() + v * 60000 : 0;
  applySsh(v ? 'SSH key switched on' : 'SSH key switched off and taken out of the shell');
};
$('#gh-ssh-ask').onchange = () => {
  S.githubSshAskPush = $('#gh-ssh-ask').checked;
  applySsh();
};

function render() {
  renderSsh();
  const u = S.githubUser || {};
  const on = !!S.githubToken;
  $('#gh-sum').textContent = on ? `Connected as @${u.login || '?'} – git and gh in the Linux shell` : 'Not connected – git and gh in the Linux shell';
  const kind = tokenKind(S.githubToken);
  const left = S.githubExpiresAt ? Math.max(0, Math.round((S.githubExpiresAt - Date.now()) / 60000)) : 0;
  $('#gh-status').textContent = on
    ? `Connected as @${u.login || '?'}${u.via === 'token' ? ' with a pasted token' : ''} – ${KIND_LABEL[kind]}.${S.githubExpiresAt ? ` This sign-in renews itself (next in about ${left >= 60 ? Math.round(left / 60) + ' h' : left + ' min'}).` : ''}${kind === 'oauth' || kind === 'classic' ? ' It reaches every repo you can; a GitHub App or a fine-grained token can be limited to the repos you choose.' : ''}${u.repos?.length ? ` Reaches ${byOwner(u.repos, u.login)}.` : ''} The shell's git and gh use it, and so does the chat's Git history.`
    : clientId()
      ? 'Not connected.'
      : 'Not connected. To sign in, add the OAuth App client ID below once – or paste a token.';
  $('#gh-signin').hidden = on;
  $('#gh-test').hidden = !on;
  $('#gh-check-row').hidden = !on;
  $('#gh-signout').hidden = !on;
  $('#gh-name').value = u.name || '';
  $('#gh-email').value = u.email || '';
  $('#gh-client-id').value = S.githubClientId || '';
}

/** t: a token string (pasted) or a tokenSet from the device flow (a GitHub App's comes with a refresh token). */
async function connected(t, via) {
  const set = typeof t === 'string' ? { token: t, refresh: '', expiresAt: 0, refreshExpiresAt: 0 } : t;
  const u = await githubUser(set.token);
  const repos = tokenKind(set.token) === 'app' ? await appRepos(set.token).catch(() => []) : [];
  S.githubToken = set.token;
  S.githubRefresh = set.refresh || '';
  S.githubExpiresAt = set.expiresAt || 0;
  S.githubRefreshExpiresAt = set.refreshExpiresAt || 0;
  S.githubUser = { login: u.login, name: u.name, email: u.email, via, scopes: u.scopes, repos };
  save();
  toast(`Signed in to GitHub as @${u.login}`);
}

async function closeSigninBrowser() {
  try {
    await browserFor(BROWSER).close();
  } catch {
    /* not open */
  }
}

async function openOnGithub(url, code) {
  // the assistant's browser shares the app's cookies: if you signed in to github.com there, you are signed in here
  if (canControlBrowser()) {
    const api = browserFor(BROWSER);
    try {
      await api.open({ url, width: 390, height: 844, mobile: true });
      api.show?.({ message: `Enter the code ${code}, approve, then tap Done` }).catch(() => {});
      return;
    } catch {
      /* fall through to a normal window */
    }
  }
  window.open(url, '_blank');
}

$('#gh-signin').onclick = async () => {
  if (signing) return;
  const id = clientId();
  if (!id) {
    $('#gh-client-id').closest('details').open = true;
    $('#gh-client-id').focus();
    toast('Add the OAuth App client ID first (or paste a token)');
    return;
  }
  const me = (signing = { cancelled: false });
  try {
    const start = await deviceStart(id);
    $('#gh-code').textContent = start.user_code;
    $('#gh-code-box').hidden = false;
    $('#gh-wait').textContent = 'Waiting for you to approve…';
    $('#gh-code-open').onclick = () => openOnGithub(start.verification_uri, start.user_code);
    $('#gh-code-copy').onclick = () => copyText(start.user_code).then(() => toast('Code copied'));
    copyText(start.user_code).catch(() => {});
    openOnGithub(start.verification_uri, start.user_code);
    const token = await devicePoll(id, start, { cancelled: () => me.cancelled });
    await connected(token, 'device');
  } catch (e) {
    if (!me.cancelled) toast(String(e.message || e));
  } finally {
    if (signing === me) signing = null;
    $('#gh-code-box').hidden = true;
    closeSigninBrowser();
  }
};
$('#gh-code-cancel').onclick = () => {
  if (signing) signing.cancelled = true;
  $('#gh-code-box').hidden = true;
  closeSigninBrowser();
};

$('#gh-pat-save').onclick = async () => {
  const t = $('#gh-pat').value.trim();
  if (!t) return;
  try {
    await connected(t, 'token');
    $('#gh-pat').value = '';
  } catch (e) {
    toast(String(e.message || e));
  }
};

for (const [id, key] of [['#gh-name', 'name'], ['#gh-email', 'email']]) {
  $(id).onchange = () => {
    S.githubUser = { ...(S.githubUser || {}), [key]: $(id).value.trim() };
    save();
  };
}
$('#gh-client-id').onchange = () => {
  S.githubClientId = $('#gh-client-id').value.trim();
  save();
};

/** The shell, if there is one, with this sign-in. → exec(cmd, ms) or null */
async function testShell() {
  if (!canUseShell()) return null;
  const st = await shellStatus().catch(() => null);
  if (!st?.installed) return null;
  return (cmd, ms = 60000) => runShell(cmd, { id: 'github-test', timeoutMs: ms });
}

$('#gh-signout').onclick = async () => {
  for (const k of ['githubToken', 'githubUser', 'githubRefresh', 'githubExpiresAt', 'githubRefreshExpiresAt']) delete S[k];
  save();
  const exec = await testShell();
  if (exec) await syncShellGithub(exec).catch(() => {});
  toast('Signed out of GitHub here. To revoke the token itself: GitHub › Settings › Applications (or your tokens).');
};

const owner = (repo) => repo.split('/')[0];
/** Repos per owner, organisations first (a personal account's long list must not hide them): "org: 2 (a, b); me: 44 (…)" */
function byOwner(repos, me = '') {
  const m = new Map();
  for (const r of repos) m.set(owner(r), [...(m.get(owner(r)) || []), r.split('/')[1]]);
  return [...m.entries()]
    .sort((a, b) => (a[0] === me) - (b[0] === me) || a[0].localeCompare(b[0]))
    .map(([o, names]) => `${o}: ${names.length} (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''})`)
    .join('; ');
}
$('#gh-test').onclick = async () => {
  const out = $('#gh-status');
  out.textContent = 'Testing…';
  try {
    const u = await githubUser(S.githubToken);
    const kind = tokenKind(S.githubToken);
    const lines = [`✓ GitHub knows the token: @${u.login} – ${KIND_LABEL[kind]}${u.scopes ? ` (scopes: ${u.scopes})` : ''}.`];
    // a GitHub App reaches only where it is installed: say where that is (and keep it on the card)
    let reach = null;
    if (kind === 'app') {
      reach = await appRepos(S.githubToken).catch(() => null);
      if (reach) {
        S.githubUser = { ...(S.githubUser || {}), repos: reach };
        saveSettings(S);
        lines.push(reach.length ? `It reaches ${reach.length} repo${reach.length === 1 ? '' : 's'}: ${byOwner(reach, u.login)}.` : 'It reaches no repos yet: install the app on an account or organisation (github.com/apps/<your app> › Install).');
      }
    }
    const exec = await testShell();
    if (!exec) lines.push('The Linux shell is not installed, so git there was not tested (Settings › Connections › Linux terminal).');
    else {
      const note = await syncShellGithub(exec);
      if (note) lines.push(note);
      const asked = $('#gh-check-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
      const repo = /^[\w.-]+\/[\w.-]+$/.test(asked) ? asked : await latestRepo(S.githubToken);
      if (!repo) lines.push('No repository to test git with.');
      else {
        const r = await exec(`${ensureCmd('git', { apt: 'git ca-certificates', apk: 'git' })}; GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/${repo} 2>&1 | head -3; echo "EXIT=$?"`, 120000);
        const o = scrubToken(String(r.output || '')).trim();
        const reached = /refs\/heads\//.test(o);
        let why = '';
        if (!reached && kind === 'app' && reach && !reach.some((r) => r.toLowerCase() === repo.toLowerCase())) {
          const owner = repo.split('/')[0];
          why = reach.some((r) => r.split('/')[0].toLowerCase() === owner.toLowerCase())
            ? ` The app is installed on ${owner} but this repo is not selected: on GitHub open ${owner}'s Settings › GitHub Apps › your app › Configure and add it.`
            : ` The app is not installed on ${owner} (yet): github.com/apps/<your app> › Install › ${owner} › Only select repositories. If you are not an owner of ${owner}, this sends a request that an owner has to approve first.`;
        } else if (!reached && /OAuth App access restrictions/i.test(o)) why = ` ${owner(repo)} refuses OAuth App sign-ins: use a GitHub App (below) or a fine-grained token.`;
        lines.push(reached ? `✓ git in the shell reached ${repo} (${(o.match(/refs\/heads\//g) || []).length}+ branches).` : `✗ git in the shell could not reach ${repo}.${why || ' ' + o.slice(-300)}`);
      }
    }
    out.textContent = lines.join(' ');
  } catch (e) {
    out.textContent = '✗ ' + String(e.message || e);
  }
};

render();
