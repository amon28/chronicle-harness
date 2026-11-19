import { describe, it, expect } from 'vitest';
import { hooksFor, hookScript, runHooks } from '../../src/hooks.js';

const list = [
  { name: 'fmt', event: 'post_tool', matcher: 'write_file|edit_file', command: 'prettier -w .' },
  { name: 'guard', event: 'pre_tool', matcher: 'shell', command: 'echo no' },
  { name: 'tests', event: 'stop', command: 'npm test' },
  { name: 'off', event: 'stop', command: 'x', enabled: false },
];
describe('hooks', () => {
  it('pick by event and tool name', () => {
    expect(hooksFor(list, 'post_tool', 'edit_file').map((h) => h.name)).toEqual(['fmt']);
    expect(hooksFor(list, 'post_tool', 'read_file')).toEqual([]);
    expect(hooksFor(list, 'stop').map((h) => h.name)).toEqual(['tests']);
  });
  it('the script exports the tool data safely quoted', () => {
    const s = hookScript(list[0], { event: 'post_tool', toolName: 'edit_file', args: { path: "it's.js" } });
    expect(s).toContain(`export TOOL_ARGS='{"path":"it'\\''s.js"}'`);
    expect(s).toContain('cd /workspace; prettier -w .');
  });
  it('exit 2 blocks, other failures and output are notes', async () => {
    const run = async (script) => (script.includes('echo no') ? { exit: 2, output: 'rm -rf is not allowed' } : script.includes('prettier') ? { exit: 0, output: 'formatted 2 files' } : { exit: 1, output: 'boom' });
    const pre = await runHooks(hooksFor(list, 'pre_tool', 'shell'), { event: 'pre_tool' }, run);
    expect(pre.blocked).toEqual({ hook: 'guard', output: 'rm -rf is not allowed' });
    const post = await runHooks(hooksFor(list, 'post_tool', 'write_file'), { event: 'post_tool' }, run);
    expect(post.notes[0]).toContain('formatted 2 files');
    const stop = await runHooks(hooksFor(list, 'stop'), { event: 'stop' }, run);
    expect(stop.notes[0]).toContain('exited 1');
  });
});
