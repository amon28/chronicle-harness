// GitHub for the shell and the app's Git: one token, from "Sign in with GitHub" (OAuth device flow) or pasted.
//
// The assistant's browser being signed in to github.com does not help git: GitHub takes cookies only on its website,
// and git over https needs a token. So the app gets one – the device flow shows a code, the user approves it on
// github.com/login/device (in the assistant's browser, where they are signed in), and the token comes back here.
// It is stored with the other secrets (Android Keystore) and given to the shell as a git credential helper and a
// `gh` login, plus the commit name and email. Anything a command prints is scrubbed of it.
import { pkgInstall } from './pkg.js';
import { httpRequest } from './api.js';
import { sha256Hex } from './hash.js';

// The OAuth App the device flow signs in to (Settings › Connections › GitHub can override it). Not a secret: the
// device flow needs no client secret. Register one at GitHub › Settings › Developer settings › OAuth Apps, with
// "Enable Device Flow" ticked.
export const DEFAULT_CLIENT_ID = '';
export const SCOPES = 'repo read:user user:email';
const base = () => globalThis.__ocmGithubBase || { web: 'https://github.com', api: 'https://api.github.com' };

const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
async function post(url, body) {
  const r = await httpRequest(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
  let j = null;
  try {
    j = JSON.parse(r.body || '{}');
  } catch {
    throw new Error(`GitHub answered ${r.status} with something that is not JSON`);
  }
  if (r.status >= 400 && !j.error) throw new Error(`GitHub answered ${r.status}`);
  return j;
}

/** Step 1: a code for the user to enter. → { device_code, user_code, verification_uri, interval, expires_in } */
export async function deviceStart(clientId) {
  if (!clientId) throw new Error('No OAuth client ID yet: register an OAuth App (Device Flow on) and paste its client ID, or paste a token instead.');
  const j = await post(`${base().web}/login/device/code`, { client_id: clientId, scope: SCOPES });
  if (j.error) throw new Error(j.error === 'device_flow_disabled' ? 'Device Flow is not enabled on that OAuth App (tick "Enable Device Flow" in its settings).' : j.error_description || j.error);
  if (!j.device_code || !j.user_code) throw new Error('GitHub did not give a code');
  return j;
}

/**
 * What kind of GitHub credential a token is (by its prefix), and how far it reaches.
 *   app     – a GitHub App sign-in (ghu_): only the repos the app is installed on, expires after 8 hours
 *   oauth   – an OAuth App sign-in (gho_): every repo you can reach that the app's scopes allow; organisations
 *             can refuse it ("OAuth App access restrictions")
 *   fine    – a fine-grained token (github_pat_): the repos and permissions picked when it was made, expires
 *   classic – a classic token (ghp_): everything its scopes allow
 */
export function tokenKind(token = '') {
  const t = String(token);
  if (t.startsWith('ghu_')) return 'app';
  if (t.startsWith('gho_')) return 'oauth';
  if (t.startsWith('github_pat_')) return 'fine';
  if (t.startsWith('ghp_')) return 'classic';
  return 'other';
}
export const KIND_LABEL = { app: 'GitHub App sign-in (only the repos the app is installed on)', oauth: 'OAuth App sign-in (all your repos; organisations may refuse it)', fine: 'fine-grained token (only the repos you picked)', classic: 'classic token (everything its scopes allow)', other: 'token' };

/** A token answer from GitHub as we keep it: { token, refresh, expiresAt, refreshExpiresAt } (0 = does not expire). */
export function tokenSet(j, now = Date.now()) {
  return {
    token: j.access_token,
    refresh: j.refresh_token || '',
    expiresAt: Number(j.expires_in) > 0 ? now + Number(j.expires_in) * 1000 : 0,
    refreshExpiresAt: Number(j.refresh_token_expires_in) > 0 ? now + Number(j.refresh_token_expires_in) * 1000 : 0,
  };
}

/**
 * A GitHub App's sign-in lasts 8 hours: a new one is fetched with the refresh token (once each: the old pair
 * stops working). A device-flow sign-in needs no client secret for this. → tokenSet, or throws.
 */
export async function refreshGithub(clientId, refresh) {
  if (!clientId || !refresh) throw new Error('No refresh token – sign in again');
  const j = await post(`${base().web}/login/oauth/access_token`, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh });
  if (!j.access_token) throw new Error(j.error === 'bad_refresh_token' ? 'The GitHub sign-in ran out – sign in again' : j.error_description || j.error || 'GitHub did not give a new token');
  return tokenSet(j);
}

