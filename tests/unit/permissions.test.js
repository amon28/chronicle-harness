import { describe, it, expect } from 'vitest';
import { toolPermission } from '../../src/permissions.js';

describe('tool permissions', () => {
  const p = { shell: 'ask', delete_file: 'deny', 'mcp_*': 'ask', mcp_notes_read: 'allow' };
  it('own rule, then the MCP / mod default, else allow', () => {
    expect(toolPermission(p, 'shell')).toBe('ask');
    expect(toolPermission(p, 'delete_file')).toBe('deny');
    expect(toolPermission(p, 'mcp_github_create_issue')).toBe('ask');
    expect(toolPermission(p, 'mcp_notes_read')).toBe('allow');
    expect(toolPermission(p, 'read_file')).toBe('allow');
    expect(toolPermission(undefined, 'shell')).toBe('allow');
  });
});
