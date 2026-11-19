import { describe, it, expect } from 'vitest';
import { AcpClient } from '../../src/acp.js';

describe('ACP client closed by the app', () => {
  it('a request still waiting fails when the connection is closed (Claude Code restarted or stopped in Settings)', async () => {
    const http = async (url, { method }) => {
      if (method === 'POST') return { status: 202, body: '{}' };
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200, body: JSON.stringify({ next: 0, events: [] }) };
    };
    const c = new AcpClient({ url: 'http://127.0.0.1:39703', secret: 's', http });
    c.loop();
    const p = c.prompt('s1', 'a long job').then(() => 'answered', (e) => e.message);
    await new Promise((r) => setTimeout(r, 30));
    c.close();
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('still waiting'), 500))]);
    expect(r).toMatch(/closed|stopped|restarted/);
  });
});
