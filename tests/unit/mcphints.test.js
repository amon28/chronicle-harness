import { describe, it, expect, beforeEach } from 'vitest';
import { clearMcpHints, mcpDestructive, mcpReadOnly, noteMcpTool } from '../../src/mcphints.js';
import { asksFirst, isWriteCall } from '../../src/planmode.js';

describe('MCP read-only / destructive labels (decision 201)', () => {
  beforeEach(clearMcpHints);
  it('a read-only label counts only for a trusted server', () => {
    noteMcpTool('mcp_docs_search', { readOnlyHint: true }, false);
    expect(mcpReadOnly('mcp_docs_search')).toBe(false);
    expect(isWriteCall('mcp_docs_search', {})).toBe(true);
    noteMcpTool('mcp_docs_search', { readOnlyHint: true }, true);
    expect(mcpReadOnly('mcp_docs_search')).toBe(true);
    expect(isWriteCall('mcp_docs_search', {})).toBe(false); // plan mode lets it through
    expect(asksFirst('mcp_docs_search', '{}')).toBe(false); // 🛡 Ask first does not ask
  });
  it('a tool labelled both read-only and destructive is neither; destructive shows even untrusted', () => {
    noteMcpTool('mcp_x_odd', { readOnlyHint: true, destructiveHint: true }, true);
    expect(mcpReadOnly('mcp_x_odd')).toBe(false);
    expect(mcpDestructive('mcp_x_odd')).toBe(false);
    noteMcpTool('mcp_x_rm', { destructiveHint: true }, false);
    expect(mcpDestructive('mcp_x_rm')).toBe(true);
    expect(isWriteCall('mcp_x_rm', {})).toBe(true);
    expect(isWriteCall('mcp_unknown_tool', {})).toBe(true); // no label: a write, as before
  });
});
