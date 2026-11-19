import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellScript, scrubToken, setGithubAuth, githubPrompt, devicePoll, refreshGithub, freshGithub, githubHint, tokenKind, sshScript, sshOn, sshRepos, setGithubSsh, sshAsksPush, sshGitScript } from '../../src/github.js';
import { plain } from '../../src/shell.js';
import { shellDanger } from '../../src/shellguard.js';

const TOKEN = 'gho_abc"def$(rm -rf x)`ghi\'123';
// run the script with /root pointed at a temporary home, then ask real git for github.com's credentials
function runIn(home, auth) {
  return execFileSync('sh', ['-c', shellScript(auth, { home })], { encoding: 'utf8' });
}

describe('the shell gets the GitHub sign-in', () => {
  it('git asks the helper and gets the token; name, email and gh are set; the token file is private', () => {
    const home = mkdtempSync(join(tmpdir(), 'ghhome-'));
    expect(runIn(home, { token: TOKEN, login: 'tester', name: 'Test Er', email: 't@example.com' })).toContain('GITHUB_SIGNED_IN');
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env, encoding: 'utf8' });
    expect(cred).toContain('username=x-access-token');
    expect(cred).toContain('password=' + TOKEN); // quotes, $( ) and backticks arrive untouched
    expect(execFileSync('git', ['config', 'user.email'], { env, encoding: 'utf8' }).trim()).toBe('t@example.com');
    expect(statSync(join(home, '.config/chronicle/gh-token')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, '.config/gh/hosts.yml'), 'utf8')).toMatch(/oauth_token: .*\n {4}user: tester/);
    // running it again does not include the file twice
    runIn(home, { token: TOKEN, login: 'tester' });
    expect(readFileSync(join(home, '.gitconfig'), 'utf8').match(/\[include\]/g)).toHaveLength(1);
    // other hosts are not given the token
    const other = execFileSync('sh', ['-c', 'printf "protocol=https\\nhost=gitlab.com\\n\\n" | GIT_TERMINAL_PROMPT=0 git credential fill 2>&1 || true'], { env, encoding: 'utf8' });
    expect(other).not.toContain(TOKEN);
    // the commit name is quoted: characters git treats specially do not break it
    runIn(home, { token: TOKEN, login: 'tester', name: 'Ann #1; "Q" \\ Lee', email: 'a@b.c' });
    expect(execFileSync('git', ['config', 'user.name'], { env, encoding: 'utf8' }).trim()).toBe('Ann #1; "Q" \\ Lee');
    // the script runs in a subshell: the shell that ran it keeps its own umask
    const um = execFileSync('sh', ['-c', `umask 022; ${shellScript({ token: TOKEN, login: 't' }, { home })} >/dev/null; umask`], { encoding: 'utf8' }).trim();
    expect(um).toBe('0022');
    // signing out removes it
    expect(runIn(home, {})).toContain('GITHUB_SIGNED_OUT');
    expect(() => statSync(join(home, '.config/chronicle/gh-token'))).toThrow();
  });

  it('the token never shows in output, and the model is told the shell is signed in', () => {
    setGithubAuth({ githubToken: 'gho_secret_value_1234', githubUser: { login: 'tester', name: 'Test Er', email: 't@example.com' } });
    expect(scrubToken('remote: https://x-access-token:gho_secret_value_1234@github.com/a/b')).toBe('remote: https://x-access-token:[GitHub token]@github.com/a/b');
    expect(githubPrompt()).toMatch(/signed in as @tester[\s\S]*Never print/);
    expect(githubPrompt()).toMatch(/OAuth App sign-in[\s\S]*Never create, add or use other GitHub credentials yourself \(SSH keys/);
    setGithubAuth({});
    expect(githubPrompt()).toMatch(/not signed in\. Never create SSH keys/);
  });

  it('device flow: waits while pending, slows down when asked, stops when declined', async () => {
    const answers = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'tok' }];
    globalThis.__ocmGithubBase = { web: 'http://gh.test', api: 'http://api.gh.test' };
    const waits = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(answers.shift()), { status: 200 });
    try {
      const t = await devicePoll('cid', { device_code: 'd', interval: 5, expires_in: 900 }, { sleep: async (ms) => waits.push(ms) });
      expect(t).toEqual({ token: 'tok', refresh: '', expiresAt: 0, refreshExpiresAt: 0 });
      expect(waits).toEqual([5000, 5000, 10000]);
      answers.push({ error: 'access_denied' });
      await expect(devicePoll('cid', { device_code: 'd', interval: 1 }, { sleep: async () => {} })).rejects.toThrow(/declined/);
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.__ocmGithubBase;
    }
  });

  it('a GitHub App sign-in: kept with its refresh token and renewed before it runs out, without a client secret', async () => {
    globalThis.__ocmGithubBase = { web: 'http://gh.test', api: 'http://api.gh.test' };
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, o) => {
      sent.push({ url: String(url), body: String(o?.body || '') });
      return new Response(JSON.stringify({ access_token: 'ghu_new_token_000000', refresh_token: 'ghr_new', expires_in: 28800, refresh_token_expires_in: 15897600 }), { status: 200 });
    };
    try {
      const t = await refreshGithub('Iv1.app', 'ghr_old');
      expect(t.token).toBe('ghu_new_token_000000');
      expect(t.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600e3);
      expect(sent[0].body).toMatch(/grant_type=refresh_token/);
      expect(sent[0].body).not.toMatch(/client_secret/);
      // the settings sign-in: renewed only when it runs out within 10 minutes, then saved
      const s = { githubToken: 'ghu_old_token_0000000', githubRefresh: 'ghr_old', githubClientId: 'Iv1.app', githubExpiresAt: Date.now() + 60 * 60e3, githubUser: { login: 'me' } };
      let saved = 0;
      setGithubAuth(s, () => saved++);
      expect(await freshGithub()).toBe('');
      expect(sent.length).toBe(1);
      s.githubExpiresAt = Date.now() + 5 * 60e3;
      expect(await freshGithub()).toBe('');
      expect(s.githubToken).toBe('ghu_new_token_000000');
      expect(s.githubRefresh).toBe('ghr_new');
      expect(saved).toBe(1);
      expect(scrubToken('x ghu_new_token_000000 y')).toBe('x [GitHub token] y');
      // a refusal: the old sign-in stays, and the note says to sign in again
      globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 200 });
      s.githubExpiresAt = Date.now() + 60e3;
      expect(await freshGithub()).toMatch(/could not be renewed.*sign in again/);
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.__ocmGithubBase;
      setGithubAuth({});
    }
  });

  it('kinds of token, and what the model is told when an organisation refuses the sign-in', () => {
    expect(['ghu_x', 'gho_x', 'github_pat_x', 'ghp_x', 'x'].map(tokenKind)).toEqual(['app', 'oauth', 'fine', 'classic', 'other']);
    const out = "remote: Repository not found.\nfatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 403\nAlthough you appear to have the correct authorization credentials, the `org` organization has enabled OAuth App access restrictions";
    expect(githubHint(out, 'oauth')).toMatch(/refuses OAuth App sign-ins\. Do NOT work around it \(no SSH keys/);
    expect(githubHint("fatal: repository 'https://github.com/org/x.git/' not found\nRepository not found", 'app')).toMatch(/not installed on that repo/);
    expect(githubHint('all good', 'oauth')).toBe('');
  });

  it('the shell asks before making or handing out long-lived credentials', () => {
    for (const cmd of ['ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""', 'ssh-add ~/.ssh/id_ed25519', 'gh ssh-key add ~/.ssh/id.pub', 'gh auth token', 'gh auth login --with-token', 'echo "ssh-ed25519 AAA" >> ~/.ssh/authorized_keys', 'git config --global credential.helper store', 'cp key /root/.ssh/id_rsa'])
      expect(shellDanger(cmd)?.rule, cmd).toBe('credentials');
    for (const cmd of ['ssh-keygen -l -f key.pub', 'gh auth status', 'git push origin main', 'gh pr list', 'cat ~/.ssh/known_hosts'])
      expect(shellDanger(cmd), cmd).toBeNull();
  });

  it('the SSH key: only for the listed repos, the GitHub host key pinned, files private, out when it is off', () => {
    const home = mkdtempSync(join(tmpdir(), 'sshhome-'));
    const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----';
    const k = { key: KEY, pub: 'ssh-ed25519 AAAA', repos: ['acme-studio/demogame'], until: Date.now() + 3600e3, askPush: true };
    expect(execFileSync('sh', ['-c', sshScript(k, { home }).replace(/command -v ssh .*\n/, '')], { encoding: 'utf8' })).toContain('SSH_ON');
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    const repo = (url) => {
      const d = mkdtempSync(join(tmpdir(), 'r-'));
      execFileSync('git', ['init', '-q', d], { env });
      execFileSync('git', ['-C', d, 'remote', 'add', 'origin', url], { env });
      try {
        return execFileSync('git', ['-C', d, 'config', 'core.sshCommand'], { env, encoding: 'utf8' }).trim();
      } catch {
        return '';
      }
    };
    // the listed repo gets the key, with GitHub's own host key and nothing from ~/.ssh or an agent
    const cmd = repo('git@github.com:acme-studio/demogame.git');
    expect(cmd).toMatch(/-i \S+\/\.config\/chronicle\/ssh\/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none/);
    expect(cmd).toMatch(/StrictHostKeyChecking=yes/);
    expect(repo('ssh://git@github.com/acme-studio/demogame')).toBe(cmd);
    // any other repo does not
    expect(repo('git@github.com:acme-studio/other.git')).toBe('');
    expect(repo('git@github.com:someone/x.git')).toBe('');
    expect(readFileSync(join(home, '.config/chronicle/ssh/known_hosts'), 'utf8')).toMatch(/^github\.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl/);
    expect(statSync(join(home, '.config/chronicle/ssh/id_ed25519')).mode & 0o777).toBe(0o600);
    // time up: the next sync takes it out
    expect(sshOn(Date.now(), k)).toBe(true);
    expect(sshOn(Date.now() + 2 * 3600e3, k)).toBe(false);
    expect(execFileSync('sh', ['-c', sshScript(k, { home, now: Date.now() + 2 * 3600e3 })], { encoding: 'utf8' })).toContain('SSH_OFF');
    expect(() => statSync(join(home, '.config/chronicle/ssh/id_ed25519'))).toThrow();
    expect(repo('git@github.com:acme-studio/demogame.git')).toBe('');
    // no repos listed: never on, whatever the time
    expect(sshOn(Date.now(), { ...k, repos: [] })).toBe(false);
    expect(sshRepos('https://github.com/a/b.git\ngit@github.com:c/d.git, e/f/ junk')).toEqual(['a/b', 'c/d', 'e/f']);
  });

  it('while the key is on: every push asks, the key file cannot be read by a command, and a printed key is hidden', () => {
    setGithubSsh({ githubSshKey: 'k', githubSshRepos: ['a/b'], githubSshUntil: -1 });
    expect(sshAsksPush()).toBe(true);
    expect(shellDanger('cd /workspace/b && git push origin main', { askPush: true })?.rule).toBe('ssh-push');
    expect(shellDanger('git status', { askPush: true })).toBeNull();
    expect(shellDanger('cat ~/.config/chronicle/ssh/id_ed25519')?.rule).toBe('credentials');
    expect(shellDanger('cp /root/.config/chronicle/ssh/id_ed25519 /workspace/k')?.rule).toBe('credentials');
    expect(scrubToken('x\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\ny')).toBe('x\n[private key hidden]\ny');
    expect(githubPrompt()).toMatch(/GitHub over SSH: the user switched on their SSH key for a\/b[\s\S]*Every git push asks the user first/);
    setGithubSsh({ githubSshKey: 'k', githubSshRepos: ['a/b'], githubSshUntil: -1, githubSshAskPush: false });
    expect(sshAsksPush()).toBe(false);
    setGithubSsh({});
    expect(githubPrompt()).not.toMatch(/over SSH/);
  });

  it('tester round: ssh-git for bare URLs, honest config comment, no false prompts or hints, .git protected, progress lines', () => {
    const home = mkdtempSync(join(tmpdir(), 'sshgit-'));
    const script = join(home, 'ssh-git');
    execFileSync('sh', ['-c', `cat > ${script} && chmod 755 ${script}`], { input: sshGitScript(['acme-studio/demogame'], '/nonexistent') });
    // a URL that is not listed: refused before git runs
    let err = '';
    try {
      execFileSync(script, ['ls-remote', 'git@github.com:acme-studio/CrypticGarden.git'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      err = String(e.stderr);
    }
    expect(err).toMatch(/acme-studio\/crypticgarden is not in the SSH key's repo list/);
    // no URL at all: plain git
    expect(execFileSync(script, ['--version'], { encoding: 'utf8' })).toMatch(/^git version/);
    // the config says what the list is and is not
    const k = { key: 'x', repos: ['a/b'], until: -1 };
    expect(sshScript(k)).toContain('ssh-git');
    const inc = Buffer.from(/echo (\S+) \| base64 -d > \S+ssh\.gitconfig/.exec(sshScript(k))[1], 'base64').toString();
    expect(inc).toMatch(/full user key[\s\S]*NOT a limit on what the key/);
    // ssh-keygen only asks when it makes a key
    for (const cmd of ['ssh-keygen -lf /root/.ssh/id.pub', 'ssh-keygen -y -f k', 'ssh-keygen -E md5 -lf k.pub', 'ssh-keygen -p -f k']) expect(shellDanger(cmd), cmd).toBeNull();
    expect(shellDanger('ssh-keygen -t ed25519 -f k')?.rule).toBe('credentials');
    // deleting inside .git asks
    expect(shellDanger('rm /root/repo/.git/objects/pack/.l2s.tmp_123')?.rule).toBe('git-objects');
    expect(shellDanger('cd /root/repo && rm -f .git/index.lock')).toBeNull();
    // a clone that worked over SSH is not told the GitHub App is missing
    expect(githubHint("Cloning into 'demogame'...\nReceiving objects: 100% (403/5310), done.", 'app')).toBe('');
    expect(githubHint("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403", 'app')).toMatch(/not installed on that repo/);
    // progress redrawn with \r shows its last state
    expect(plain('Receiving objects:  10%\rReceiving objects:  55%\rReceiving objects: 100% (5310/5310), done.\nResolving deltas: 100%')).toBe('Receiving objects: 100% (5310/5310), done.\nResolving deltas: 100%');
  });
});

