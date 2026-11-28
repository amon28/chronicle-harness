import { describe, it, expect, vi } from 'vitest';
import { lanIp, lanHostOf, netKey, sameNet, lanUsable, runLanTool, netName } from '../../src/lan.js';

// Decision 271: a chat's local-network grant – exact private addresses, on the network it was given on, with the OK.
const HOME = { connected: true, transport: 'wifi', gateway: '192.168.1.1', ipv4: ['192.168.1.57/24'], dns: ['192.168.1.1'] };
const CAFE = { connected: true, transport: 'wifi', gateway: '192.168.1.1', ipv4: ['192.168.1.80/24'], dns: ['8.8.8.8'] };

describe('what a grant may hold', () => {
  it('literal private IPv4 only – never a name, the phone itself, link-local or carrier NAT', () => {
    expect(['192.168.1.20', '10.0.0.5', '172.20.1.1'].map(lanIp)).toEqual(['192.168.1.20', '10.0.0.5', '172.20.1.1']);
    expect(['router.lan', '127.0.0.1', '169.254.169.254', '100.64.0.1', '8.8.8.8', '192.168.1.300', 'localhost', '172.32.0.1'].map(lanIp)).toEqual(Array(8).fill(null));
    expect(lanHostOf('http://192.168.1.20:8080/x')).toBe('192.168.1.20');
    expect(lanHostOf('http://nas.local/')).toBeNull();
  });
  it('a network is known by its BSSID when shown, else gateway + subnet + DNS – the same gateway elsewhere is not the same network', () => {
    const home = netKey(HOME);
    expect(home).toEqual({ gateway: '192.168.1.1', subnet: '192.168.1.0/24', dns: '192.168.1.1', self: '192.168.1.57' });
    expect(sameNet(home, netKey({ ...HOME, ipv4: ['192.168.1.99/24'] }))).toBe(true); // another address on the same network
    expect(sameNet(home, netKey(CAFE))).toBe(false);
    const b = netKey({ ...HOME, bssid: 'AA:BB:CC:00:11:22', ssid: 'Home' });
    expect(sameNet(b, netKey({ ...CAFE, bssid: 'aa:bb:cc:00:11:22' }))).toBe(true);
    expect(sameNet(b, netKey({ ...HOME, bssid: 'aa:bb:cc:00:11:99' }))).toBe(false);
    // another access point of the same Wi-Fi (a mesh): same name, gateway and subnet (decision 276)
    expect(sameNet(b, netKey({ ...HOME, bssid: 'aa:bb:cc:00:11:99', ssid: 'Home' }))).toBe(true);
    expect(sameNet(b, netKey({ ...CAFE, bssid: 'aa:bb:cc:00:11:99', ssid: 'Home', ipv4: ['10.0.0.5/24'] }))).toBe(false);
    expect(netName(b)).toBe('the Wi-Fi “Home”');
    expect(netKey({ connected: false })).toBeNull();
  });
  it('the addresses are usable only on that network', () => {
    const g = { ips: ['192.168.1.20'], net: netKey(HOME) };
    expect(lanUsable(g, netKey(HOME)).ips).toEqual(['192.168.1.20']);
    expect(lanUsable(g, netKey(CAFE))).toEqual({ ips: [], why: 'other-network' });
    expect(lanUsable(null, netKey(HOME)).ips).toEqual([]);
  });
});

describe('the local_network tool', () => {
  const mk = (answer, net = HOME) => {
    let grant = null;
    const asked = [];
    return {
      asked,
      get grant() {
        return grant;
      },
      ctx: { ask: async (q) => (asked.push(q), answer), lan: { grant: () => grant, set: (g) => (grant = g), now: async () => netKey(net) } },
    };
  };
  it('asks with the addresses, the network and what the shell is not limited by; a yes is kept for this network', async () => {
    const t = mk('Allow in this chat');
    const r = await runLanTool({ action: 'request', addresses: ['192.168.1.20'], reason: 'Read the printer status page' }, t.ctx);
    expect(r.ok).toBe(true);
    expect(t.asked[0]).toMatch(/^Let the assistant reach 192\.168\.1\.20 on the network behind 192\.168\.1\.1 in this chat\?\n\nWhy: Read the printer status page\n\nOnly these addresses, only on this network, until you take it back/);
    expect(t.asked[0]).toMatch(/Helpers and scheduled runs never get this\. The Linux shell is not limited by it at all\./);
    expect(t.grant).toMatchObject({ ips: ['192.168.1.20'], net: { gateway: '192.168.1.1' } });
    const st = await runLanTool({ action: 'status' }, t.ctx);
    expect(st.result).toMatch(/may reach 192\.168\.1\.20 .* the phone is on it now\. The phone is on the network behind 192\.168\.1\.1: subnet 192\.168\.1\.0\/24, gateway 192\.168\.1\.1, the phone itself 192\.168\.1\.57/);
  });
  it('a no, a name, a public address and no network are refused before anything is opened', async () => {
    const no = mk('Not now');
    expect((await runLanTool({ action: 'request', addresses: ['192.168.1.20'] }, no.ctx)).result).toMatch(/said no/);
    expect(no.grant).toBeNull();
    const t = mk('Allow in this chat');
    expect((await runLanTool({ action: 'request', addresses: ['router.lan'] }, t.ctx)).result).toMatch(/Only literal private IPv4 addresses .* not router\.lan/);
    expect((await runLanTool({ action: 'request', addresses: ['8.8.8.8'] }, t.ctx)).ok).toBe(false);
    expect(t.asked).toEqual([]);
    const off = mk('Allow in this chat', { connected: false });
    expect((await runLanTool({ action: 'request', addresses: ['192.168.1.20'] }, off.ctx)).result).toMatch(/not on a local network/);
  });
  it('a helper or a scheduled run (no ctx.lan) cannot get it', async () => {
    const r = await runLanTool({ action: 'request', addresses: ['192.168.1.20'] }, { ask: vi.fn() });
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/a helper agent, Claude Code and a scheduled or proactive run get no grant, even when the chat has one.*the Linux shell reaches it/);
  });
  it('on another network the grant is said to be blocked', async () => {
    const t = mk('Allow in this chat');
    await runLanTool({ action: 'request', addresses: ['192.168.1.20'] }, t.ctx);
    t.ctx.lan.now = async () => netKey(CAFE);
    expect((await runLanTool({ action: 'status' }, t.ctx)).result).toMatch(/on another network now, so they are blocked/);
  });
});
