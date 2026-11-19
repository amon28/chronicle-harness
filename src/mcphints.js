// What MCP servers say about their tools (decision 201): `annotations.readOnlyHint` / `destructiveHint` from
// tools/list. The MCP spec says to treat them as untrusted unless the server is trusted, so a read-only hint counts
// only for a server the user marked as trusted (Settings › MCP servers › Test › "Trust its read-only labels"); then
// its read-only tools are not treated as writes (plan mode lets them through, 🛡 Ask first does not ask, they run
// side by side with other reads). A destructive hint is always shown when you are asked. Never loosens "Never".
const hints = new Map(); // tool name as offered (mcp_server_tool) → { readOnly, destructive }

/** Called by mcp.js as it lists a server's tools. */
export function noteMcpTool(name, annotations, trusted) {
  const a = annotations && typeof annotations === 'object' ? annotations : {};
  hints.set(name, { readOnly: !!trusted && a.readOnlyHint === true && a.destructiveHint !== true, destructive: a.destructiveHint === true && a.readOnlyHint !== true });
}
export const mcpReadOnly = (name) => !!hints.get(String(name || ''))?.readOnly;
export const mcpDestructive = (name) => !!hints.get(String(name || ''))?.destructive;
/** For tests. */
export const clearMcpHints = () => hints.clear();
