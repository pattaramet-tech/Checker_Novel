// ชุดทดสอบงานเพิ่มความเร็ว lightScan (branch perf/lightscan-fast)
// ตรวจ 2 เรื่องหลัก: (1) ผล cleanup รวม 4 กฎ ต้องได้ข้อความ/จำนวน "ตรงกับ" การทำงานแบบเดิม
// (2) logic ความครบถ้วน (coverage) แยก "ตรวจแล้วไม่พบ" ออกจาก "ตรวจไม่ครบ"
// รัน: node tests/LIGHT_SCAN_PERF_TEST.js

// ===== Stubs จาก Checker_Main / Checker_Batch =====
const NOTE_TEXT_ = "พบคำต่างประเทศ";
const INVIS_RE_ = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g;

function cleanText_(s) {
  return String(s || "").replace(INVIS_RE_, "").trim();
}

function thaiDigitsToArabic_(s) {
  return String(s || '').replace(/[๐-๙]/g, function(ch) {
    return { '๐':'0','๑':'1','๒':'2','๓':'3','๔':'4','๕':'5','๖':'6','๗':'7','๘':'8','๙':'9' }[ch] || ch;
  });
}

function normalizeChapterLine_(s) {
  return cleanText_(s).replace(/^[\s\u2013\u2014\-–—]+/, "").trim();
}

