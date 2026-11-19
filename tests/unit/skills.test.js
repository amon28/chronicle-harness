import { describe, it, expect } from 'vitest';
import { parseSkillMd, skillToMd, upsertSkill, skillFromFiles, skillDefs, skillsPrompt, runSkillTool, slugName, registerSkillScripts, syncSkillScripts } from '../../src/skills.js';
import { sha256Hex } from '../../src/hash.js';
import { toolDefs, toolsSystemPrompt } from '../../src/tools.js';

describe('skills', () => {
  it('parses SKILL.md front matter, including folded descriptions', () => {
    const p = parseSkillMd('---\nname: Meeting Notes\ndescription: Turns a transcript\n  into notes. Use after meetings.\n---\n\n# Steps\n1. Read it');
    expect(p.name).toBe('meeting-notes');
    expect(p.description).toBe('Turns a transcript into notes. Use after meetings.');
    expect(p.body).toBe('# Steps\n1. Read it');
    expect(parseSkillMd('just text').body).toBe('just text');
  });
  it('round-trips through SKILL.md', () => {
    const k = { name: 'a-b', description: 'does x', instructions: 'Do it.' };
    expect(parseSkillMd(skillToMd(k))).toEqual({ name: 'a-b', description: 'does x', body: 'Do it.' });
  });
  it('creates, validates and updates by name', () => {
    const list = [];
    expect(() => upsertSkill(list, { name: 'X', description: 'd', instructions: 'i' })).toThrow(/2–49/);
    expect(() => upsertSkill(list, { name: 'ok-name', description: '', instructions: 'i' })).toThrow(/description/);
    const a = upsertSkill(list, { name: 'Weekly Report', description: 'weekly', instructions: 'v1', files: [{ path: 'template.md', content: '# T' }, { path: '../evil.md', content: 'x' }, { path: 'SKILL.md', content: 'ignored' }] });
    expect(a.created).toBe(true);
    expect(a.skill.name).toBe('weekly-report');
    expect(Object.keys(a.skill.files)).toEqual(['template.md', 'evil.md']);
    const b = upsertSkill(list, { name: 'weekly-report', description: 'weekly v2', instructions: 'v2' });
    expect(b.created).toBe(false);
    expect(list).toHaveLength(1);
    expect(list[0].instructions).toBe('v2');
    expect(list[0].files['template.md']).toBe('# T'); // files are kept when an update sends none
  });
  it('imports a folder of files', () => {
    const k = skillFromFiles({ 'pdf-forms/SKILL.md': '---\nname: pdf-forms\ndescription: Fill forms\n---\nSteps', 'pdf-forms/ref/fields.md': 'f', 'other/x.md': 'no' });
    expect(k.name).toBe('pdf-forms');
    expect(k.files).toEqual({ 'ref/fields.md': 'f' });
    expect(() => skillFromFiles({ 'a.txt': 'x' })).toThrow(/SKILL.md/);
    expect(slugName('  Hello World! ')).toBe('hello-world');
  });
  it('is offered to the model: save_skill always, use_skill once one exists, and the prompt lists them', () => {
    expect(skillDefs([]).map((t) => t.function.name)).toEqual(['save_skill']);
    const sk = [{ name: 'meeting-notes', description: 'Notes from meetings', instructions: 'x', enabled: true }];
    expect(toolDefs({ skills: sk }).map((t) => t.function.name)).toEqual(expect.arrayContaining(['use_skill', 'save_skill']));
    expect(toolsSystemPrompt({ skills: sk }, 0)).toContain('meeting-notes: Notes from meetings');
    expect(skillsPrompt([])).toContain('save_skill');
  });
  it('use_skill returns the instructions and copies reference files into the workspace', async () => {
    const settings = { agentSkills: [{ name: 'weekly-report', description: 'd', instructions: 'Write it weekly.', files: { 'template.md': '# T' }, enabled: true }] };
    const ctx = { settings, workspace: { id: 'c', files: {} } };
    const r = await runSkillTool('use_skill', { name: 'weekly-report' }, ctx);
    expect(r.result).toContain('Write it weekly.');
    expect(r.result).toContain('skills/weekly-report/template.md');
    expect(ctx.workspace.files['skills/weekly-report/template.md']).toBeTruthy();
    await expect(runSkillTool('use_skill', { name: 'nope' }, ctx)).rejects.toThrow(/No skill/);
    const s = await runSkillTool('save_skill', { name: 'new-one', description: 'd', instructions: 'i' }, { ...ctx, onSkillsChanged() {} });
    expect(s.ok).toBe(true);
    expect(settings.agentSkills).toHaveLength(2);
  });
});

