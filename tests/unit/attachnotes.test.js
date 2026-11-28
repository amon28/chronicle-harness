import { describe, it, expect } from 'vitest';
import { readAttachment } from '../../src/files.js';
import { folderFileAttachment } from '../../src/camera.js';

// Decision 275: what the note on an attachment promises.
describe('a PDF says its text copy is text only', () => {
  it('figures, diagrams and the layout of formulas are not included', async () => {
    const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 18 Tf 20 100 Td (Hello Alex) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
    const a = await readAttachment(new File([pdf], 'notes.pdf', { type: 'application/pdf' }), { allowImages: false });
    expect(a.text).toContain('Hello Alex');
    expect(a.note).toBe('PDF, 1 page, text only – figures, diagrams and the layout of formulas are not included');
  });
});

describe("a big file in the chat's folder", () => {
  const f = { name: 'data.csv', size: 20 * 1048576 };
  it('says "work with it in the shell" only when Linux is installed and the chat has the shell', () => {
    const on = folderFileAttachment(f, { hasLinux: true, shellOn: true }).text;
    expect(on).toContain('/workspace/uploads/data.csv');
    expect(on).toContain('Work with it in the shell');
    expect(on).toContain('run_python can open it');
    const off = folderFileAttachment(f, { hasLinux: true, shellOn: false }).text;
    expect(off).toContain('uploads/data.csv');
    expect(off).not.toContain('Work with it in the shell');
    expect(off).toMatch(/read_file and run_python cannot open it/);
    const none = folderFileAttachment(f, { hasLinux: false, shellOn: false }).text;
    expect(none).toMatch(/needs the built-in Linux, which is not set up yet/);
  });
  it('a file over 32 MB is not promised to run_python', () => {
    const t = folderFileAttachment({ name: 'big.bin', size: 40 * 1048576 }, { hasLinux: true, shellOn: true }).text;
    expect(t).toMatch(/run_python cannot open it/);
  });
});
