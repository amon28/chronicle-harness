import { describe, it, expect, beforeEach } from 'vitest';
import { runTool, toolDefs, toolsSystemPrompt } from '../../src/tools.js';

// a fake phone folder: { path: Uint8Array }
let disk;
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = (s) => new TextEncoder().encode(s);
beforeEach(() => {
  disk = { 'notes/todo.txt': enc('buy milk'), 'photos/a.jpg': new Uint8Array([1, 2, 3]), 'photos/b.jpg': new Uint8Array([4, 5]), 'readme.md': enc('# hi') };
  globalThis.__ocmPhoneFolder = {
    pick: async () => ({ uri: 'content://x', name: 'Projects' }),
    list: async ({ path, recursive }) => {
      const pre = path ? path + '/' : '';
      const out = [];
      const dirs = new Set();
      for (const [p, d] of Object.entries(disk)) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length);
        const first = rest.split('/')[0];
        if (recursive) out.push({ path: p, isDir: false, size: d.length });
        else if (rest.includes('/')) dirs.add(pre + first);
        else out.push({ path: p, isDir: false, size: d.length });
      }
      if (recursive) return { entries: out };
      return { entries: [...[...dirs].map((p) => ({ path: p, isDir: true, size: 0 })), ...out] };
    },
    read: async ({ path }) => {
      if (!disk[path]) throw new Error('No such file: ' + path);
      return { base64: b64(disk[path]) };
    },
    write: async ({ path, base64 }) => {
      const existed = path in disk;
      disk[path] = fromB64(base64);
      return { existed };
    },
    remove: async ({ path }) => (delete disk[path], { ok: true }),
    exists: async ({ path }) => {
      if (disk[path]) return { exists: true, isDir: false, size: disk[path].length };
      const dir = Object.keys(disk).some((p) => p.startsWith(path + '/'));
      return { exists: dir, isDir: dir, size: 0 };
    },
  };
});

const mk = (mode = 'auto') => {
  const folder = { uri: 'content://x', name: 'Projects' };
  const ctx = {
    settings: {},
    workspace: { id: 'c1', files: {} },
    phone: { folder: () => ctx._f, link: async () => (ctx._f = folder), mode: () => mode, stage: new Map(), log: [] },
    _f: folder,
  };
  return { ctx };
};
const call = (name, args) => ({ name, arguments: JSON.stringify(args) });

describe('phone folder tools', () => {
  it('are only offered when enabled, and the prompt explains linking', () => {
    expect(toolDefs({ phone: true }).map((t) => t.function.name)).toContain('phone_import');
    expect(toolDefs({ phone: false }).map((t) => t.function.name)).not.toContain('phone_import');
    expect(toolsSystemPrompt({ phone: true }, 0, null)).toContain('phone_folder');
    expect(toolsSystemPrompt({ phone: true }, 0, { name: 'Projects' })).toContain('"Projects"');
  });
  it('lets the assistant ask the user to pick a folder', async () => {
    const { ctx } = mk();
    ctx._f = null;
    const need = await runTool(call('phone_list', {}), ctx);
    expect(need.ok).toBe(false);
    expect(need.result).toContain('phone_folder');
    const r = await runTool(call('phone_folder', { action: 'link' }), ctx);
    expect(r.ok).toBe(true);
    expect((await runTool(call('phone_list', {}), ctx)).result).toContain('readme.md');
  });
  it('lists, reads text, and imports files into the workspace', async () => {
    const { ctx } = mk();
    expect((await runTool(call('phone_list', {}), ctx)).result).toContain('notes/');
    // the contents, then the evidence line every tool result now carries
    expect((await runTool(call('phone_read', { path: 'notes/todo.txt' }), ctx)).result.split('\n\n[surface=')[0]).toBe('buy milk');
    const r = await runTool(call('phone_import', { path: 'photos' }), ctx);
    expect(r.ok).toBe(true);
    expect(Object.keys(ctx.workspace.files).sort()).toEqual(['photos/a.jpg', 'photos/b.jpg']);
    await runTool(call('phone_import', { path: 'readme.md', to: 'docs/readme.md' }), ctx);
    expect(ctx.workspace.files['docs/readme.md']).toBeTruthy();
  });
  it('phone_import to: a folder to copy into (keeping the name), unless it ends in the same extension', async () => {
    const { ctx } = mk();
    const r = await runTool(call('phone_import', { path: 'readme.md', to: 'imported' }), ctx);
    expect(r.ok).toBe(true);
    expect(Object.keys(ctx.workspace.files)).toEqual(['imported/readme.md']);
    expect(r.result).toContain('imported/readme.md');
    await runTool(call('phone_import', { path: 'notes/todo.txt', to: 'in/' }), ctx);
    expect(ctx.workspace.files['in/todo.txt']).toBeTruthy();
    await runTool(call('phone_import', { path: 'notes/todo.txt', to: 'in/list.TXT' }), ctx);
    expect(ctx.workspace.files['in/list.TXT']).toBeTruthy();
    await runTool(call('phone_import', { path: 'photos', to: 'pics' }), ctx);
    expect(ctx.workspace.files['pics/a.jpg']).toBeTruthy();
    expect(toolDefs({ phone: true }).find((t) => t.function.name === 'phone_import').function.parameters.properties.to.description).toMatch(/keeps its name/);
  });
  it('saves a workspace file to the phone', async () => {
    const { ctx } = mk();
    ctx.workspace.files['output/chart.png'] = { data: new Uint8Array([9, 9]) };
    await runTool(call('phone_write', { path: 'chart.png', from_workspace: 'output/chart.png' }), ctx);
    expect([...disk['chart.png']]).toEqual([9, 9]);
  });
});