describe('a skill\'s scripts/ folder as a toolkit source', () => {
  const ws = () => ({ id: 'c', files: {} });
  const read = (w, p) => new TextDecoder().decode(w.files[p].data);
  const manifest = (w, n = 'demo') => (w.files[`skills/${n}/scripts/.toolkit`] ? read(w, `skills/${n}/scripts/.toolkit`) : '');
  const url = (w) => (w.files['.toolkit-url'] ? read(w, '.toolkit-url') : null);

  it('places scripts LF-normalised and executable, with a manifest hashed from the bytes on disk', async () => {
    const w = ws();
    const r = await registerSkillScripts(w, 'demo', { 'scripts/b-hello': '#!/bin/sh\r\necho b\r\n', 'scripts/a-hello': '#!/bin/sh\necho a\r\n', 'notes.md': 'n' });
    expect(r.scripts).toEqual(['a-hello', 'b-hello']);
    expect(read(w, 'skills/demo/scripts/b-hello')).toBe('#!/bin/sh\necho b\n');
    expect(w.files['skills/demo/scripts/a-hello'].exec).toBe(true);
    expect(w.files['skills/demo/scripts/b-hello'].exec).toBe(true);
    expect(read(w, 'skills/demo/notes.md')).toBe('n');
    expect(w.files['skills/demo/notes.md'].exec).toBe(false);
    const lines = manifest(w).split('\n');
    expect(lines[0]).toBe('# toolkit source for the skill demo (written by the app) - do not edit');
    expect(lines[1]).toBe(`${await sha256Hex('#!/bin/sh\necho a\n')}  a-hello`);
    expect(lines[2]).toBe(`${await sha256Hex('#!/bin/sh\necho b\n')}  b-hello`);
    expect(lines[3]).toBe('');
    expect(w.files['skills/demo/scripts/.toolkit'].exec).toBe(false);
    expect(r.placed).toContain('skills/demo/scripts/.toolkit');
  });

  it('only installs scripts that can be installed; the rest stay plain reference files', async () => {
    const w = ws();
    const r = await registerSkillScripts(w, 'demo', { 'scripts/ok': '#!/bin/sh\r\necho ok\r\n', 'scripts/sub/x': 'x', 'scripts/.hidden': 'h', 'scripts/job': '#!/bin/sh\r\necho job\r\n', 'scripts/bad name': 'b' });
    expect(r.scripts).toEqual(['ok']);
    const man = manifest(w);
    expect(man).not.toMatch(/sub|hidden|job|bad name|\.x/);
    expect(man.trim().split('\n').filter((l) => !l.startsWith('#'))).toHaveLength(1);
    // still placed, untouched (no LF normalisation, no exec bit) - they are reference files only
    for (const p of ['skills/demo/scripts/sub/x', 'skills/demo/scripts/.hidden', 'skills/demo/scripts/job', 'skills/demo/scripts/bad name']) {
      expect(w.files[p]).toBeTruthy();
      expect(w.files[p].exec).toBe(false);
    }
    expect(read(w, 'skills/demo/scripts/job')).toBe('#!/bin/sh\r\necho job\r\n');
  });

  it('registers the folder in .toolkit-url once and keeps whatever is already there', async () => {
    const w = ws();
    await registerSkillScripts(w, 'demo', { 'scripts/a': 'a' });
    const first = url(w);
    expect(first.split('\n')[0]).toBe("# toolkit sources, one per line - the app adds each used skill's scripts/ folder");
    expect(first.split('\n')[1]).toBe('file:///workspace/skills/demo/scripts');
    expect(first.endsWith('\n')).toBe(true);
    await registerSkillScripts(w, 'demo', { 'scripts/a': 'a' });
    expect(url(w)).toBe(first); // no duplicate line

    const w2 = ws();
    w2.files['.toolkit-url'] = { data: new TextEncoder().encode('https://example.test/tk') };
    await registerSkillScripts(w2, 'demo', { 'scripts/a': 'a' });
    expect(url(w2)).toBe('https://example.test/tk\nfile:///workspace/skills/demo/scripts\n');

    const w3 = ws();
    w3.files['.toolkit-url'] = { data: new TextEncoder().encode('# mine\nhttps://x.test/y\n') };
    await registerSkillScripts(w3, 'other', { 'scripts/a': 'a' });
    expect(url(w3)).toBe('# mine\nhttps://x.test/y\nfile:///workspace/skills/other/scripts\n');

    const w4 = ws();
    w4.files['.toolkit-url'] = { data: new TextEncoder().encode('file:///workspace/skills/demo/scripts\n') };
    await registerSkillScripts(w4, 'demo', { 'scripts/a': 'a' });
    expect(url(w4)).toBe('file:///workspace/skills/demo/scripts\n');
  });

  it('a skill with no scripts/ writes no manifest and leaves .toolkit-url alone', async () => {
    const w = ws();
    const r = await registerSkillScripts(w, 'demo', { 'template.md': '# T', 'scripts/deep/x': 'x' });
    expect(r.scripts).toEqual([]);
    expect(w.files['skills/demo/scripts/.toolkit']).toBeUndefined();
    expect(w.files['.toolkit-url']).toBeUndefined();
    expect(read(w, 'skills/demo/template.md')).toBe('# T');
    expect(read(w, 'skills/demo/scripts/deep/x')).toBe('x');
  });

  it('use_skill says the scripts are a toolkit source the shell can pull', async () => {
    const settings = { agentSkills: [{ name: 'demo', description: 'd', instructions: 'Do it.', files: { 'scripts/hello': '#!/bin/sh\necho hi\n' }, enabled: true }] };
    const ctx = { settings, workspace: ws() };
    const r = await runSkillTool('use_skill', { name: 'demo' }, ctx);
    expect(r.result).toContain('Do it.');
    expect(r.result).toContain('skills/demo/scripts/hello');
    expect(r.result).toContain('[Scripts registered as a toolkit source: hello - run toolkit-pull in the shell to install them into PATH]');
    expect(url(ctx.workspace)).toContain('file:///workspace/skills/demo/scripts');
  });
});

