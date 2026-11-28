import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { excelDate, fileToPrompt, officeToText, readAttachment, utf16Kind, xlsxDateStyles } from '../../src/files.js';

// Decision 275: a small binary data file was refused ("looks like a binary file") while a bigger one worked through
// the chat's folder; a UTF-16 CSV was taken for binary; Excel dates came out as day counts.
const parquet = () => new File([new Uint8Array([0x50, 0x41, 0x52, 0x31, 0, 0, 0, 1, 2, 3, 0, 0, 0x50, 0x41, 0x52, 0x31])], 'sales.parquet');

describe('a small binary file is attached to the workspace', () => {
  it('gives the bytes and a stub, not an error', async () => {
    const a = await readAttachment(parquet(), { allowImages: false });
    expect(a).toMatchObject({ kind: 'file', binary: true, name: 'sales.parquet', size: 16, note: 'binary, 16 B', hint: 'pandas.read_parquet' });
    expect(a.bytes).toHaveLength(16);
    a.inWorkspace = 'sales.parquet';
    const p = fileToPrompt(a, true);
    expect(p).toContain('path="/workspace/sales.parquet"');
    expect(p).toContain('read it with run_python (pandas.read_parquet) or the shell, if it is on');
    expect(p).not.toContain('PAR1');
  });
  it('is refused only in a chat without tools', async () => {
    await expect(readAttachment(parquet(), { allowImages: false, tools: false })).rejects.toThrow(/chat without tools/);
    const a = await readAttachment(new File([new Uint8Array([0, 1, 2, 0, 9])], 'data.db'), { allowImages: false });
    expect(fileToPrompt(a, false)).toMatch(/cannot be read in a chat without tools/);
  });
});

describe('UTF-16 text is text', () => {
  const le = (s, bom = true) => {
    const out = [];
    if (bom) out.push(0xff, 0xfe);
    for (const ch of s) out.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
    return new Uint8Array(out);
  };
  it('by its byte-order mark, or a text name without one', async () => {
    expect(utf16Kind(le('a,b'))).toBe('utf-16le');
    expect(utf16Kind(new Uint8Array([0xfe, 0xff, 0, 0x61]))).toBe('utf-16be');
    expect(utf16Kind(le('name,city\nAlex,Leeds\n', false), 'people.csv')).toBe('utf-16le');
    expect(utf16Kind(le('name,city\nAlex,Leeds\n', false), 'blob.bin')).toBe('');
    const a = await readAttachment(new File([le('name,city\nAlex,Zürich\n')], 'people.csv'), { allowImages: false });
    expect(a).toMatchObject({ kind: 'file', text: 'name,city\nAlex,Zürich\n', note: 'UTF-16 text', lang: 'csv' });
    expect(a.binary).toBeUndefined();
  });
});

describe('Excel dates', () => {
  it('a date style is read from styles.xml', () => {
    const styles = '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00 &quot;kg&quot;"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/></cellXfs></styleSheet>';
    expect(xlsxDateStyles(styles)).toEqual(['', 'date', 'date', '', 'time']);
    expect(excelDate(45292, 'date')).toBe('2024-01-01');
    expect(excelDate(45292.5625, 'date')).toBe('2024-01-01 13:30:00');
    expect(excelDate(0.75, 'time')).toBe('18:00:00');
  });
  it('a .xlsx gives dates as ISO dates and says what the CSV copy cannot', () => {
    const x = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Log" sheetId="1"/></sheets></workbook>'),
      'xl/styles.xml': strToU8('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>45292</v></c><c r="B1"><v>45292</v></c><c r="C1" s="1"><f>A1+1</f><v>45293</v></c></row></sheetData></worksheet>'),
    });
    const r = officeToText(x, 'xlsx');
    expect(r.text).toBe('--- Sheet Log (1 rows) ---\n2024-01-01,45292,2024-01-02');
    expect(r.note).toMatch(/formulas show their last saved value/);
    expect(r.note).toMatch(/pandas\.read_excel.*openpyxl/);
  });
});
