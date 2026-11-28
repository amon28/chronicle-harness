import { describe, it, expect } from 'vitest';
import { splitDeferred, loadToolsDef, pickToLoad, deferredList } from '../../src/deferred.js';

const def = (name, desc = 'Does a thing. More text here.') => ({ type: 'function', function: { name, description: desc, parameters: { type: 'object', properties: { x: { type: 'string', description: 'y'.repeat(300) } } } } });
describe('deferred tools', () => {
  it('a few small tools are sent as they are', () => {
    const r = splitDeferred([def('tool_a'), def('tool_b')]);
    expect(r.active).toHaveLength(2);
    expect(r.deferred).toHaveLength(0);
  });
  it('many tools are held back except the ones already loaded', () => {
    const many = Array.from({ length: 30 }, (_, i) => def('mcp_s_t' + i, `[S] Tool number ${i}. Long.`));
    const r = splitDeferred(many, ['mcp_s_t3']);
    expect(r.active.map((d) => d.function.name)).toEqual(['mcp_s_t3']);
    expect(r.deferred).toHaveLength(29);
    const lt = loadToolsDef(r.deferred);
    expect(lt.function.description).toContain('- mcp_s_t4: Tool number 4.');
  });
  it('load by name or by a search word', () => {
    const d = [def('tool_weather', 'Gets the weather.'), def('mcp_gh_issue', 'Create a GitHub issue.')];
    expect(pickToLoad({ names: ['tool_weather', 'nope'] }, d)).toEqual({ names: ['tool_weather'], missing: ['nope'] });
    expect(pickToLoad({ query: 'github' }, d).names).toEqual(['mcp_gh_issue']);
  });
});

describe('built-in tools on demand (decision 175)', () => {
  it('holds back the seldom-used ones until they are loaded, keeps the everyday ones', async () => {
    const { splitBuiltins, ON_DEMAND } = await import('../../src/deferred.js');
    const { toolDefs } = await import('../../src/tools.js');
    const on = { web: true, python: true, files: true, phone: true, intents: true, device: true, phonectl: true, delegate: true, creator: true, browser: true, shell: true, preview: true, autonomy: true, claudecode: { models: [] }, vision: true, models: [] };
    const all = toolDefs(on);
    const names = (l) => l.map((d) => d.function.name);
    const { active, deferred } = splitBuiltins(all, []);
    for (const n of ['read_file', 'write_file', 'shell', 'web_search', 'fetch_url', 'browser', 'run_python', 'phone_read', 'memory', 'ask_user']) expect(names(active)).toContain(n);
    for (const n of ['calendar', 'places', 'save_character', 'schedule_task', 'claude_code', 'phone_control']) expect(names(deferred)).toContain(n);
    expect(deferred.every((d) => ON_DEMAND.has(d.function.name))).toBe(true);
    // what it saves: well over a third of the definitions
    const size = (l) => JSON.stringify(l).length;
    expect(size(deferred) / size(all)).toBeGreaterThan(0.35);
    // loaded ones are sent again
    expect(names(splitBuiltins(all, ['calendar']).active)).toContain('calendar');
  });
});

describe('the load_tools list within budget (decision 269)', () => {
  const def = (name, d = 'Does a thing that is described at some length here.') => ({ type: 'function', function: { name, description: d } });
  it('built-ins come first and are never cut off behind a hundred MCP tools; the rest go to names only, then "and N more"', () => {
    const mcp = Array.from({ length: 400 }, (_, i) => def(`mcp_server_tool_number_${i}`, 'An MCP tool with a long description that takes up a good part of the budget. More words.'));
    const all = [...mcp, def('calendar', 'Read and add calendar events.'), def('claude_code', 'Run Claude Code.')];
    const t = deferredList(all);
    expect(t.split('\n')[0]).toBe('- calendar: Read and add calendar events.');
    expect(t.split('\n')[1]).toBe('- claude_code: Run Claude Code.');
    expect(t).toMatch(/- also \(names only – load_tools with a query searches their descriptions\): mcp_server_tool_number_\d+, /);
    expect(t).toMatch(/- … and \d+ more: load_tools with a query/);
    expect(t.length).toBeLessThan(8600);
    expect(loadToolsDef(all).function.description).toContain('- calendar:');
  });
  it('a short list is every tool with its line', () => {
    expect(deferredList([def('a', 'One.'), def('b', 'Two.')])).toBe('- a: One.\n- b: Two.');
  });
});

describe('the one line of a deferred tool', () => {
  it('is cut at a word with …, and a too-short first sentence takes the next one', () => {
    const d = (desc) => ({ type: 'function', function: { name: 't', description: desc } });
    expect(deferredList([d('Short one. It lists the jobs kept on the computer for an hour.')])).toBe('- t: Short one. It lists the jobs kept on the computer for an hour.');
    const long = deferredList([d('Look at the phone calendar and the contacts and the location and the places nearby and the weather and the time zones of the cities the user travels to and much more besides.')]);
    expect(long).toMatch(/^- t: Look at the phone calendar .*[a-z]…$/);
    expect(long.length).toBeLessThan(150);
  });
});
