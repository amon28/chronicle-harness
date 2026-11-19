import { describe, it, expect } from 'vitest';
import { asksFirst, isWriteCall } from '../../src/planmode.js';

describe('🛡 Ask first: which calls wait for an OK', () => {
  it('asks for the plain write tools, as before', () => {
    for (const n of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'shell', 'run_python', 'browser', 'schedule_task', 'save_tool', 'phone_write']) expect(asksFirst(n, '{}')).toBe(true);
  });
  it('asks for calls that run saved code or reach outside, which plan mode already treats as changes', () => {
    expect(asksFirst('tool_cleanup', '{}')).toBe(true); // a saved Python tool
    expect(asksFirst('mcp_github__create_issue', '{"title":"x"}')).toBe(true);
    expect(asksFirst('mod_dice__roll', {})).toBe(true);
    expect(asksFirst('memory', '{"action":"delete","id":"m_1"}')).toBe(true);
    expect(asksFirst('saved_tools', { action: 'delete', name: 'x' })).toBe(true);
  });
  it('never asks for reading', () => {
    for (const [n, a] of [['read_file', '{"path":"a"}'], ['list_files', '{}'], ['web_search', '{"query":"x"}'], ['memory', '{"action":"list"}'], ['memory', ''], ['saved_tools', '{"action":"read","name":"x"}'], ['location', '{}'], ['contacts', '{}'], ['run_script', '{"code":"1"}']]) expect(asksFirst(n, a)).toBe(false);
  });
  it('leaves the two that ask in their own way alone', () => {
    expect(isWriteCall('delegate', { tools: 'full' })).toBe(true);
    expect(asksFirst('delegate', '{"tools":"full","task":"x"}')).toBe(false); // each of the helper's calls is asked
    expect(asksFirst('calendar', '{"action":"add","title":"x","start":"2026-11-20"}')).toBe(false); // shows its own question every time
  });
  it('survives arguments that are not JSON', () => {
    expect(asksFirst('write_file', '{"path":')).toBe(true);
    expect(asksFirst('read_file', '{"path":')).toBe(false);
  });
});
