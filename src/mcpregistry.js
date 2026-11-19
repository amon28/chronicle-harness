/**
 * The official MCP registry (registry.modelcontextprotocol.io): search it, and turn an entry into a server to add –
 * a remote (Streamable HTTP) one as is, an npm / PyPI package as a stdio command for the built-in Linux.
 */
export const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** One registry entry → { name, publisher, title, description, version, website, repo, options: [...] } */
export function describeEntry(entry) {
  const s = entry?.server || entry || {};
  const options = [];
  for (const r of s.remotes || []) {
    if (!/streamable-http|http/.test(r.type || r.transport_type || '')) continue; // the old SSE transport is not supported
    options.push({ kind: 'remote', url: r.url, headers: (r.headers || []).map((h) => ({ name: h.name, secret: !!h.isSecret, required: !!h.isRequired, description: h.description || '' })) });
  }
  for (const p of s.packages || []) {
    const type = p.registryType || p.registry_name;
    const id = p.identifier || p.name;
    if (!id || (p.transport?.type && p.transport.type !== 'stdio')) continue;
    const ver = p.version && p.version !== 'latest' ? p.version : '';
    const args = [...(p.runtimeArguments || []), ...(p.packageArguments || [])].filter((a) => a.type === 'positional' && a.value && a.value !== '-y').map((a) => q(a.value));
    let command = '';
    if (type === 'npm') command = `npx -y ${id}${ver ? '@' + ver : ''}`;
    else if (type === 'pypi') command = `uvx ${id}${ver ? '@' + ver : ''}`;
    else continue; // docker / nuget / mcpb: not runnable here
    options.push({ kind: type, command: [command, ...args].join(' '), env: (p.environmentVariables || []).map((e) => ({ name: e.name, required: !!e.isRequired, secret: !!e.isSecret, description: e.description || '', def: e.default || '' })) });
  }
  const name = s.name || '';
  return { name, publisher: name.includes('/') ? name.split('/')[0] : '', title: s.title || name.split('/').pop() || name, description: s.description || '', version: s.version || '', website: s.websiteUrl || '', repo: s.repository?.url || '', options };
}

/** Search → newest version of each server, runnable ones first. http(url) → { status, body }. */
export async function searchRegistry(query, { http, limit = 30 }) {
  const url = `${REGISTRY}?limit=${limit}${query ? `&search=${encodeURIComponent(query)}` : ''}`;
  const r = await http(url, { Accept: 'application/json' });
  if (r.status >= 400) throw new Error(`The MCP registry answered HTTP ${r.status}`);
  const list = JSON.parse(r.body).servers || [];
  const byName = new Map();
  for (const e of list) {
    const latest = e?._meta?.['io.modelcontextprotocol.registry/official']?.isLatest;
    const d = describeEntry(e);
    if (!d.name) continue;
    if (!byName.has(d.name) || latest) byName.set(d.name, d);
  }
  return [...byName.values()].sort((a, b) => (b.options.length > 0) - (a.options.length > 0));
}

/** A chosen option + the values you gave → the server to add to Settings › MCP servers. */
export function serverFrom(entry, option, values = {}, { id, secret }) {
  const name = (entry.title || entry.name.split('/').pop() || 'server').slice(0, 30);
  if (option.kind === 'remote') {
    const headers = option.headers.filter((h) => values[h.name]).map((h) => `${h.name}: ${values[h.name]}`).join('\n');
    return { id, name, url: option.url, headers, enabled: true, registry: entry.name };
  }
  const env = option.env.filter((e) => values[e.name] || e.def).map((e) => `${e.name}=${q(values[e.name] || e.def)}`).join(' ');
  return { id, name, transport: 'stdio', command: `${env ? env + ' ' : ''}${option.command}`, bridgeSecret: secret, enabled: true, registry: entry.name };
}
