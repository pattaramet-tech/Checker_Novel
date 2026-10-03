function setNovelFinalParagraphCellStyle_(queue, sheetRow, finalCol) {
  try {
    if (!finalCol || finalCol <= 0) return;

    queue.getRange(Number(sheetRow), finalCol)
      .setFontFamily(NOVEL_APPLY_FONT_FAMILY)
      .setFontSize(NOVEL_APPLY_FONT_SIZE)
      .setWrap(true)
      .setVerticalAlignment('top');
  } catch (e) {}
}

function setNovelImportedRowsStyle_(queue, sheetRows, finalCol) {
  try {
    if (!finalCol || finalCol <= 0 || !sheetRows || !sheetRows.length) return;

    sheetRows.forEach(function(rowNo) {
      queue.getRange(Number(rowNo), finalCol)
        .setFontFamily(NOVEL_APPLY_FONT_FAMILY)
        .setFontSize(NOVEL_APPLY_FONT_SIZE)
        .setWrap(true)
        .setVerticalAlignment('top');
    });
  } catch (e) {}
}

function setNovelParagraphTextSarabun18_(para, text) {
  if (!para) throw new Error('ไม่พบ paragraph สำหรับ apply');

  const finalText = String(text || '');

  // เก็บเฉพาะ layout ของ paragraph เดิมไว้ ไม่เก็บ para attributes ทั้งก้อน
  // เพราะ para.setAttributes() อาจเขียนทับ font/size/background ที่เพิ่งตั้งใหม่
  const align = (function() {
    try { return para.getAlignment ? para.getAlignment() : null; } catch (e) { return null; }
  })();
  const indentFirst = (function() {
    try { return para.getIndentFirstLine ? para.getIndentFirstLine() : null; } catch (e) { return null; }
  })();
  const indentStart = (function() {
    try { return para.getIndentStart ? para.getIndentStart() : null; } catch (e) { return null; }
  })();
  const spacingBefore = (function() {
    try { return para.getSpacingBefore ? para.getSpacingBefore() : null; } catch (e) { return null; }
  })();
  const spacingAfter = (function() {
    try { return para.getSpacingAfter ? para.getSpacingAfter() : null; } catch (e) { return null; }
  })();

  const textEl = para.editAsText();
  textEl.setText(finalText);

  // คืน layout ก่อน แล้วค่อยบังคับ style ของข้อความเป็นขั้นตอนสุดท้าย
  try { if (align) para.setAlignment(align); } catch (e) {}
  try { if (indentFirst !== null) para.setIndentFirstLine(indentFirst); } catch (e) {}
  try { if (indentStart !== null) para.setIndentStart(indentStart); } catch (e) {}
  try { if (spacingBefore !== null) para.setSpacingBefore(spacingBefore); } catch (e) {}
  try { if (spacingAfter !== null) para.setSpacingAfter(spacingAfter); } catch (e) {}

  const len = textEl.getText().length;
  if (len > 0) {
    textEl.setFontFamily(0, len - 1, NOVEL_APPLY_FONT_FAMILY);
    textEl.setFontSize(0, len - 1, NOVEL_APPLY_FONT_SIZE);

    // ไฮไลต์ย่อหน้าที่ถูก Apply จาก Claude JSON เพื่อให้ไล่ตรวจง่าย
    // ใช้พื้นหลังสี #d62828 และตัวอักษรสีขาวเพื่อให้อ่านบนพื้นแดงได้ชัด
    textEl.setBackgroundColor(0, len - 1, NOVEL_APPLY_HIGHLIGHT_COLOR);
    textEl.setForegroundColor(0, len - 1, NOVEL_APPLY_HIGHLIGHT_TEXT_COLOR);
  }

  return true;
}

function cleanNovelImportedJsonText_(text) {
  let s = String(text || '').trim();

  // ตัด BOM
  s = s.replace(/^\uFEFF/, '');

  // ตัด markdown fence ถ้ามี
  s = s.replace(/^```(?:json)?\s*/i, '');
  s = s.replace(/```\s*$/i, '');

  // ดึงเฉพาะ JSON array กรณีมีข้อความอื่นปน
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }

  return s.trim();
}

/**
 * ซ่อมเคส AI ใส่เครื่องหมาย " ตรง ๆ ใน string value แล้ว JSON.parse พัง
 * เช่น "เขาพูดว่า "รัก" แล้วเดินไป" -> "เขาพูดว่า \"รัก\" แล้วเดินไป"
 *
 * หมายเหตุ:
 * - ใช้เป็นตัวช่วยเท่านั้น
 * - วิธีที่ดีที่สุดคือให้ AI ใช้เครื่องหมายคำพูดไทย “ ” ในเนื้อหา
 */
