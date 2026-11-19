import { test, expect } from './helpers.js';

const openGithub = async (app) => {
  await app.evaluate(() => {
    globalThis.__ocmGithubBase = { web: `${globalThis.__MOCK}/gh`, api: `${globalThis.__MOCK}/ghapi` };
    window.open = () => null; // the code page would open in a new window here
  });
  await app.click('#menu-btn');
  await app.click('#open-settings');
  await app.click('.set-item[data-page="connect"]');
  await app.click('#gh-box > summary');
};

test('Sign in with GitHub: a code to approve, then connected with the name and email to commit with', async ({ app }) => {
  await openGithub(app);
  await expect(app.locator('#gh-status')).toContainText('add the OAuth App client ID');
  // no client ID yet: the field is shown instead of a failed request
  await app.click('#gh-signin');
  await expect(app.locator('#gh-client-id')).toBeVisible();
  await app.fill('#gh-client-id', 'Ov23test');
  await app.locator('#gh-client-id').dispatchEvent('change');
  await app.click('#gh-signin');
  await expect(app.locator('#gh-code')).toHaveText('ABCD-1234');
  await expect(app.locator('#gh-status')).toContainText('Connected as @tester', { timeout: 10000 });
  await expect(app.locator('#gh-code-box')).toBeHidden();
  await expect(app.locator('#gh-sum')).toContainText('Connected as @tester');
  await expect(app.locator('#gh-name')).toHaveValue('Test Er');
  await expect(app.locator('#gh-email')).toHaveValue('tester@example.com'); // the primary verified email (the profile hides it)

  // sign out, then a pasted token
  await app.click('#gh-signout');
  await expect(app.locator('#gh-sum')).toContainText('Not connected');
  await app.click('#gh-box summary:has-text("Paste a token")');
  await app.fill('#gh-pat', 'github_pat_wrong');
  await app.click('#gh-pat-save');
  await expect(app.locator('.toast').last()).toContainText('does not accept this token');
  await app.fill('#gh-pat', 'github_pat_mock123');
  await app.click('#gh-pat-save');
  await expect(app.locator('#gh-status')).toContainText('Connected as @tester with a pasted token');
});

test('Sign in with a GitHub App: only the installed repos, and the sign-in renews itself', async ({ app }) => {
  await openGithub(app);
  await app.click('#gh-box summary:has-text("Use a GitHub App")');
  await app.fill('#gh-client-id', 'Iv1test');
  await app.locator('#gh-client-id').dispatchEvent('change');
  await app.click('#gh-signin');
  await expect(app.locator('#gh-status')).toContainText('GitHub App sign-in (only the repos the app is installed on)', { timeout: 10000 });
  await expect(app.locator('#gh-status')).toContainText('Reaches acme: 2 (game, site)');
  await expect(app.locator('#gh-status')).toContainText('renews itself');
});


test('Test names the kind of sign-in, what it reaches, and why an org repo is not reachable', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__ocmShell = { status: async () => ({ available: true, installed: true }), exec: async ({ cmd }) => ({ output: /ls-remote/.test(cmd) ? (/acme\/game/.test(cmd) ? 'abc\trefs/heads/main\nEXIT=0' : 'remote: Repository not found.\nfatal: repository not found\nEXIT=0') : 'GITHUB_SIGNED_IN', exit: 0 }), addListener: async () => ({ remove() {} }) };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openGithub(app);
  await app.click('#gh-box summary:has-text("Use a GitHub App")');
  await app.fill('#gh-client-id', 'Iv1test');
  await app.locator('#gh-client-id').dispatchEvent('change');
  await app.click('#gh-signin');
  await expect(app.locator('#gh-status')).toContainText('Reaches acme: 2', { timeout: 10000 });
  await app.fill('#gh-check-repo', 'other-org/secret');
  await app.click('#gh-test');
  await expect(app.locator('#gh-status')).toContainText('GitHub App sign-in', { timeout: 15000 });
  await expect(app.locator('#gh-status')).toContainText('It reaches 2 repos: acme: 2 (game, site)');
  await expect(app.locator('#gh-status')).toContainText('not installed on other-org');
  await app.fill('#gh-check-repo', 'https://github.com/acme/game.git');
  await app.click('#gh-test');
  await expect(app.locator('#gh-status')).toContainText('✓ git in the shell reached acme/game', { timeout: 15000 });
});

test('SSH key (last resort): made on the phone, used only for listed repos, switched on for a time, deleted', async ({ app }) => {
  await app.addInitScript(() => {
    globalThis.__sshCmds = [];
    globalThis.__ocmShell = {
      status: async () => ({ available: true, installed: true }),
      exec: async ({ cmd }) => {
        globalThis.__sshCmds.push(cmd);
        if (/ssh-keygen -q -t ed25519/.test(cmd)) return { output: 'KEYSTART\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----\nPUBSTART\nssh-ed25519 AAAAC3pub chronicle-phone\nFPSTART\n256 SHA256:abcFP chronicle-phone (ED25519)\nKEYEND', exit: 0 };
        if (/SSH_ON|SSH_OFF/.test(cmd)) return { output: /\/id_ed25519$/m.test(cmd) || /use-key/.test(cmd) ? 'SSH_ON' : 'SSH_OFF', exit: 0 };
        return { output: 'GITHUB_SIGNED_OUT', exit: 0 };
      },
      addListener: async () => ({ remove() {} }),
    };
  });
  await app.reload();
  await app.waitForSelector('body[data-ready="1"]');
  await openGithub(app);
  await app.click('#gh-ssh-box > summary');
  await expect(app.locator('#gh-ssh-status')).toHaveText('No key.');
  await app.click('#gh-ssh-make');
  await expect(app.locator('#gh-ssh-status')).toContainText('Key SHA256:abcFP');
  await expect(app.locator('#gh-ssh-status')).toContainText('off: list the repos');
  // cannot switch on without repos
  await app.selectOption('#gh-ssh-for', '60');
  await expect(app.locator('#gh-ssh-for')).toHaveValue('0');
  await app.fill('#gh-ssh-repos', 'https://github.com/acme-studio/demogame.git');
  await app.locator('#gh-ssh-repos').dispatchEvent('change');
  await app.selectOption('#gh-ssh-for', '60');
  await expect(app.locator('#gh-ssh-status')).toContainText('ON for acme-studio/demogame until');
  // the key went into the shell (base64 inside the script), never as plain text
  const cmds = await app.evaluate(() => globalThis.__sshCmds.join('\n'));
  expect(cmds).toContain('SSH_ON');
  expect(cmds).not.toContain('AAAAfake');
  // delete: off, out of the shell, gone from the phone
  app.once('dialog', (d) => d.accept());
  await app.click('#gh-ssh-delete');
  await expect(app.locator('#gh-ssh-status')).toHaveText('No key.');
  expect(await app.evaluate(() => globalThis.__sshCmds.at(-1))).toContain('SSH_OFF');
});
