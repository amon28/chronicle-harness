import { describe, it, expect } from 'vitest';
import { parseModSource, parseModFiles, validateManifest, applyRequestEdit, requestView, toolName, describePerm, modDocument, checkCode } from '../../src/mods.js';
import { addBuiltinSkills } from '../../src/skills.js';

const hdr = (m) => `/*! @mod ${JSON.stringify(m)} */\nmod.log(1);`;

describe('mod files', () => {
  it('reads the header of a single-file mod', () => {
    const r = parseModSource(hdr({ id: 'My Mod', name: 'My mod', permissions: ['tools', 'net:api.github.com'] }));
    expect(r.manifest).toMatchObject({ id: 'my-mod', name: 'My mod', version: '1.0.0', permissions: ['tools', 'net:api.github.com'] });
  });
  it('refuses a file without a header, bad JSON, and unknown permissions', () => {
    expect(() => parseModSource('mod.log(1)')).toThrow(/no mod header/);
    expect(() => parseModSource('/*! @mod {oops} */')).toThrow(/not valid JSON/);
    expect(() => validateManifest({ id: 'x1', permissions: ['root'] })).toThrow(/Unknown permission/);
    expect(() => validateManifest({ id: '', name: '' })).toThrow(/id/);
    expect(() => checkCode('   ')).toThrow();
  });
  it('reads a zip with mod.json and main.js', () => {
    const r = parseModFiles({ 'pack/mod.json': JSON.stringify({ id: 'zipmod', name: 'Zip', permissions: ['commands'] }), 'pack/main.js': 'mod.log(2)' });
    expect(r.manifest.id).toBe('zipmod');
    expect(r.code).toBe('mod.log(2)');
    expect(() => parseModFiles({ 'main.js': 'x' })).toThrow(/mod.json/);
  });
  it('describes permissions in plain words, with net:* called out', () => {
    expect(describePerm('net:api.github.com')).toContain('api.github.com');
    expect(describePerm('net:*')).toMatch(/ANY website/);
  });
  it('tool names are namespaced by mod and safe', () => {
    expect(toolName('my-mod', 'roll')).toBe('mod_my_mod__roll');
  });
});

describe('what a beforeRequest hook may change', () => {
  const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:...' } }] }, { role: 'assistant', content: null, tool_calls: [{ id: '1' }] }, { role: 'tool', content: 'result', tool_call_id: '1' }];
  it('sees a plain-text view: pictures and tool results are summarized', () => {
    const v = requestView(msgs, { model: 'm', persona: { id: 'p', name: 'P' } });
    expect(v.system).toBe('SYS');
    expect(v.messages.map((m) => m.content)).toEqual(['hi\n[image]', '[tool call]', '[tool result]']);
  });
  it('may replace the system prompt and add messages after it and at the end, nothing else', () => {
    const out = applyRequestEdit(msgs, { system: 'NEW', prepend: [{ role: 'system', content: 'P' }], append: [{ role: 'user', content: 'A' }, { role: 'tool', content: 'sneaky' }, { role: 'system', content: 5 }], messages: [{ role: 'user', content: 'ignored' }] });
    expect(out[0].content).toBe('NEW');
    expect(out[1]).toEqual({ role: 'system', content: 'P' });
    expect(out.at(-1)).toEqual({ role: 'user', content: 'A' });
    expect(out).toHaveLength(msgs.length + 2); // invalid entries dropped, the history itself is untouched
    expect(out.slice(2, 5)).toEqual(msgs.slice(1));
    expect(applyRequestEdit(msgs, null)).toBe(msgs);
  });
});

describe('the sandbox page', () => {
  it('forbids every request with a CSP and escapes </script> in mod code', () => {
    const doc = modDocument('tok', { id: 'a', name: 'A', version: '1', permissions: [] }, 'mod.log("</script><b>")');
    expect(doc).toContain("default-src 'none'");
    expect(doc.match(/<\/script>/g)).toHaveLength(1); // only the real closing tag
  });
});