/** The repos a GitHub App sign-in reaches (the app's installations ∩ your access). → ['owner/name', …] (at most 200) */
export async function appRepos(token) {
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Chronicle' };
  const r = await httpRequest(`${base().api}/user/installations?per_page=100`, { headers: h });
  if (r.status >= 400) return [];
  const out = [];
  for (const inst of JSON.parse(r.body || '{}').installations || []) {
    const rr = await httpRequest(`${base().api}/user/installations/${inst.id}/repositories?per_page=100`, { headers: h });
    if (rr.status < 400) for (const repo of JSON.parse(rr.body || '{}').repositories || []) out.push(repo.full_name);
    if (out.length >= 200) break;
  }
  return out;
}

/**
 * What to do next when git or gh was refused, for the model and the user. '' when the output is not such a refusal.
 * The answer is always a narrow, expiring credential the user sets up – never an SSH key in the shared shell.
 */
export function githubHint(output, kind = tokenKind(auth?.token)) {
  const o = String(output || '');
  if (/OAuth App access restrictions|has enabled OAuth App/i.test(o))
    return 'GitHub: this organisation refuses OAuth App sign-ins. Do NOT work around it (no SSH keys, no other tokens). Tell the user the safe options: (1) sign in with a GitHub App installed on the organisation for just the repos needed (Settings › Connections › GitHub › "Use a GitHub App"), or (2) a fine-grained token for that one repo with an expiry date, pasted in the same place. An organisation owner may have to approve either.';
  // only a real refusal over https (not a progress count with "403" in it, not an SSH clone that worked)
  if (kind === 'app' && /(fatal:|error:|remote:)/i.test(o) && /(Repository not found|Resource not accessible by integration|Permission to \S+ denied|returned error: 40[34])/i.test(o) && /https:\/\/github\.com/i.test(o) && !/git@github\.com/i.test(o))
    return 'GitHub: the GitHub App this shell is signed in with is not installed on that repo (or lacks the permission). Ask the user to add the repo to the app\'s installation on GitHub (Settings › Applications › Installed GitHub Apps › Configure), then try again. Do not create SSH keys or other tokens.';
  if (/Permission denied \(publickey\)/.test(o) && sshOn())
    return `GitHub over SSH: the user's key is used only inside a clone of a listed repo (${ssh.repos.join(', ')}), or with ssh-git for a bare URL (e.g. ssh-git ls-remote git@github.com:${ssh.repos[0]}.git). A repo that is not listed never gets it – tell the user to add it in Settings › Connections › GitHub › SSH key.`;
  return '';
}

/**
 * Step 2: wait while the user approves. → the token answer (tokenSet). Stops on denial, expiry, or when cancelled() says so.
 * GitHub asks to be polled no faster than `interval` seconds (and to slow down by 5 s when it says slow_down).
 */