describe('installed skills reach the shell without use_skill', () => {
  const dec = (u8) => new TextDecoder().decode(u8);
  const skill = (over = {}) => ({ name: 'hls-aes-grab', description: 'd', instructions: 'i', enabled: true, files: { 'scripts/spca-grab': '#!/bin/sh\r\necho grab\r\n', 'README.md': 'r' }, ...over });

  it('places every enabled skill script, its manifest and the source line', async () => {
    const w = { id: 'sk1', files: {} };
    const r = await syncSkillScripts(w, [skill(), skill({ name: 'off-skill', enabled: false, files: { 'scripts/nope': 'x' } })]);
    expect(r.scripts.map((s) => s.name)).toEqual(['spca-grab']);
    expect(r.changed).toEqual(['spca-grab']);
    expect(dec(w.files['skills/hls-aes-grab/scripts/spca-grab'].data)).toBe('#!/bin/sh\necho grab\n');
    expect(w.files['skills/hls-aes-grab/scripts/spca-grab'].exec).toBe(true);
    const h = await sha256Hex('#!/bin/sh\necho grab\n');
    expect(dec(w.files['skills/hls-aes-grab/scripts/.toolkit'].data)).toContain(h + '  spca-grab');
    expect(dec(w.files['.toolkit-url'].data)).toContain('file:///workspace/skills/hls-aes-grab/scripts');
    expect(w.files['skills/off-skill/scripts/nope']).toBeUndefined();
    expect(w.files['skills/hls-aes-grab/README.md']).toBeUndefined(); // reference files still wait for use_skill
  });

  it('writes nothing the second time, and only the script that changed after an edit', async () => {
    const w = { id: 'sk2', files: {} };
    const first = await syncSkillScripts(w, [skill()]);
    const before = { ...w.files };
    const again = await syncSkillScripts(w, [skill()]);
    expect(again.changed).toEqual([]);
    expect(again.signature).toBe(first.signature);
    for (const p of Object.keys(before)) expect(w.files[p]).toBe(before[p]); // same objects: no rewrite, no crossing
    const edited = await syncSkillScripts(w, [skill({ files: { 'scripts/spca-grab': '#!/bin/sh\necho v2\n' } })]);
    expect(edited.changed).toEqual(['spca-grab']);
    expect(edited.signature).not.toBe(first.signature);
  });

  it('the skill list says which scripts each skill puts in PATH', () => {
    const p = skillsPrompt([skill(), { name: 'plain', description: 'no tools', files: {} }]);
    expect(p).toContain('hls-aes-grab: d (its scripts are installed in the shell\'s PATH: spca-grab)');
    expect(p).toContain('plain: no tools');
    expect(p).not.toContain('plain: no tools (');
  });
});

describe('edit_skill', () => {
  const mk = () => [{ id: 's1', name: 'meeting-notes', description: 'Notes from meetings.', instructions: '1. List attendees\n2. Write decisions', files: { 'template.md': '# Notes\n## Decisions' }, enabled: true }];
  it('edits the instructions and a file, keeps the rest', async () => {
    const { editSkill } = await import('../../src/skills.js');
    const list = mk();
    const r = editSkill(list, { name: 'meeting-notes', edits: [{ old_text: '2. Write decisions', new_text: '2. Write decisions\n3. List action items' }, { file: 'template.md', old_text: '## Decisions', new_text: '## Decisions\n## Actions' }], files: [{ path: 'example.md', content: 'x' }] });
    expect(r.changed).toEqual(['instructions (1 edit)', 'template.md (1 edit)', 'added example.md']);
    expect(list[0].instructions).toContain('3. List action items');
    expect(list[0].description).toBe('Notes from meetings.');
    expect(Object.keys(list[0].files).sort()).toEqual(['example.md', 'template.md']);
  });
  it('rename, switch off, delete; a bad edit or unknown skill is an error', async () => {
    const { editSkill } = await import('../../src/skills.js');
    const list = mk();
    editSkill(list, { name: 'meeting-notes', rename: 'minutes', enabled: false });
    expect(list[0]).toMatchObject({ name: 'minutes', enabled: false });
    expect(() => editSkill(list, { name: 'minutes', edits: [{ old_text: 'nope', new_text: 'x' }] })).toThrow();
    expect(() => editSkill(list, { name: 'ghost', delete: true })).toThrow(/No skill called/);
    editSkill(list, { name: 'minutes', delete: true });
    expect(list).toHaveLength(0);
  });
});