describe('built-in skill', () => {
  it('adds the mods guide as a skill once', () => {
    const s = {};
    expect(addBuiltinSkills(s)).toBe(true);
    expect(s.agentSkills.map((k) => k.name)).toContain('chronicle-mods');
    expect(s.agentSkills[0].instructions).toContain('mod.tool');
    expect(addBuiltinSkills(s)).toBe(false);
    s.agentSkills = []; // deleted by the user: it stays deleted
    expect(addBuiltinSkills(s)).toBe(false);
    expect(s.agentSkills).toHaveLength(0);
  });
});

import { ModHost } from '../../src/mods.js';
describe('search sources from mods', () => {
  it('asks every running mod source, tidies the results, and never lets one failure break the rest', async () => {
    const host = new ModHost({ getSettings: () => ({}), save() {}, toast() {}, onChange() {} });
    host.running.set('wiki', { ready: true, manifest: { name: 'Wiki' }, sources: [{ name: 'pages' }], invoke: async (kind, name, p) => [{ title: 'A', url: 'https://a.test', snippet: 'about ' + p.args.query }, { title: '', snippet: '' }] });
    host.running.set('bad', { ready: true, manifest: { name: 'Bad' }, sources: [{ name: 'x' }], invoke: async () => Promise.reject(new Error('timed out')) });
    host.running.set('off', { ready: false, manifest: { name: 'Off' }, sources: [{ name: 'y' }], invoke: async () => [] });
    const out = await host.runSearchSources('cats', { max: 5 });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ source: 'Wiki · pages', results: [{ title: 'A', url: 'https://a.test', snippet: 'about cats' }] });
    expect(out[1].error).toBe('timed out');
  });
});

describe('tool hooks and panels from mods', () => {
  const host = () => new ModHost({ getSettings: () => ({}), save() {}, toast() {}, onChange() {} });
  it('beforeTool can block or change a call, afterTool can rewrite a result, a broken hook is skipped', async () => {
    const h = host();
    const logs = [];
    h.running.set('guard', { ready: true, manifest: { name: 'Guard' }, hooks: ['beforeTool', 'afterTool'], logs, invoke: async (kind, name, p) => (name === 'beforeTool' ? (p.payload.name === 'delete_file' ? { block: 'no deleting' } : p.payload.name === 'read_file' ? { args: { ...p.payload.args, max_chars: 100 } } : null) : { result: p.payload.result.replace('SECRET', '***') }) });
    h.running.set('broken', { ready: true, manifest: { name: 'Broken' }, hooks: ['beforeTool'], logs, invoke: async () => Promise.reject(new Error('boom')) });
    expect((await h.beforeTool('delete_file', { path: 'a' })).block).toBe('Guard: no deleting');
    expect((await h.beforeTool('read_file', { path: 'a' })).args).toEqual({ path: 'a', max_chars: 100 });
    expect((await h.beforeTool('list_files', {})).args).toEqual({});
    expect(await h.afterTool('read_file', {}, 'a SECRET b')).toBe('a *** b');
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });
  it('lists panels and renders one', async () => {
    const h = host();
    h.running.set('notes', { ready: true, manifest: { name: 'Notes', id: 'notes' }, panels: [{ name: 'Notes', icon: '📝', description: 'x' }], invoke: async (kind, name) => `# ${name}\nhello` });
    expect(h.panelList()).toEqual([{ id: 'notes', mod: 'Notes', name: 'Notes', icon: '📝', description: 'x' }]);
    expect(await h.renderPanel('notes', 'Notes')).toBe('# Notes\nhello');
  });
});

describe('built-in harness guide', () => {
  it('is added, and a newer text replaces an unedited copy but never an edited one', () => {
    const s = {};
    addBuiltinSkills(s);
    const k = s.agentSkills.find((x) => x.name === 'chronicle-harness');
    expect(k.instructions).toContain('private to the page');
    expect(k.builtinHash).toBeTruthy();
    // an older app shipped an older text
    k.instructions = 'old guide';
    k.builtinHash = 'x';
    expect(addBuiltinSkills(s)).toBe(false); // edited (text no longer matches its hash): left alone
    expect(k.instructions).toBe('old guide');
    const fnv = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
    k.builtinHash = fnv('old guide'); // unedited copy of the old text
    expect(addBuiltinSkills(s)).toBe(true);
    expect(k.instructions).toContain('private to the page');
  });
});
