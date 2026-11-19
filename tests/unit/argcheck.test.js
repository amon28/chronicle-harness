import { describe, it, expect } from 'vitest';
import { repairArgs } from '../../src/argcheck.js';

const READ = { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] };
const parse = (r) => JSON.parse(r.arguments);

describe('tool arguments are checked against the tool’s schema', () => {
  it('numbers and booleans sent as text are read as the type the tool takes, and said', () => {
    const r = repairArgs('read_file', READ, '{"path":"a.js","start_line":"5"}');
    expect(parse(r)).toEqual({ path: 'a.js', start_line: 5 });
    expect(r.changed).toBe(true);
    expect(r.note).toContain('"start_line"');
    const b = repairArgs('x', { type: 'object', properties: { overwrite: { type: 'boolean' }, urls: { type: 'array' } } }, '{"overwrite":"true","urls":"https://a.b"}');
    expect(parse(b)).toEqual({ overwrite: true, urls: ['https://a.b'] });
  });
  it('a near-miss name is moved, an unknown one is left out and said; a missing required one is refused', () => {
    const r = repairArgs('read_file', READ, '{"file_path":"a.js","reason":"look"}');
    expect(parse(r)).toEqual({ path: 'a.js' });
    expect(r.note).toContain('"file_path" was read as "path"');
    expect(r.note).toContain('ignored "reason"');
    expect(repairArgs('read_file', READ, '{"start_line":1}').error).toMatch(/missing "path".*It takes: path \(required\)/);
  });
  it('MCP and mod tools keep what their schema does not list', () => {
    const r = repairArgs('mcp_x__search', { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } } }, '{"q":"cats","limit":"3","extra":1}');
    expect(parse(r)).toEqual({ q: 'cats', limit: 3, extra: 1 });
    expect(r.note).not.toContain('ignored');
  });
  it('right as sent: unchanged; broken JSON and schema-less tools: left to the tool', () => {
    const r = repairArgs('read_file', READ, '{"path":"a.js"}');
    expect(r.changed).toBe(false);
    expect(r.note).toBe('');
    expect(repairArgs('read_file', READ, '{"path":')).toBeNull();
    expect(repairArgs('doctor', { type: 'object', properties: {} }, '{}')).toBeNull();
  });
});
