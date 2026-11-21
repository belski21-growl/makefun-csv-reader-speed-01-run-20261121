// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// SPDX-License-Identifier: MIT
//
// Returns exactly what csv-reader 1.0.0 returns for every {text, header}:
// {columns, rows, errors}. Semantics copied from the reference
// (baselines/csv-reader/vendor/csv-reader/index.js):
//  - U+FEFF at the very start is dropped; a record ends at LF or CRLF;
//    a line left with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with a quote runs to the next non-doubled quote
//    ("" inside is one quote; CRLF / lone CR inside read as LF); what
//    follows the closing quote up to the next comma or line break is
//    appended as it stands (quote_junk, when the field ends); a quote
//    that never closes is a literal character and the text after it is
//    read again as unquoted (unterminated_quote).
//  - A quote inside an unquoted field is literal; fields stay strings.
//  - columns is the first record when header is true, else null; rows
//    are padded (short_row, fields: count) or cut (long_row, extra: the
//    cut fields) to the first record's width.
//  - Each error is {code, line, row} in the order met; line is the
//    1-based line its record starts on, row its index in rows (null for
//    the header).
//
// Speed strategy (the reference is one character at a time with string
// += per character):
//  - Fast record path: a record whose line holds no '"' and no stray CR
//    is sliced whole and split(',') — all C-level work. That covers the
//    large majority of records (plain int/decimal/date/code/word fields).
//    The quote/CR checks use bounded indexOf from the record start, so
//    the line is sliced only once, for the split itself (rev. pasca-buka
//    21 Nov 14:2x WIB).
//  - Slow path (records with quotes or stray CRs) still never walks
//    character by character building strings: unquoted fields scan with
//    one tight charCodeAt loop and slice once; quoted fields jump with
//    indexOf('"') and slice, converting CR/CRLF inside quotes to LF only
//    when the segment actually holds one (a CR-free segment skips both
//    regex passes and only counts its LFs — rev. pasca-buka 21 Nov
//    14:2x WIB).
//  - No object is allocated per field; field end is carried in two
//    locals (fval / fend).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null for the header). Errors pushed while reading it use these.
  let recordLine = 1;
  let recordRow = null;

  // Current field, as set by readUnquoted / readQuoted.
  let fval = '';
  let fend = END;
  // Characters kept by the last readUnquoted call (excludes its initial
  // value); used for the quote_junk check.
  let uadded = 0;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break; a CR not followed by LF is dropped (stray_cr). Sets fval/fend
  // and uadded (characters kept by this call). Scans with one tight
  // charCodeAt loop and slices once: the three-indexOf version made each
  // indexOf overshoot past the field end (the '\r' scan runs to the next
  // CR anywhere later in the text), and measured ~2x slower on practice.
  function readUnquoted(value) {
    let v = value;
    let added = 0;
    for (;;) {
      let i = pos;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i += 1;
      }
      if (i >= len) {
        if (i > pos) { v += text.slice(pos, i); added += i - pos; }
        pos = len;
        fval = v; fend = END; uadded = added;
        return;
      }
      const c = text.charCodeAt(i);
      if (i > pos) { v += text.slice(pos, i); added += i - pos; }
      if (c === 44) {
        pos = i + 1;
        fval = v; fend = COMMA; uadded = added;
        return;
      }
      if (c === 10) {
        pos = i + 1;
        line += 1;
        fval = v; fend = LINE_BREAK; uadded = added;
        return;
      }
      // CR: CRLF is a line break, a lone CR is dropped (stray_cr).
      if (i + 1 < len && text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        fval = v; fend = LINE_BREAK; uadded = added;
        return;
      }
      err('stray_cr');
      pos = i + 1;
      // A stray CR is dropped and the field goes on.
    }
  }

  // Converts a quoted segment [a, b) the reference way: each CRLF or
  // lone CR inside it is one LF, and every such break counts a line.
  // No CR in the segment is the common case (LF-only): skip both regex
  // passes, count the LFs with an indexOf loop and return it unchanged.
  function conv(a, b) {
    const s = text.slice(a, b);
    if (s.indexOf('\r') === -1) {
      let n = 0;
      let i = s.indexOf('\n');
      while (i !== -1) { n += 1; i = s.indexOf('\n', i + 1); }
      line += n;
      return s;
    }
    const br = s.match(/\r\n|\r|\n/g);
    if (br) line += br.length;
    return s.replace(/\r\n?/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos. Sets fval/fend.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let v = '';
    let segStart = pos + 1;
    for (;;) {
      const j = text.indexOf('"', segStart);
      if (j === -1) {
        // The quote never closes: it is a literal character, and the
        // text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (j + 1 < len && text.charCodeAt(j + 1) === 34) {
        // Doubled quote: one quote in the value.
        v += conv(segStart, j);
        v += '"';
        segStart = j + 2;
        continue;
      }
      // Closed at j.
      v += conv(segStart, j);
      const n = j + 1;
      if (n >= len) {
        pos = len;
        fval = v; fend = END;
        return;
      }
      const c = text.charCodeAt(n);
      if (c === 44) {
        pos = n + 1;
        fval = v; fend = COMMA;
        return;
      }
      if (c === 10) {
        pos = n + 1;
        line += 1;
        fval = v; fend = LINE_BREAK;
        return;
      }
      if (c === 13 && n + 1 < len && text.charCodeAt(n + 1) === 10) {
        pos = n + 2;
        line += 1;
        fval = v; fend = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break.
      pos = n;
      readUnquoted(v);
      if (uadded > 0) err('quote_junk');
      return;
    }
  }

  // Finishes a record's fields: header, or a row padded/cut to width.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast record path: the record ends at the next LF, its line holds
    // no '"' and no stray CR (a CR only as the CRLF line ending).
    // Bounded indexOf from pos (never slicing the line first): the only
    // copy left is the one split(',') needs.
    const nl = text.indexOf('\n', pos);
    if (nl !== -1) {
      const q = text.indexOf('"', pos);
      const r = text.indexOf('\r', pos);
      if ((q === -1 || q >= nl) && (r === -1 || r >= nl || r === nl - 1)) {
        const body = r === nl - 1 ? text.slice(pos, nl - 1) : text.slice(pos, nl);
        pos = nl + 1;
        line += 1;
        if (body === '') continue; // a line holding only a stray CR
        finishRecord(body.split(','));
        continue;
      }
    } else {
      // No LF left: the rest of the text is the last record.
      const rest = text.slice(pos);
      if (rest.indexOf('"') === -1 && rest.indexOf('\r') === -1) {
        pos = len;
        finishRecord(rest.split(','));
        continue;
      }
    }

    // Slow path: the record holds a quote or a stray CR (or spans lines
    // inside quotes). Field by field, still indexOf-driven.
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fval);
    } while (fend === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
