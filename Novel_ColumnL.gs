function noteHasNovelForeignWork_(note) {
  const s = String(note || '');
  // "พบประโยคภาษาอังกฤษยาว แท็บ 2, 5" คือ marker ใหม่จาก Checker (V11.12)
  return /ต่างประเทศ|ศัพท์ต่างประเทศ|คำเกาหลี|คำญี่ปุ่น|คำจีน|คำอังกฤษ|ประโยคภาษาอังกฤษยาว|ภาษาอังกฤษยาว|แท็บ\s*\d+|\d+\s*[-–]\s*\d+/.test(s);
}

function noteIsOnlyContinuous_(note) {
  const s = stripCheckerFreeMarker_(note);
  if (!/เลขบทเรียงต่อเนื่อง/.test(s)) return false;
  const rest = s.replace(/เลขบทเรียงต่อเนื่อง/g, '').replace(/[|,\s]+/g, '');
  return !rest && !noteHasNovelForeignWork_(s.replace(/เลขบทเรียงต่อเนื่อง/g, ''));
}

// ดึง marker ปัญหาที่ "ยังไม่ได้แก้" ออกมาเก็บไว้ ไม่ให้หายตอน Build/Apply
function extractCheckerProblemMarkers_(note) {
  var s = stripCheckerFreeMarker_(note);
  var found = [];
  var patterns = [
    /เลขบทซ้ำ(?:\s*[0-9,\s\-–]+)?/g,
    /บทที่หาย(?:\s*[0-9,\s\-–]+)?/g,
    /เนื้อหาซ้ำ[^|]*/g,
    /เลขบทไม่ต่อเนื่อง/g,
    /ต้นฉบับไม่มีบทที่(?:\s*:\s*แท็บ[0-9,\s\-–]+)?/g
  ];

  patterns.forEach(function(re) {
    var m;
    while ((m = re.exec(s)) !== null) {
      var seg = m[0].trim().replace(/[,\s]+$/, '').trim();
      if (seg && found.indexOf(seg) === -1) found.push(seg);
    }
  });

  return found;
}

// สร้างหมายเหตุ "รอ N แท็บ" โดยพ่วง marker ปัญหาที่ยังค้างไว้
function composeWaitingTabsNote_(tabCount, originalNote) {
  var n = Number(tabCount);
  if (isNaN(n)) n = 0;
  var parts = [addCheckerFreeMarker_('รอ ' + n + ' แท็บ', hasCheckerFreeMarker_(originalNote))];
  extractCheckerProblemMarkers_(originalNote).forEach(function(m) { parts.push(m); });
  return parts.join(' | ');
}

// เขียนหมายเหตุโปรแกรมเฉพาะเมื่อค่าเปลี่ยน และนับผลต่อ source row เพียงครั้งเดียวต่อ Build Queue
function setNovelProgramNoteIfChanged_(main, sourceRow, nextNote, stats) {
  const noteRange = main.getRange(sourceRow, NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL);
  const currentNote = String(noteRange.getValue() || '');
  const normalizedNextNote = String(nextNote || '');
  const updated = currentNote !== normalizedNextNote;

  if (updated) noteRange.setValue(normalizedNextNote);

  if (stats) {
    if (!stats.noteResultRows) stats.noteResultRows = new Set();
    const rowKey = String(sourceRow);
    if (!stats.noteResultRows.has(rowKey)) {
      if (updated) stats.notesUpdated++;
      else stats.unchangedRows++;
      stats.noteResultRows.add(rowKey);
    }
  }

  return { updated: updated, unchanged: !updated };
}

// Returns [{ tab, title, tabId }]. Prefers getAllTabsFlat_ (Checker_Main.txt) since it already
// flattens nested child tabs correctly; falls back to a local flattener when that's not loaded.
function parseNovelTargetTabs_(note, tabCount) {
  return parseNovelTargetTabsDetailed_(note, tabCount).tabs;
}

