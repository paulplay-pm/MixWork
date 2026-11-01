/**
 * CSV emission for the analytics and audit exports.
 *
 * Two rules carry all of the weight here:
 *
 * 1. The document opens with a UTF-8 BOM. Excel on Windows picks the character
 *    set from byte 0 of the file and nowhere else, so the BOM has to be the
 *    first code unit of the body we hand to `Response` -- not something a
 *    caller prepends afterwards, and not something that can slide behind a
 *    leading space.
 * 2. Every cell goes through `csvCell`. The old audit export escaped commas
 *    with `.replace(/,/g, '\\,')`, which deleted them rather than quoting the
 *    field, so any payload containing a comma spilled into the next column.
 */

/** U+FEFF, encoded by `Response` as the leading EF BB BF byte triplet. */
const BOM = '\uFEFF';

/** Characters that force a field to be quoted per RFC 4180. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Encode one cell. The decision to quote is made purely from the value's
 * characters, never from its type or length: a field that is safe today is not
 * safe tomorrow, because someone can put a comma in a model name.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (!NEEDS_QUOTING.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Build the document: BOM, the range line, the header, then the rows.
 *
 * The range line is deliberate product behaviour, not a stray header row --
 * these exports get archived by finance and compliance staff who need to know
 * the window the numbers cover without reopening the web UI.
 */
export function toCsv(meta: { rangeLabel: string }, header: string[], rows: unknown[][]): string {
  // The header goes through csvCell for the same reason rows do: a column
  // label is just another string, and `用量, tokens` would otherwise become
  // two columns.
  const lines = [`统计范围：${meta.rangeLabel}`, header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return BOM + lines.join('\r\n');
}

/** Percent-encode per RFC 5987; `encodeURIComponent` leaves these five legal. */
function encodeFilename(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Wrap an already-built document in a downloadable response. The row count
 * rides along in `x-export-count` so the caller can tell the user how much was
 * exported without parsing the file back.
 *
 * `total` is the number of rows the query matched, which is NOT always
 * `rowCount`: a caller that renders rows in bounded batches cannot always fit
 * every match into one document. Those are two different facts, and collapsing
 * them into one header would leave a truncated file indistinguishable from a
 * complete one — the reader sees a plausible count with no way to know rows are
 * missing. So both ride along:
 *
 *   x-export-count — rows actually written to THIS file.
 *   x-export-total — rows the query matched, i.e. what the export covers.
 *   x-excluded-count — rows the query matched AND deliberately dropped, because
 *     the caller filtered them out. Zero when nothing was excluded. This one is
 *     about the FILTER rather than the file: a CSV opened by someone who never
 *     saw the page it came from has no way to know that model-call rows, say,
 *     were omitted on purpose, and a file that silently drops a category is the
 *     same failure `x-export-count` exists to prevent — one row class instead of
 *     the whole tail.
 *
 * A caller that omits `total` is asserting that its row set IS the match set
 * (an unbounded query), and the two headers are then equal by construction. It
 * defaults to `rowCount` rather than being omitted so a client never has to
 * branch on the header's presence.
 */
export function csvResponse(opts: {
  body: string;
  rowCount: number;
  filename: string;
  total?: number;
  excluded?: number;
}): Response {
  return new Response(opts.body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      // A bare filename="..." carrying non-ASCII is invalid, and the names
      // here are Chinese, so only the RFC 5987 form is emitted.
      'content-disposition': `attachment; filename*=UTF-8''${encodeFilename(opts.filename)}`,
      'x-export-count': String(opts.rowCount),
      'x-export-total': String(opts.total ?? opts.rowCount),
      'x-excluded-count': String(opts.excluded ?? 0),
    },
  });
}
