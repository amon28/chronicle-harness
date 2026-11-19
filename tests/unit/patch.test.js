import { describe, it, expect } from 'vitest';
import { parsePatch, applyHunks } from '../../src/patch.js';

describe('apply_patch format', () => {
  const file = 'def a():\n    return 1\n\ndef b():\n    return 2\n';
  it('Codex style: add, update (two hunks), delete, move', () => {
    const ops = parsePatch(`*** Begin Patch
*** Add File: new.txt
+hello
+world
*** Update File: x.py
*** Move to: y.py
@@ def a():
 def a():
-    return 1
+    return 10
@@
 def b():
-    return 2
+    return 20
*** Delete File: old.txt
*** End Patch`);
    expect(ops.map((o) => o.op)).toEqual(['add', 'update', 'delete']);
    expect(ops[0].lines).toEqual(['hello', 'world']);
    expect(ops[1].moveTo).toBe('y.py');
    expect(applyHunks(file, ops[1].hunks, 'x.py')).toBe('def a():\n    return 10\n\ndef b():\n    return 20\n');
  });
  it('unified diff', () => {
    const ops = parsePatch('--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n def a():\n-    return 1\n+    return 3\n');
    expect(applyHunks(file, ops[0].hunks)).toContain('return 3');
  });
  it('a hunk that does not match says what it expected', () => {
    const ops = parsePatch('*** Begin Patch\n*** Update File: x.py\n@@\n-    return 99\n+    return 1\n*** End Patch');
    expect(() => applyHunks(file, ops[0].hunks, 'x.py')).toThrow(/Hunk 1 of x.py does not match[\s\S]*return 99/);
  });
  it('tolerates trailing spaces and a missing final newline', () => {
    const ops = parsePatch('*** Begin Patch\n*** Update File: t\n@@\n-a  \n+b\n*** End Patch');
    expect(applyHunks('a\nc', ops[0].hunks)).toBe('b\nc');
  });
});
