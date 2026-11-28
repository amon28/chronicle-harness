// A chat's local-network grant (decision 271). The app's web tools never reach the user's own network – except the
// exact addresses the user allowed for one chat, on the network it was allowed on, until they take it back:
//  - literal private IPv4 addresses only (192.168.1.20), never a name (a name can be pointed anywhere after the OK)
//    and never the phone itself (127.x), link-local (169.254.x: cloud metadata) or carrier-grade NAT;
//  - tied to the network it was given on: its BSSID when Android shows it, else the gateway, subnet and DNS servers;
//  - a request must START at an allowed address – a public page that redirects there is refused (GoStreamPlugin,
//    BrowserPlugin);
//  - never inherited by a helper agent (delegate) or a scheduled run: they get no grant at all;
//  - the Linux shell is not limited by it (it has its own network stack), which the question says.

/** A literal private IPv4 address that a grant may hold, or null. */
export function lanIp(v) {
  const t = String(v || '').trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  if (b.some((x) => x > 255)) return null;
  const priv = b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168);
  return priv ? b.join('.') : null;
}

/** The host of a URL, when it is a literal private IPv4 address. */
export function lanHostOf(url) {
  try {
    return lanIp(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** What a network is known by: { bssid?, gateway?, subnet?, dns } – from PhonePlugin.lanNet. */
export function netKey(n) {
  if (!n?.connected) return null;
  const subnet = (n.ipv4 || []).map((a) => {
    const [ip, len] = String(a).split('/');
    const p = ip.split('.').map(Number);
    const bits = Math.max(0, Math.min(32, Number(len) || 24));
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const v = (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0) & mask;
    return `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}/${bits}`;
  })[0];
  const self = String((n.ipv4 || [])[0] || '').split('/')[0];
  return { ...(n.bssid ? { bssid: String(n.bssid).toLowerCase() } : {}), ...(n.ssid ? { ssid: n.ssid } : {}), gateway: n.gateway || '', subnet: subnet || '', dns: [...(n.dns || [])].sort().join(','), ...(self ? { self } : {}) };
}

/** Is `now` the network the grant was given on? The BSSID when both have one; else gateway, subnet and DNS all equal. */
export function sameNet(granted, now) {
  if (!granted || !now) return false;
  // another access point of the same Wi-Fi (a mesh, the 5 GHz radio – decision 276): its name, gateway and subnet are
  // the same, only the BSSID changed; a café with the same gateway is not (different name or subnet)
  const sameLan = !!granted.gateway && granted.gateway === now.gateway && granted.subnet === now.subnet;
  if (granted.bssid && now.bssid) return granted.bssid === now.bssid || (!!granted.ssid && granted.ssid === now.ssid && sameLan);
  return !!granted.gateway && granted.gateway === now.gateway && granted.subnet === now.subnet && granted.dns === now.dns;
}

/** How the user sees the network in the question and the badge. */
export const netName = (k) => (k?.ssid ? `the Wi-Fi “${k.ssid}”` : k?.gateway ? `the network behind ${k.gateway}` : 'this network');

/**
 * → the addresses usable now: grant.ips when the phone is on the grant's network, else [] with why.
 * grant: { ips, net, at } (conv.lanGrant); now: netKey of the current network.
 */
export function lanUsable(grant, now) {
  if (!grant?.ips?.length) return { ips: [], why: 'none' };
  if (!sameNet(grant.net, now)) return { ips: [], why: 'other-network' };
  return { ips: grant.ips, why: '' };
}

export const lanDefs = () => [
  {
    type: 'function',
    function: {
      name: 'local_network',
      description:
        "The app's web tools (fetch_url, the browser) never reach the user's own network – a router, a printer, a NAS, a home server. With the user's OK, this chat may reach exact addresses there. action request: ask for them (literal addresses like 192.168.1.20 – no names; give the reason the user reads); status: what this chat may reach now. The OK holds only on the network it was given on and until the user takes it back; helpers and scheduled runs never get it. The Linux shell is not limited by this at all.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['request', 'status'] },
          addresses: { type: 'array', items: { type: 'string' }, description: 'request: the private IPv4 addresses (up to 8)' },
          reason: { type: 'string', description: 'request: why, in one sentence the user reads' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
];

/** The local_network tool. ctx.lan: { grant(), set(grant), now() → netKey | null } – absent for helpers and scheduled runs. */
export async function runLanTool(args, ctx) {
  const lan = ctx.lan;
  if (!lan) return { ok: false, result: "Local-network access is never given here: a helper agent, Claude Code and a scheduled or proactive run get no grant, even when the chat has one (nobody is watching what it reaches). Do not ask for it again from here: for a check on a device on the user's network, the Linux shell reaches it (curl http://192.168.x.y/…), or tell the user to run it in the chat.", display: { error: 'unavailable' } };
  const now = await lan.now().catch(() => null);
  const grant = lan.grant();
  if ((args.action || 'status') === 'status') {
    // where the phone is (decision 272): ip route and arp do not work in an Android app, so this is how the subnet is found
    const here = now ? ` The phone is on ${netName(now)}${now.subnet ? `: subnet ${now.subnet}` : ''}${now.gateway ? `, gateway ${now.gateway}` : ''}${now.self ? `, the phone itself ${now.self}` : ''}${now.dns ? `, DNS ${now.dns}` : ''}.` : ' The phone is not on a local network now.';
    if (!grant?.ips?.length) return { ok: true, result: `This chat may not reach any local-network address. Ask with action request.${here}`, display: { path: 'local network: none' } };
    const u = lanUsable(grant, now);
    return { ok: true, result: (u.ips.length ? `This chat may reach ${grant.ips.join(', ')} on ${netName(grant.net)} – the phone is on it now.` : `This chat was allowed ${grant.ips.join(', ')} on ${netName(grant.net)}, but the phone is ${now ? 'on another network' : 'not on a local network'} now, so they are blocked until it is back there.`) + here, display: { path: `local network: ${grant.ips.length}` } };
  }
  const raw = (Array.isArray(args.addresses) ? args.addresses : []).map(String);
  const ips = [...new Set(raw.map(lanIp).filter(Boolean))].slice(0, 8);
  const bad = raw.filter((x) => !lanIp(x));
  if (bad.length) return { ok: false, result: `Only literal private IPv4 addresses (10.x, 172.16–31.x, 192.168.x) can be asked for – not ${bad.slice(0, 4).join(', ')}. A name (router.lan) cannot be: it could be pointed anywhere after the OK. Find the address first: local_network action status gives this network's gateway and subnet; in the shell, getent hosts <name> looks a name up through the network's own DNS, and nmap -sn -PS80,443 <subnet> (apt-get install -y nmap) finds devices – ip route and arp do not work in an Android app; or ask the user.`, display: { error: 'not a local address' } };
  if (!ips.length) return { ok: false, result: 'Give addresses: the local IPv4 addresses to reach, e.g. ["192.168.1.20"].', display: { error: 'no addresses' } };
  if (!now) return { ok: false, result: 'The phone is not on a local network now (no Wi-Fi or Ethernet), so there is nothing to allow.', display: { error: 'no network' } };
  if (!ctx.ask) return { ok: false, result: "This needs the user's OK, which is not available here.", display: { error: 'unavailable' } };
  const yes = 'Allow in this chat';
  ctx.onStatus?.('waiting for your OK…');
  const reason = String(args.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const ans = await ctx.ask(`Let the assistant reach ${ips.join(', ')} on ${netName(now)} in this chat?${reason ? `\n\nWhy: ${reason}` : ''}\n\nOnly these addresses, only on this network, until you take it back (the 🏠 badge above the message box). It can read and change what those devices let a browser read and change. Helpers and scheduled runs never get this. The Linux shell is not limited by it at all.`, [yes, 'Not now'], ctx.signal);
  if (ans !== yes) return { ok: false, result: `The user said no (${ans}). Nothing on the local network was opened.`, display: { error: 'declined' } };
  const keep = grant && sameNet(grant.net, now) ? [...new Set([...grant.ips, ...ips])].slice(0, 16) : ips;
  lan.set({ ips: keep, net: now, at: Date.now() });
  return { ok: true, result: `Allowed: ${keep.join(', ')} on ${netName(now)}, for this chat. fetch_url and the browser can open http://${ips[0]}/ now; a name, another address, or a redirect from a public page there is still refused.`, display: { path: `local network: ${keep.join(', ')}` } };
}
