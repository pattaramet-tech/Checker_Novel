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
  SOURCE_NOTE_TAB_RE_: [/หมายเหตุ/, /ต้นฉบับ/]
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

function computeLightScanParaEdits_(text, isHeadingPara) {
  var s = String(text || '');
  var edits = [];
  var emDash = 0;
  var waw = 0;
  var thaiDigit = 0;
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

  edits.sort(function(a, b) { return b.start - a.start; });

  return {
    edits: edits,
    counts: { emDash: emDash, waw: waw, thaiDigit: thaiDigit, colon: colonFix ? 1 : 0 },
    colonFix: colonFix
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

// พฤติกรรม "เดิม": ทำทีละ pass บนข้อความผลลัพธ์ล่าสุดเสมอ
function oldSequentialSim_(text, isHeading) {
  var s = String(text || '');
  var counts = { emDash: 0, waw: 0, thaiDigit: 0, colon: 0 };

  counts.emDash = (s.match(/—/g) || []).length;
  s = s.replace(/—/g, '...');
  counts.waw = (s.match(/و/g) || []).length;
  s = s.replace(/و/g, 'ล');

  var fix = isHeading ? findChapterTitleColonFix_(s) : null;
  if (fix) {
    counts.colon = 1;
    s = s.slice(0, fix.start) + (fix.insertSpace ? ' ' : '') + s.slice(fix.end);
  }

  counts.thaiDigit = (s.match(/[๐-๙]/g) || []).length;
  s = s.replace(/[๐-๙]/g, function(ch) { return thaiDigitsToArabic_(ch); });

  return { text: s, counts: counts };
}

function newCombinedSim_(text, isHeading) {
  var computed = computeLightScanParaEdits_(text, isHeading);
  return { text: applyEditsSim_(text, computed.edits), counts: computed.counts };
}

// ===== buildLightScanColumnNotes_ (สำเนาตรงจาก Checker_Batch perf-1) =====
function buildLightScanColumnNotes_(summary, doc) {
  summary = summary || {};

  var lang = [];
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
  var missingMarkerTabs = summary.endingMissingMarkerTabs || [];
  if (missingMarkerTabs.length) other.push('ไม่พบ "จบตอน" ท้ายแท็บ: แท็บ ' + formatTabNumberList_(missingMarkerTabs));

  var engSourceTabs = (summary.englishSourceUncertainTabs || [])
    .map(function(x) { return Number(x.tabIndex || 0); })
    .filter(Boolean);
  if (engSourceTabs.length) other.push('พบต้นฉบับอังกฤษติดหัวแท็บ: แท็บ ' + formatTabNumberList_(engSourceTabs));

  var fixStats = [];
  if (Number(summary.replacedEmDashCount || 0) > 0) fixStats.push('แทน — เป็น ... ' + Number(summary.replacedEmDashCount) + ' จุด');
  if (Number(summary.titleColonFixed || 0) > 0) fixStats.push('ลบ : ในชื่อบท ' + Number(summary.titleColonFixed) + ' จุด');
  if (Number(summary.thaiDigitFixed || 0) > 0) fixStats.push('แปลงเลขไทยเป็นอารบิก ' + Number(summary.thaiDigitFixed) + ' ตัว');
  if (fixStats.length) other.push('แก้แล้ว: ' + fixStats.join(' | '));

  if (summary.untranslatedFallbackRan) {
    other.push('ตรวจไม่ครบ — สแกน untranslated ซ้ำทั้งเอกสารอัตโนมัติ');
  }

  var noteLanguage = dedupeCheckerNotes_(lang.join(' | '));
  var noteSequence = dedupeCheckerNotes_(seq.join(' | '));
  var noteOther = dedupeCheckerNotes_(other.join(' | '));

  if (doc && typeof isFreeChapterRangeDocument_ === 'function') {
    noteLanguage = addCheckerFreeMarker_(noteLanguage, isFreeChapterRangeDocument_(doc));
  }

  return { noteLanguage: noteLanguage, noteSequence: noteSequence, noteOther: noteOther };
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
    var oldRes = oldSequentialSim_(text, isHeading);
    var newRes = newCombinedSim_(text, isHeading);
    parityChecked++;
    expectEqual(
      'ข้อความสุดท้ายตรงกัน [' + text + '|' + isHeading + ']',
      newRes.text, oldRes.text
    );
    expectEqual(
      'จำนวนจุดแก้ตรงกัน [' + text + '|' + isHeading + ']',
      JSON.stringify(newRes.counts), JSON.stringify(oldRes.counts)
    );
  });
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

console.log("\n=========================");
console.log('parity cases: ' + parityChecked + ' ตัวอย่าง x 2 การตรวจ');
console.log(failed === 0 ? "✅ ผ่านทุกเคส" : "❌ ไม่ผ่าน " + failed + " เคส");
process.exitCode = failed === 0 ? 0 : 1;
