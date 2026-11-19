import { describe, it, expect } from 'vitest';
import { viewPlan } from '../../src/tools.js';
import { cloneNote, finishedResult, rememberPlace } from '../../src/shell.js';

describe('field report: images, clones, empty output', () => {
  it('small images are enlarged with hard edges on a checkerboard; big ones are left alone', () => {
    expect(viewPlan(16, 16)).toMatchObject({ k: 16, nearest: true, w: 256, h: 256, bgs: ['checker'] });
    expect(viewPlan(16, 16, { scale: 4, background: 'all' })).toMatchObject({ k: 4, nearest: true, bgs: ['checker', 'dark', 'light'] });
    expect(viewPlan(800, 600)).toMatchObject({ k: 1, nearest: false });
    expect(viewPlan(2000, 1000).w).toBe(1024); // never past 1024 px
    expect(viewPlan(64, 32, { scale: 99 }).k).toBe(16); // capped at 1024 px
  });

  it('a clone outside /workspace is said to be shell-only, remembered, and big repos get a hint', () => {
    const note = cloneNote('cd /root && git clone https://github.com/a/b.git', "Cloning into 'b'...\ndone.");
    expect(note).toMatch(/Cloned into b – unless that is under \/workspace, it is in the shell only/);
    expect(note).toMatch(/--depth=1 --filter=blob:none/);
    expect(cloneNote('git clone --depth=1 x', "Cloning into 'x'...")).not.toMatch(/--depth=1 --filter/);
    expect(cloneNote('ls', '')).toBe('');
    const w = { files: {} };
    rememberPlace(w, 'cd /root && git clone https://github.com/a/astral.git', "Cloning into 'astral'...");
    rememberPlace(w, 'git clone https://x/y.git /workspace/y', "Cloning into '/workspace/y'...");
    expect(w.shellPlaces).toEqual(['/root/astral']);
  });

  it('a command that printed nothing and succeeded says so', () => {
    expect(finishedResult({ output: '', exit: 0, cmd: 'true' }).result).toMatch(/printed nothing – it succeeded/);
    expect(finishedResult({ output: '', exit: 1, cmd: 'false' }).result).toMatch(/exit code 1\n\(no output\)/);
  });
});