export async function devicePoll(clientId, start, { cancelled = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let wait = Math.max(1, Number(start.interval) || 5) * 1000;
  const until = Date.now() + (Number(start.expires_in) || 900) * 1000;
  while (Date.now() < until) {
    await sleep(wait);
    if (cancelled()) throw new Error('cancelled');
    const j = await post(`${base().web}/login/oauth/access_token`, { client_id: clientId, device_code: start.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (j.access_token) return tokenSet(j);
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') {
      wait += 5000;
      continue;
    }
    if (j.error === 'access_denied') throw new Error('The sign-in was declined on GitHub.');
    if (j.error === 'expired_token') break;
    throw new Error(j.error_description || j.error || 'GitHub did not give a token');
  }
  throw new Error('The code expired before it was approved – start again.');
}

/** Who the token belongs to, and the email to commit with. → { login, name, email, scopes } */
export async function githubUser(token) {
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Chronicle' };
  const r = await httpRequest(`${base().api}/user`, { headers: h });
  if (r.status === 401) throw new Error('GitHub does not accept this token (expired, revoked or mistyped).');
  if (r.status >= 400) throw new Error(`GitHub answered ${r.status}`);
  const u = JSON.parse(r.body || '{}');
  let email = u.email || '';
  if (!email) {
    try {
      const e = await httpRequest(`${base().api}/user/emails`, { headers: h });
      const list = e.status < 400 ? JSON.parse(e.body || '[]') : [];
      email = (list.find((x) => x.primary && x.verified) || list.find((x) => x.verified) || {}).email || '';
    } catch {
      /* a fine-grained token may not see emails */
    }
  }
  // GitHub's own no-reply address when the real one is private: commits still link to the account
  if (!email && u.id && u.login) email = `${u.id}+${u.login}@users.noreply.github.com`;
  return { login: u.login || '', name: u.name || u.login || '', email, scopes: r.headers?.['x-oauth-scopes'] || '' };
}

/** The repo pushed to most recently (for the connection test). → 'owner/name' or '' */
export async function latestRepo(token) {
  const r = await httpRequest(`${base().api}/user/repos?per_page=1&sort=pushed`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Chronicle' } });
  if (r.status >= 400) return '';
  return JSON.parse(r.body || '[]')[0]?.full_name || '';
}

// ---------- the shell ----------

const b64 = (s) => btoa(unescape(encodeURIComponent(String(s))));
/** A git config value in quotes, with \\ and " escaped and line breaks removed. */
export const gitQuote = (v) => `"${String(v).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/**
 * A script that signs the shell in (or out, without a token): the token in a file only root can read, a git
 * credential helper for github.com that reads it, `gh` logged in, and the commit name and email. Plain sh – git does
 * not have to be installed (the git settings are a file that ~/.gitconfig includes).
 */
export function shellScript({ token = '', login = '', name = '', email = '' } = {}, { home = '/root' } = {}) {
  const DIR = `${home}/.config/chronicle`;
  if (!token) {
    return [
      `rm -f ${DIR}/gh-token ${DIR}/gitconfig`,
      `[ -f ${home}/.config/gh/hosts.yml ] && grep -q 'chronicle' ${home}/.config/gh/hosts.yml && rm -f ${home}/.config/gh/hosts.yml`,
      'echo GITHUB_SIGNED_OUT',
    ].join('\n');
  }
  const helper = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$(cat ${DIR}/gh-token)"; }; f`;
  const gitconfig = [
    '# written by Chronicle (Settings › Connections › GitHub)',
    '[credential "https://github.com"]',
    `\thelper = "${helper.replace(/"/g, '\\"')}"`,
    // quoted: a name with ; # " or \ must not cut the value short or break every git command
    ...(name || email ? ['[user]', ...(name ? [`\tname = ${gitQuote(name)}`] : []), ...(email ? [`\temail = ${gitQuote(email)}`] : [])] : []),
  ].join('\n');
  const hosts = ['# written by Chronicle', 'github.com:', `    oauth_token: ${token}`, `    user: ${login}`, '    git_protocol: https'].join('\n');
  // all of it in a subshell: the chat's shell keeps its own umask (077 made every later file private) and directory
  return [
    '(',
    'umask 077',
    `mkdir -p ${DIR} ${home}/.config/gh`,
    `echo ${b64(token)} | base64 -d > ${DIR}/gh-token`,
    `echo ${b64(gitconfig + '\n')} | base64 -d > ${DIR}/gitconfig`,
    `echo ${b64(hosts + '\n')} | base64 -d > ${home}/.config/gh/hosts.yml`,
    `chmod 600 ${DIR}/gh-token ${DIR}/gitconfig ${home}/.config/gh/hosts.yml`,
    `touch ${home}/.gitconfig; grep -q '${DIR}/gitconfig' ${home}/.gitconfig || printf '[include]\\n\\tpath = ${DIR}/gitconfig\\n' >> ${home}/.gitconfig`,
    'echo GITHUB_SIGNED_IN',
    ')',
  ].join('\n');
}

// ---------- the SSH key (last resort, Settings › Connections › GitHub) ----------
// An SSH key on a GitHub account reaches every repo the account can push to and never expires: GitHub cannot narrow
// it. So the app narrows what it can: the key lives in the app's secure store and is put into the shell only while it
// is switched on (a time limit), git uses it only for the repos listed (a remote that is not on the list never gets
// it), GitHub's server is checked against its published host key, and every push asks first (unless turned off).
// What it cannot stop: a program running in the shell while the key is on could copy the key file.

/** GitHub's own SSH host key (docs.github.com › GitHub's SSH key fingerprints): no trust-on-first-use. */
export const GITHUB_HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
/** "owner/name" lines → the repos the key may be used for. */
export const sshRepos = (text = '') =>
  [...new Set(String(text).split(/[\s,]+/).map((r) => r.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/, '').replace(/\/+$/, '')).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, 20);
let ssh = null; // { key, pub, repos: [], until, askPush } from the settings
export function setGithubSsh(s) {
  ssh = s?.githubSshKey ? { key: String(s.githubSshKey), pub: String(s.githubSshPub || ''), repos: Array.isArray(s.githubSshRepos) ? s.githubSshRepos : [], until: Number(s.githubSshUntil) || 0, askPush: s.githubSshAskPush !== false } : null;
}
/** Is the key switched on right now (it has repos, and its time has not run out)? until = -1 means "until I switch it off". */
export const sshOn = (now = Date.now(), k = ssh) => !!k?.key && k.repos.length > 0 && (k.until === -1 || k.until > now);
export const sshAsksPush = () => sshOn() && ssh.askPush;
/** The lines of git config that send THIS key to github.com for these repos only (git 2.36+: hasconfig). */
export function sshGitconfig(repos, dir) {
  const cmd = `ssh -i ${dir}/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=${dir}/known_hosts -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o BatchMode=yes`;
  const out = [
    '# written by Chronicle (Settings › Connections › GitHub › SSH key).',
    '# This is a full user key: on GitHub it reaches every repo the account can push to, and it does not expire.',
    '# The repo list below only decides when git in this shell picks the key; it is NOT a limit on what the key',
    '# can reach. For a real per-repo limit use a deploy key (one repo) or a GitHub App, not a user key.',
  ];
  for (const r of repos)
    for (const url of [`git@github.com:${r}`, `git@github.com:${r}.git`, `ssh://git@github.com/${r}`, `ssh://git@github.com/${r}.git`]) out.push(`[includeIf "hasconfig:remote.*.url:${url}"]`, `\tpath = ${dir}/use-key.gitconfig`);
  return { main: out.join('\n'), useKey: ['[core]', `\tsshCommand = ${gitQuote(cmd)}`].join('\n') };
}
/** ssh-git <git args…>: every github.com SSH URL in the arguments must be a listed repo, else nothing runs. */
export function sshGitScript(repos, dir) {
  const allowed = repos.map((r) => r.toLowerCase()).join(' ');
  return [
    '#!/bin/sh',
    '# written by Chronicle: git with the SSH key, for the listed repos only (bare URLs: ls-remote, clone)',
    `allowed="${allowed}"`,
    'for a in "$@"; do',
    '  case "$a" in',
    '    git@github.com:*|ssh://git@github.com/*)',
    "      r=$(printf '%s' \"$a\" | sed -e 's#^git@github.com:##' -e 's#^ssh://git@github.com/##' -e 's#\\.git$##' -e 's#/$##' | tr 'A-Z' 'a-z')",
    '      ok=; for x in $allowed; do [ "$x" = "$r" ] && ok=1; done',
    '      [ -n "$ok" ] || { echo "ssh-git: $r is not in the SSH key\'s repo list (Settings › Connections › GitHub › SSH key)" >&2; exit 2; } ;;',
    '  esac',
    'done',
    `GIT_SSH_COMMAND='ssh -i ${dir}/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=${dir}/known_hosts -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o BatchMode=yes' exec git "$@"`,
    '',
  ].join('\n');
}

/** The shell script that puts the key in (on) or takes it out (off). Plain sh, in a subshell, files readable by root only. */
export function sshScript(k = ssh, { home = '/root', now = Date.now() } = {}) {
  const DIR = `${home}/.config/chronicle/ssh`;
  const inc = `${home}/.config/chronicle/ssh.gitconfig`;
  if (!sshOn(now, k)) return [`rm -rf ${DIR} ${inc} /usr/local/bin/ssh-git`, `[ -f ${home}/.gitconfig ] && sed -i '\\#${inc}#d' ${home}/.gitconfig`, 'echo SSH_OFF'].join('\n');
  const g = sshGitconfig(k.repos, DIR);
  return [
    '(',
    'umask 077',
    `mkdir -p ${DIR}`,
    `echo ${b64(k.key.trim() + '\n')} | base64 -d > ${DIR}/id_ed25519`,
    `echo ${b64(GITHUB_HOST_KEY + '\n')} | base64 -d > ${DIR}/known_hosts`,
    `echo ${b64(g.useKey + '\n')} | base64 -d > ${DIR}/use-key.gitconfig`,
    `echo ${b64(g.main + '\n')} | base64 -d > ${inc}`,
    // ssh-git: git with the key for a listed repo's bare URL (ls-remote, clone) – any other URL is refused
    `echo ${b64(sshGitScript(k.repos, DIR))} | base64 -d > /usr/local/bin/ssh-git; chmod 755 /usr/local/bin/ssh-git`,
    `chmod 700 ${DIR}; chmod 600 ${DIR}/* ${inc}`,
    `touch ${home}/.gitconfig; grep -q '${inc}' ${home}/.gitconfig || printf '[include]\\n\\tpath = ${inc}\\n' >> ${home}/.gitconfig`,
    `command -v ssh >/dev/null 2>&1 || ${pkgInstall({ apt: 'openssh-client', apk: 'openssh-client-default' })} || ${pkgInstall({ apt: 'openssh-client', apk: 'openssh-client' })}`,
    'echo SSH_ON',
    ')',
  ].join('\n');
}
let sshWritten = null; // what the shell was last given (on/off + a hash), this app run
/** Before a shell command: the key goes in while it is on, and out as soon as it is off or its time is up. → note or '' */
export async function syncShellSsh(exec, now = Date.now()) {
  const on = sshOn(now);
  const sig = on ? 'on:' + (await sha256Hex(new TextEncoder().encode([ssh.key, ssh.repos.join(','), ssh.until].join('\n')))) : 'off';
  if (sshWritten === sig) return '';
  const had = (() => {
    try {
      return localStorage.getItem('ocm_ssh_shell') === 'on';
    } catch {
      return true;
    }
  })();
  if (!on && sshWritten === null && !had) {
    sshWritten = sig;
    return '';
  }
  const r = await exec(sshScript(ssh, { now }), 30000).catch((e) => ({ output: String(e?.message || e) }));
  const ok = /SSH_(ON|OFF)/.test(String(r.output || ''));
  if (ok) {
    sshWritten = sig;
    try {
      localStorage.setItem('ocm_ssh_shell', on ? 'on' : 'off');
    } catch {
      /* this run only */
    }
  }
  return ok ? (on ? `SSH key on for ${ssh.repos.join(', ')}${ssh.until === -1 ? '' : ` until ${new Date(ssh.until).toLocaleTimeString()}`}` : 'SSH key taken out of the shell') : 'the SSH key could not be given to the shell: ' + String(r.output || '').slice(-200);
}
export const resetShellSsh = () => (sshWritten = null);

let auth = null; // { token, login, name, email, via } while connected
let written = null; // what the shell was last given (a hash), this app run
let source = null; // the settings object, and how to save it (for refreshing an expiring sign-in)
let saver = null;
/** The app's settings changed: the account in use (null = signed out). */
export function setGithubAuth(settings, save = saver) {
  source = settings;
  saver = save;
  const token = String(settings?.githubToken || '').trim();
  auth = token ? { token, ...(settings.githubUser || {}) } : null;
}

let refreshing = null;
/**
 * Before the shell uses the sign-in: a GitHub App token that runs out within 10 minutes is renewed. → '' or a note
 * (renewal failed: the user has to sign in again; the old token is kept until it expires).
 */
export async function freshGithub(now = Date.now()) {
  const s = source;
  if (!s?.githubToken || !s.githubExpiresAt || s.githubExpiresAt - now > 10 * 60 * 1000) return '';
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const t = await refreshGithub(String(s.githubClientId || DEFAULT_CLIENT_ID || '').trim(), s.githubRefresh);
      s.githubToken = t.token;
      s.githubRefresh = t.refresh;
      s.githubExpiresAt = t.expiresAt;
      s.githubRefreshExpiresAt = t.refreshExpiresAt;
      setGithubAuth(s);
      saver?.(s);
      return '';
    } catch (e) {
      return 'GitHub sign-in could not be renewed (' + String(e?.message || e) + '): ask the user to sign in again in Settings › Connections › GitHub';
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
export const githubAuth = () => auth;
/** Output the user or the model sees never carries the token. */
export function scrubToken(text) {
  const t = auth?.token;
  let s = t && t.length >= 12 && String(text).includes(t) ? String(text).split(t).join('[GitHub token]') : text;
  // a private key never reaches the model or the screen, whoever printed it
  if (/PRIVATE KEY-----/.test(String(s))) s = String(s).replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key hidden]');
  return s;
}
/** Give the shell the sign-in once per change (the root filesystem is shared by every chat's shell). */
export async function syncShellGithub(exec, a = auth) {
  // the app's own sign-in (not one passed in by a test): renewed first when it is about to run out
  if (a === auth) {
    const renew = await freshGithub();
    if (renew) return renew;
    a = auth;
  }
  const sig = a?.token ? await sha256Hex(new TextEncoder().encode([a.token, a.login, a.name, a.email].join('\n'))) : 'none';
  if (written === sig) return '';
  // signed out, and the shell was never given a sign-in (this run or an earlier one): nothing to remove
  const had = (() => {
    try {
      return localStorage.getItem('ocm_gh_shell') === 'in';
    } catch {
      return true;
    }
  })();
  if (sig === 'none' && written === null && !had) {
    written = sig;
    return '';
  }
  const r = await exec(shellScript(a || {}), 20000).catch((e) => ({ output: String(e?.message || e) }));
  const ok = /GITHUB_SIGNED_(IN|OUT)/.test(String(r.output || ''));
  if (ok) {
    written = sig;
    try {
      localStorage.setItem('ocm_gh_shell', a?.token ? 'in' : 'out');
    } catch {
      /* remembered for this run only */
    }
  }
  return ok ? (a?.token ? `GitHub: signed in as @${a.login || '?'} (git over https and gh)` : 'GitHub: signed out') : 'GitHub sign-in could not be given to the shell: ' + scrubToken(String(r.output || '').slice(-200));
}
export const resetShellGithub = () => (written = null);

/** While the user's SSH key is on: which repos it works for (and that it is theirs, not to be copied or changed). */
const sshLine = () =>
  sshOn()
    ? `- GitHub over SSH: the user switched on their SSH key for ${ssh.repos.join(', ')}${ssh.until === -1 ? '' : ` until ${new Date(ssh.until).toLocaleTimeString()}`}. For those repos use git@github.com:<owner>/<repo>.git inside a clone; for a bare URL outside a clone (ls-remote, the first clone) use ssh-git instead of git (e.g. ssh-git clone --depth=1 git@github.com:<owner>/<repo>.git). It is not used for any other repo – but it is a full user key, so the list is a convenience, not a limit: never use it beyond what the user asked. ${ssh.askPush ? 'Every git push asks the user first. ' : ''}Never read, print, copy or move the key, and never add or change keys. Never delete anything inside .git (use git gc).\n`
    : '';
/** One line for the system prompt while GitHub is connected. */
export const githubPrompt = (a = auth) =>
  a?.token
    ? sshLine() + `- GitHub: the shell is signed in as @${a.login || 'the user'} (${KIND_LABEL[tokenKind(a.token)]}) – git clone/pull/push over https://github.com and the gh CLI work without asking for credentials (apt-get install -y git gh if missing). Commits use ${a.name || a.login} <${a.email || 'their GitHub email'}>. Never print, echo or write out the token (it is in ~/.config/chronicle/, readable by root only); ask before pushing unless the user asked for it. Never create, add or use other GitHub credentials yourself (SSH keys, deploy keys, tokens, gh auth login): the shell is shared by every chat, and such keys reach everything and never expire. When a repo is refused, say why and let the user choose a narrow credential in Settings.`
    : sshLine() + '- GitHub: the shell is not signed in. Never create SSH keys or other credentials to get in: tell the user to connect GitHub in Settings › Connections › GitHub (a GitHub App or a fine-grained token limited to the repos needed).';
