import { describe, it, expect } from 'vitest';
import { finishSurface, surfaceOf } from '../../src/surface.js';

describe('every result says which surface answered', () => {
  it('appends surface, size, time and a proof hash', async () => {
    const t0 = Date.now() - 12;
    const r = await finishSurface({ ok: true, result: 'hello', display: { path: 'x' } }, { tool: 'run_python', startedAt: t0 });
    expect(r.result).toMatch(/^hello\n\n\[surface=pyodide ok=1 bytes=\d+ ms=\d+ proof=sha256:[0-9a-f]{12}\]$/);
    expect(r.display.surface).toBe('pyodide');
  });

  it('never claims ok for a failure, and carries what the tool proved', async () => {
    const r = await finishSurface({ ok: false, result: 'Error: nope', meta: { surface: 'linux-shell', exit: 2, bytes: 11 } }, { tool: 'shell' });
    expect(r.result).toContain('ok=0');
    expect(r.result).toContain('surface=linux-shell');
    expect(r.result).toContain('exit=2');
    expect(r.result).toContain('bytes=11');
    expect(r.result).not.toContain('proof=');
  });

  it('does not repeat a line the tool already wrote', async () => {
    const once = await finishSurface({ ok: true, result: 'job done\n\n[surface=linux-shell ok=1]' }, { tool: 'shell_job' });
    expect(once.result).toContain('[surface=linux-shell ok=1]');
    expect(once.result).not.toContain('surface=linux-shell ok=1 bytes=');
  });

  it('knows each surface by name', () => {
    expect(surfaceOf('shell')).toBe('linux-shell');
    expect(surfaceOf('phone_write')).toBe('phone-folder');
    expect(surfaceOf('mcp_exa_search')).toBe('mcp');
    expect(surfaceOf('tool_summarise')).toBe('pyodide');
    expect(surfaceOf('read_file')).toBe('workspace');
  });
});