function isChapterLineText_(s) {
  return /^(?:บท(?:ที่)?|ตอนที่)\s*\[?\s*[0-9๐-๙]+/.test(s) ||
    /^chapter\s*\[?\s*[0-9๐-๙]+/i.test(s);
}

function isStatusPanelLine_(text) {
  const s = String(text || "").replace(INVIS_RE_, " ").replace(/\s+/g, " ").trim();
  return !!s && s.length <= 400 && /^【[^】]{1,380}】$/.test(s);
}

const EMPTY_TAB_SCAN_CONFIG_ = {
  ANNOUNCEMENT_RE_: [
    /^จบ(?:ตอน|บท)?(?:ที่\s*[0-9]+)?$/,
    /จากต้นฉบับ/,
    /^ประกาศ/,
    /โปรดติดตาม|ฝากติดตาม|ติดตามต่อไป/
  ],
  ANNOUNCEMENT_MIN_PARAGRAPHS: 8,
  SOURCE_NOTE_TAB_RE_: [/หมายเหตุ/, /(?:ต้นฉบับ|ต่างประเทศ)/]
};

function formatTabNumberList_(tabIndexes) {
  var arr = (tabIndexes || []).map(Number)
    .filter(function(n) { return !isNaN(n); })
    .sort(function(a, b) { return a - b; });
  arr = arr.filter(function(v, i) { return i === 0 || v !== arr[i - 1]; });
  return arr.join(', ');
}

function dedupeCheckerNotes_(noteText) {
  var parts = String(noteText || '').split('|').map(function(s) { return s.trim(); }).filter(Boolean);
  var seen = {};
  var out = [];
  parts.forEach(function(p) { if (!seen[p]) { seen[p] = true; out.push(p); } });
  return out.join(' | ');
}

function appendCheckerNote_(baseNote, addition) {
  var base = String(baseNote || '').trim();
  var add = String(addition || '').trim();
  if (!add) return dedupeCheckerNotes_(base);
  if (!base) return dedupeCheckerNotes_(add);
  return dedupeCheckerNotes_(base + ' | ' + add);
}

function mergeCheckerNotes_() {
  var combined = '';
  for (var i = 0; i < arguments.length; i++) combined = appendCheckerNote_(combined, arguments[i]);
  return combined;
}

function compressNumberRanges_(nums) {
  var arr = (nums || []).map(Number).filter(function(n) { return !isNaN(n); })
    .sort(function(a, b) { return a - b; });
  arr = arr.filter(function(v, i) { return i === 0 || v !== arr[i - 1]; });
  var out = [];
  var i = 0;
  while (i < arr.length) {
    var start = arr[i], end = start;
    while (i + 1 < arr.length && arr[i + 1] === end + 1) { i++; end = arr[i]; }
    out.push(start === end ? String(start) : start + '-' + end);
    i++;
  }
  return out.join(', ');
}

const TAIL_JUNK_GROUPS_ = { PROMO: 'โปรโมต/ลิงก์', UI: 'คอมเมนต์/โหวต', AUTHOR: 'ความคิดผู้เขียน' };

function checkerBuildLongEnglishMessage_(tabNumbers) {
  var nums = (tabNumbers || []).map(Number).filter(function(n) { return !isNaN(n) && n > 0; })
    .sort(function(a, b) { return a - b; });
  if (!nums.length) return '';
  return 'พบประโยคภาษาอังกฤษยาว แท็บ ' + nums.join(', ');
}

function checkerBuildUntranslatedEnglishMessage_(untranslatedTabs) {
  if (!untranslatedTabs || !untranslatedTabs.length) return '';
  return 'แท็บ ' + untranslatedTabs.map(function(t) { return t.tabNo; }).join(', ') + ' ยังไม่แปลเป็นไทย';
}

// ===== Logic จาก Checker_Batch (perf-1) =====
function findChapterTitleColonFix_(raw) {
  var text = String(raw || '');
  var m = text.match(
    /^(?:บทที่|ตอนที่|บท|chapter)\s*\[?\s*[0-9๐-๙]+\s*\]?[ \t\u00A0]*[:：﹕꞉∶։][ \t\u00A0]*/i
  );
  if (!m) return null;

  var colonOffsetInMatch = m[0].search(/[:：﹕꞉∶։]/);
  var start = m.index + colonOffsetInMatch;
  var end = m.index + m[0].length;

  while (start > m.index && /[ \t\u00A0]/.test(text.charAt(start - 1))) start--;

  return {
    start: start,
    end: end,
    insertSpace: text.slice(end).trim() !== ''
  };
}

function computeLightScanParaEdits_(text, isHeadingPara, isPrimaryHeading) {
  var s = String(text || '');
  var edits = [];
  var emDash = 0;
  var waw = 0;
  var thaiDigit = 0;
  var tonToBod = 0;
  var m;

  var re = /—/g;
  while ((m = re.exec(s)) !== null) { edits.push({ start: m.index, end: m.index + 1, replacement: '...' }); emDash++; }

  re = /و/g;
  while ((m = re.exec(s)) !== null) { edits.push({ start: m.index, end: m.index + 1, replacement: 'ล' }); waw++; }

  re = /[๐-๙]/g;
  while ((m = re.exec(s)) !== null) { edits.push({ start: m.index, end: m.index + 1, replacement: thaiDigitsToArabic_(m[0]) }); thaiDigit++; }

  var colonFix = null;
  if (isHeadingPara) {
    colonFix = findChapterTitleColonFix_(s);
    if (colonFix) edits.push({ start: colonFix.start, end: colonFix.end, replacement: colonFix.insertSpace ? ' ' : '' });
  }

  var tonToBodEdit = null;
  if (isPrimaryHeading && /^ตอนที่(?=\s*[0-9๐-๙])/.test(s)) {
    tonToBodEdit = { start: 0, end: 6, replacement: 'บทที่' };
    edits.push(tonToBodEdit);
    tonToBod = 1;
  }

  edits.sort(function(a, b) { return b.start - a.start; });

  return {
    edits: edits,
    counts: { emDash: emDash, waw: waw, thaiDigit: thaiDigit, colon: colonFix ? 1 : 0, tonToBod: tonToBod },
    colonFix: colonFix,
    tonToBodEdit: tonToBodEdit
  };
}

// จำลองการ apply บนข้อความล้วน (แทน paragraph.editAsText ใน GAS)
function applyEditsSim_(text, edits) {
  var s = String(text);
  edits.forEach(function(e) {
    s = s.slice(0, e.start) + e.replacement + s.slice(e.end);
  });
  return s;
}

// พฤติกรรม "เดิม": ทำทีละ pass บนข้อความผลลัพธ์ล่าสุดเสมอ (รวมกฎ ตอนที่→บทที่ ชุดเดียวกัน)
function oldSequentialSim_(text, isHeading, isPrimaryHeading) {
  var s = String(text || '');
  var counts = { emDash: 0, waw: 0, thaiDigit: 0, colon: 0, tonToBod: 0 };

  counts.emDash = (s.match(/—/g) || []).length;
  s = s.replace(/—/g, '...');
  counts.waw = (s.match(/و/g) || []).length;
  s = s.replace(/و/g, 'ล');

  var fix = isHeading ? findChapterTitleColonFix_(s) : null;
  if (fix) {
    counts.colon = 1;
    s = s.slice(0, fix.start) + (fix.insertSpace ? ' ' : '') + s.slice(fix.end);
  }

  if (isPrimaryHeading && /^ตอนที่(?=\s*[0-9๐-๙])/.test(s)) {
    counts.tonToBod = 1;
    s = 'บทที่' + s.slice(6);
  }

  counts.thaiDigit = (s.match(/[๐-๙]/g) || []).length;
  s = s.replace(/[๐-๙]/g, function(ch) { return thaiDigitsToArabic_(ch); });

  return { text: s, counts: counts };
}

function newCombinedSim_(text, isHeading, isPrimaryHeading) {
  var computed = computeLightScanParaEdits_(text, isHeading, isPrimaryHeading);
  return { text: applyEditsSim_(text, computed.edits), counts: computed.counts };
}

// ===== Free marker stubs (จาก Checker_Batch) =====
function stripCheckerFreeMarker_(note) {
  return String(note || '').split('|').map(function(part) {
    var cleanPart = part.trim();
    while (/(?:^|\s)ฟรี\s*$/.test(cleanPart)) {
      cleanPart = cleanPart.replace(/(?:^|\s)ฟรี\s*$/, '').trim();
    }
    return cleanPart;
  }).filter(Boolean).join(' | ');
}

function addCheckerFreeMarker_(note, isFree) {
  var original = String(note || '').trim();
  if (!isFree) return original;
  var cleanNote = stripCheckerFreeMarker_(original);
  var parts = cleanNote ? cleanNote.split('|').map(function(part) { return part.trim(); }).filter(Boolean) : [];
  var primaryIndex = -1;
  for (var i = 0; i < parts.length; i++) {
    if (/^(?:เลขบทเรียงต่อเนื่อง|รอ\s+[0-9]+\s+แท็บ)$/.test(parts[i])) { primaryIndex = i; break; }
  }
  if (primaryIndex >= 0) parts[primaryIndex] += ' ฟรี';
  else parts.push('ฟรี');
  return parts.join(' | ');
}

function isFreeChapterRangeDocumentName_(documentName) {
  var normalizedName = String(documentName || '').trim();
  if (!normalizedName) return false;
  var match = normalizedName.match(/(?:^|[^0-9])(0*1)\s*[-–—]\s*([0-9]+)\s*$/);
  if (!match) return false;
  var start = Number(match[1]);
  var end = Number(match[2]);
  return start === 1 && Number.isInteger(end) && end > start;
}

function isFreeChapterRangeDocument_(doc) {
  try {
    return !!doc && typeof doc.getName === 'function' && isFreeChapterRangeDocumentName_(doc.getName());
  } catch (e) {
    return false;
  }
}

function isFreeDocumentByName_(doc) {
  try {
    if (doc && typeof isFreeChapterRangeDocument_ === 'function' && isFreeChapterRangeDocument_(doc)) return true;
    var name = thaiDigitsToArabic_(String(doc && doc.getName ? doc.getName() : ''))
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /^0*1(?:[^0-9]|$)/.test(name);
  } catch (e) {
    return false;
  }
}

// ===== Empty/source-note tab classification (จาก Checker_Batch perf-7) =====
function checkerIsEmptyTabAnnouncementLine_(text) {
  var s = thaiDigitsToArabic_(cleanText_(text));
  if (!s) return true;
  for (var i = 0; i < EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_RE_.length; i++) {
    if (EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_RE_[i].test(s)) return true;
  }
  return false;
}

function checkerClassifyTabContent_(text) {
  var result = { hasNoContent: true, meaningfulParagraphCount: 0, isSourceNoteTab: false };
  var lines = String(text || '').split('\n');
  var headingLines = [];

  for (var i = 0; i < lines.length; i++) {
    var t = cleanText_(lines[i]);
    if (!t || t === NOTE_TEXT_) continue;
    if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(t)) continue;
    // เช็คหัวบทก่อนบรรทัดประกาศ เพื่อไม่ให้ /จากต้นฉบับ/ กินหัวบท "หมายเหตุจากต้นฉบับ"
    if (isChapterLineText_(normalizeChapterLine_(t))) {
      headingLines.push(normalizeChapterLine_(t));
      continue;
    }
    if (checkerIsEmptyTabAnnouncementLine_(t)) continue;
    result.hasNoContent = false;
    result.meaningfulParagraphCount++;
  }

  // แท็บหมายเหตุ: ใช้ "หัวบทแรกของแท็บ" เป็นตัวตั้ง — หัวบทแรกตรง SOURCE_NOTE_TAB_RE_
  // (เช่น "บทที่ 433 หมายเหตุจากต้นฉบับ") = แท็บหมายเหตุ แม้มีบรรทัดโปรโมต/คำอธิบายปน
  if (headingLines.length) {
    var patterns = EMPTY_TAB_SCAN_CONFIG_.SOURCE_NOTE_TAB_RE_ || [];
    var firstHeading = headingLines[0];
    var matched = patterns.length > 0;
    for (var k = 0; k < patterns.length; k++) {
      if (!patterns[k].test(firstHeading)) { matched = false; break; }
    }
    if (matched) result.isSourceNoteTab = true;
  }

  return result;
}

function checkerShouldFlagEmptyTab_(info) {
  info = info || {};
  return !!info.hasNoContent && !info.isSourceNoteTab;
}

// ===== buildLightScanColumnNotes_ (สำเนาตรงจาก Checker_Batch perf-3) =====
function buildLightScanColumnNotes_(summary, doc) {
  summary = summary || {};

  var lang = [];
  // จำนวนบทสำหรับ Export IpeNovel (sheetNotePerChapter): ทุกแท็บในไฟล์ หักแท็บหมายเหตุจากต้นฉบับ/ต่างประเทศ
  var sourceNoteTabList = summary.sourceNoteTabNumbers || [];
  var countedTabs = Math.max(0, Number(summary.tabTotal || 0) - sourceNoteTabList.length);
  lang.push('เสร็จ ' + countedTabs);
  var coverage = summary.untranslatedCoverage || null;
  var coverage = summary.untranslatedCoverage || null;
  var coverageIncomplete = !!coverage && coverage.complete === false;
  var nonThai = Number(summary.nonThaiCount || 0);
  if (nonThai > 0) {
    lang.push('พบตัวอักษรต่างประเทศ ' + nonThai + ' ตัว');
    var foreignNames = (summary.foreignTabNames || []).slice(0, 50);
    if (foreignNames.length) lang.push('พบแท็บมีคำต่างประเทศ: ' + foreignNames.join(', '));
  } else if (coverageIncomplete) {
    lang.push('ยังตรวจไม่ครบ (' + coverage.checked + '/' + coverage.total + ' แท็บ) — ยังสรุปไม่ได้ว่าไม่พบตัวอักษรต่างประเทศ');
  } else {
    lang.push('ไม่พบตัวอักษรต่างประเทศ');
  }
  var longEnglishMessage = checkerBuildLongEnglishMessage_(summary.longEnglishTabNumbers || []);
  if (longEnglishMessage) lang.push(longEnglishMessage);
  var untranslatedMessage = checkerBuildUntranslatedEnglishMessage_(summary.untranslatedEnglishTabs || []);
  if (untranslatedMessage) lang.push(untranslatedMessage);

  var seq = [];
  var dupNumbers = [];
  var missingNumbers = [];
  var otherNonContinuous = false;

  (summary.chapterSequenceIssues || []).forEach(function(issue) {
    var type = String(issue.type || '');
    var current = Number(issue.current);
    var expected = Number(issue.expected);
    if (type === 'เลขซ้ำ') {
      if (!isNaN(current) && dupNumbers.indexOf(current) === -1) dupNumbers.push(current);
    } else if (type === 'เลขข้าม' || type === 'ไม่ต่อเนื่อง') {
      if (!isNaN(expected) && !isNaN(current) && current > expected) {
        for (var n = expected; n <= current - 1; n++) {
          if (missingNumbers.indexOf(n) === -1) missingNumbers.push(n);
        }
      } else {
        otherNonContinuous = true;
      }
    } else if (type === 'เลขย้อนหลัง') {
      otherNonContinuous = true;
    }
  });

  dupNumbers.sort(function(a, b) { return a - b; });
  missingNumbers.sort(function(a, b) { return a - b; });

  var contentDupTexts = [];
  (summary.contentDuplicates || []).forEach(function(pair) {
    var a = (pair.chapterA == null) ? (pair.tabA || '') : ('บทที่ ' + pair.chapterA);
    var b = (pair.chapterB == null) ? (pair.tabB || '') : ('บทที่ ' + pair.chapterB);
    if (a && b) contentDupTexts.push(a + ' และ ' + b);
  });

  if (dupNumbers.length) seq.push('เลขบทซ้ำ ' + dupNumbers.join(', '));
  if (missingNumbers.length) seq.push('บทที่หาย ' + compressNumberRanges_(missingNumbers));
  if (otherNonContinuous) seq.push('เลขบทไม่ต่อเนื่อง');
  if (contentDupTexts.length) seq.push('เนื้อหาซ้ำ ' + contentDupTexts.slice(0, 20).join(' / '));
  if (!seq.length) seq.push('เลขบทเรียงต่อเนื่อง');

  var sourceNoChapterTabs = summary.sourceNoChapterTabs || [];
  if (sourceNoChapterTabs.length) {
    var sourceList = formatTabNumberList_(sourceNoChapterTabs.map(function(t) { return t.tabIndex; }));
    if (sourceList) seq.push('ต้นฉบับไม่มีบทที่: แท็บ ' + sourceList);
  }

  var other = [];
  var emptyTabs = summary.emptyTabNumbers || [];
  var announcementTabs = summary.announcementTabNumbers || [];

  if (emptyTabs.length) other.push('พบ ' + emptyTabs.length + ' แท็บไม่มีเนื้อหา | แท็บ ' + formatTabNumberList_(emptyTabs));
  if (announcementTabs.length) {
    other.push('เข้าข่ายประกาศ (<' + Number(EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_MIN_PARAGRAPHS) + ' ย่อหน้า) ' +
      announcementTabs.length + ' แท็บ: ' + formatTabNumberList_(announcementTabs));
  }
  if (!emptyTabs.length && !announcementTabs.length) {
    other.push('ตรวจ ' + Number(summary.tabTotal || 0) + ' แท็บ ทุกแท็บมีเนื้อหา');
  }

  if (sourceNoteTabList.length) {
    other.push('ยกเว้นแท็บหมายเหตุ (' + sourceNoteTabList.length + ' แท็บ ไม่นับเข้าเสร็จ ' + countedTabs + '): แท็บ ' + formatTabNumberList_(sourceNoteTabList));
  }

  var junkByGroup = {};
  var junkOrder = [];
  (summary.tailJunkTabGroups || []).forEach(function(item) {
    var groupName = TAIL_JUNK_GROUPS_[item.group] ? TAIL_JUNK_GROUPS_[item.group] : String(item.group || '');
    if (!junkByGroup[groupName]) { junkByGroup[groupName] = []; junkOrder.push(groupName); }
    if (junkByGroup[groupName].indexOf(item.tabIndex) === -1) junkByGroup[groupName].push(item.tabIndex);
  });
  junkOrder.forEach(function(groupName) {
    other.push('ขยะท้ายบท ' + groupName + ': แท็บ ' + formatTabNumberList_(junkByGroup[groupName]));
  });

  var pendingPromoTabs = summary.endingPendingPromoTabs || [];
  if (pendingPromoTabs.length) other.push('พบบรรทัดโปรโมตท้ายบท: แท็บ ' + formatTabNumberList_(pendingPromoTabs));
  // ไม่รายงาน "ไม่พบ จบตอน ท้ายแท็บ" ตามที่ผู้ใช้ขอ (ข้อมูลยังสะสมใน endingMissingMarkerTabs แต่ไม่แสดง)

  var engSourceTabs = (summary.englishSourceUncertainTabs || [])
    .map(function(x) { return Number(x.tabIndex || 0); })
    .filter(Boolean);
  if (engSourceTabs.length) other.push('พบต้นฉบับอังกฤษติดหัวแท็บ: แท็บ ' + formatTabNumberList_(engSourceTabs));

  var fixStats = [];
  if (Number(summary.replacedEmDashCount || 0) > 0) fixStats.push('แทน — เป็น ... ' + Number(summary.replacedEmDashCount) + ' จุด');
  if (Number(summary.titleColonFixed || 0) > 0) fixStats.push('ลบ : ในชื่อบท ' + Number(summary.titleColonFixed) + ' จุด');
  if (Number(summary.thaiDigitFixed || 0) > 0) fixStats.push('แปลงเลขไทยเป็นอารบิก ' + Number(summary.thaiDigitFixed) + ' ตัว');
  if (Number(summary.episodePrefixFixed || 0) > 0) fixStats.push('แก้ ตอนที่ เป็น บทที่ ' + Number(summary.episodePrefixFixed) + ' จุด');
  if (Number(summary.paragraphCount || 0) > 0 || Number(summary.spacingCount || 0) > 0) {
    fixStats.push('จัดเว้นวรรค ' + Number(summary.paragraphCount || 0) + ' | ระยะห่าง ' + Number(summary.spacingCount || 0) + ' ย่อหน้า');
  }
  if (fixStats.length) other.push('แก้แล้ว: ' + fixStats.join(' | '));

  if (summary.untranslatedFallbackRan) {
    other.push('ตรวจไม่ครบ — สแกน untranslated ซ้ำทั้งเอกสารอัตโนมัติ');
  }

  var noteLanguage = dedupeCheckerNotes_(lang.join(' | '));
  var noteSequence = dedupeCheckerNotes_(seq.join(' | '));
  var noteOther = dedupeCheckerNotes_(other.join(' | '));

  if (doc && typeof isFreeDocumentByName_ === 'function') {
    noteLanguage = addCheckerFreeMarker_(noteLanguage, isFreeDocumentByName_(doc));
  }

  return { noteLanguage: noteLanguage, noteSequence: noteSequence, noteOther: noteOther };
}

// ===== Tail junk lines (จาก Checker_Batch perf-8) =====
const TAIL_JUNK_SCAN_CFG_ = { COLUMN: 15, TAIL_PARAGRAPHS: 10 };

function normalizeTailJunkText_(text) {
  return String(text || '')
    .replace(INVIS_RE_, ' ')
    .replace(/[“”"'`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyTailJunkLine_(text) {
  var s = thaiDigitsToArabic_(normalizeTailJunkText_(text));
  if (!s) return null;

  if (/^(?:ความคิด|ความคิดเห็น|หมายเหตุ|บันทึก)\s*(?:ของ)?\s*(?:ผู้สร้าง|ผู้เขียน|ผู้แต่ง|ผู้ประพันธ์)\s*:?\s*$/i.test(s) ||
      /^(?:author'?s?|creator'?s?)\s+(?:thoughts?|notes?)\s*:?\s*$/i.test(s)) {
    return 'AUTHOR';
  }

  if (/takamiya[_\s-]*shin/i.test(s) || /^([a-z][a-z0-9_.-]{2,})\s+\1$/i.test(s)) {
    return 'PROMO';
  }

  if (/patreon/i.test(s) ||
      /อ่านล่วงหน้า/.test(s) ||
      /(?:อ่าน|ติดตาม).{0,12}(?:ตอน|บท|เนื้อหา)?\s*(?:เพิ่มเติม|เพิ่ม|ต่อไป)/.test(s) ||
      /\b(?:read\s+more|more\s+chapters?|next\s+chapters?|early\s+chapters?)\b/i.test(s) ||
      /\bbit\.ly\//i.test(s)) {
    return 'PROMO';
  }

  if (/paypal\.me\/|ko-fi\.com\/|buymeacoffee\.com\//i.test(s) ||
      /(?:สนับสนุน|บริจาค|โดเนท|อุดหนุน)\s*(?:ผู้เขียน|ผู้แต่ง|ผู้สร้าง|ผู้ประพันธ์|นิยาย|เรื่อง)/.test(s)) {
    return 'PROMO';
  }

  if (/^(?:ความคิดเห็น|คอมเมนต์|ความเห็น)\s*[:：]?\s*[0-9]*\s*$/.test(s) ||
      /^(?:comments?|reviews?)\s*[:：]?\s*[0-9]*\s*$/i.test(s)) {
    return 'UI';
  }

  if (/^(?:โหวต|คะแนนโหวต|จำนวนโหวต)\s*[:：]?\s*[0-9]*\s*$/.test(s) ||
      /^(?:votes?|voting)\s*[:：]?\s*[0-9]*\s*$/i.test(s)) {
    return 'UI';
  }

  if (/^(?:power\s*stones?|powerstone)\s*[:：]?\s*[0-9]*\s*$/i.test(s) ||
      /^(?:พาวเวอร์\s*สโตน|หินพลัง)\s*[:：]?\s*[0-9]*\s*$/.test(s)) {
    return 'UI';
  }

  return null;
}

function scanTabTailJunkLines_(texts) {
  var found = [];
  var limit = Number(TAIL_JUNK_SCAN_CFG_.TAIL_PARAGRAPHS || 10);
  var startIdx = Math.max(0, (texts || []).length - limit);

  for (var i = startIdx; i < (texts || []).length; i++) {
    if (!String(texts[i] || '').trim()) continue;
    var group = classifyTailJunkLine_(texts[i]);
    if (group) found.push({ lineIdx: i, group: group });
  }

  return found;
}

// ===== TEST RUNNER =====
let failed = 0;
function expectEqual(desc, actual, expected) {
  if (actual === expected) {
    console.log("PASS | " + desc);
  } else {
    failed++;
    console.log("FAIL | " + desc);
    console.log("       expected: " + JSON.stringify(expected));
    console.log("       actual:   " + JSON.stringify(actual));
  }
}

console.log("=== Parity: cleanup รวม 4 กฎ vs แบบทีละ pass (เดิม) ===\n");

const parityCases = [
  'บทที่ 130: เป็นเทพของเธอ?',
  'บทที่ ๑๓๐: ชื่อไทย — จบ',
  'บทที่ 130 : ช่องว่างหน้า colon',
  'A — B — و — ๑๒๓',
  'บทที่ ๑๓๘ หมายเหตุจากต้นฉบับ',
  'ปกติ ๑ กับ — และ و ปนกัน',
  'chapter 5: The Beginning',
  'บทที่ 5: ชื่อ: มี colon ที่สอง',
  '',
  'จบตอน',
  '—๑—๒',
  'و١'
];

let parityChecked = 0;
parityCases.forEach(function(text) {
  [true, false].forEach(function(isHeading) {
    [true, false].forEach(function(isPrimary) {
      var oldRes = oldSequentialSim_(text, isHeading, isPrimary);
      var newRes = newCombinedSim_(text, isHeading, isPrimary);
      parityChecked++;
      expectEqual(
        'ข้อความสุดท้ายตรงกัน [' + text + '|H:' + isHeading + '|P:' + isPrimary + ']',
        newRes.text, oldRes.text
      );
      expectEqual(
        'จำนวนจุดแก้ตรงกัน [' + text + '|H:' + isHeading + '|P:' + isPrimary + ']',
        JSON.stringify(newRes.counts), JSON.stringify(oldRes.counts)
      );
    });
  });
});

console.log("\n=== ตอนที่ → บทที่ (เฉพาะหัวบทหลักแรกของแท็บ) ===\n");

const tonCases = [
  { text: 'ตอนที่ 130: เป็นเทพของเธอ?', isH: true, isP: true, expected: 'บทที่ 130 เป็นเทพของเธอ?' },
  { text: 'ตอนที่ ๑๒๓ ชื่อไทย', isH: true, isP: true, expected: 'บทที่ 123 ชื่อไทย' },
  { text: 'ตอนที่ 45', isH: true, isP: true, expected: 'บทที่ 45' },
  { text: 'ตอนที่ 130: เป็นเทพของเธอ?', isH: true, isP: false, expected: 'ตอนที่ 130 เป็นเทพของเธอ?' },
  { text: 'ตอนที่ฉันยังเด็ก ๆ', isH: false, isP: false, expected: 'ตอนที่ฉันยังเด็ก ๆ' },
  { text: 'บทที่ 12: แล้วพบกัน', isH: true, isP: true, expected: 'บทที่ 12 แล้วพบกัน' }
];

tonCases.forEach(function(c) {
  var res = newCombinedSim_(c.text, c.isH, c.isP);
  expectEqual(c.text + ' (H=' + c.isH + ', P=' + c.isP + ')', res.text, c.expected);
  expectEqual(c.text + ' (นับ tonToBod)', res.counts.tonToBod, /ตอนที่(?=\s*[0-9๐-๙])/.test(c.text) && c.isP && c.isH ? 1 : 0);
});

console.log("\n=== ตัวอย่างผลรวม (สำหรับตรวจสายตา) ===\n");
var sample = newCombinedSim_('บทที่ ๑๓๐: ตอนพิเศษ — ตอนจบ و', true);
console.log('in : บทที่ ๑๓๐: ตอนพิเศษ — ตอนจบ و');
console.log('out:', sample.text, JSON.stringify(sample.counts));

console.log("\n=== coverage: แยก ตรวจแล้วไม่พบ / ตรวจไม่ครบ ===\n");

var completeNotes = buildLightScanColumnNotes_({
  nonThaiCount: 0,
  tabTotal: 50,
  untranslatedCoverage: { checked: 50, total: 50, complete: true },
  untranslatedFallbackRan: false,
  chapterSequenceIssues: [],
  contentDuplicates: [],
  emptyTabNumbers: [],
  announcementTabNumbers: [],
  tailJunkTabGroups: []
});
expectEqual('ครบ 50/50 => รายงานไม่พบต่างประเทศได้', completeNotes.noteLanguage.indexOf('ไม่พบตัวอักษรต่างประเทศ') !== -1, true);
expectEqual('ครบแล้วไม่มี marker ตรวจไม่ครบใน N', completeNotes.noteOther.indexOf('สแกน untranslated') === -1, true);

var incompleteNotes = buildLightScanColumnNotes_({
  nonThaiCount: 0,
  tabTotal: 50,
  untranslatedCoverage: { checked: 48, total: 50, complete: false },
  untranslatedFallbackRan: true,
  chapterSequenceIssues: [],
  contentDuplicates: [],
  emptyTabNumbers: [],
  announcementTabNumbers: [],
  tailJunkTabGroups: []
});
expectEqual('ไม่ครบ 48/50 => ห้ามรายงานผ่าน', incompleteNotes.noteLanguage.indexOf('ยังตรวจไม่ครบ (48/50') !== -1, true);
expectEqual('ไม่ครบ => N มี marker สแกนซ้ำ', incompleteNotes.noteOther.indexOf('สแกน untranslated ซ้ำทั้งเอกสาร') !== -1, true);

console.log("\n=== regression: หมายเหตุ N (แท็บว่าง/ขยะท้ายบท) ===\n");

var otherNotes = buildLightScanColumnNotes_({
  nonThaiCount: 0,
  tabTotal: 50,
  untranslatedCoverage: { checked: 50, total: 50, complete: true },
  untranslatedFallbackRan: false,
  chapterSequenceIssues: [],
  contentDuplicates: [],
  emptyTabNumbers: [3, 7],
  announcementTabNumbers: [12],
  tailJunkTabGroups: [
    { tabIndex: 11, group: 'PROMO' },
    { tabIndex: 11, group: 'UI' }
  ]
});
expectEqual('N รายงานแท็บว่าง', otherNotes.noteOther.indexOf('พบ 2 แท็บไม่มีเนื้อหา | แท็บ 3, 7') !== -1, true);
expectEqual('N รายงานขยะท้ายบทแยกกลุ่ม',
  otherNotes.noteOther.indexOf('ขยะท้ายบท โปรโมต/ลิงก์: แท็บ 11') !== -1 &&
  otherNotes.noteOther.indexOf('ขยะท้ายบท คอมเมนต์/โหวต: แท็บ 11') !== -1, true);

console.log("\n=== เสร็จ N (จำนวนแท็บสำหรับ Export IpeNovel) ===\n");

var countNotes = buildLightScanColumnNotes_({
  nonThaiCount: 0,
  tabTotal: 50,
  untranslatedCoverage: { checked: 50, total: 50, complete: true },
  chapterSequenceIssues: [],
  contentDuplicates: [],
  emptyTabNumbers: [],
  announcementTabNumbers: [],
  sourceNoteTabNumbers: [],
  tailJunkTabGroups: []
});
expectEqual('50 แท็บ ไม่มีแท็บหมายเหตุ => L ขึ้นต้น เสร็จ 50', countNotes.noteLanguage.indexOf('เสร็จ 50 | ') === 0, true);

var countWithNote = buildLightScanColumnNotes_({
  nonThaiCount: 0,
  tabTotal: 50,
  untranslatedCoverage: { checked: 50, total: 50, complete: true },
  chapterSequenceIssues: [],
  contentDuplicates: [],
  emptyTabNumbers: [],
  announcementTabNumbers: [],
  sourceNoteTabNumbers: [3, 9],
  tailJunkTabGroups: []
});
expectEqual('หักแท็บหมายเหตุ 2 แท็บ => เสร็จ 48', countWithNote.noteLanguage.indexOf('เสร็จ 48 | ') === 0, true);
expectEqual('N รายงานแท็บหมายเหตุที่ยกเว้น',
  countWithNote.noteOther.indexOf('ยกเว้นแท็บหมายเหตุ (2 แท็บ ไม่นับเข้าเสร็จ 48): แท็บ 3, 9') !== -1, true);

console.log("\n=== ฟรี ตามชื่อไฟล์ (ขึ้นต้น 001 / ช่วงเลขเริ่ม 1) ===\n");

expectEqual('ชื่อไฟล์ "001 - 050 เรื่องแปล" => ฟรี', isFreeDocumentByName_({ getName: function() { return '001 - 050 เรื่องแปล'; } }), true);
expectEqual('ชื่อไฟล์ "๐๐๑ - ๐๕๐ เรื่องแปล" (เลขไทย) => ฟรี', isFreeDocumentByName_({ getName: function() { return '๐๐๑ - ๐๕๐ เรื่องแปล'; } }), true);
expectEqual('ชื่อไฟล์ "136 - 185 เรื่องแปล" (ช่วงเริ่ม 136) => ไม่ฟรี', isFreeDocumentByName_({ getName: function() { return '136 - 185 เรื่องแปล'; } }), false);
expectEqual('ชื่อไฟล์ "001 เรื่องแปล" (ขึ้นต้น 001 ไม่มีช่วง) => ฟรี', isFreeDocumentByName_({ getName: function() { return '001 เรื่องแปล'; } }), true);
expectEqual('ชื่อไฟล์ "เรื่องแปลธรรมดา" => ไม่ฟรี', isFreeDocumentByName_({ getName: function() { return 'เรื่องแปลธรรมดา'; } }), false);

var freeNotes = buildLightScanColumnNotes_({
  nonThaiCount: 0,
  tabTotal: 50,
  untranslatedCoverage: { checked: 50, total: 50, complete: true },
  chapterSequenceIssues: [],
  contentDuplicates: [],
  emptyTabNumbers: [],
  announcementTabNumbers: [],
  sourceNoteTabNumbers: [],
  tailJunkTabGroups: []
}, { getName: function() { return '001 - 050 เรื่องแปล'; } });
expectEqual('L มีคำว่า ฟรี เมื่อชื่อไฟล์ 001', freeNotes.noteLanguage.indexOf('ฟรี') !== -1, true);
expectEqual('L ยังมี เสร็จ 50 ควบคู่กัน', freeNotes.noteLanguage.indexOf('เสร็จ 50') !== -1, true);

// ลำดับบทภายในแท็บ (port ตรงจาก checkChapterSequenceFromChapters_)
function checkChapterSequenceFromChapters_(chapters) {
  var issues = [];

  for (var i = 1; i < chapters.length; i++) {
    var prev = chapters[i - 1];
    var curr = chapters[i];
    var expected = prev.chapterNumber + 1;

    if (curr.chapterNumber !== expected) {
      var type = 'ไม่ต่อเนื่อง';
      if (curr.chapterNumber === prev.chapterNumber) type = 'เลขซ้ำ';
      else if (curr.chapterNumber < prev.chapterNumber) type = 'เลขย้อนหลัง';
      else if (curr.chapterNumber > expected) type = 'เลขข้าม';

      issues.push({ type: type, expected: expected, previous: prev.chapterNumber, current: curr.chapterNumber });
    }
  }

  return { ok: issues.length === 0, totalFound: chapters.length, chapters: chapters, issues: issues };
}

console.log("\n=== เลขบทนับเฉพาะหัวบทแรกของแท็บ ===\n");

// lightScan ส่งเฉพาะ chapters[0] เข้าลำดับบท — บรรทัดกลางเนื้อเรื่องต้องไม่ทำให้ไม่ต่อเนื่อง
var firstOnlySeq = checkChapterSequenceFromChapters_([{ chapterNumber: 138, text: 'บทที่ 138 หมายเหตุจากต้นฉบับ' }]);
expectEqual('แท็บเดียวมีหัวบทเดียว => ต่อเนื่อง ไม่มี issue', firstOnlySeq.ok, true);
expectEqual('จำนวน issue เป็น 0', firstOnlySeq.issues.length, 0);

var allChaptersSeq = checkChapterSequenceFromChapters_([
  { chapterNumber: 138 },
  { chapterNumber: 140 }
]);
expectEqual('ถ้านับกลางเนื้อเรื่องจะขึ้นเลขข้าม (พฤติกรรมเก่า ใช้ยืนยันว่า logic จับได้)', allChaptersSeq.issues.length > 0, true);

console.log("\n=== แท็บหมายเหตุจากต้นฉบับ (ไม่นับเข้า เสร็จ N) ===\n");

var sourceNoteCases = [
  { text: "บทที่ 433 หมายเหตุจากต้นฉบับ\nเผล Ipe นิยายแปล เว็บไซต์ Ipenovel.com", note: true, flag: false, desc: "เคสจริงแท็บ 43: หัวบทหมายเหตุ + โปรโมต Ipe" },
  { text: "บทที่ 434 หมายเหตุจากต้นฉบับ\nเผล Ipe นิยายแปล เว็บไซต์ Ipenovel.com", note: true, flag: false, desc: "เคสจริงแท็บ 44" },
  { text: "บทที่ 435 หมายเหตุจากต้นฉบับ\nเนื่องจากที่กันบทที่ 432", note: true, flag: false, desc: "เคสจริงแท็บ 45: หัวบทหมายเหตุ + คำอธิบาย" },
  { text: "บทที่ 138 หมายเหตุจากต้นฉบับ", note: true, flag: false, desc: "หัวบทหมายเหตุล้วน" },
  { text: "บทที่ 138 หมายเหตุจากต้นฉบับ\nจบตอน", note: true, flag: false, desc: "หมายเหตุ + จบตอน" },
  { text: "บทที่ 138", note: false, flag: true, desc: "หัวบทธรรมดาไม่มีคำหมายเหตุ = นับเป็นแท็บว่าง" },
  { text: "บทที่ 500 ชื่อบทจริง\nเขาเดินเข้ามาอย่างช้า ๆ\nบทที่ 499 หมายเหตุจากต้นฉบับ", note: false, flag: false, desc: "นิยายจริง (หัวบทแรกไม่ใช่หมายเหตุ) = ไม่ยกเว้น" }
];

sourceNoteCases.forEach(function(c) {
  var info = checkerClassifyTabContent_(c.text);
  expectEqual(c.desc + " (isSourceNoteTab)", info.isSourceNoteTab, c.note);
  expectEqual(c.desc + " (flag เป็นแท็บว่าง)", checkerShouldFlagEmptyTab_(info), c.flag);
});

console.log("\n=== scanTabTailJunkLines_ (หาบรรทัดขยะท้ายบทเพื่อไฮไลต์) ===\n");

// สร้างแท็บ 12 ย่อหน้า: เนื้อเรื่อง 9 ย่อหน้า + ขยะ 2 บรรทัด (idx 10, 11) + จบตอน (idx 11 หลัง shift)
var tabTexts = [];
for (var tI = 0; tI < 9; tI++) tabTexts.push('ย่อหน้าเนื้อเรื่องที่ ' + (tI + 1) + ' มีเนื้อหายาวพอควรสำหรับนิยาย');
tabTexts.push('อ่านล่วงหน้าได้อีก 20 บทบน Patreon ของฉัน!');       // idx 9  PROMO
tabTexts.push('ความคิดเห็น 19');                                    // idx 10  UI
tabTexts.push('จบตอน');                                             // idx 11  ไม่ใช่ขยะ

var junkLines = scanTabTailJunkLines_(tabTexts);
expectEqual('หาขยะได้ 2 บรรทัด (ใน 10 ย่อหน้าท้าย)', junkLines.length, 2);
expectEqual('บรรทัดแรก idx 9 กลุ่ม PROMO', JSON.stringify(junkLines[0]), JSON.stringify({ lineIdx: 9, group: 'PROMO' }));
expectEqual('บรรทัดที่สอง idx 10 กลุ่ม UI', JSON.stringify(junkLines[1]), JSON.stringify({ lineIdx: 10, group: 'UI' }));
expectEqual('บรรทัด จบตอน ไม่ถูกนับเป็นขยะ', junkLines.some(function(j) { return j.lineIdx === 11; }), false);

// ขยะที่อยู่นอกช่วงท้าย 10 ย่อหน้า ต้องไม่ถูกจับ
var longTexts = ['อ่านล่วงหน้าได้อีก 20 บทบน Patreon ของฉัน!'];
for (var tJ = 0; tJ < 14; tJ++) longTexts.push('ย่อหน้าเนื้อเรื่องปกติที่ ' + (tJ + 1));
expectEqual('ขยะนอกช่วงท้าย 10 ย่อหน้า ไม่ถูกจับ', scanTabTailJunkLines_(longTexts).length, 0);

console.log("\n=== FOREIGN_WORD_RE_V9_ (ตรวจจับอักษรต่างประเทศ perf-9) ===\n");

// สำเนา regex จาก Checker_Main.gs (perf-9: เพิ่มอักษรอินเดีย \u0900-\u0DFF)
const FOREIGN_WORD_RE_V9_ = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u0DFF\uFB50-\uFDFF\uFE70-\uFEFF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0400-\u04FF\u1E00-\u1EFF\u0300-\u036F]+/g;

function countForeignMatches_(text) {
  const re = new RegExp(FOREIGN_WORD_RE_V9_.source, 'g');
  let count = 0, m;
  while ((m = re.exec(text)) !== null) count++;
  return count;
}

expectEqual('เทวนาครี "री" (ฮินดี) ถูกตรวจจับ', countForeignMatches_('ข้อความไทย रี ต่อ'), 1);
expectEqual('เทวนาครี "रामायण" ถูกตรวจจับ', countForeignMatches_('रामायण'), 1);
expectEqual('คาตากานะญี่ปุ่น "カロリー" ถูกตรวจจับ (มีอยู่แล้ว)', countForeignMatches_('カロリー バツ'), 2);
expectEqual('ภาษาจีน "江湖" ถูกตรวจจับ (มีอยู่แล้ว)', countForeignMatches_('江湖'), 1);
expectEqual('ภาษาเกาหลี "한국" ถูกตรวจจับ (มีอยู่แล้ว)', countForeignMatches_('한국'), 1);
expectEqual('ภาษาไทย "คาทอรี" ไม่ถูกนับเป็นต่างประเทศ (ถูกต้อง)', countForeignMatches_('คาทอรี บัตสึอุนไซ'), 0);
expectEqual('ภาษาอังกฤษไม่ถูกนับ (จับด้วยกฎยาวแยกต่างหาก)', countForeignMatches_('Patreon Ipenovel'), 0);

console.log("\n=== Auto Trigger: เลือกแถวจาก C มีลิงก์ + G ยังไม่ติ๊ก ===\n");

const CHECKER_CFG_TRIG = { START_ROW: 2 };

function checkerTriggerPickAutoRows_(rows, cfg) {
  const startRow = Number((typeof CHECKER_CFG !== 'undefined' && CHECKER_CFG && CHECKER_CFG.START_ROW) || 2);
  const seenDocIds = {};
  const out = [];

  (rows || []).forEach(function(r) {
    const sheetRow = Number(r && r.sheetRow || 0);
    if (!sheetRow || sheetRow < startRow) return;

    const title = String(r && r.title || '').trim();
    if (!title) return;

    const docId = String(r && r.docId || '').trim();
    if (!docId) return;

    if (r.checked) return;
    if (seenDocIds[docId]) return;

    seenDocIds[docId] = true;
    out.push({ sheetRow: sheetRow, docId: docId, tabId: String(r && r.tabId || ''), enqueuedAt: Number(r && r.now || 0), attempts: 0 });
  });

  return out;
}

var autoRows = checkerTriggerPickAutoRows_([
  { sheetRow: 3, title: 'เรื่อง A 001 - 050', docId: 'docAAA', checked: false },   // รับ
  { sheetRow: 4, title: 'เรื่อง B 051 - 080', docId: 'docBBB', checked: true },    // G ติ๊กแล้ว = ข้าม
  { sheetRow: 5, title: '', docId: 'docCCC', checked: false },                     // ไม่มีชื่อ = ข้าม
  { sheetRow: 6, title: 'เรื่อง C', docId: '', checked: false },                   // ไม่มีลิงก์ = ข้าม
  { sheetRow: 7, title: 'เรื่อง D 001 - 050', docId: 'docAAA', checked: false },   // DocID ซ้ำ = ข้าม
  { sheetRow: 1, title: 'หัวตาราง', docId: 'docDDD', checked: false }              // แถวหัวตาราง = ข้าม
], CHECKER_CFG_TRIG);

expectEqual('เลือกได้เฉพาะแถวที่ผ่านเงื่อนไข 1 แถว', autoRows.length, 1);
expectEqual('แถวที่เลือกคือแถว 3 เรื่อง A', autoRows.length && autoRows[0].sheetRow === 3 && autoRows[0].docId === 'docAAA', true);

console.log("\n=========================");
console.log('parity cases: ' + parityChecked + ' ตัวอย่าง x 4 การตรวจ');
console.log(failed === 0 ? "✅ ผ่านทุกเคส" : "❌ ไม่ผ่าน " + failed + " เคส");
process.exitCode = failed === 0 ? 0 : 1;

// ===== เว้นวรรค/ระยะห่างจาก snapshot (port จาก formatLayoutFromSnapshot_) =====
function formatLayoutFromSnapshot_(paras, paraTexts) {
  var indent = 36;
  var after = 10;
  var indentCount = 0;
  var spacingCount = 0;

  for (var i = 0; i < paras.length; i++) {
    var tx = String(paraTexts[i] || '').trim();
    if (!tx) continue;
    var p = paras[i];
    var statusLine = (typeof isStatusPanelLine_ === 'function') ? isStatusPanelLine_(tx) : false;
    var targetIndent = statusLine ? 0 : indent;
    var targetAfter = statusLine ? 0 : after;
    var wroteIndent = false;
    var wroteSpacing = false;

    if (typeof p.getIndentFirstLine === 'function') {
      if (p.getIndentFirstLine() !== targetIndent) { p.setIndentFirstLine(targetIndent); wroteIndent = true; }
    }
    if (typeof p.getIndentStart === 'function') {
      if (p.getIndentStart() !== 0) { p.setIndentStart(0); wroteIndent = true; }
    }
    if (typeof p.getSpacingBefore === 'function') {
      if (p.getSpacingBefore() !== 0) { p.setSpacingBefore(0); wroteSpacing = true; }
    }
    if (typeof p.getSpacingAfter === 'function') {
      if (p.getSpacingAfter() !== targetAfter) { p.setSpacingAfter(targetAfter); wroteSpacing = true; }
    }

    indentCount++;
    spacingCount++;
  }

  return { indentCount: indentCount, spacingCount: spacingCount, writes: { indent: wroteIndent } };
}

function makeFakePara_(firstIndent, indentStart, spacingBefore, spacingAfter) {
  return {
    _ops: [],
    getIndentFirstLine: function() { return this._fi; },
    getIndentStart: function() { return this._is; },
    getSpacingBefore: function() { return this._sb; },
    getSpacingAfter: function() { return this._sa; },
    setIndentFirstLine: function(v) { this._fi = v; this._ops.push('fi=' + v); },
    setIndentStart: function(v) { this._is = v; this._ops.push('is=' + v); },
    setSpacingBefore: function(v) { this._sb = v; this._ops.push('sb=' + v); },
    setSpacingAfter: function(v) { this._sa = v; this._ops.push('sa=' + v); },
    _fi: firstIndent, _is: indentStart, _sb: spacingBefore, _sa: spacingAfter
  };
}

console.log("\n=== formatLayoutFromSnapshot_ (เว้นวรรค/ระยะห่าง จาก snapshot) ===\n");

var layoutParas = [
  makeFakePara_(36, 0, 0, 10),      // ถูกต้องแล้ว = ไม่เขียน
  makeFakePara_(0, 0, 0, 0),        // ต้องแก้ทั้งสอง
  makeFakePara_(0, 12, 5, 20)       // ต้องแก้ indentStart/spacing
];
var layoutTexts = ['ย่อหน้าแรกมีเนื้อหา', 'ย่อหน้าสองมีเนื้อหา', 'ย่อหน้าสามมีเนื้อหา'];
var layoutRes = formatLayoutFromSnapshot_(layoutParas, layoutTexts);
expectEqual('นับย่อหน้าที่จัดครบ 3', layoutRes.indentCount, 3);
expectEqual('นับระยะห่างครบ 3', layoutRes.spacingCount, 3);
expectEqual('ย่อหน้าที่ถูกต้องแล้วไม่ถูกเขียนซ้ำ (รักษาค่าเดิม)', layoutParas[0]._ops.length, 0);
expectEqual('ย่อหน้าที่สาม ย่อหน้าแรก=36', layoutParas[2]._fi, 36);
expectEqual('ย่อหน้าที่สาม spacingAfter=10', layoutParas[2]._sa, 10);

// แผงสถานะ 【...】 ต้องไม่ย่อหน้า/ไม่ระยะ
var panelPara = makeFakePara_(36, 0, 5, 10);
formatLayoutFromSnapshot_([panelPara], ['【รอ 5 แท็บ】']);
expectEqual('แผงสถานะ indent=0', panelPara._fi, 0);
expectEqual('แผงสถานะ spacingAfter=0', panelPara._sa, 0);

console.log("\n=========================");
