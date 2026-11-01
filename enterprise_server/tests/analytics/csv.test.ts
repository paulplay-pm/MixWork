import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';

import { csvCell, csvResponse, toCsv } from '../../src/analytics/csv';

/**
 * A minimal RFC 4180 reader, used to count the columns a downstream consumer
 * would actually see. Deliberately independent of `csvCell`: asserting the
 * emitter against its own helper would agree with a broken emitter.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else { cur += ch; }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else { cur += ch; }
  }
  out.push(cur);
  return out;
}

describe('analytics/csv', () => {
  test('the document starts with a UTF-8 BOM', () => {
    expect(toCsv({ rangeLabel: '近 7 天' }, ['a'], []).charCodeAt(0)).toBe(0xfeff);
  });

  test('the first line is the range, then the header', () => {
    const out = toCsv({ rangeLabel: '近 7 天' }, ['用户名称', '部门'], [['张伟', '研发中心']]);
    expect(out.replace(/^\uFEFF/, '').split('\r\n').slice(0, 2))
      .toEqual(['统计范围：近 7 天', '用户名称,部门']);
  });

  // The header row used to be the one row in the document with no escaping
  // guard, because it was joined with a plain `header.join(',')`. A column
  // label containing a comma or a quote silently became extra columns.
  test('a header cell with a comma or quote stays one column', () => {
    const out = toCsv(
      { rangeLabel: '近 7 天' },
      ['用户名称', '用量, tokens', 'say "hi"'],
      [['张伟', 1, 'x']],
    );
    // Count fields the way a CSV reader does: a quoted field is one column
    // regardless of what separators appear inside it.
    const headerLine = out.replace(/^\uFEFF/, '').split('\r\n')[1];
    expect(headerLine).toBe('用户名称,"用量, tokens","say ""hi"""');
    expect(splitCsvLine(headerLine)).toEqual(['用户名称', '用量, tokens', 'say "hi"']);
  });

  test('commas, quotes and newlines are escaped, not stripped', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  test('a JSON payload survives as one column', () => {
    expect(csvCell(JSON.stringify({ a: 1, b: 'x,y' }))).toBe('"{""a"":1,""b"":""x,y""}"');
  });

  test('null and undefined become empty cells, not the words', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  test('csvResponse carries the count and an attachment filename', () => {
    const res = csvResponse({ body: 'x', rowCount: 42, filename: '近 7 天-用户用量.csv' });
    expect(res.headers.get('x-export-count')).toBe('42');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
  });

  // `x-export-count` alone cannot express a file that holds fewer rows than the
  // query matched: its value is a plausible-looking number either way, so a
  // truncated download is indistinguishable from a complete one. The second
  // header is what makes truncation visible, and it defaults rather than
  // disappearing so a client never has to branch on presence.
  test('total defaults to the row count for an unbounded caller', () => {
    const res = csvResponse({ body: 'x', rowCount: 42, filename: 'a.csv' });
    expect(res.headers.get('x-export-total')).toBe('42');
  });

  test('total is emitted verbatim and may exceed the count', () => {
    const res = csvResponse({ body: 'x', rowCount: 42, total: 12_000, filename: 'a.csv' });
    expect(res.headers.get('x-export-count')).toBe('42');
    expect(res.headers.get('x-export-total')).toBe('12000');
    expect(res.headers.get('x-export-count')).not.toBe(res.headers.get('x-export-total'));
  });

  // The BOM is only load-bearing if it survives into the emitted bytes: Excel
  // on Windows picks the character set from byte 0 alone. Asserting on the
  // decoded string cannot catch a body that was re-encoded or re-prefixed
  // downstream, so read the raw bytes off the Response.
  test('the emitted response body starts with the EF BB BF byte sequence', async () => {
    const body = toCsv({ rangeLabel: '近 7 天' }, ['用户名称'], [['张伟']]);
    const bytes = new Uint8Array(await csvResponse({ body, rowCount: 1, filename: 'x.csv' }).arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });
});
