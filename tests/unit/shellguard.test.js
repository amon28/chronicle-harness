import { describe, it, expect } from 'vitest';
import { shellDanger, shellChecks, commands, lex, resolvePath, unwrap, RULES } from '../../src/shellguard.js';

const asks = (cmd) => shellDanger(cmd);
const names = (cmd) => commands(cmd).map((c) => c.name);

describe('shellguard lexer', () => {
  it('splits on ; && || | & and newlines, keeping quoted operators inside words', () => {
    expect(names('a; b && c || d | e & f\ng')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(names('echo "a; b && c" \'| d\'')).toEqual(['echo']);
    expect(commands('echo "rm -rf /"')[0].args.map((a) => a.v)).toEqual(['rm -rf /']);
  });
  it('marks variables and command substitutions as unknown, and parses the substitution as a command too', () => {
    const t = lex('rm -rf "$DIR"/x $(pwd) `ls`');
    expect(t.tokens.filter((x) => x.t === 'w').map((x) => x.dyn)).toEqual([false, false, true, true, true]);
    expect(t.subs).toEqual(['pwd', 'ls']);
    expect(lex('echo $((1 + 2))').subs).toEqual([]); // arithmetic is not a command
    expect(names('echo $(rm -rf /etc)')).toContain('rm');
  });
  it('reads redirections with their targets, and drops fd duplications', () => {
    const c = commands('echo hi > /phone/a.txt 2>&1 >>log')[0];
    expect(c.redirects.map((r) => [r.v, r.target])).toEqual([
      ['>', '/phone/a.txt'],
      ['>>', 'log'],
    ]);
    expect(commands('cmd 2>/dev/null')[0].redirects[0]).toMatchObject({ v: '>', target: '/dev/null' });
    expect(commands('echo x>"/phone/q a.txt"')[0].redirects[0].target).toBe('/phone/q a.txt');
  });
  it('skips heredoc bodies, so a script being written is not read as commands', () => {
    const cmd = "cat > clean.sh <<'EOF'\nrm -rf /\ngit push --force\nEOF\nchmod +x clean.sh";
    expect(names(cmd)).toEqual(['cat', 'chmod']);
    expect(asks(cmd)).toBeNull();
    expect(names('cat <<-END > x\n\trm -rf /\n\tEND\necho ok')).toEqual(['cat', 'echo']);
  });
  it('skips comments, keeps # inside words', () => {
    expect(names('# rm -rf /\necho a#b')).toEqual(['echo']);
    expect(asks('ls # rm -rf /')).toBeNull();
  });
  it('handles backslashes and line continuations', () => {
    expect(names('\\rm -rf /x')).toEqual(['rm']);
    expect(commands('rm \\\n -rf /etc')[0].args.map((a) => a.v)).toEqual(['-rf', '/etc']);
  });
});

describe('shellguard prefixes and nesting', () => {
  it('takes sudo, env, command, nohup, timeout, nice, busybox, VAR= off', () => {
    for (const p of ['sudo', 'sudo -u root', 'env', 'env -i A=1 B=2', 'command', 'nohup', 'timeout 10', 'timeout -s KILL 5', 'nice -n 5', 'busybox', 'FOO=1', 'doas', 'exec', 'time', '/usr/bin/env']) expect(asks(`${p} rm -rf /etc`), p).toMatchObject({ rule: 'rm-recursive' });
    expect(unwrap(lex('sudo -u me env X=1 /bin/rm -r a').tokens).argv.map((w) => w.v)).toEqual(['/bin/rm', '-r', 'a']);
  });
  it('follows sh -c, bash -lc and eval strings', () => {
    expect(asks('sh -c "rm -rf /etc"')).toMatchObject({ rule: 'rm-recursive' });
    expect(asks("bash -lc 'cd /phone && rm -rf pics'")).toMatchObject({ rule: 'rm-recursive' });
    expect(asks('eval "git reset --hard"')).toMatchObject({ rule: 'git' });
    expect(asks('sh script.sh')).toBeNull();
  });
  it('follows cd within the line', () => {
    expect(asks('cd /phone && rm -rf old')).toMatchObject({ rule: 'rm-recursive' });
    expect(asks('cd build && rm -rf *')).toBeNull();
    expect(asks('cd /workspace/app; rm -rf node_modules dist')).toBeNull();
    expect(asks('cd "$X" && rm -rf out')).toMatchObject({ rule: 'rm-recursive' }); // unknown folder
    expect(asks('cd .. && rm -rf workspace')).toMatchObject({ reason: expect.stringContaining('whole workspace') });
  });
  it('resolves paths', () => {
    expect(resolvePath('/workspace', 'a/../b/./c')).toBe('/workspace/b/c');
    expect(resolvePath('/workspace', '../..')).toBe('/');
    expect(resolvePath('/x', '~/y')).toBe('/root/y');
    expect(resolvePath(null, 'y')).toBeNull();
    expect(resolvePath(null, '/y')).toBe('/y');
  });
});

describe('shellguard: rm', () => {
  const yes = ['rm -rf /', 'rm -rf /*', 'rm -fr /etc', 'rm -r /root', 'rm -Rf ~', 'rm -rf ~/projects', 'rm -rf "$HOME"', 'rm --recursive --force /usr', 'rm -rfv /var/lib', 'rm -rf /workspace', 'rm -rf /workspace/', 'rm -rf /workspace/*', 'rm -rf *', 'rm -rf .', 'rm -rf ./*', 'rm -rf ..', 'rm -rf ../../etc', 'rm -rf /phone/Pictures', 'rm -r /sdcard/DCIM', 'rm -rf /storage/emulated/0', 'rm /phone/notes.txt', 'rm -f /sdcard/a.jpg', 'rm -rf $BUILD', 'rm -rf "${OUT}/"', 'rm -rf /tmp', 'rm -rf /tmp/*', 'ls | xargs rm -rf', 'find /phone -name "*.tmp" | xargs rm -rf', 'rm -rf -- /etc', 'true && rm -rf /opt || echo no', 'echo a; rm -rf /home'];
  for (const cmd of yes) it(`asks: ${cmd}`, () => expect(asks(cmd)).toMatchObject({ rule: 'rm-recursive' }));
  const no = ['rm -rf /workspace/build', 'rm -rf node_modules', 'rm -rf build dist .cache', 'rm -rf /workspace/app/node_modules', 'rm -rf ./out/*', 'rm -rf /tmp/build', 'rm -rf /tmp/x/*', 'rm a.txt', 'rm -f /etc/motd', 'rm -rf "my dir"', "rm -rf 'a b'/c", 'echo "rm -rf /"', "echo 'rm -rf /phone'", 'printf "%s" "rm -rf ~"', 'grep -r "rm -rf" .', 'git rm -r --cached dist', 'find . -name "*.pyc" | xargs rm -f', 'find . -name "*.pyc" | xargs rm -rf', 'docker rm -f x', 'rm -rf /workspace/a/../b'];
  for (const cmd of no) it(`lets through: ${cmd}`, () => expect(asks(cmd)).toBeNull());
  it('says why', () => {
    expect(asks('rm -rf /phone/x').reason).toMatch(/phone/);
    expect(asks('rm -rf /etc').reason).toMatch(/outside the workspace/);
    expect(asks('rm -rf /workspace').reason).toMatch(/whole workspace/);
    expect(asks('rm -rf $X').reason).toMatch(/only known when it runs/);
  });
});

describe('shellguard: find, git, disk, chmod, phone writes', () => {
  const cases = [
    ['find /phone -name "*.bak" -delete', 'find-delete'],
    ['find /sdcard/Download -type f -delete', 'find-delete'],
    ['cd /phone && find . -delete', 'find-delete'],
    ['find /phone -exec rm {} \\;', 'find-delete'],
    ['git reset --hard', 'git'],
    ['git reset --hard HEAD~3', 'git'],
    ['git -C repo reset --hard origin/main', 'git'],
    ['git push --force', 'git'],
    ['git push -f origin main', 'git'],
    ['git push -uf origin main', 'git'],
    ['git push --force-with-lease', 'git'],
    ['git push --force-with-lease=main:abc origin main', 'git'],
    ['git push origin +main', 'git'],
    ['git push origin :old-branch', 'git'],
    ['git push --delete origin old', 'git'],
    ['git clean -fd', 'git'],
    ['git clean -xfd', 'git'],
    ['git clean --force', 'git'],
    ['git checkout -- .', 'git'],
    ['git checkout .', 'git'],
    ['git restore .', 'git'],
    ['git branch -D feature', 'git'],
    ['git branch --delete --force feature', 'git'],
    ['git stash clear', 'git'],
    ['sudo git push -f', 'git'],
    ['dd if=/dev/zero of=/dev/block/sda', 'disk'],
    ['dd if=a of=b bs=1M', 'disk'],
    ['mkfs.ext4 /dev/sdb1', 'disk'],
    ['mkfs -t vfat /dev/x', 'disk'],
    ['shred -u secrets.txt', 'disk'],
    ['chmod -R 000 /workspace', 'chmod-000'],
    ['chmod -R 0 .', 'chmod-000'],
    ['chmod -R a-rwx src', 'chmod-000'],
    ['echo hi > /phone/notes.txt', 'phone-overwrite'],
    ['cat x >| /sdcard/a', 'phone-overwrite'],
    ['cd /phone; echo > list.txt', 'phone-overwrite'],
    ['mv report.pdf /phone/', 'phone-overwrite'],
    ['cp -r out /sdcard/Documents', 'phone-overwrite'],
    ['cp -t /phone a b', 'phone-overwrite'],
    ['mv /phone/a.txt .', 'phone-overwrite'],
    ['echo x | tee /phone/a.txt', 'phone-overwrite'],
  ];
  for (const [cmd, rule] of cases) it(`asks: ${cmd}`, () => expect(asks(cmd)).toMatchObject({ rule }));
  const no = [
    'git push',
    'git push origin main',
    'git push -u origin feature',
    'git push --tags',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git checkout main',
    'git checkout -b new',
    'git checkout -- src/app.js',
    'git restore --staged .',
    'git branch -d merged',
    'git log --force',
    'git commit -m "push --force later"',
    'echo "git reset --hard"',
    'find . -name "*.log" -delete',
    'find /workspace/tmp -delete',
    'find /phone -name "*.jpg"',
    'chmod -R 755 .',
    'chmod 000 one-file',
    'echo hi >> /phone/log.txt',
    'cat /phone/a.txt > /workspace/a.txt',
    'cp /phone/a.txt /workspace/',
    'cp a b',
    'mv a.txt b.txt',
    'tee -a /phone/log < x',
    'ddrescue a b',
    'echo of=x | dd',
    'ls -la /phone',
    'python3 -c "import shutil; print(1)"',
    'npm test && npm run build',
  ];
  for (const cmd of no) it(`lets through: ${cmd}`, () => expect(asks(cmd)).toBeNull());
  it('every rule has an id and a description', () => {
    for (const r of RULES) expect(r.id && r.what && typeof r.test).toBeTruthy();
  });
  it('never throws on odd input', () => {
    for (const cmd of ['', '"', "'", '$(', '`', '<<', 'a |', '&& ||', '))))', '\\', 'x'.repeat(20000), 'echo $((', '>']) expect(() => shellDanger(cmd)).not.toThrow();
  });
});

describe('shellChecks (for the done check)', () => {
  it('writing, moving or listing files is not a check', () => {
    for (const c of ["cat > a.py <<'EOF'\nprint(1)\nEOF", 'echo x > a.txt', 'mkdir -p src && mv a b', "sed -i 's/a/b/' x", 'ls -la', 'git add -A && git commit -m x', 'cp -r a b; chmod +x b', 'sh -c "echo x > y"', 'apk add nodejs']) expect(shellChecks(c), c).toBe(false);
  });
  it('running anything else is', () => {
    for (const c of ['python3 a.py', 'npm test', 'node index.js', 'cat > a.py <<EOF\nprint(1)\nEOF\npython3 a.py', 'bash build.sh', 'curl -s http://127.0.0.1:8000/', 'sed -n 1,5p x', 'make', 'pytest -q', 'sh -c "pytest"']) expect(shellChecks(c), c).toBe(true);
  });
});