/**
 * อ่านเลขแท็บจากหมายเหตุพร้อมบอกสาเหตุเมื่ออ่านไม่ได้
 * รองรับข้อความที่ Checker_Batch สร้างจริง เช่น:
 * - พบแท็บมีคำต่างประเทศ: 1, 2, 3
 * - พบประโยคภาษาอังกฤษยาว แท็บ 2, 5
 * - แท็บ 1, 2 ยังไม่แปลเป็นไทย
 * - พบคำต่างประเทศ แท็บที่ 2-4
 * - tab 2 / tabs 2, 3
 * - เลขไทย: แท็บ ๒-๔
 */
function parseNovelTargetTabsDetailed_(note, tabCount) {
  const valid = new Set();
  const mentioned = new Set();
  const maxTab = Math.max(0, Number(tabCount) || 0);
  const text = String(note || '')
    .replace(/[๐-๙]/g, function(ch) {
      return String('๐๑๒๓๔๕๖๗๘๙'.indexOf(ch));
    })
    .replace(/[—−]/g, '-');

  function remember_(n) {
    n = Number(n);
    if (!Number.isInteger(n) || n <= 0) return;
    mentioned.add(n);
    if (n <= maxTab) valid.add(n);
  }

  function parseNumberList_(segment) {
    const s = String(segment || '');
    let m;
    const tokenRe = /(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?/g;
    while ((m = tokenRe.exec(s)) !== null) {
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      if (a <= 0 || b <= 0) continue;
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      // กันหมายเหตุผิดรูปแบบจนสร้างช่วงขนาดมหาศาล
      if (end - start > 1000) {
        remember_(a);
        remember_(b);
        continue;
      }
      for (let n = start; n <= end; n++) remember_(n);
    }
  }

  // รูปแบบผลลัพธ์จาก Checker_Batch:
  // "พบแท็บมีคำต่างประเทศ: 1, 2" (เลขไม่ได้อยู่ติดคำว่า "แท็บ")
  let m;
  const checkerListRe = /พบแท็บมีคำต่างประเทศ\s*[:：]?\s*([0-9\s,，;；\/\-–]+)/gi;
  while ((m = checkerListRe.exec(text)) !== null) parseNumberList_(m[1]);

  // marker ใหม่จาก Checker V11.12: "พบประโยคภาษาอังกฤษยาว แท็บ 2, 5"
  // อ่านเลขแท็บให้ชัดเจน แม้จะเขียนโดยไม่มีคำว่า "แท็บ" เช่น "พบประโยคภาษาอังกฤษยาว: 2, 5"
  const longEnglishListRe = /(?:พบ)?ประโยคภาษาอังกฤษยาว\s*[:：]?\s*(?:แท็บ(?:ที่)?\s*)?([0-9][0-9\s,，;；\/\-–]*)/gi;
  while ((m = longEnglishListRe.exec(text)) !== null) parseNumberList_(m[1]);

  // รูปแบบทั่วไป: "แท็บ 1, 2", "แท็บที่ 1-3", "tab 1 / tabs 2,3"
  // หยุด capture ก่อนข้อความถัดไป เพื่อไม่หยิบเลขบทหรือเลขอื่นในหมายเหตุ
  const labeledRe = /(?:แท็บ(?:ที่)?|tabs?)\s*[:：#]?\s*([0-9][0-9\s,，;；\/\-–]*)/gi;
  while ((m = labeledRe.exec(text)) !== null) parseNumberList_(m[1]);

  // เอกสารแบบไม่มี Docs tabs มีตัวแทนชื่อ "เอกสารหลัก" ซึ่งคือแท็บ 1
  if (!mentioned.size && maxTab === 1 && /เอกสารหลัก/.test(text)) remember_(1);

  // ยังคงรองรับหมายเหตุที่มีเฉพาะรายการเลข เช่น "41, 42, 43"
  if (!mentioned.size && /^[\d\s,，;；\/\-–]+$/.test(text.trim())) {
    parseNumberList_(text);
  }

  return {
    tabs: Array.from(valid).sort(function(a, b) { return a - b; }),
    mentioned: Array.from(mentioned).sort(function(a, b) { return a - b; }),
    outOfRange: Array.from(mentioned)
      .filter(function(n) { return n > maxTab; })
      .sort(function(a, b) { return a - b; }),
    tabCount: maxTab
  };
}

function novelRescanDocumentForCompletion_(doc) {
  const tabs = getNovelDocumentTabs_(doc);
  // T6 (round 4): completion uses novelParagraphIsDirtyForCompletion_, NOT the export-time test —
  // AI Apply's own review highlight must never by itself block เสร็จ. A marker-only paragraph
  // (literal "พบคำต่างประเทศ" text, no foreign characters of its own) still counts as dirty and
  // keeps this document out of the clean "เสร็จ" state; real foreign/long-English leakage does too.
  const foreignTabs = novelLiveScanDirtyTabs_(doc, tabs, novelParagraphIsDirtyForCompletion_);
  return { tabCount: tabs.length, stillHasForeign: foreignTabs.length > 0, foreignTabs: foreignTabs };
}

// F5: exact base texts are "เสร็จ N แท็บ รอแอดแพรวตรวจ" (still dirty somewhere) and
// "เสร็จ N แท็บ" (clean) — no extra marker text spliced into the base itself.
// F6: originalNote passed in here must be the CURRENT Column L value read fresh right before
// composing (callers must not use a stale export-time note), so a เลขบทซ้ำ/เนื้อหาซ้ำ/ฟรี/บทที่หาย
// marker that was added or removed after export is still honored, and a blocker cannot be
// bypassed by a stale export-time note.
function composeNovelCompletionNote_(tabCount, currentNote, stillHasForeign, reviewTabs) {
  let n = Number(tabCount);
  if (isNaN(n)) n = 0;
  const markers = extractCheckerProblemMarkers_(currentNote);
  const blocking = markers.filter(function(m) { return /เลขบทซ้ำ|เนื้อหาซ้ำ/.test(m); });
  if (blocking.length) {
    return composeWaitingTabsNote_(n, currentNote); // AC9/F6: duplicate-chapter/content markers still block "เสร็จ"
  }
  // CGS-008: Apply may finish AI edits, but human review is still pending.
  // When Apply supplies affected tabs, preserve that exact list instead of total document tab count.
  if (Array.isArray(reviewTabs)) {
    const tabSet = new Set();
    reviewTabs.forEach(function(value) {
      const tabNo = Number(value);
      if (Number.isInteger(tabNo) && tabNo > 0) tabSet.add(tabNo);
    });
    const tabs = Array.from(tabSet).sort(function(a, b) { return a - b; });
    const tabText = tabs.map(function(tabNo) { return 'แท็บ ' + tabNo; }).join(', ');
    const reviewBase = tabs.length
      ? ('รอตรวจ ' + tabs.length + ' แท็บ: ' + tabText + ' รอแอดแพรวตรวจ')
      : 'รอตรวจ 0 แท็บ รอแอดแพรวตรวจ';
    const reviewParts = [addCheckerFreeMarker_(reviewBase, hasCheckerFreeMarker_(currentNote))];
    markers.forEach(function(m) { reviewParts.push(m); });
    return reviewParts.join(' | ');
  }
  const base = stillHasForeign
    ? ('เสร็จ ' + n + ' แท็บ รอแอดแพรวตรวจ') // F5
    : ('เสร็จ ' + n + ' แท็บ'); // F5
  const parts = [addCheckerFreeMarker_(base, hasCheckerFreeMarker_(currentNote))]; // AC8: ฟรี preserved
  markers.forEach(function(m) { parts.push(m); }); // AC8: e.g. บทที่หาย preserved (blocking markers already returned above)
  return parts.join(' | ');
}
