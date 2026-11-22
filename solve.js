// csv-reader-speed: a fast drop-in replacement for csv-reader 1.0.0.
//
// run({ text, header }) returns { columns, rows, errors } exactly as
// csv-reader 1.0.0 does. The text is read once, left to right. Clean
// one-line records without quotes take a bulk path (one slice + split per
// line); quoted or broken records go through a tight indexOf-driven state
// machine that only pays for the damage actually present.

const CR = 13;
const LF = 10;
const COMMA = 44;
const QUOTE = 34;
const BOM = 0xFEFF;

export function run(input) {
  const text = input.text;
  const header = input.header;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = header ? [] : null;
  let width = -1;
  let pos = 0;
  if (len > 0 && text.charCodeAt(0) === BOM) pos = 1;
  let line = 1;
  let rowNo = 0;

  while (pos < len) {
    const recLine = line;
    const isFirst = width === -1;
    const recRow = isFirst && header ? null : rowNo;

    // ---- bulk path: one line, no quote, no stray CR ----
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? len : nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q > end) {
      const r = text.indexOf("\r", pos);
      if (r === -1 || r > end || (nl !== -1 && r === end - 1)) {
        const segEnd = nl !== -1 && r !== -1 && r === end - 1 ? end - 1 : end;
        if (segEnd === pos) {
          if (nl === -1) break;
          pos = nl + 1;
          line++;
          continue;
        }
        const fields = text.slice(pos, segEnd).split(",");
        finishRecord(fields, recLine, recRow, isFirst);
        if (nl === -1) break;
        pos = nl + 1;
        line++;
        continue;
      }
    }

    // ---- general path: one record, field by field ----
    const fields = [];
    let extraLines = 0;
    let terminated = false;
    let recEnded = false;
    while (!recEnded) {
      if (pos >= len) {
        // trailing empty field at EOF; only reached after a comma
        fields.push("");
        break;
      }
      let value;
      let substantial;
      let endKind; // 0 = comma, 1 = line break, 2 = EOF
      if (text.charCodeAt(pos) === QUOTE) {
        // ---- quoted field ----
        let cur = pos + 1;
        const pieces = [];
        let closed = -1;
        while (true) {
          const k = text.indexOf('"', cur);
          if (k === -1) {
            closed = -1;
            break;
          }
          if (text.charCodeAt(k + 1) === QUOTE) {
            pieces.push(text.slice(cur, k));
            pieces.push('"');
            cur = k + 2;
            continue;
          }
          closed = k;
          pieces.push(text.slice(cur, k));
          break;
        }
        if (closed === -1) {
          // never closes: literal quote, re-read as unquoted
          errors.push({ code: "unterminated_quote", line: recLine, row: recRow });
          const u = unquoted(pos, recLine, recRow);
          value = u[0];
          substantial = value !== "";
          endKind = u[1];
          pos = u[2];
        } else {
          // ---- junk after the closing quote ----
          let j = closed + 1;
          let junkLen = 0;
          if (j >= len) {
            endKind = 2;
            pos = len;
          } else {
            const d = text.charCodeAt(j);
            if (d === COMMA) {
              endKind = 0;
              pos = j + 1;
            } else if (d === LF) {
              endKind = 1;
              pos = j + 1;
              terminated = true;
            } else if (d === CR && text.charCodeAt(j + 1) === LF) {
              endKind = 1;
              pos = j + 2;
              terminated = true;
            } else {
              let cur = j;
              for (;;) {
                const ci = text.indexOf(",", cur);
                const ni = text.indexOf("\n", cur);
                const ri = text.indexOf("\r", cur);
                let m = -1;
                let kind = -1;
                if (ci !== -1) {
                  m = ci;
                  kind = 0;
                }
                if (ni !== -1 && (m === -1 || ni < m)) {
                  m = ni;
                  kind = 1;
                }
                if (ri !== -1 && (m === -1 || ri < m)) {
                  m = ri;
                  kind = 2;
                }
                if (m === -1) {
                  pieces.push(text.slice(cur));
                  junkLen += len - cur;
                  endKind = 2;
                  pos = len;
                  break;
                }
                if (kind === 2) {
                  if (text.charCodeAt(m + 1) === LF) {
                    pieces.push(text.slice(cur, m));
                    junkLen += m - cur;
                    endKind = 1;
                    pos = m + 2;
                    terminated = true;
                    break;
                  }
                  errors.push({ code: "stray_cr", line: recLine, row: recRow });
                  pieces.push(text.slice(cur, m));
                  junkLen += m - cur;
                  cur = m + 1;
                  continue;
                }
                pieces.push(text.slice(cur, m));
                junkLen += m - cur;
                endKind = kind === 0 ? 0 : 1;
                pos = m + 1;
                if (endKind === 1) terminated = true;
                break;
              }
            }
          }
          value = pieces.join("");
          if (value.indexOf("\r") !== -1) value = value.replace(/\r\n?/g, "\n");
          let n = 0;
          let ix = value.indexOf("\n");
          while (ix !== -1) {
            n++;
            ix = value.indexOf("\n", ix + 1);
          }
          extraLines += n;
          if (junkLen > 0) errors.push({ code: "quote_junk", line: recLine, row: recRow });
          substantial = true;
        }
      } else {
        // ---- unquoted field ----
        const u = unquoted(pos, recLine, recRow);
        value = u[0];
        substantial = value !== "";
        endKind = u[1];
        pos = u[2];
      }
      if (endKind === 1) terminated = true;
      if (endKind === 0) {
        fields.push(value);
      } else {
        // line break or EOF: the pending field only counts when the
        // record has a field already or this field is substantial
        if (fields.length > 0 || substantial) fields.push(value);
        recEnded = true;
      }
    }

    if (fields.length > 0) {
      finishRecord(fields, recLine, recRow, isFirst);
    }
    line = recLine + extraLines + (terminated ? 1 : 0);
    if (!terminated && pos >= len) break;
  }

  return { columns, rows, errors };

  // Unquoted field starting at `start`. Returns [value, endKind, nextPos]
  // with endKind 0 = comma, 1 = line break, 2 = EOF. A CR not followed by
  // LF is dropped and reported; CRLF ends the record.
  function unquoted(start, recLine, recRow) {
    // Two indexOf calls find the field end; a stray CR inside the value is
    // rare, so it is detected on the (short) value and re-parsed then.
    const ci = text.indexOf(",", start);
    const ni = text.indexOf("\n", start);
    let m;
    let kind;
    if (ci !== -1 && (ni === -1 || ci < ni)) {
      m = ci;
      kind = 0;
    } else if (ni !== -1) {
      m = ni;
      kind = 1;
    } else {
      m = len;
      kind = 2;
    }
    let value = text.slice(start, m);
    if (kind === 1 && value.length > 0 && value.charCodeAt(value.length - 1) === CR) {
      value = value.slice(0, -1);
    }
    if (value.indexOf("\r") !== -1) {
      // lone CR(s) inside: drop each, report it, keep the rest
      let out = "";
      let cur = 0;
      for (;;) {
        const r = value.indexOf("\r", cur);
        if (r === -1) {
          out += value.slice(cur);
          break;
        }
        errors.push({ code: "stray_cr", line: recLine, row: recRow });
        out += value.slice(cur, r);
        cur = r + 1;
      }
      value = out;
    }
    if (kind === 0) return [value, 0, m + 1];
    if (kind === 1) return [value, 1, m + 1];
    return [value, 2, len];
  }

  // Width check + store for one materialized record.
  function finishRecord(fields, recLine, recRow, isFirst) {
    if (isFirst) {
      width = fields.length;
      if (header) {
        columns = fields;
      } else {
        rows.push(fields);
        rowNo++;
      }
      return;
    }
    if (fields.length < width) {
      errors.push({ code: "short_row", line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push("");
    } else if (fields.length > width) {
      errors.push({ code: "long_row", line: recLine, row: recRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
    rowNo++;
  }
}