function repairLooseJsonQuotes_(jsonText) {
  const s = String(jsonText || '');
  let out = '';
  let inString = false;
  let escaped = false;

  function nextNonSpace(pos) {
    for (let i = pos + 1; i < s.length; i++) {
      const c = s[i];
      if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') return c;
    }
    return '';
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (!inString) {
      out += c;
      if (c === '"') {
        inString = true;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }

    if (c === '\\') {
      out += c;
      escaped = true;
      continue;
    }

    if (c === '"') {
      const n = nextNonSpace(i);

      // quote ปิด string ของ JSON มักตามด้วย :, ,, }, ]
      if (n === ':' || n === ',' || n === '}' || n === ']') {
        out += c;
        inString = false;
      } else {
        // quote ภายในข้อความ ให้ escape
        out += '\\"';
      }
      continue;
    }

    out += c;
  }

  return out;
}

function parseNovelClaudeJsonSafe_(jsonText) {
  const cleaned = cleanNovelImportedJsonText_(jsonText);

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    const repaired = repairLooseJsonQuotes_(cleaned);

    try {
      return JSON.parse(repaired);
    } catch (secondErr) {
      throw new Error(
        'JSON ไม่ถูกต้อง: ' + firstErr.message +
        '\n\nลองซ่อมเครื่องหมาย quote อัตโนมัติแล้ว แต่ยัง parse ไม่ผ่าน: ' + secondErr.message +
        '\n\nวิธีแก้:' +
        '\n1) ใน finalParagraph/newText/oldText/reason ห้ามใช้เครื่องหมาย " ตรง ๆ' +
        '\n2) ใช้เครื่องหมายคำพูดไทย “ ” แทน เช่น เขาพูดว่า “รัก”' +
        '\n3) หรือ escape เป็น \\" เช่น เขาพูดว่า \\"รัก\\"' +
        '\n4) ต้องตอบเป็น JSON array เท่านั้น ห้ามมี markdown หรือคำอธิบาย'
      );
    }
  }
}

function importNovelClaudeJson(jsonText) {
  const edits = parseNovelClaudeJsonSafe_(jsonText);

  if (!Array.isArray(edits)) throw new Error('ต้องเป็น JSON array');

  const meta = ensureNovelHelperSheets_();
  const queue = meta.queue;
  const lastRow = queue.getLastRow();
  if (lastRow < 2) return { ok: true, updated: 0, message: 'AI_QUEUE ว่าง' };

  const width = meta.queueHeaders.length;
  const values = queue.getRange(2, 1, lastRow - 1, width).getValues();
  // ใช้ header map จริงของชีต (อาจไม่ตรงลำดับ NOVEL_QUEUE_HEADERS ถ้าเพิ่งย้าย/ผสาน header)
  const idx = {};
  Object.keys(meta.queueMap).forEach(function(h) { idx[h] = meta.queueMap[h] - 1; });
  const byId = new Map(edits.map(e => [String(e.taskId), e]));
  let updated = 0;
  const updatedSheetRows = [];

  for (let r = 0; r < values.length; r++) {
    const taskId = String(values[r][idx.taskId]);
    const edit = byId.get(taskId);
    if (!edit) continue;

    const status = String(edit.status || 'ready').toLowerCase();
    values[r][idx.claudeStatus] = status === 'needs_review' ? 'NEEDS_REVIEW' : 'READY';
    values[r][idx.finalParagraph] = edit.finalParagraph || edit.newText || '';
    values[r][idx.message] = edit.reason || '';
    updated++;
    updatedSheetRows.push(r + 2);
  }

  queue.getRange(2, 1, values.length, width).setValues(values);

  // ตั้งรูปแบบ finalParagraph ที่ import เข้ามาให้เป็น Sarabun 18 ทันที
  setNovelImportedRowsStyle_(queue, updatedSheetRows, meta.queueMap.finalParagraph);
  SpreadsheetApp.flush();

  return { ok: true, updated, message: `นำเข้า Claude edits แล้ว ${updated} งาน และตั้ง finalParagraph เป็น Sarabun 18 แล้ว` };}

function formatExistingNovelImportedFinalParagraphs() {
  const meta = ensureNovelHelperSheets_();
  const queue = meta.queue;
  const lastRow = queue.getLastRow();
  if (lastRow < 2) return { ok: true, updated: 0, message: 'AI_QUEUE ว่าง' };

  const finalCol = meta.queueMap.finalParagraph || 0;
  if (finalCol <= 0) throw new Error('ไม่พบคอลัมน์ finalParagraph');

  queue.getRange(2, finalCol, lastRow - 1, 1)
    .setFontFamily(NOVEL_APPLY_FONT_FAMILY)
    .setFontSize(NOVEL_APPLY_FONT_SIZE)
    .setWrap(true)
    .setVerticalAlignment('top');

  SpreadsheetApp.flush();

  return {
    ok: true,
    updated: lastRow - 1,
    message: `ตั้ง finalParagraph เดิมทั้งหมด ${lastRow - 1} แถวเป็น Sarabun 18 แล้ว`
  };
}


