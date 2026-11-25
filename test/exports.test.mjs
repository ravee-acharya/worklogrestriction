import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkbook,
  columnLetter,
  safeSheetName,
  toExcelSerial,
} from '../src/shared/xlsx.mjs';
import {
  PENDING_REVIEW_COLUMNS,
  REMOVAL_LOG_COLUMNS,
  exportFileName,
  pendingReviewRows,
  removalLogRows,
} from '../src/shared/exports.mjs';

/* ------------------------------------------------------------- zip reading -- */

/**
 * Minimal reader for the archives this writer produces (stored entries only).
 *
 * The point of parsing the container rather than eyeballing the bytes is that
 * the test proves the file is actually readable — a workbook with a wrong
 * offset or CRC opens as "corrupt" in Excel and there is no other way to catch
 * that from a unit test.
 */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'no end-of-central-directory record found');

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const files = new Map();

  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, 'bad central directory signature');

    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));

    assert.equal(method, 0, `${name} is not stored`);

    // Walk into the local header to find where the data actually begins.
    assert.equal(view.getUint32(offset, true), 0x04034b50, `bad local header for ${name}`);
    const localNameLen = view.getUint16(offset + 26, true);
    const localExtraLen = view.getUint16(offset + 28, true);
    const start = offset + 30 + localNameLen + localExtraLen;

    files.set(name, {
      crc,
      text: new TextDecoder().decode(bytes.subarray(start, start + size)),
    });

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

/** Independent CRC32, so the test does not trust the writer's own table. */
function crc32(text) {
  const bytes = new TextEncoder().encode(text);
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

const SIMPLE = {
  sheetName: 'Sheet',
  columns: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'hours', label: 'Hours', type: 'number' },
    { key: 'when', label: 'When', type: 'datetime' },
  ],
  rows: [{ name: 'Ada', hours: 1.5, when: '2026-08-01T09:00:00.000Z' }],
};

/* ------------------------------------------------------------------- tests -- */

describe('xlsx container', () => {
  it('produces a readable ZIP with every part Excel requires', () => {
    const files = readZip(buildWorkbook(SIMPLE));

    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]) {
      assert.ok(files.has(part), `missing ${part}`);
    }
  });

  it('records a correct CRC for every entry', () => {
    for (const [name, file] of readZip(buildWorkbook(SIMPLE))) {
      assert.equal(file.crc, crc32(file.text), `CRC mismatch for ${name}`);
    }
  });

  it('starts with the local file header signature', () => {
    const bytes = buildWorkbook(SIMPLE);
    assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  });

  it('is deterministic — the same input yields the same bytes', () => {
    assert.deepEqual([...buildWorkbook(SIMPLE)], [...buildWorkbook(SIMPLE)]);
  });

  it('refuses a workbook with no columns rather than writing an unopenable file', () => {
    assert.throws(() => buildWorkbook({ sheetName: 'X', columns: [], rows: [] }), /at least one column/);
  });
});

describe('xlsx sheet content', () => {
  const sheet = (spec) => readZip(buildWorkbook(spec)).get('xl/worksheets/sheet1.xml').text;

  it('writes a bold, frozen header row', () => {
    const xml = sheet(SIMPLE);
    assert.match(xml, /<c r="A1" s="1" t="inlineStr"><is><t>Name<\/t><\/is><\/c>/);
    assert.match(xml, /state="frozen"/);
  });

  it('writes numbers as numbers, not text', () => {
    assert.match(sheet(SIMPLE), /<c r="B2"><v>1\.5<\/v><\/c>/);
  });

  it('writes dates as Excel serials with a date format', () => {
    // 2026-08-01T09:00Z -> 46235.375
    assert.match(sheet(SIMPLE), /<c r="C2" s="2"><v>46235\.375<\/v><\/c>/);
  });

  it('falls back to text for an unparseable date rather than dropping it', () => {
    const xml = sheet({
      sheetName: 'S',
      columns: [{ key: 'when', label: 'When', type: 'datetime' }],
      rows: [{ when: 'not a date' }],
    });
    assert.match(xml, /<is><t>not a date<\/t><\/is>/);
  });

  it('escapes XML metacharacters in free text', () => {
    const xml = sheet({
      sheetName: 'S',
      columns: [{ key: 'summary', label: 'Summary', type: 'text' }],
      rows: [{ summary: 'Fix <b> & "quotes"' }],
    });
    assert.match(xml, /Fix &lt;b&gt; &amp; &quot;quotes&quot;/);
  });

  it('strips control characters that make Excel reject the file', () => {
    const xml = sheet({
      sheetName: 'S',
      columns: [{ key: 'summary', label: 'Summary', type: 'text' }],
      rows: [{ summary: 'bad' + String.fromCharCode(1) + 'char' }],
    });
    assert.match(xml, /badchar/);
    assert.ok(!xml.includes(String.fromCharCode(1)));
  });

  it('omits empty cells instead of writing blank strings', () => {
    const xml = sheet({
      sheetName: 'S',
      columns: [
        { key: 'a', label: 'A', type: 'text' },
        { key: 'b', label: 'B', type: 'text' },
      ],
      rows: [{ a: 'x', b: '' }],
    });
    assert.match(xml, /<row r="2"><c r="A2"/);
    assert.ok(!xml.includes('r="B2"'));
  });

  it('sets an autofilter spanning the used range', () => {
    assert.match(sheet(SIMPLE), /<autoFilter ref="A1:C2"\/>/);
  });
});

