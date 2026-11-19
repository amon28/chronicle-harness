import { describe, it, expect } from 'vitest';
import { applyToolPicks, applyToolset, picksFrom } from '../../src/toolset.js';
import { picksArg } from '../../src/creatortools.js';
import { toolDefs } from '../../src/tools.js';

const names = (defs) => defs.map((d) => d.function.name);
const ALL = { web: true, python: false, files: true, shell: false, device: true, creator: true, autonomy: true };

describe('single tools on top of a persona’s groups', () => {
  it('a light persona with no web keeps web_search alone, and loses memory', () => {
    const groups = applyToolset(ALL, { web: false, device: false, creator: false });
    const before = names(toolDefs(groups));
    expect(before).not.toContain('web_search');
    expect(before).toContain('memory');
    const out = names(applyToolPicks(toolDefs(groups), { on: ['web_search', 'calendar'], off: ['memory'] }, () => toolDefs(ALL)));
    expect(out).toContain('web_search');
    expect(out).toContain('calendar');
    expect(out).not.toContain('fetch_url'); // only the one asked for, not its whole group
    expect(out).not.toContain('memory');
  });
  it('a tool the user has off in Settings cannot be given by a persona', () => {
    const out = names(applyToolPicks(toolDefs({ ...ALL, web: false }), { on: ['run_python'] }, () => toolDefs(ALL)));
    expect(out).not.toContain('run_python');
  });
  it('no picks: the list is unchanged', () => {
    const d = toolDefs(ALL);
    expect(applyToolPicks(d, undefined, () => [])).toBe(d);
    expect(applyToolPicks(d, {}, () => [])).toBe(d);
  });
  it('stores only what differs from the groups', () => {
    const groupOf = { web_search: ['web'], memory: ['base'], calendar: ['device'], read_file: ['python', 'files'] };
    expect(picksFrom(new Set(['web_search', 'calendar']), new Set(['memory', 'read_file']), groupOf, new Set(['base', 'web', 'files']))).toEqual({ on: ['calendar'], off: ['memory', 'read_file'] });
    expect(picksFrom(new Set(['web_search']), new Set(['calendar']), groupOf, new Set(['base', 'web']))).toBeUndefined();
  });
  it('the assistant’s add_tools / remove_tools: a list given replaces it, a list left out stays', () => {
    expect(picksArg({})).toBeUndefined();
    expect(picksArg({ add_tools: ['memory', 'Bad Name', 'memory'] })).toEqual({ on: ['memory'], keepOn: false, keepOff: true });
    expect(picksArg({ add_tools: [], remove_tools: [] })).toEqual({ keepOn: false, keepOff: false });
    expect(picksArg({ add_tools: ['a_b'], remove_tools: ['a_b', 'c_d'] })).toEqual({ on: ['a_b'], off: ['c_d'], keepOn: false, keepOff: false });
  });
});

import { isSmallModel, splitBuiltins } from '../../src/deferred.js';
import { deferredSections } from '../../src/tools.js';
describe('a lighter tool set for small models (decision 201)', () => {
  it('small: on-device, 14B or less, mini/nano/lite; not the big ones', () => {
    expect(isSmallModel({ source: 'local', id: 'qwen' })).toBe(true);
    expect(isSmallModel({ id: 'qwen2.5-7b-instruct' })).toBe(true);
    expect(isSmallModel({ id: 'llama-3.1-70b' })).toBe(false);
    expect(isSmallModel({ id: 'gpt-5-mini' })).toBe(true);
    expect(isSmallModel({ id: 'glm-5.3', name: 'GLM-5.3' })).toBe(false);
    expect(isSmallModel({ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' })).toBe(false);
  });
  it('the browser, previews, scripts and helpers wait in load_tools, with their guidance', () => {
    const defs = toolDefs({ web: true, files: true, browser: true, preview: true, delegate: true, autonomy: true, agents: [], models: [] });
    const lean = splitBuiltins(defs, [], { lean: true });
    for (const n of ['browser', 'preview_page', 'run_script', 'delegate']) expect(names(lean.deferred)).toContain(n);
    expect(names(lean.active)).toContain('read_file');
    expect(names(splitBuiltins(defs, []).active)).toContain('browser');
    expect(deferredSections({ browser: true, lean: true }).map((x) => x.key)).toContain('browser');
    expect(deferredSections({ browser: true }).map((x) => x.key)).not.toContain('browser');
  });
});
