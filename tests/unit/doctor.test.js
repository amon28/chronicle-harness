import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/webread.js', () => ({ readUrl: async () => ({ ok: true, status: 200, via: 'direct', bytes: 512 }) }));
const { runDoctorTool, doctorDefs } = await import('../../src/doctor.js');

beforeEach(() => {
  globalThis.__ocmShell = {
    status: async () => ({ available: true, installed: true, abi: 'arm64-v8a' }),
    exec: async (a) => (a.cmd === 'doctor 2>&1' ? { output: 'kernel   Linux 6.1 aarch64\nffmpeg   MISSING\n/workspace   writable', exit: 0 } : { output: '', exit: 0 }),
    kill: async () => {},
    addListener: async () => ({ remove() {} }),
  };
  globalThis.__ocmPhoneFolder = {
    list: async () => ({ entries: [{ path: 'notes', isDir: true }, { path: 'a.txt', isDir: false }] }),
    localPath: async () => ({}),
  };
});

describe('doctor', () => {
  it('runs each surface instead of reading a flag, and says which answered', async () => {
    const r = await runDoctorTool({ surfaces: ['shell', 'phone', 'network'], network: true }, { phone: { folder: () => ({ uri: 'content://p', name: 'Notes' }) } });
    expect(r.result).toContain('shell        OK');
    expect(r.result).toContain('ffmpeg   MISSING');
    expect(r.result).toMatch(/phone folder OK.*"Notes"/);
    expect(r.result).toMatch(/network      OK.*HTTP 200/);
    expect(r.result).toMatch(/mounts.*\/workspace/);
    expect(r.ok).toBe(true);
    expect(doctorDefs()[0].function.name).toBe('doctor');
  });

  it('is honest when a surface is not there', async () => {
    globalThis.__ocmShell.status = async () => ({ available: true, installed: false });
    const r = await runDoctorTool({ surfaces: ['shell'], network: false }, {});
    expect(r.result).toMatch(/shell +MISSING/);
    expect(r.ok).toBe(false);
  });

  it('skips the network probe when asked to', async () => {
    const r = await runDoctorTool({ surfaces: ['python'], network: false }, {});
    expect(r.result).toMatch(/python/);
    expect(r.result).not.toContain('HTTP 200');
  });
  it('reports whether replies keep going in the background, and why the last protection ended (decision 172)', async () => {
    globalThis.__ocmKeepAlive = { status: async () => ({ running: false, lastStop: 'time limit', lastStopAt: Date.now() - 120000, notifications: true, batteryFree: false }) };
    try {
      const r = await runDoctorTool({ surfaces: ['background'], network: false }, {});
      expect(r.result).toMatch(/^background\s+PAUSED\s+protects a reply while one runs; last stop: time limit \(2 min ago\); battery optimisation is on/m);
    } finally {
      delete globalThis.__ocmKeepAlive;
    }
    const none = await runDoctorTool({ surfaces: ['background'], network: false }, {});
    expect(none.result).toMatch(/^background\s+N\/A\s+only in the Android app/m);
  });
  it("shows the app's latest logged errors (decision 177)", async () => {
    const { logError, _resetLogForTest } = await import('../../src/errorlog.js');
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
    _resetLogForTest();
    const none = await runDoctorTool({ surfaces: ['errors'], network: false }, {});
    expect(none.result).toMatch(/^errors\s+NONE\s+nothing in the app error log/m);
    logError('tool', 'search server busy (HTTP 502)', { tool: 'places' });
    const r = await runDoctorTool({ surfaces: ['errors'], network: false }, {});
    expect(r.result).toMatch(/^errors\s+LOGGED\s+1 in the last 24 h, 1 kept/m);
    expect(r.result).toMatch(/Tools\s+places: search server busy \(HTTP 502\)/);
    delete globalThis.localStorage;
  });
});
