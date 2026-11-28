import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/mcp.js', async (orig) => ({
  ...(await orig()),
  callTool: vi.fn(async () => ({ text: 'The chart:\n[picture 1 – shown to you after this result]', images: ['data:image/png;base64,iVBORw0KGgo='], isError: false })),
}));
const { runTool } = await import('../../src/tools.js');

// Decision 270: an MCP tool's pictures, for a model that cannot see them, are described by a vision model – before, it
// was only told that there were pictures it could not see.
describe("an MCP tool's pictures for a model that cannot see", () => {
  const route = { mcp_s_chart: { server: { name: 'charts' }, tool: 'chart' } };
  const call = { name: 'mcp_s_chart', arguments: '{}' };
  it('are described, and the text says so', async () => {
    const asked = [];
    const r = await runTool(call, { mcpRoute: route, vision: false, describeImages: async (imgs, q) => (asked.push([imgs.length, q]), { text: 'A bar chart: sales 2025 rise from 10 to 40.', model: 'Vision One' }) });
    expect(r.result).toMatch(/\[picture 1 – described below\]/);
    expect(r.result).toMatch(/\[The pictures, described by Vision One – this model cannot see them\]\nA bar chart: sales 2025 rise from 10 to 40\./);
    expect(asked[0][0]).toBe(1);
    expect(r.images).toBeUndefined();
  });
  it('without a vision model, says it cannot see them', async () => {
    const r = await runTool(call, { mcpRoute: route, vision: false });
    expect(r.result).toMatch(/\[picture 1 – this model cannot see pictures\]/);
  });
  it('a model that sees gets the pictures themselves', async () => {
    const r = await runTool(call, { mcpRoute: route, vision: true });
    expect(r.images).toHaveLength(1);
  });
});