describe('xlsx helpers', () => {
  it('converts column indices to spreadsheet letters past Z', () => {
    assert.equal(columnLetter(0), 'A');
    assert.equal(columnLetter(25), 'Z');
    assert.equal(columnLetter(26), 'AA');
    assert.equal(columnLetter(27), 'AB');
  });

  it('places the Excel epoch correctly', () => {
    // 1970-01-01 is serial 25569.
    assert.equal(toExcelSerial('1970-01-01T00:00:00.000Z'), 25569);
  });

  it('returns null for an unparseable date', () => {
    assert.equal(toExcelSerial('nonsense'), null);
  });

  it('strips characters Excel rejects in a sheet name and caps it at 31', () => {
    assert.equal(safeSheetName('a/b:c*d?e[f]g'), 'a b c d e f g');
    assert.equal(safeSheetName('x'.repeat(40)).length, 31);
    assert.equal(safeSheetName(''), 'Sheet');
  });
});

describe('removal log export rows', () => {
  const entry = {
    id: 'ABC-1:100',
    issueKey: 'ABC-1',
    issueSummary: 'Reconcile timesheets',
    projectKey: 'ABC',
    worklogId: 100,
    authorAccountId: 'acc-1',
    authorDisplayName: 'Ada Lovelace',
    worklogStarted: '2026-08-01T09:00:00.000Z',
    timeSpent: '2h 30m',
    timeSpentSeconds: 9000,
    ruleViolated: 'Last 1 Week',
    violationSince: '2026-08-08T09:00:00.000Z',
    removedAt: '2026-08-10T10:00:00.000Z',
  };

  it('carries every audit field the log records', () => {
    const [row] = removalLogRows([entry]);
    for (const column of REMOVAL_LOG_COLUMNS) {
      assert.ok(column.key in row, `export is missing ${column.key}`);
    }
  });

  it('converts seconds to decimal hours so the column sums', () => {
    assert.equal(removalLogRows([entry])[0].hours, 2.5);
  });

  it('leaves hours blank rather than zero when the duration is unknown', () => {
    assert.equal(removalLogRows([{ ...entry, timeSpentSeconds: undefined }])[0].hours, null);
  });

  it('reports restore state as a readable flag', () => {
    assert.equal(removalLogRows([entry])[0].restored, 'No');
    assert.equal(
      removalLogRows([{ ...entry, restoredAt: '2026-08-11T00:00:00.000Z' }])[0].restored,
      'Yes',
    );
  });

  it('stringifies the worklog id so Excel cannot reformat it as a number', () => {
    assert.equal(removalLogRows([entry])[0].worklogId, '100');
  });

  it('names an unknown author rather than leaving the cell empty', () => {
    assert.equal(removalLogRows([{ ...entry, authorDisplayName: '' }])[0].authorDisplayName, 'Unknown');
  });

  it('builds a workbook from a real entry without throwing', () => {
    const bytes = buildWorkbook({
      sheetName: 'Removal Log',
      columns: REMOVAL_LOG_COLUMNS,
      rows: removalLogRows([entry]),
    });
    assert.ok(readZip(bytes).get('xl/worksheets/sheet1.xml').text.includes('Reconcile timesheets'));
  });
});

describe('pending review export rows', () => {
  const entry = {
    id: 'ABC-1:101',
    issueKey: 'ABC-1',
    issueSummary: 'Q2 close',
    projectKey: 'ABC',
    worklogId: 101,
    authorAccountId: 'acc-2',
    authorDisplayName: 'Grace Hopper',
    worklogStarted: '2026-07-01T09:00:00.000Z',
    timeSpent: '1h',
    timeSpentSeconds: 3600,
    ruleViolated: 'Last Month',
    violationSince: '2026-08-01T00:00:00.000Z',
    flaggedAt: '2026-08-03T10:00:00.000Z',
  };

  it('carries every queue field', () => {
    const [row] = pendingReviewRows([entry]);
    for (const column of PENDING_REVIEW_COLUMNS) {
      assert.ok(column.key in row, `export is missing ${column.key}`);
    }
  });

  it('does not carry restore columns — nothing was removed', () => {
    const [row] = pendingReviewRows([entry]);
    assert.ok(!('restored' in row));
    assert.ok(!('restoredAt' in row));
  });

  it('handles an empty queue', () => {
    assert.deepEqual(pendingReviewRows([]), []);
  });
});

describe('export file names', () => {
  it('stamps the date and uses the xlsx extension', () => {
    assert.equal(
      exportFileName('worklog-removal-log', new Date('2026-09-15T12:00:00Z')),
      'worklog-removal-log-2026-09-15.xlsx',
    );
  });
});