describe('agent modes', () => {
  it('auto mode writes at once and logs the previous contents', async () => {
    const { ctx } = mk('auto');
    await runTool(call('phone_write', { path: 'out/new.txt', content: 'hello' }), ctx);
    await runTool(call('phone_write', { path: 'readme.md', content: 'changed' }), ctx);
    expect(new TextDecoder().decode(disk['out/new.txt'])).toBe('hello');
    expect(new TextDecoder().decode(disk['readme.md'])).toBe('changed');
    expect(ctx.phone.log.map((e) => e.kind)).toEqual(['new', 'replace']);
    expect(new TextDecoder().decode(ctx.phone.log[1].before)).toBe('# hi');
    await runTool(call('phone_delete', { path: 'readme.md' }), ctx);
    expect(disk['readme.md']).toBeUndefined();
    expect(ctx.phone.log[2].kind).toBe('delete');
  });
  it('review mode stages changes and leaves the disk alone', async () => {
    const { ctx } = mk('ask');
    const r = await runTool(call('phone_write', { path: 'readme.md', content: 'changed' }), ctx);
    expect(r.result).toContain('NOT saved');
    expect(new TextDecoder().decode(disk['readme.md'])).toBe('# hi');
    await runTool(call('phone_write', { path: 'new.txt', content: 'n' }), ctx);
    await runTool(call('phone_delete', { path: 'notes/todo.txt' }), ctx);
    expect([...ctx.phone.stage.entries()].map(([p, e]) => p + ':' + e.kind)).toEqual(['readme.md:replace', 'new.txt:new', 'notes/todo.txt:delete']);
    // the assistant sees its own staged changes
    expect((await runTool(call('phone_read', { path: 'new.txt' }), ctx)).result.split('\n\n[surface=')[0]).toBe('n');
    expect((await runTool(call('phone_read', { path: 'readme.md' }), ctx)).result.split('\n\n[surface=')[0]).toBe('changed');
    const list = (await runTool(call('phone_list', {}), ctx)).result;
    expect(list).toContain('new.txt');
  });
  it('read-only refuses every write', async () => {
    const { ctx } = mk('readonly');
    const w = await runTool(call('phone_write', { path: 'x.txt', content: 'x' }), ctx);
    const d = await runTool(call('phone_delete', { path: 'readme.md' }), ctx);
    expect(w.ok).toBe(false);
    expect(d.ok).toBe(false);
    expect(disk['x.txt']).toBeUndefined();
    expect(disk['readme.md']).toBeTruthy();
  });

  // Review mode: what a staged change is called decides what ↩ Undo does after you accept it. "new" is undone by
  // DELETING the file, "replace" by writing the old bytes back (review-ui.js reads them, engine.js undoFileChanges).
  it('phone_delete deletes an empty folder (staged in review mode), never one with something in it', async () => {
    const dirs = new Set(['stress-tmp', 'full']);
    disk['full/keep.txt'] = enc('k');
    const fake = globalThis.__ocmPhoneFolder;
    const { exists, list, remove } = fake;
    fake.exists = async (o) => (dirs.has(o.path) && !(await exists(o)).exists ? { exists: true, isDir: true, size: 0 } : exists(o));
    fake.list = async (o) => (dirs.has(o.path) && !Object.keys(disk).some((p) => p.startsWith(o.path + '/')) ? { entries: [] } : list(o));
    fake.remove = async (o) => (dirs.has(o.path) ? (dirs.delete(o.path), { ok: true }) : remove(o));
    const auto = mk('auto').ctx;
    const full = await runTool(call('phone_delete', { path: 'full' }), auto);
    expect(full.ok).toBe(false);
    expect(full.result).toMatch(/full\/ is not empty \(1 entry\) – only an empty folder can be deleted/);
    expect(disk['full/keep.txt']).toBeTruthy();
    const review = mk('ask').ctx;
    const st = await runTool(call('phone_delete', { path: 'stress-tmp' }), review);
    expect(st.ok).toBe(true);
    expect(review.phone.stage.get('stress-tmp')).toMatchObject({ kind: 'delete', dir: true });
    expect(dirs.has('stress-tmp')).toBe(true);
    const d = await runTool(call('phone_delete', { path: 'stress-tmp/' }), auto);
    expect(d.ok).toBe(true);
    expect(d.result).toMatch(/Deleted the empty folder stress-tmp\//);
    expect(dirs.has('stress-tmp')).toBe(false);
    // review mode: a file staged inside the folder makes it not empty
    const r2 = mk('ask').ctx;
    dirs.add('tmp2');
    await runTool(call('phone_write', { path: 'tmp2/new.txt', content: 'n' }), r2);
    expect((await runTool(call('phone_delete', { path: 'tmp2' }), r2)).ok).toBe(false);
  });
  it('review mode: delete then write of a file that exists is a replacement, not a new file (undo would delete your original)', async () => {
    const { ctx } = mk('ask');
    await runTool(call('phone_delete', { path: 'notes/todo.txt' }), ctx);
    const r = await runTool(call('phone_write', { path: 'notes/todo.txt', content: 'rewritten' }), ctx);
    expect(r.ok).toBe(true);
    expect(ctx.phone.stage.get('notes/todo.txt').kind).toBe('replace');
    expect(new TextDecoder().decode(disk['notes/todo.txt'])).toBe('buy milk'); // still only staged
  });

  it('review mode: a file staged as new stays new when written again, and deleting it just drops it', async () => {
    const { ctx } = mk('ask');
    await runTool(call('phone_write', { path: 'draft.txt', content: 'one' }), ctx);
    await runTool(call('phone_write', { path: 'draft.txt', content: 'two' }), ctx);
    expect(ctx.phone.stage.get('draft.txt').kind).toBe('new'); // it is not on the phone: nothing to "replace", and undo removes it
    const d = await runTool(call('phone_delete', { path: 'draft.txt' }), ctx);
    expect(d.ok).toBe(true);
    expect(ctx.phone.stage.has('draft.txt')).toBe(false); // nothing left for the review to "delete" on the phone
  });
});

describe('paths that leave the folder', () => {
  it('phone_write / phone_delete refuse ".." instead of quietly changing another file', async () => {
    const { ctx } = mk('auto');
    disk['escape-test.txt'] = enc('keep me');
    const w = await runTool(call('phone_write', { path: '../escape-test.txt', content: 'x' }), ctx);
    expect(w.ok).toBe(false);
    expect(w.result).toMatch(/"\.\." is not allowed in path \(\.\.\/escape-test\.txt\).*escape-test\.txt/);
    expect(new TextDecoder().decode(disk['escape-test.txt'])).toBe('keep me');
    const d = await runTool(call('phone_delete', { path: 'notes/../escape-test.txt' }), ctx);
    expect(d.ok).toBe(false);
    expect(disk['escape-test.txt']).toBeTruthy();
    expect((await runTool(call('phone_write', { path: 'sub/./ok.txt', content: 'y' }), ctx)).ok).toBe(true);
    expect(disk['sub/ok.txt']).toBeTruthy();
  });
});
