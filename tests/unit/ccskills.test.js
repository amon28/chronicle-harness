// Chronicle's skills as Claude Code skills (decision 166): the commands run by a real sh in a temporary folder that
// stands for ~/.claude/skills; only folders Chronicle wrote are ever changed or removed.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccSkill, ccSkills, skillMd, safeSkillPath, skillsPlanCmd, skillsWriteCmds, parsePlan, syncCcSkills, MARKER } from '../../src/ccskills.js';

const sh = (cmd) => ({ output: execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }) });
const exec = async (cmd) => sh(cmd);
const skill = (name, o = {}) => ({ name, description: `What ${name} does: a test`, instructions: `# ${name}\n\nDo the ${name} thing.`, files: {}, enabled: true, ...o });
function place() {
  const T = mkdtempSync(join(tmpdir(), 'ccsk-'));
  return { dir: join(T, 'state'), skillsDir: join(T, 'skills') };
}

/** The frontmatter of a SKILL.md, read the way YAML reads it (the description is a JSON = YAML double-quoted string). */
function front(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const out = {};
  for (const line of m[1].split('\n')) {
    const [, k, v] = /^(\w+): (.*)$/.exec(line);
    out[k] = v.startsWith('"') ? JSON.parse(v) : v;
  }
  return out;
}

describe('Claude Code skills from Chronicle skills', () => {
  it('SKILL.md: frontmatter on the first line with name and a quoted description, then the instructions', () => {
    const md = skillMd(skill('meeting-notes', { description: 'Notes: "who said what" –\nand when' }));
    expect(md.startsWith('---\nname: meeting-notes\ndescription: ')).toBe(true);
    expect(front(md)).toEqual({ name: 'meeting-notes', description: 'Notes: "who said what" – and when' });
    expect(md).toContain('# meeting-notes\n\nDo the meeting-notes thing.');
    expect(md).toContain('mcp__chronicle__');
    expect(front(skillMd(skill('a-b', { description: 'x'.repeat(3000) }))).description).toHaveLength(1024);
  });
  it('only enabled skills with a valid name; unsafe file paths are left out', async () => {
    expect(await ccSkill(skill('off', { enabled: false }))).toBeNull();
    expect(await ccSkill(skill('Bad Name'))).toBeNull();
    for (const p of ['/etc/passwd', '../x', 'a/../../x', 'SKILL.md', MARKER, 'a//b', 'x\ny']) expect(safeSkillPath(p)).toBeNull();
    expect(safeSkillPath('docs/ref.md')).toBe('docs/ref.md');
    const s = await ccSkill(skill('tools', { files: { 'scripts/run.sh': 'echo hi', 'ref.md': 'r', '../evil': 'x', 'SKILL.md': 'not ours' } }));
    expect(s.files.map((f) => [f.path, f.exec])).toEqual([['SKILL.md', false], ['ref.md', false], ['scripts/run.sh', true]]);
    const all = await ccSkills([skill('a1'), skill('a1'), skill('b1', { enabled: false })]);
    expect(all.list.map((x) => x.name)).toEqual(['a1']);
  });

  it('writes them, keeps a user folder of the same name, rewrites only what changed, removes only its own', async () => {
    const { dir, skillsDir } = place();
    mkdirSync(join(skillsDir, 'mine'), { recursive: true });
    writeFileSync(join(skillsDir, 'mine', 'SKILL.md'), '---\nname: mine\n---\nthe user wrote this');
    mkdirSync(join(skillsDir, 'clash'), { recursive: true });
    writeFileSync(join(skillsDir, 'clash', 'SKILL.md'), 'the user clash');
    const set1 = [skill('notes', { files: { 'scripts/tool.sh': '#!/bin/sh\necho tool', 'docs/a b.md': "it's here" } }), skill('clash'), skill('pack-one', { source: 'pack' })];
    const r1 = await syncCcSkills(set1, { exec, dir, skillsDir });
    expect(r1.wrote.sort()).toEqual(['notes', 'pack-one']);
    expect(r1.user).toEqual(['clash']);
    const md = readFileSync(join(skillsDir, 'notes', 'SKILL.md'), 'utf8');
    expect(front(md)).toEqual({ name: 'notes', description: 'What notes does: a test' });
    expect(readFileSync(join(skillsDir, 'notes', 'docs', 'a b.md'), 'utf8')).toBe("it's here");
    expect(statSync(join(skillsDir, 'notes', 'scripts', 'tool.sh')).mode & 0o111).toBeTruthy();
    expect(execFileSync(join(skillsDir, 'notes', 'scripts', 'tool.sh'), { encoding: 'utf8' })).toBe('tool\n');
    expect(readFileSync(join(skillsDir, 'clash', 'SKILL.md'), 'utf8')).toBe('the user clash'); // never replaced
    expect(readFileSync(join(dir, 'skills.manifest'), 'utf8').trim().split('\n').sort()).toEqual(['notes', 'pack-one']);
    expect(existsSync(join(skillsDir, '.chronicle-manifest'))).toBe(false); // nothing of ours beside the skills

    // nothing changed: nothing written
    const r2 = await syncCcSkills(set1, { exec, dir, skillsDir });
    expect(r2.wrote).toEqual([]);
    expect(r2.same.sort()).toEqual(['notes', 'pack-one']);

    // one changed, one switched off: only those two are touched; the user's folders stay
    const set3 = [{ ...set1[0], instructions: 'new text' }, set1[1], { ...set1[2], enabled: false }];
    const r3 = await syncCcSkills(set3, { exec, dir, skillsDir });
    expect(r3.wrote).toEqual(['notes']);
    expect(r3.removed).toEqual(['pack-one']);
    expect(readFileSync(join(skillsDir, 'notes', 'SKILL.md'), 'utf8')).toContain('new text');
    expect(existsSync(join(skillsDir, 'pack-one'))).toBe(false);
    expect(readdirSync(skillsDir).sort()).toEqual(['clash', 'mine', 'notes']);

    // a name in our list whose folder the user replaced with their own (no marker): left alone when removed
    execFileSync('sh', ['-c', `rm -f '${join(skillsDir, 'notes', MARKER)}'`]);
    const r4 = await syncCcSkills([], { exec, dir, skillsDir });
    expect(r4.removed).toEqual([]);
    expect(existsSync(join(skillsDir, 'notes', 'SKILL.md'))).toBe(true);
    expect(readdirSync(skillsDir).sort()).toEqual(['clash', 'mine', 'notes']);
  });

  it('the plan is text with no skill contents; big skills are split over several commands', async () => {
    const big = await ccSkills([skill('big-a', { files: { 'a.txt': 'a'.repeat(300000) } }), skill('big-b', { files: { 'b.txt': 'b'.repeat(300000) } })]);
    const plan = skillsPlanCmd(big.list, { dir: '/x', skills: '/y' });
    expect(plan).not.toContain('aaaa');
    expect(parsePlan('@@NEED big-a\n@@USER x\n@@REMOVED old\n@@PLANNED')).toEqual({ need: ['big-a'], same: [], user: ['x'], removed: ['old'], ok: true });
    expect(skillsWriteCmds(big.list, { dir: '/x', skills: '/y' })).toHaveLength(2);
    expect(() => skillsPlanCmd([{ name: 'x; rm -rf /', hash: 'abc' }], { dir: '/x' })).toThrow();
  });
});