// ตรวจหาย่อหน้าที่ต้องแก้จริง (optimistic concurrency), fix round 3 (S1/S2/S3/S6):
//
// A pure "rank among currently-matching duplicates" scheme (round 2) cannot tell apart two
// situations that look identical from the outside: (a) THIS task's own paragraph was edited
// elsewhere and a SIBLING with matching content still remains — must block, zero mutation
// (S1); vs (b) a SIBLING was already applied/edited and THIS task's own paragraph is untouched
// — must still resolve correctly (S2/S5). Content-only counting can silently resolve (a) to the
// wrong physical paragraph. The fix: prove identity primarily via the paragraph's POSITION at
// export time (paragraphs don't shift index when some OTHER paragraph's text is edited in
// place), and only fall back to a content-only search when this paragraph's content was proven
// unique among dirty paragraphs at export time (occurrenceCount <= 1) — for a paragraph that had
// duplicate siblings, content alone can never safely disambiguate, so no fallback is attempted:
// any failure of the position check blocks, never guesses (S1/S6).
//
// 1) Position anchor (always tried first, and for a paragraph that had siblings the ONLY path
//    that can succeed): the paragraph physically at the recorded export-time index must still
//    exist and still carry the exact recorded content. Editing/removing OTHER paragraphs doesn't
//    move this one, so this succeeds even after a sibling duplicate was applied elsewhere (S2/S5).
// 2) If the position anchor fails and this paragraph's content was UNIQUE (no siblings) at
//    export time, fall back to a content-only search across the tab — but restricted to
//    paragraphs that are STILL dirty right now (same "highlighted / foreign / long-English"
//    universe export used to count occurrences), so an identical-text CLEAN sibling can never be
//    mistaken for the dirty paragraph this task actually targets (S3). Requires a unique match;
//    more than one live candidate is genuinely ambiguous and blocks (S6 — unrelated
//    insertion/reorder must never cause a silent wrong apply).
// 3) Even when the position anchor succeeds for a paragraph that was UNIQUE at export time, an
//    unrelated insertion could coincidentally have introduced a brand-new duplicate elsewhere in
//    the tab that now shares this exact content — the position match is no longer sufficient
//    proof of identity by itself. Verify no other CURRENTLY-dirty paragraph shares the same
//    fingerprint; if one exists, the new ambiguity blocks rather than guesses (S6). This
//    additional check only applies to originally-unique paragraphs — for a paragraph that had
//    real siblings at export time (expectedCount > 1), the position anchor is already the sole
//    source of truth (S1/S5) and other live matches are the EXPECTED siblings, not an anomaly.
// T8 (round 4): a legacy task exported before occurrenceCount existed (or carrying an invalid
// value) must NEVER be assumed unique. Defaulting a missing occurrenceCount to 1 let an ambiguous
// legacy duplicate silently take the content-fallback path below and potentially resolve to the
// WRONG physical paragraph. An unknown count is treated as conservatively as a confirmed sibling
// count for the fallback decision (no content-only search — position anchor only), but — unlike a
// confirmed sibling count, where other live matches are the EXPECTED siblings — it still runs the
// post-match extra-duplicate check, because we genuinely don't know whether duplicates are
// expected here and an unexplained extra match must block rather than be assumed benign.
// V1/V2/V3 (round 6/C07): the skipExtraDuplicateCheck shortcut above (for a CONFIRMED duplicate)
// was itself unsafe on its own — two identical dirty paragraphs exported at index 0/1, followed by
// an unrelated paragraph inserted BEFORE the group, shifts BOTH siblings' indices by one; the
// second task's recorded index (1) then coincidentally lands on what is now physically the FIRST
// sibling, and the shortcut trusted that position match blindly, mutating the WRONG physical
// paragraph.
// W1-W8 (round 7/C08): a raw paragraph-COUNT check (round 6/C07's first attempt) is still not
// sufficient — a same-count REORDER (a non-duplicate paragraph moved from after the group to
// before it, e.g.) preserves total count while silently realigning indices, and was independently
// reproduced doing exactly that. novelDuplicateTabStructureStable_ is the stronger anchor: it
// requires the full recorded fingerprint SEQUENCE to prove every position OUTSIDE this task's own
// duplicate group still holds its exact export-time content — in-place edits to a GROUP member
// (e.g. a sibling being fixed) are deliberately exempt, so raw position stays trustworthy for a
// confirmed duplicate only when nothing outside its own group has moved.
