/* =========================
 * Checker_Main.gs
 * Batched tab scanning (25 tabs/call)
 * ========================= */
const CHECKER_CFG = {
  SHEET_NAME: 'รายชื่อนิยาย',
  HEADER_ROW: 1,
  START_ROW: 2,
  COL: {
    index: 1,         // A: No.
    title: 2,         // B: ชื่อเรื่อง
    episodeUrl: 3,    // C: ลิงก์ตอน / Google Docs
    sourceUrl: 4,     // D: ลิงก์ต้นฉบับเดิม
    sourceUrl2: 5,    // E: คอลัมน์ที่เพิ่มใหม่ / ลิงก์ต้นฉบับอีกช่อง
    checked: 6,       // F: Checked
    knownWords: 7,    // G: Reviewed / เช็คคำแล้ว
    posted: 8,        // H: ลงแล้ว
    noThai: 9,        // I: ไม่มีใน Thai
    draftGroup: 10,   // J: ร่างกลุ่มแล้ว
    note: 12,         // L: หมายเหตุ
    pdfUrl: 14        // N: PDF URL ล่าสุด แยกจาก M ที่ใช้เป็นสถานะตั้งค่าไฟล์
  },
  PAGE_SIZE: 200,
  PDF_FOLDER_ID: '1CHSTVNa3MArRYgCSZ2-Fxa_pL-qoNBCK',
  // V11.4: กดตรวจแล้วให้เรียงชื่อแท็บอัตโนมัติเป็น แท็บ 1, แท็บ 2, ...
  // Fix timeout: ปิดเป็นค่าเริ่มต้นชั่วคราว (Phase C ของ finalize) เพราะเรียก Docs API
  // เพิ่มเติมทุกครั้งที่ตรวจจบ ทำให้ finalize เสี่ยง timeout เกินจำเป็น - เรียงชื่อแท็บผ่านเมนู/ปุ่ม
  // แยก (resetTabNamesRow / resetTabNamesSequentialWithAlert) แทน
  RENAME_TABS_AFTER_SCAN: false,
  // V11.6: รายการคำ/อักษรต่างประเทศที่ไม่ต้องไฮไลต์ ให้อ่านจากชีตนี้ คอลัมน์ A ทีละแถว
  EXCEPTION_SHEET_NAME: 'คำยกเว้น',

  // ตรวจแท็บที่ยังเป็นภาษาอังกฤษล้วน/ยังไม่แปลเป็นไทย
  ENGLISH_UNTRANSLATED_CHECK_ENABLED: true,
  ENGLISH_UNTRANSLATED_MIN_CHARS: 300,
  ENGLISH_UNTRANSLATED_LATIN_RATIO: 0.60,
  ENGLISH_UNTRANSLATED_THAI_RATIO_MAX: 0.15,

  // ตรวจ "ประโยคภาษาอังกฤษยาว" ระดับย่อหน้า/ช่วงข้อความ (ที่ Gemini แปลไม่หมด)
  // ต่างจาก ENGLISH_UNTRANSLATED_* ตรงที่ตรวจทีละย่อหน้า จึงจับกรณี
  // อังกฤษ 1 ประโยค/1 ย่อหน้าที่ปนอยู่กับภาษาไทยได้
  LONG_ENGLISH_CHECK_ENABLED: true,
  LONG_ENGLISH_MIN_WORDS: 8,
  LONG_ENGLISH_MIN_LATIN_CHARS: 45,
  LONG_ENGLISH_MIN_SPAN_CHARS: 60
};

const CHECKER_DATA_REVISION_PROPERTY_PREFIX_ = 'CHECKER_DATA_REVISION:';
const CHECKER_DATA_REVISION_WARNING_CODE_ = 'REVISION_UNAVAILABLE';

function getCheckerDataRevisionPropertyKey_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ไม่พบ Spreadsheet ที่ผูกกับ Apps Script');
  return CHECKER_DATA_REVISION_PROPERTY_PREFIX_ + ss.getId();
}

function getCheckerDataRevision_() {
  try {
    const revision = PropertiesService.getScriptProperties()
      .getProperty(getCheckerDataRevisionPropertyKey_()) || '';
    return {
      revisionAvailable: true,
      revision: String(revision),
      warningCode: ''
    };
  } catch (err) {
    logCheckerDataRevisionWarning_('read');
    return {
      revisionAvailable: false,
      revision: null,
      warningCode: CHECKER_DATA_REVISION_WARNING_CODE_
    };
  }
}

function touchCheckerDataRevision_() {
  try {
    const properties = PropertiesService.getScriptProperties();
    const propertyKey = getCheckerDataRevisionPropertyKey_();
    const revision = String(Date.now()) + '-' + Utilities.getUuid();
    properties.setProperty(propertyKey, revision);
    return {
      revisionAvailable: true,
      revision: revision,
      warningCode: ''
    };
  } catch (err) {
    logCheckerDataRevisionWarning_('write');
    return {
      revisionAvailable: false,
      revision: null,
      warningCode: CHECKER_DATA_REVISION_WARNING_CODE_
    };
  }
}

function logCheckerDataRevisionWarning_(operation) {
  try {
    console.warn('Checker revision signal unavailable during ' + String(operation || 'operation'));
  } catch (ignored) {}
}

function getCheckerDataRevision() {
  return getCheckerDataRevision_();
}

/**
 * Fix timeout: ควบคุมขนาด chunk การตรวจทั้งเอกสาร + time budget ฝั่ง server
 * ให้เป็น config กลางจุดเดียว ห้าม hardcode เลข chunk size กระจายหลายจุด
 * - DEFAULT_CHUNK_SIZE: จำนวนแท็บต่อคำสั่ง scanWholeDocumentChunk ปกติ
 * - HEAVY_DOCUMENT_CHUNK_SIZE: เผื่อเอกสารหนักเป็นพิเศษ (ยังไม่ auto-switch ในรอบนี้ เก็บไว้ให้ client เลือกใช้ได้)
 * - SERVER_TIME_BUDGET_MS: เวลาสูงสุดที่ยอมให้ loop ตรวจแท็บใน scanWholeDocumentChunk ก่อน break ปลอดภัย
 * - FINALIZE_TIME_BUDGET_MS: เวลาสูงสุดสำหรับ call finalize (เผื่อ client อยากส่ง timeout ของตัวเองแยกกัน)
 */
const WEBAPP_SCAN_CONFIG_ = {
  DEFAULT_CHUNK_SIZE: 3,
  HEAVY_DOCUMENT_CHUNK_SIZE: 1,
  SERVER_TIME_BUDGET_MS: 240000,
  FINALIZE_TIME_BUDGET_MS: 180000,
  ENABLE_TAB_LOGGING: true
};

/**
 * เตรียมโครงสร้างสำหรับโหมดตรวจแบบเบาในอนาคต (ยังไม่เปิดใช้เป็นค่าเริ่มต้น)
 * FULL: ตรวจและจัดรูปแบบทั้งหมดเหมือนเดิม
 * VALIDATE_ONLY: ตรวจคำต่างประเทศ/เลขบท/หมายเหตุ/English source/ข้อความท้ายบท
 *   แต่ไม่จัดฟอนต์/indent/spacing ทั้งเอกสาร (ลดเวลาสำหรับ pass ตรวจเร็วในอนาคต)
 */
const CHECKER_RUN_MODE_CONFIG_ = {
  MODE: 'FULL'
};

/**
 * Performance controls
 * - ENABLED=false: ไม่สร้าง timing log ระหว่าง batch
 * - MAX_TABS_PER_RUN=0: ไม่จำกัด เพื่อคงพฤติกรรม runAllChecksAllTabs() เดิม
 *   หากต้องแบ่งงาน ให้ส่ง options.startTabIndex/options.maxTabs หรือกำหนดค่านี้
 */
const PERFORMANCE_LOG_CONFIG_ = {
  ENABLED: false,
  LOG_EACH_TAB: true,
  LOG_SLOW_STEP_MS: 1000,
  MAX_TABS_PER_RUN: 0,
  MAX_ROWS_PER_RUN: 0
};

/**
 * แยกหัวตอนของต้นฉบับที่โผล่กลางเนื้อหาออกจากเลขบทหลัก
 * เป็น report-only: ไม่ลบและไม่แก้ข้อความใน Google Docs
 */
const SOURCE_EPISODE_CONFIG_ = {
  ENABLED: true,
  HEADER_PARAGRAPH_LIMIT: 5,
  REPORT_ONLY: true,
  IGNORE_FOR_SEQUENCE_CHECK: true
};

/**
 * Web app: layout ของหัวบท/ชื่อบท
 * KEEP_EXISTING (ค่าเริ่มต้น): ไม่แก้โครงสร้าง paragraph ไม่ว่าหัวบทเดิมจะอยู่บรรทัดเดียวหรือแยกบรรทัด
 * KEEP_SAME_LINE: ถ้าแยกบรรทัดอยู่ ให้พยายามรวมกลับเป็นบรรทัดเดียว
 * SPLIT_NEXT_LINE: ถ้าอยู่บรรทัดเดียว ให้แยกชื่อบทไปบรรทัดถัดไป (พฤติกรรมเดิมก่อน V-webapp)
 * ALLOW_SPLIT_ON_EXPORT: เผื่อ export บางประเภทในอนาคตต้องการแยกชื่อบทเฉพาะตอน export
 * MUTATE_DOCUMENT_DURING_CHECK: ต้องเป็น false เสมอสำหรับ Web app - การตรวจต้อง parse ในหน่วยความจำ ไม่แก้เอกสาร
 */
const WEBAPP_CHAPTER_TITLE_CONFIG_ = {
  LAYOUT_MODE: 'KEEP_EXISTING',
  ALLOW_SPLIT_ON_EXPORT: true,
  MUTATE_DOCUMENT_DURING_CHECK: false
};

/**
 * Web app: ตรวจ/ลบต้นฉบับภาษาอังกฤษที่ติดมาก่อนหัวบทแปลภาษาไทยในแท็บเดียวกัน
 * ลบเฉพาะกรณีความมั่นใจสูง (ผ่านเงื่อนไขครบทุกข้อ) เท่านั้น กรณีไม่มั่นใจให้ report ไว้ ไม่ลบ
 */
const ENGLISH_SOURCE_CLEANUP_CONFIG_ = {
  ENABLED: true,
  AUTO_REMOVE_HIGH_CONFIDENCE: true,
  REPORT_UNCERTAIN_CASES: true,
  MIN_ENGLISH_PARAGRAPHS: 2,
  MIN_LATIN_RATIO: 0.65,
  MIN_THAI_PARAGRAPHS_AFTER_HEADING: 2,
  MAX_SCAN_PARAGRAPHS: 300,
  KEEP_ENGLISH_HEADING: false
};

/**
 * Web app: ตรวจข้อความ "ต้นฉบับไม่มีบทที่" (และข้อความใกล้เคียง) ช่วงต้นแท็บ
 * รอบนี้เป็น report-only เท่านั้น: ห้ามลบข้อความออกจาก Google Docs
 */
const SOURCE_NO_CHAPTER_NOTE_CONFIG_ = {
  ENABLED: true,
  TOP_MEANINGFUL_PARAGRAPH_LIMIT: 10,
  REMOVE_FROM_DOCUMENT: false,
  APPEND_TO_EXISTING_NOTE: true
};

/**
 * Web app: ลบข้อความโปรโมต/ปิดท้ายที่ไม่ต้องการ (เช่น "โปรดติดตามตอนต่อไป",
 * "ฝากติดตามเพจ Ipe นิยายแปล") แล้วบังคับให้ท้ายบทมี END_MARKER_TEXT เพียง 1 บรรทัดเสมอ
 * ตรวจเฉพาะ TAIL_PARAGRAPH_SCAN_LIMIT ย่อหน้าสุดท้ายของแท็บเท่านั้น ไม่แตะเนื้อเรื่องกลางบท
 */
const ENDING_CLEANUP_CONFIG_ = {
  ENABLED: true,
  TAIL_PARAGRAPH_SCAN_LIMIT: 15,
  AUTO_REMOVE_PROMO_LINES: true,
  AUTO_ENSURE_END_MARKER: true,
  END_MARKER_TEXT: 'จบตอน'
};

const CHECKER_PROBLEM_CODES_ = {
  CHAPTER_DUPLICATE: 'CHAPTER_DUPLICATE',
  CHAPTER_GAP: 'CHAPTER_GAP',
  CHAPTER_BACKWARD: 'CHAPTER_BACKWARD',
  CHAPTER_NON_CONTINUOUS: 'CHAPTER_NON_CONTINUOUS',
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  SOURCE_EPISODE_MARKER: 'SOURCE_EPISODE_MARKER',
  FOREIGN_TEXT_FOUND: 'FOREIGN_TEXT_FOUND',
  LONG_ENGLISH_FOUND: 'LONG_ENGLISH_FOUND',
  CHAPTER_HEADING_FIXED: 'CHAPTER_HEADING_FIXED',
  TAB_CHECK_ERROR: 'TAB_CHECK_ERROR'
};

var __CHECKER_DOC_CTX__ = null;
var __CHECKER_FOREIGN_ALLOW_WORDS_CACHE__ = null;

const NOTE_TEXT_ = "พบคำต่างประเทศ";
const INVIS_RE_ = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g;
const COLON_CLASS_ = "[:：﹕꞉∶։]";
// มาตรฐานหัวบทปัจจุบันคือ Sarabun 18 (ตรงกับ setFontToSarabun16() ที่ตั้ง 18 จริง)
const CHECKER_HEADING_FONT_SIZE_ = 18;
const EXTRA_ALLOWED_CHARS_V9_ = new Set(["・"]);
const FOREIGN_WORD_RE_V9_ = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0400-\u04FF\u1E00-\u1EFF\u0300-\u036F]+/g;

// ===== Watermark =====
const WM_TEXT = "ห้ามคัดลอก/เผยแพร่ By. charcoal gray silver gold maya เพจ Ipe นิยายแปล";
const WM_COLOR = "#B0B0B0";
const WM_FONT_SIZE = 9;
const WM_HEADER_ALIGN = DocumentApp.HorizontalAlignment.RIGHT;
const WM_FOOTER_ALIGN = DocumentApp.HorizontalAlignment.RIGHT;
const WM_HEADER_INSERT = "BOTTOM";
const WM_FOOTER_INSERT = "TOP";
const WM_SPACING_BEFORE = 0;
const WM_SPACING_AFTER = 0;

function onOpen(e) {
  const ui = SpreadsheetApp.getUi();

  ui.createMenu('📌 Sidebar')
    .addItem('เปิด Novel Helper', 'showNovelHelperSidebar')
    .addItem('เปิด IpeNovel Package Export', 'showIpeNovelPackageRowExportSidebar')
    .addItem('เปิด Thai-Novel Bulk TXT', 'showThaiNovelBulkTxtExportSidebar')
    .addSeparator()
    .addItem('🧹 ลบ ตอนที่ n หลัง บทที่ n', 'removeRedundantEpisodeTitleAfterChapterWithAlert')
    .addSeparator()
    .addItem('⚙️ ติดตั้งทริกเกอร์สั่งตรวจ (คอลัมน์ K)', 'installCheckerCommandTriggerWithAlert')
    .addItem('🧺 ล้างคิวสั่งตรวจ', 'resetCheckerCommandQueueWithAlert')
    .addSeparator()
    .addItem('รีเฟรชเมนู Sidebar', 'installAllSheetMenusNow')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function installAllSheetMenusNow() {
  onOpen({});

  SpreadsheetApp.getUi().alert(
    'รีเฟรชเมนู Sidebar แล้ว\n\n' +
    'ถ้ายังไม่เห็นเมนู ให้ปิด/เปิดไฟล์ Google Sheets ใหม่อีกครั้ง'
  );
}



function openCheckerWebApp() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url ? ('เปิดหน้าเว็บได้ที่\n' + url) : 'ต้อง Deploy เป็น Web App ก่อน');
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Checker Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* =========================
 * Sheet helpers
 * ========================= */
function richTextLinksToUrl() {
  const sh = SpreadsheetApp.getActiveSheet();
  const range = sh.getRange('C2:C');
  const rtv = range.getRichTextValues();
  const out = rtv.map(function(row) {
    const rt = row[0];
    const url = rt ? rt.getLinkUrl() : '';
    return [url || ''];
  });
  range.setValues(out);
}

function runAutoNumber() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const numRows = sheet.getDataRange().getNumRows();
  if (numRows < 2) {
    SpreadsheetApp.getUi().alert('❗ ไม่มีข้อมูลในชีตสำหรับสร้างเลขลำดับ');
    return;
  }

  const numbers = [];
  for (let i = 2; i <= numRows; i++) numbers.push([i - 1]);
  sheet.getRange(2, 1, numbers.length, 1).setValues(numbers);
  SpreadsheetApp.getUi().alert('✅ สร้างเลขลำดับอัตโนมัติเรียบร้อยแล้ว');
}

/* =========================
 * Context / Docs helpers
 * ========================= */
function withDocTabContext_(docId, tabId, fn) {
  const doc = openDocByIdSafe_(docId);
  return withOpenDocTabContext_(doc, tabId, fn);
}

/**
 * ใช้ document instance ที่เปิดอยู่แล้ว เพื่อลด DocumentApp.openById()
 * ใน loop หลายแท็บ โดยยังคง context/getActiveBody_() ชุดเดิม
 */
function withOpenDocTabContext_(doc, tabOrId, fn) {
  if (!doc) throw new Error('ไม่พบเอกสารปลายทาง');
  const prev = __CHECKER_DOC_CTX__;

  let targetTab = null;
  let targetTabId = typeof tabOrId === 'string' ? tabOrId : '';
  let targetTabTitle = '';

  if (doc.getTabs) {
    if (tabOrId && typeof tabOrId !== 'string') {
      targetTab = tabOrId;
    } else {
      const tabs = getAllTabsFlat_(doc);
      targetTab = targetTabId
        ? tabs.find(function(t) { return t.getId && t.getId() === targetTabId; })
        : (tabs[0] || null);
    }

    if (targetTab) {
      targetTabId = targetTab.getId ? targetTab.getId() : '';
      targetTabTitle = getTabNameSafe_(targetTab, 0);
    }
  }

  __CHECKER_DOC_CTX__ = {
    doc: doc,
    tab: targetTab,
    tabId: targetTabId,
    tabTitle: targetTabTitle
  };

  try {
    return fn(__CHECKER_DOC_CTX__);
  } finally {
    __CHECKER_DOC_CTX__ = prev;
  }
}

function startTimer_() {
  return Date.now();
}

function endTimer_(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

function performanceLoggingEnabled_() {
  return !!(PERFORMANCE_LOG_CONFIG_ && PERFORMANCE_LOG_CONFIG_.ENABLED);
}

function logSlowStep_(stepName, elapsedMs, details, forceLog) {
  if (!performanceLoggingEnabled_()) return;
  const threshold = Math.max(0, Number(PERFORMANCE_LOG_CONFIG_.LOG_SLOW_STEP_MS || 0));
  if (!forceLog && Number(elapsedMs || 0) < threshold) return;

  const suffix = details ? ' | ' + details : '';
  try { console.log('[Checker Performance] ' + stepName + ': ' + elapsedMs + ' ms' + suffix); } catch (e) {
    try { Logger.log('[Checker Performance] ' + stepName + ': ' + elapsedMs + ' ms' + suffix); } catch (_) {}
  }
}

function runTimedStep_(timings, stepName, fn) {
  const startedAt = startTimer_();
  const value = fn();
  const elapsedMs = endTimer_(startedAt);
  if (timings) timings[stepName] = elapsedMs;
  logSlowStep_(stepName, elapsedMs, getCurrentTabTitle_(), false);
  return value;
}

/**
 * Fix timeout: log ต่อแท็บระหว่าง scanWholeDocumentChunk() เพื่อหาว่าแถว/แท็บไหนช้าที่สุด
 * ห้าม log เนื้อหานิยายเต็มย่อหน้า - log แค่ sheetRow/tabIndex/tabName/elapsedMs/performanceTimings
 */
function checkerScanLoggingEnabled_() {
  return !!(WEBAPP_SCAN_CONFIG_ && WEBAPP_SCAN_CONFIG_.ENABLE_TAB_LOGGING);
}

function logCheckerScanChunkPerf_(phase, info) {
  if (!checkerScanLoggingEnabled_()) return;
  info = info || {};

  var parts = [String(phase || '')];
  if (info.sheetRow != null) parts.push('row ' + info.sheetRow);
  if (info.tabIndex != null) parts.push('tab ' + info.tabIndex);
  if (info.tabName) parts.push('(' + String(info.tabName).slice(0, 40) + ')');
  if (info.nextTabIndex != null) parts.push('next tab ' + info.nextTabIndex);
  if (info.elapsedMs != null) parts.push('elapsed ' + info.elapsedMs + ' ms');
  if (info.timeBudgetReached) parts.push('timeBudgetReached');

  var line = parts.join(' ');
  try { console.log(line); } catch (e) {
    try { Logger.log(line); } catch (_) {}
  }

  if (info.performanceTimings) {
    try { console.log('  performanceTimings: ' + JSON.stringify(info.performanceTimings)); } catch (e2) {}
  }
}

function getChapterIssueProblemCode_(issueType) {
  const type = String(issueType || '');
  if (type === 'เลขซ้ำ') return CHECKER_PROBLEM_CODES_.CHAPTER_DUPLICATE;
  if (type === 'เลขข้าม') return CHECKER_PROBLEM_CODES_.CHAPTER_GAP;
  if (type === 'เลขย้อนหลัง') return CHECKER_PROBLEM_CODES_.CHAPTER_BACKWARD;
  if (type === 'ไม่พบเลขบท') return CHECKER_PROBLEM_CODES_.CHAPTER_NOT_FOUND;
  return CHECKER_PROBLEM_CODES_.CHAPTER_NON_CONTINUOUS;
}

function buildRunReportEvents_(data) {
  data = data || {};
  const events = [];

  if (Number(data.nonThaiCount || 0) > 0) {
    events.push({
      code: CHECKER_PROBLEM_CODES_.FOREIGN_TEXT_FOUND,
      severity: 'WARNING',
      changed: false,
      count: Number(data.nonThaiCount || 0)
    });
  }

  if (Number(data.longEnglishParagraphCount || 0) > 0) {
    // เก็บเฉพาะจำนวนย่อหน้า ห้ามแนบข้อความอังกฤษดิบเข้า report event
    events.push({
      code: CHECKER_PROBLEM_CODES_.LONG_ENGLISH_FOUND,
      severity: 'WARNING',
      changed: false,
      count: Number(data.longEnglishParagraphCount || 0)
    });
  }

  const cleanup = data.chapterHeadingCleanup || {};
  (cleanup.changes || []).forEach(function(change) {
    events.push({
      code: CHECKER_PROBLEM_CODES_.CHAPTER_HEADING_FIXED,
      severity: 'FIXED',
      changed: true,
      paragraphIndex: Number(change.paragraphIndex || 0) + 1,
      before: String(change.from || ''),
      after: String(change.to || '')
    });
  });

  const sequence = data.chapterSequence || {};
  (sequence.issues || []).forEach(function(issue) {
    events.push({
      code: getChapterIssueProblemCode_(issue.type),
      severity: issue.type === 'เลขซ้ำ' ? 'ERROR' : 'WARNING',
      changed: false,
      paragraphIndex: issue.paragraphIndex || null,
      chapterNumber: issue.current == null ? null : issue.current,
      expected: issue.expected == null ? null : issue.expected,
      text: String(issue.text || '')
    });
  });

  (sequence.sourceEpisodeMarkers || []).forEach(function(marker) {
    events.push({
      code: CHECKER_PROBLEM_CODES_.SOURCE_EPISODE_MARKER,
      severity: 'WARNING',
      changed: false,
      paragraphIndex: marker.paragraphIndex,
      chapterNumber: marker.chapterNumber,
      sourceEpisodeNumber: marker.sourceEpisodeNumber,
      text: String(marker.text || '')
    });
  });

  return events;
}

function dedupeReportEvents_(events) {
  const seen = {};
  return (events || []).filter(function(event) {
    const key = [
      event.code || '',
      event.tabIndex || '',
      event.paragraphIndex || '',
      event.chapterNumber == null ? '' : event.chapterNumber,
      event.sourceEpisodeNumber || '',
      event.before || '',
      event.message || ''
    ].join('|');
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function getActiveDocSafe_() {
  if (__CHECKER_DOC_CTX__ && __CHECKER_DOC_CTX__.doc) return __CHECKER_DOC_CTX__.doc;
  return DocumentApp.getActiveDocument();
}

function getActiveTabSafe_(doc) {
  doc = doc || getActiveDocSafe_();
  if (!doc) return null;

  if (__CHECKER_DOC_CTX__ && __CHECKER_DOC_CTX__.tab) return __CHECKER_DOC_CTX__.tab;

  try {
    return doc.getActiveTab ? doc.getActiveTab() : null;
  } catch (e) {
    return null;
  }
}

function getBodyFromTabSafe_(tab, doc) {
  if (!tab) return doc ? doc.getBody() : null;

  try {
    if (typeof tab.asDocumentTab === 'function') {
      return tab.asDocumentTab().getBody();
    }
  } catch (e) {}

  try {
    if (typeof tab.getBody === 'function') return tab.getBody();
  } catch (e) {}

  return doc ? doc.getBody() : null;
}

function getHeaderFromTabSafe_(tab, doc) {
  if (!tab) {
    try { return doc && doc.getHeader ? doc.getHeader() : null; } catch (e) {}
    return null;
  }

  try {
    if (typeof tab.asDocumentTab === 'function') {
      const dt = tab.asDocumentTab();
      return dt.getHeader ? dt.getHeader() : null;
    }
  } catch (e) {}

  try {
    return tab.getHeader ? tab.getHeader() : null;
  } catch (e) {}

  return null;
}

function getFooterFromTabSafe_(tab, doc) {
  if (!tab) {
    try { return doc && doc.getFooter ? doc.getFooter() : null; } catch (e) {}
    return null;
  }

  try {
    if (typeof tab.asDocumentTab === 'function') {
      const dt = tab.asDocumentTab();
      return dt.getFooter ? dt.getFooter() : null;
    }
  } catch (e) {}

  try {
    return tab.getFooter ? tab.getFooter() : null;
  } catch (e) {}

  return null;
}

function getActiveBody_() {
  const doc = getActiveDocSafe_();
  if (!doc) throw new Error('ไม่พบเอกสารปลายทาง');

  const tab = getActiveTabSafe_(doc);
  const body = getBodyFromTabSafe_(tab, doc);
  if (!body) throw new Error('ไม่พบ body ของเอกสาร/แท็บ');

  return body;
}

function getChildCountSafe_(el) {
  try {
    return el && typeof el.getNumChildren === 'function' ? el.getNumChildren() : 0;
  } catch (e) {
    return 0;
  }
}

function getTextNodesInElement_(root) {
  const out = [];

  function walk(el) {
    if (!el) return;

    let type = null;
    try { type = el.getType ? el.getType() : null; } catch (e) {}

    if (type === DocumentApp.ElementType.TEXT) {
      out.push(el.asText());
      return;
    }

    const n = getChildCountSafe_(el);
    for (let i = 0; i < n; i++) {
      try { walk(el.getChild(i)); } catch (e) {}
    }
  }

  walk(root);
  return out;
}

function getParagraphsDeep_(root) {
  const out = [];

  function walk(el) {
    if (!el) return;

    let type = null;
    try { type = el.getType ? el.getType() : null; } catch (e) {}

    if (type === DocumentApp.ElementType.PARAGRAPH) {
      out.push(el.asParagraph());
      return;
    }

    const n = getChildCountSafe_(el);
    for (let i = 0; i < n; i++) {
      try { walk(el.getChild(i)); } catch (e) {}
    }
  }

  walk(root);
  return out;
}

function removeElementFromParentSafe_(el) {
  if (!el) return false;

  try {
    const parent = el.getParent();
    if (parent && typeof parent.removeChild === 'function') {
      parent.removeChild(el);
      return true;
    }
  } catch (e) {}

  return false;
}

function getCurrentTabTitle_() {
  const doc = getActiveDocSafe_();
  if (!doc) return 'เอกสาร';

  const tab = getActiveTabSafe_(doc);
  if (!tab) return 'เอกสาร';

  try {
    if (typeof tab.getTitle === 'function') return tab.getTitle();
    if (typeof tab.getName === 'function') return tab.getName();
  } catch (e) {}

  return 'เอกสาร';
}

function getAllTabsFlat_(doc) {
  const out = [];
  const walk = function(arr) {
    (arr || []).forEach(function(t) {
      out.push(t);
      const kids = t.getChildTabs ? t.getChildTabs() : [];
      if (kids && kids.length) walk(kids);
    });
  };
  walk(doc.getTabs ? doc.getTabs() : []);
  return out;
}

function getTabNameSafe_(t, index) {
  try {
    if (t && typeof t.getTitle === 'function') return t.getTitle();
    if (t && typeof t.getName === 'function') return t.getName();
  } catch (e) {}
  return 'แท็บ ' + (index + 1);
}

function processTabsInChunks_(tabs, chunkSize, handler) {
  const size = Math.max(1, Number(chunkSize || WEBAPP_SCAN_CONFIG_.DEFAULT_CHUNK_SIZE || 3));
  for (let i = 0; i < tabs.length; i += size) {
    const chunk = tabs.slice(i, i + size);
    chunk.forEach(function(tab, idxInChunk) {
      handler(tab, i + idxInChunk);
    });
    SpreadsheetApp.flush();
    Utilities.sleep(100);
  }
}

/* =========================
 * English-untranslated tab detection
 * ใช้ตอนกดตรวจแถวใน Sheets: อ่านทุกแท็บของ Google Docs แล้วเช็คว่าแท็บใด
 * ยังเป็นภาษาอังกฤษล้วน/ยังไม่แปลเป็นไทย เพื่อเขียนหมายเหตุลงคอลัมน์ L
 * ========================= */
function checkerGetAllDocTabsForLanguageCheck_(doc) {
  var out = [];
  if (!doc) return out;

  var tabs = (doc.getTabs && typeof getAllTabsFlat_ === 'function') ? getAllTabsFlat_(doc) : [];

  if (!tabs || !tabs.length) {
    var body = doc.getBody ? doc.getBody() : null;
    var text = body ? body.getText() : '';
    out.push({ tabNo: 1, title: 'เอกสารหลัก', text: String(text || '') });
    return out;
  }

  tabs.forEach(function(tab, idx) {
    var title = getTabNameSafe_(tab, idx);
    var body = getBodyFromTabSafe_(tab, doc);
    var text = body ? body.getText() : '';
    out.push({ tabNo: idx + 1, title: title, text: String(text || '') });
  });

  return out;
}

function checkerAnalyzeThaiEnglishRatio_(text) {
  var s = String(text || '');
  var thaiCount = (s.match(/[\u0E00-\u0E7F]/g) || []).length;
  var latinCount = (s.match(/[A-Za-z]/g) || []).length;
  var meaningfulCount = thaiCount + latinCount;

  return {
    thaiCount: thaiCount,
    latinCount: latinCount,
    meaningfulCount: meaningfulCount,
    thaiRatio: meaningfulCount > 0 ? thaiCount / meaningfulCount : 0,
    latinRatio: meaningfulCount > 0 ? latinCount / meaningfulCount : 0
  };
}

function checkerIsLikelyUntranslatedEnglishText_(text) {
  var cfg = CHECKER_CFG || {};
  var analysis = checkerAnalyzeThaiEnglishRatio_(text);

  var minChars = Number(cfg.ENGLISH_UNTRANSLATED_MIN_CHARS != null ? cfg.ENGLISH_UNTRANSLATED_MIN_CHARS : 300);
  var minLatinRatio = Number(cfg.ENGLISH_UNTRANSLATED_LATIN_RATIO != null ? cfg.ENGLISH_UNTRANSLATED_LATIN_RATIO : 0.60);
  var maxThaiRatio = Number(cfg.ENGLISH_UNTRANSLATED_THAI_RATIO_MAX != null ? cfg.ENGLISH_UNTRANSLATED_THAI_RATIO_MAX : 0.15);

  if (analysis.meaningfulCount < minChars) return false;
  if (analysis.latinRatio < minLatinRatio) return false;
  if (analysis.thaiRatio > maxThaiRatio) return false;

  return true;
}

function checkerFindUntranslatedEnglishTabsInDoc_(doc) {
  var result = [];
  if (!CHECKER_CFG || CHECKER_CFG.ENGLISH_UNTRANSLATED_CHECK_ENABLED === false) return result;

  var tabsInfo = checkerGetAllDocTabsForLanguageCheck_(doc);

  tabsInfo.forEach(function(tabInfo) {
    if (!checkerIsLikelyUntranslatedEnglishText_(tabInfo.text)) return;

    var analysis = checkerAnalyzeThaiEnglishRatio_(tabInfo.text);
    result.push({
      tabNo: tabInfo.tabNo,
      title: tabInfo.title,
      latinRatio: analysis.latinRatio,
      thaiRatio: analysis.thaiRatio
    });
  });

  return result;
}

/**
 * Fix timeout: ตรวจว่าแท็บ "ปัจจุบัน" (ที่ withDocTabContext_ เปิดอยู่แล้ว) เข้าข่ายยังไม่แปลเป็นไทยหรือไม่
 * ใช้ตอนสแกนแท็บนั้นอยู่แล้วใน scanWholeDocumentChunk() เพื่อสะสมผลไว้ใน batchTotals แทนการเปิด
 * getBody()/getText() ของทุกแท็บซ้ำอีกรอบตอน finalize (checkerFindUntranslatedEnglishTabsInDoc_
 * ยังอยู่ครบเพื่อ compatibility กับจุดอื่นที่อาจเรียกใช้ตรงๆ แต่ไม่ใช่ hot path ของ finalize อีกต่อไป)
 */
function computeUntranslatedEnglishInfoForActiveTab_() {
  if (!CHECKER_CFG || CHECKER_CFG.ENGLISH_UNTRANSLATED_CHECK_ENABLED === false) return null;

  try {
    var body = getActiveBody_();
    var text = body ? body.getText() : '';
    if (!checkerIsLikelyUntranslatedEnglishText_(text)) return null;

    var analysis = checkerAnalyzeThaiEnglishRatio_(text);
    return { latinRatio: analysis.latinRatio, thaiRatio: analysis.thaiRatio };
  } catch (e) {
    return null;
  }
}

function checkerBuildUntranslatedEnglishMessage_(untranslatedTabs) {
  if (!untranslatedTabs || !untranslatedTabs.length) return '';
  var tabNos = untranslatedTabs.map(function(t) { return t.tabNo; });
  return 'แท็บ ' + tabNos.join(', ') + ' ยังไม่แปลเป็นไทย';
}

/* =========================
 * Long English detection (V11.12)
 * ตรวจ "ประโยค/ย่อหน้าภาษาอังกฤษยาว" ที่ Gemini แปลไม่หมด
 *
 * ต่างจาก checkerIsLikelyUntranslatedEnglishText_() ตรงที่ทำงานระดับย่อหน้า
 * และระดับ contiguous English span จึงจับได้ทั้ง
 * - ย่อหน้าภาษาอังกฤษล้วน
 * - ภาษาอังกฤษต้นฉบับตามด้วยคำแปลไทยในย่อหน้าเดียวกัน
 * - ย่อหน้าอังกฤษกับย่อหน้าไทยอยู่ติดกัน
 *
 * ข้อกำหนดความเป็นส่วนตัว: ห้ามคืน/เก็บ raw English text ออกไปนอกฟังก์ชันเหล่านี้
 * ให้คืนเฉพาะ "จำนวน" เท่านั้น
 * ========================= */

/** ลบ URL และอีเมลออกก่อนพิจารณา เพื่อไม่ให้ลิงก์ถูกนับเป็นประโยคอังกฤษ */
function checkerStripLinksAndEmails_(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[A-Za-z0-9-]+\.(?:com|net|org|co|io|me|jp|kr|cn|th)\b\S*/gi, ' ');
}

/**
 * ตัดข้อความเป็น "ช่วงอักษรละตินที่ต่อเนื่องกัน"
 * อักษรไทย/จีน/ญี่ปุ่น/เกาหลี ฯลฯ ถือเป็นตัวคั่นช่วง
 */
function checkerExtractEnglishSpans_(text) {
  const cleaned = checkerStripLinksAndEmails_(text).replace(INVIS_RE_, ' ');
  // เก็บไว้เฉพาะ Basic Latin + Latin Extended + เครื่องหมายวรรคตอนที่ใช้ในภาษาอังกฤษ
  const spans = cleaned.split(/[^ -ɏ‘’“”–—…]+/);

  return spans
    .map(function(span) { return String(span || '').replace(/\s+/g, ' ').trim(); })
    .filter(Boolean);
}

/** วัดขนาดของช่วงภาษาอังกฤษหนึ่งช่วง (ไม่คืนข้อความดิบ) */
function checkerMeasureEnglishSpan_(span) {
  const s = String(span || '');
  const words = s.match(/[A-Za-z][A-Za-z'’-]*/g) || [];

  return {
    spanLength: s.trim().length,
    latinCount: (s.match(/[A-Za-z]/g) || []).length,
    wordCount: words.length
  };
}

/**
 * ช่วงนี้ยาวพอที่จะถือว่าเป็นภาษาอังกฤษที่แปลไม่หมดหรือไม่
 *
 * ตัดสินจากเกณฑ์หลักสามข้อเท่านั้น (URL/email ถูกตัดทิ้งไปก่อนแล้ว):
 * อย่างน้อย 8 English words, 45 Latin letters และ span ยาว 60 ตัวอักษร
 *
 * จงใจไม่มี heuristic เพิ่มเติม: ข้อความที่ผ่านสามเกณฑ์นี้ต้องถูกตรวจพบเสมอ
 * คำอังกฤษสั้น ชื่อสกิล และชื่อเฉพาะทั่วไปตกเกณฑ์ความยาวอยู่แล้ว
 */
function checkerIsLongEnglishSpan_(span) {
  const cfg = CHECKER_CFG || {};
  const minWords = Number(cfg.LONG_ENGLISH_MIN_WORDS != null ? cfg.LONG_ENGLISH_MIN_WORDS : 8);
  const minLatin = Number(cfg.LONG_ENGLISH_MIN_LATIN_CHARS != null ? cfg.LONG_ENGLISH_MIN_LATIN_CHARS : 45);
  const minSpan = Number(cfg.LONG_ENGLISH_MIN_SPAN_CHARS != null ? cfg.LONG_ENGLISH_MIN_SPAN_CHARS : 60);

  const measured = checkerMeasureEnglishSpan_(span);
  if (measured.wordCount < minWords) return false;
  if (measured.latinCount < minLatin) return false;
  if (measured.spanLength < minSpan) return false;

  return true;
}

/** ย่อหน้านี้มีประโยคภาษาอังกฤษยาวหรือไม่ (ไม่คืนข้อความดิบ) */
function checkerHasLongEnglishSentence_(text) {
  const cfg = CHECKER_CFG || {};
  if (cfg.LONG_ENGLISH_CHECK_ENABLED === false) return false;

  const spans = checkerExtractEnglishSpans_(text);
  for (let i = 0; i < spans.length; i++) {
    if (checkerIsLongEnglishSpan_(spans[i])) return true;
  }
  return false;
}

/**
 * นับจำนวนย่อหน้าที่มีประโยคภาษาอังกฤษยาวในแท็บที่กำลังทำงานอยู่
 * คืนเฉพาะจำนวน ไม่คืนข้อความหรือ index ของย่อหน้า
 */
function checkerScanLongEnglishParagraphsInActiveBody_() {
  const cfg = CHECKER_CFG || {};
  if (cfg.LONG_ENGLISH_CHECK_ENABLED === false) return { paragraphCount: 0 };

  let body = null;
  try {
    body = getActiveBody_();
  } catch (e) {
    return { paragraphCount: 0 };
  }
  if (!body || !body.getParagraphs) return { paragraphCount: 0 };

  const paras = body.getParagraphs();
  let paragraphCount = 0;

  for (let i = 0; i < paras.length; i++) {
    const text = cleanText_(paras[i].getText());
    if (!text || text === NOTE_TEXT_) continue;
    if (checkerHasLongEnglishSentence_(text)) paragraphCount++;
  }

  return { paragraphCount: paragraphCount };
}

/** หมายเหตุคอลัมน์ L: "พบประโยคภาษาอังกฤษยาว แท็บ 2, 5" */
function checkerBuildLongEnglishMessage_(tabNumbers) {
  const nums = (tabNumbers || [])
    .map(Number)
    .filter(function(n) { return !isNaN(n) && n > 0; })
    .sort(function(a, b) { return a - b; })
    .filter(function(n, idx, arr) { return idx === 0 || n !== arr[idx - 1]; });

  if (!nums.length) return '';
  return 'พบประโยคภาษาอังกฤษยาว แท็บ ' + nums.join(', ');
}

/* =========================
 * Tab reset helpers
 * V11.3: เรียงชื่อแท็บเป็น แท็บ 1, แท็บ 2, ... ด้วย Google Docs API updateDocumentTabProperties
 * หมายเหตุ: ต้องเปิด Advanced Google Service: Google Docs API (Identifier: Docs)
 * ========================= */
function buildSequentialTabTitle_(index) {
  return 'แท็บ ' + (index + 1);
}

function ensureDocsAdvancedService_() {
  if (typeof Docs === 'undefined' || !Docs.Documents || !Docs.Documents.batchUpdate) {
    throw new Error('ยังไม่ได้เปิด Advanced Google Service: Google Docs API\nไปที่ Apps Script > Services (+) > เลือก Google Docs API > Add โดยใช้ Identifier: Docs');
  }
}

function chunkArray_(arr, size) {
  var out = [];
  size = Math.max(1, Number(size || 50));
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function updateDocumentTabTitlesByApi_(docId, renames) {
  renames = renames || [];
  if (!renames.length) return { ok: true, requestCount: 0, batchCount: 0 };
  ensureDocsAdvancedService_();

  var requests = renames.map(function(r) {
    return {
      updateDocumentTabProperties: {
        tabProperties: {
          tabId: String(r.tabId || ''),
          title: String(r.newTitle || r.title || '').trim()
        },
        fields: 'title'
      }
    };
  }).filter(function(req) {
    var p = req.updateDocumentTabProperties.tabProperties;
    return !!p.tabId && !!p.title;
  });

  var batches = chunkArray_(requests, 50);
  batches.forEach(function(batch, idx) {
    Docs.Documents.batchUpdate({ requests: batch }, docId);
    if (idx < batches.length - 1) Utilities.sleep(250);
  });

  return { ok: true, requestCount: requests.length, batchCount: batches.length };
}

function resetTabNamesInDoc_(doc) {
  var tabs = getAllTabsFlat_(doc) || [];
  var renames = [];

  tabs.forEach(function(t, i) {
    var tabId = t && t.getId ? t.getId() : '';
    var oldTitle = getTabNameSafe_(t, i);
    var newTitle = buildSequentialTabTitle_(i);
    if (tabId && oldTitle !== newTitle) {
      renames.push({
        tabId: tabId,
        oldTitle: oldTitle,
        newTitle: newTitle,
        tabIndex: i + 1
      });
    }
  });

  var apiResult = updateDocumentTabTitlesByApi_(doc.getId(), renames);
  return { ok: true, count: tabs.length, renamedCount: renames.length, renamed: renames, apiResult: apiResult };
}

function resetTabNamesRow(sheetRow) {
  var row = getMappedRow_(Number(sheetRow));
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');
  var doc = openDocByIdSafe_(row.docId);
  return resetTabNamesInDoc_(doc);
}

function resetSequentialTabNamesRow(sheetRow) {
  return resetTabNamesRow(sheetRow);
}

function resetTabNamesAfterScanSafe_(doc) {
  var out = {
    enabled: !(CHECKER_CFG && CHECKER_CFG.RENAME_TABS_AFTER_SCAN === false),
    ok: false,
    result: null,
    error: ''
  };

  if (!out.enabled) {
    out.ok = true;
    return out;
  }

  if (!doc) {
    out.error = 'ไม่พบเอกสารสำหรับเรียงชื่อแท็บ';
    return out;
  }

  if (typeof resetTabNamesInDoc_ !== 'function') {
    out.error = 'ไม่พบฟังก์ชัน resetTabNamesInDoc_';
    return out;
  }

  try {
    out.result = resetTabNamesInDoc_(doc);
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }

  return out;
}


function sanitizeTabTitle_(title, maxLen) {
  maxLen = Math.max(20, Number(maxLen || 90));
  var s = String(title || '')
    .replace(INVIS_RE_, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[：:：\-–—\s]+$/g, '')
    .trim();

  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trim() + '…';
  return s;
}

function parseChapterTitleLineForTabName_(text) {
  var raw = String(text || '')
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!raw || raw === NOTE_TEXT_ || isStatusPanelLine_(raw)) {
    return { chapterNumber: null, title: '', kind: '' };
  }

  var s = thaiDigitsToArabic_(raw);

  // รูปแบบ [298] : ชื่อบท / [ 298 ] - ชื่อบท
  var bm = s.match(/^\[\s*([0-9]+)\s*\]\s*(?:[:：\-–—]\s*)?(.*)$/);
  if (bm) {
    return {
      chapterNumber: Number(bm[1]),
      title: sanitizeTabTitle_(bm[2] || ''),
      kind: 'bracket'
    };
  }

  // รูปแบบ บทที่ 298 ชื่อบท / ตอนที่ 298: ชื่อบท
  var m = s.match(/^(บทที่|ตอนที่)\s*([0-9]+)\s*(.*)$/i);
  if (m) {
    var rest = String(m[3] || '')
      .replace(/^\s*[:：]\s*/, '')
      .replace(/^\s*[\-–—]+\s*/, '')
      .trim();
    return {
      chapterNumber: Number(m[2]),
      title: sanitizeTabTitle_(rest),
      kind: 'thaiHeading'
    };
  }

  // รูปแบบ Chapter 298 ชื่อบท
  m = s.match(/^chapter\s*([0-9]+)\s*(.*)$/i);
  if (m) {
    var rest2 = String(m[2] || '')
      .replace(/^\s*[:：]\s*/, '')
      .replace(/^\s*[\-–—]+\s*/, '')
      .trim();
    return {
      chapterNumber: Number(m[1]),
      title: sanitizeTabTitle_(rest2),
      kind: 'chapterHeading'
    };
  }

  return { chapterNumber: null, title: '', kind: '' };
}

function deriveTabTitleFromBody_(body) {
  var paras = body ? body.getParagraphs() : [];
  var info = null;

  for (var i = 0; i < Math.min(paras.length, 120); i++) {
    var raw = cleanText_(paras[i].getText());
    if (!raw || raw === NOTE_TEXT_ || isStatusPanelLine_(raw)) continue;

    var parsed = parseChapterTitleLineForTabName_(raw);
    if (parsed.chapterNumber != null && !isNaN(parsed.chapterNumber)) {
      info = {
        chapterNumber: Number(parsed.chapterNumber),
        title: parsed.title || '',
        sourceText: raw,
        paragraphIndex: i + 1,
        kind: parsed.kind
      };

      // ถ้าเจอแค่ "บทที่ 298" ให้ดูบรรทัดถัดไปที่เป็นชื่อบทจริง
      // ใช้เฉพาะกรณีบรรทัดถัดไปเป็นหัวเรื่อง bold+underline หรือเป็น [298] : ชื่อบท
      if (!info.title) {
        for (var j = i + 1; j < Math.min(paras.length, i + 8); j++) {
          var nextRaw = cleanText_(paras[j].getText());
          if (!nextRaw || nextRaw === NOTE_TEXT_ || isStatusPanelLine_(nextRaw)) continue;
          if (isChapterLineText_(normalizeChapterLine_(nextRaw))) break;

          var nextParsed = parseChapterTitleLineForTabName_(nextRaw);
          if (nextParsed.chapterNumber != null) {
            if (Number(nextParsed.chapterNumber) === info.chapterNumber && nextParsed.title) {
              info.title = nextParsed.title;
              info.sourceText += ' / ' + nextRaw;
              break;
            }
            if (!nextParsed.title) continue;
            break;
          }

          var nextClean = sanitizeTabTitle_(stripLeadingBracketTags_(nextRaw));
          if (nextClean && typeof isBoldUnderlineParagraph_ === 'function' && isBoldUnderlineParagraph_(paras[j])) {
            info.title = nextClean;
            info.sourceText += ' / ' + nextRaw;
            break;
          }
          break;
        }
      }

      return info;
    }
  }

  return { chapterNumber: null, title: '', sourceText: '', paragraphIndex: -1, kind: '' };
}

function buildRestoredTabTitleFromInfo_(info) {
  if (!info || info.chapterNumber == null || isNaN(Number(info.chapterNumber))) return '';
  var base = 'ตอนที่ ' + Number(info.chapterNumber);
  var title = sanitizeTabTitle_(info.title || '');
  return sanitizeTabTitle_(base + (title ? ': ' + title : ''), 90);
}

function restoreTabNamesFromContentInDoc_(doc) {
  // V11.3: ผู้ใช้ต้องการคืนชื่อแท็บแบบลำดับ ไม่ใช่ตั้งตามชื่อบท
  return resetTabNamesInDoc_(doc);
}

function restoreTabNamesFromContentRow(sheetRow) {
  return resetTabNamesRow(sheetRow);
}

// aliases เผื่อปุ่มใน Index เรียกชื่อเดิม/ชื่อใหม่ต่างกัน
function restoreOriginalTabNamesRow(sheetRow) {
  return resetTabNamesRow(sheetRow);
}

function renameTabsFromContentRow(sheetRow) {
  return resetTabNamesRow(sheetRow);
}

/* =========================
 * Text / parsing helpers
 * ========================= */
function cleanText_(s) {
  return String(s || "").replace(INVIS_RE_, "").trim();
}

function normalizeChapterLine_(s) {
  return cleanText_(s).replace(/^[\s\u2013\u2014\-–—]+/, "").trim();
}

function isChapterLineText_(s) {
  return /^(?:บท(?:ที่)?|ตอนที่)\s*\[?\s*[0-9๐-๙]+/.test(s) ||
    /^chapter\s*\[?\s*[0-9๐-๙]+/i.test(s);
}

function thaiDigitsToArabic_(s) {
  return String(s || '').replace(/[๐-๙]/g, function(ch) {
    return {
      '๐':'0','๑':'1','๒':'2','๓':'3','๔':'4',
      '๕':'5','๖':'6','๗':'7','๘':'8','๙':'9'
    }[ch] || ch;
  });
}

function appendNoteParts_() {
  const parts = [];
  for (let i = 0; i < arguments.length; i++) {
    const v = String(arguments[i] || '').trim();
    if (v) parts.push(v);
  }
  return parts.join(' | ');
}

/* =========================
 * Row mapping / dashboard
 * ========================= */
function getCheckerSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ไม่พบ Spreadsheet ที่ผูกกับ Apps Script');

  const preferredNames = [
    CHECKER_CFG && CHECKER_CFG.SHEET_NAME,
    'รายชื่อนิยาย',
    'รวมนิยาย'
  ].filter(function(name, idx, arr) {
    return !!name && arr.indexOf(name) === idx;
  });

  for (var i = 0; i < preferredNames.length; i++) {
    var sh = ss.getSheetByName(preferredNames[i]);
    if (sh) return sh;
  }

  // fallback: ใช้ชีตที่เปิดอยู่ ถ้าไม่ใช่ชีตระบบ
  const helperSheets = ['AI_QUEUE', 'AI_LOG', 'คำยกเว้น'];
  const active = ss.getActiveSheet();
  if (active && helperSheets.indexOf(active.getName()) === -1) {
    return active;
  }

  // fallback สุดท้าย: หา sheet แรกที่ไม่ใช่ชีตระบบ
  const sheets = ss.getSheets();
  for (var j = 0; j < sheets.length; j++) {
    if (helperSheets.indexOf(sheets[j].getName()) === -1) return sheets[j];
  }

  throw new Error('ไม่พบชีตงานหลัก: กรุณาตั้งชื่อชีตเป็น "รายชื่อนิยาย" หรือ "รวมนิยาย"');
}

function parseGoogleDocUrl_(url) {
  const s = String(url || '').trim();
  if (!s) return { docId: '', tabId: '' };

  const m = s.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  const docId = m ? m[1] : '';

  let tabId = '';
  const q1 = s.match(/[?&#]tab=([^&#]+)/i);
  if (q1) tabId = decodeURIComponent(q1[1]);

  const q2 = s.match(/[?&#]gid=([^&#]+)/i);
  if (!tabId && q2) tabId = decodeURIComponent(q2[1]);

  const q3 = s.match(/tab([A-Za-z0-9_-]+)/i);
  if (!tabId && q3) tabId = q3[1];

  return { docId: docId, tabId: tabId };
}

function buildGoogleDocTabUrl_(docId, tabId) {
  if (!docId) return '';
  const base = 'https://docs.google.com/document/d/' + docId + '/edit';
  return tabId ? (base + '?tab=' + encodeURIComponent(tabId)) : base;
}

function isTruthyCell_(value) {
  return value === true || value === 'TRUE' || value === 'true' || value === '✓' || value === '✔' || value === '✅';
}

function getRichTextUrlSafe_(range) {
  try {
    var rt = range.getRichTextValue();
    if (!rt) return '';
    var url = rt.getLinkUrl && rt.getLinkUrl();
    if (url) return url;

    var runs = rt.getRuns ? rt.getRuns() : [];
    for (var i = 0; i < runs.length; i++) {
      var runUrl = runs[i].getLinkUrl && runs[i].getLinkUrl();
      if (runUrl) return runUrl;
    }
  } catch (e) {}
  return '';
}

function applyRichTextUrlsToRows_(sh, startRow, values) {
  values = values || [];
  if (!values.length) return values;

  var linkCols = [
    CHECKER_CFG.COL.episodeUrl,
    CHECKER_CFG.COL.sourceUrl,
    CHECKER_CFG.COL.sourceUrl2
  ].filter(function(col, idx, arr) {
    return !!col && arr.indexOf(col) === idx;
  });

  linkCols.forEach(function(col) {
    try {
      var rich = sh.getRange(startRow, col, values.length, 1).getRichTextValues();
      for (var i = 0; i < values.length; i++) {
        var rt = rich[i] && rich[i][0];
        if (!rt) continue;

        var url = '';
        try { url = rt.getLinkUrl && rt.getLinkUrl(); } catch (e) { url = ''; }

        if (!url) {
          try {
            var runs = rt.getRuns ? rt.getRuns() : [];
            for (var j = 0; j < runs.length; j++) {
              var runUrl = runs[j].getLinkUrl && runs[j].getLinkUrl();
              if (runUrl) { url = runUrl; break; }
            }
          } catch (e2) {}
        }

        if (url) values[i][col - 1] = url;
      }
    } catch (e3) {}
  });

  return values;
}

function getMappedDisplayRow_(sh, sheetRow, lastCol) {
  var range = sh.getRange(sheetRow, 1, 1, lastCol);
  var row = range.getDisplayValues()[0];

  [CHECKER_CFG.COL.episodeUrl, CHECKER_CFG.COL.sourceUrl, CHECKER_CFG.COL.sourceUrl2].forEach(function(col) {
    if (!col) return;
    var url = getRichTextUrlSafe_(sh.getRange(sheetRow, col));
    if (url) row[col - 1] = url;
  });

  return row;
}

function getMappedRow_(sheetRow) {
  const sh = getCheckerSheet_();
  const lastCol = Math.max(CHECKER_CFG.COL.note, CHECKER_CFG.COL.pdfUrl, CHECKER_CFG.COL.sourceUrl2 || 0);
  const row = getMappedDisplayRow_(sh, sheetRow, lastCol);
  return mapRow_(sheetRow, row);
}

// Resolve ด้วย docId เพื่อให้งานที่พักไว้ยังตามเอกสารเดิมได้เมื่อมีการแทรก/ย้ายแถว
function resolveMappedRowByIdentity_(sheetRow, docId) {
  var expectedDocId = String(docId || '').trim();
  var hintedRow = Number(sheetRow || 0);
  var sh = getCheckerSheet_();
  var lastRow = sh.getLastRow();

  if (hintedRow >= CHECKER_CFG.START_ROW && hintedRow <= lastRow) {
    var hinted = getMappedRow_(hintedRow);
    if (!expectedDocId || hinted.docId === expectedDocId) return hinted;
  }
  if (!expectedDocId) throw new Error('ไม่พบ docId สำหรับค้นหาแถวปัจจุบัน');

  if (lastRow < CHECKER_CFG.START_ROW) throw new Error('ไม่พบข้อมูลในชีต');

  var rowCount = lastRow - CHECKER_CFG.START_ROW + 1;
  var lastCol = Math.max(CHECKER_CFG.COL.note, CHECKER_CFG.COL.sourceUrl2 || 0);
  var values = sh.getRange(CHECKER_CFG.START_ROW, 1, rowCount, lastCol).getDisplayValues();
  applyRichTextUrlsToRows_(sh, CHECKER_CFG.START_ROW, values);

  // หา "ทุก" แถวที่ตรง DocID — ถ้าซ้ำหลายแถวต้องหยุดให้ตรวจสอบ ห้ามเลือกแถวแรกเอง
  var matches = [];
  for (var i = 0; i < values.length; i++) {
    var mapped = mapRow_(CHECKER_CFG.START_ROW + i, values[i]);
    if (mapped.docId === expectedDocId) matches.push(mapped);
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    var rowList = matches.map(function(m2) { return m2.sheetRow; }).join(', ');
    throw new Error('พบ DocID ซ้ำในหลายแถว (แถว ' + rowList + ') กรุณาตรวจสอบชีตก่อนตรวจต่อ');
  }
  throw new Error('ไม่พบเอกสารเดิมในชีต อาจถูกลบหรือเปลี่ยนลิงก์');
}

function resolveCheckerRowIdentity(payload) {
  payload = payload || {};
  return resolveMappedRowByIdentity_(payload.sheetRow, payload.docId);
}

function mapRow_(sheetRow, row) {
  const episodeUrl = row[CHECKER_CFG.COL.episodeUrl - 1] || '';
  const sourceUrl = row[CHECKER_CFG.COL.sourceUrl - 1] || '';
  const sourceUrl2 = CHECKER_CFG.COL.sourceUrl2 ? (row[CHECKER_CFG.COL.sourceUrl2 - 1] || '') : '';
  const chosenUrl = episodeUrl || sourceUrl || sourceUrl2;
  const parsed = parseGoogleDocUrl_(chosenUrl);

  return {
    sheetRow: sheetRow,
    indexText: row[CHECKER_CFG.COL.index - 1] || '',
    title: row[CHECKER_CFG.COL.title - 1] || '',
    episodeUrl: episodeUrl,
    sourceUrl: sourceUrl,
    sourceUrl2: sourceUrl2,
    checked: isTruthyCell_(row[CHECKER_CFG.COL.checked - 1]),
    knownWords: isTruthyCell_(row[CHECKER_CFG.COL.knownWords - 1]),
    posted: isTruthyCell_(row[CHECKER_CFG.COL.posted - 1]),
    noThai: isTruthyCell_(row[CHECKER_CFG.COL.noThai - 1]),
    draftGroup: isTruthyCell_(row[CHECKER_CFG.COL.draftGroup - 1]),
    note: row[CHECKER_CFG.COL.note - 1] || '',
    pdfUrl: row[CHECKER_CFG.COL.pdfUrl - 1] || '',
    docId: parsed.docId,
    tabId: parsed.tabId,
    openUrl: buildGoogleDocTabUrl_(parsed.docId, parsed.tabId) || chosenUrl,
    statusText: deriveStatusText_(row)
  };
}

function noteHasCheckerProblem_(note) {
  var s = String(note || '').trim();
  return s.indexOf('แท็บมีต่างประเทศ:') !== -1 ||
         s.indexOf('พบแท็บมีคำต่างประเทศ:') !== -1 ||
         s.indexOf('เลขบทไม่ต่อเนื่อง') !== -1 ||
         s.indexOf('เลขบทซ้ำ') !== -1 ||
         s.indexOf('พบเลขบทซ้ำ') !== -1 ||
         s.indexOf('บทที่หาย') !== -1 ||
         s.indexOf('เนื้อหาซ้ำ') !== -1 ||
         s.indexOf('แท็บไม่มีเนื้อหา') !== -1 ||
         s.indexOf('เข้าข่ายประกาศ') !== -1;
}

function deriveStatusText_(row) {
  var checked = isTruthyCell_(row[CHECKER_CFG.COL.checked - 1]);
  var knownWords = isTruthyCell_(row[CHECKER_CFG.COL.knownWords - 1]);
  var note = String(row[CHECKER_CFG.COL.note - 1] || '').trim();

  if (!checked) return 'รอตรวจ';
  if (checked && !knownWords) return 'กดตรวจแล้ว ยังไม่เช็คคำ';
  if (noteHasCheckerProblem_(note)) return 'มีปัญหา';
  return 'ปกติ';
}

function applyFilters_(rows, filters) {
  var out = rows.slice();
  var q = String(filters.q || '').trim().toLowerCase();
  var mode = String(filters.mode || 'pending');

  if (q) {
    out = out.filter(function(r) {
      return String(r.title || '').toLowerCase().indexOf(q) !== -1 ||
             String(r.note || '').toLowerCase().indexOf(q) !== -1 ||
             String(r.indexText || '').toLowerCase().indexOf(q) !== -1 ||
             String(r.sourceUrl2 || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  if (mode === 'pending') {
    out = out.filter(function(r) { return !r.checked; });
  } else if (mode === 'waitingWordCheck') {
    out = out.filter(function(r) { return r.checked && !r.knownWords; });
  } else if (mode === 'problem') {
    out = out.filter(function(r) {
      return noteHasCheckerProblem_(r.note);
    });
  }

  return out;
}

function buildStats_(rows) {
  const stats = {
    total: rows.length,
    pending: 0,
    waitingWordCheck: 0,
    problem: 0
  };

  rows.forEach(function(r) {
    if (!r.checked) stats.pending++;
    if (r.checked && !r.knownWords) stats.waitingWordCheck++;
    if (noteHasCheckerProblem_(r.note)) stats.problem++;
  });

  return stats;
}

function getDashboardData(filters) {
  filters = filters || {};
  const startedAt = Date.now();
  // จับ revision ก่อนอ่านชีต: ถ้ามี Apply เกิดกลางทาง รอบ focus ถัดไปจะยังตรวจพบค่าใหม่
  // แทนการผูก revision ใหม่เข้ากับ snapshot เก่าที่อาจอ่านไปแล้ว
  const dataRevision = getCheckerDataRevision_();
  const sh = getCheckerSheet_();
  const lastRow = sh.getLastRow();
  const sheetName = sh.getName();

  if (lastRow < CHECKER_CFG.START_ROW) {
    return {
      rows: [],
      total: 0,
      page: 1,
      pageSize: CHECKER_CFG.PAGE_SIZE,
      stats: { total: 0, pending: 0, waitingWordCheck: 0, problem: 0 },
      revision: dataRevision.revision,
      revisionAvailable: dataRevision.revisionAvailable,
      scriptUrl: ScriptApp.getService().getUrl() || '',
      debug: { sheetName: sheetName, lastRow: lastRow, rawRows: 0, mappedRows: 0, filteredRows: 0 }
    };
  }

  // Dashboard ไม่ใช้ PDF แล้ว จึงอ่านถึงคอลัมน์หมายเหตุ/ลิงก์ที่จำเป็นเท่านั้น
  const lastCol = Math.max(CHECKER_CFG.COL.note, CHECKER_CFG.COL.sourceUrl2 || 0);
  // อ่านค่าพื้นฐานรอบเดียวเพื่อ filter/status ก่อน โดยยังไม่อ่าน Rich Text ทั้งชีต
  const values = sh
    .getRange(CHECKER_CFG.START_ROW, 1, lastRow - CHECKER_CFG.START_ROW + 1, lastCol)
    .getDisplayValues();

  const rows = values
    .map(function(row, i) { return mapRow_(CHECKER_CFG.START_ROW + i, row); })
    .filter(function(r) {
      return r.title || r.episodeUrl || r.sourceUrl || r.sourceUrl2 || r.docId || r.note;
    });

  const filtered = applyFilters_(rows, filters);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.min(500, Math.max(1, Number(filters.pageSize || CHECKER_CFG.PAGE_SIZE)));
  const start = (page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  // Rich Text เป็น service call ที่หนัก จึงอ่านเฉพาะช่วงซึ่งครอบแถวของหน้าปัจจุบัน
  // แทนการอ่าน C/D/E ทุกแถวก่อน pagination เหมือนเดิม
  let responseRows = pageRows;
  let richTextRowsRead = 0;
  if (pageRows.length) {
    const firstSheetRow = Number(pageRows[0].sheetRow);
    const lastSheetRow = Number(pageRows[pageRows.length - 1].sheetRow);
    const spanStart = Math.min(firstSheetRow, lastSheetRow);
    const spanEnd = Math.max(firstSheetRow, lastSheetRow);
    const valueStartIndex = spanStart - CHECKER_CFG.START_ROW;
    const spanValues = values
      .slice(valueStartIndex, valueStartIndex + (spanEnd - spanStart + 1))
      .map(function(row) { return row.slice(); });

    applyRichTextUrlsToRows_(sh, spanStart, spanValues);
    richTextRowsRead = spanValues.length;

    const enrichedBySheetRow = {};
    spanValues.forEach(function(row, index) {
      const sheetRow = spanStart + index;
      enrichedBySheetRow[String(sheetRow)] = mapRow_(sheetRow, row);
    });
    responseRows = pageRows.map(function(row) {
      return enrichedBySheetRow[String(row.sheetRow)] || row;
    });
  }

  return {
    rows: responseRows,
    total: filtered.length,
    page: page,
    pageSize: pageSize,
    stats: buildStats_(rows),
    revision: dataRevision.revision,
    revisionAvailable: dataRevision.revisionAvailable,
    scriptUrl: ScriptApp.getService().getUrl() || '',
    debug: {
      sheetName: sheetName,
      lastRow: lastRow,
      rawRows: values.length,
      mappedRows: rows.length,
      filteredRows: filtered.length,
      richTextRowsRead: richTextRowsRead,
      elapsedMs: Date.now() - startedAt,
      mode: String(filters.mode || '')
    }
  };
}

function listDocumentTabs_(docId, selectedTabId) {
  const doc = openDocByIdSafe_(docId);
  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  return tabs.map(function(tab, idx) {
    const id = tab.getId ? tab.getId() : '';
    return {
      id: id,
      title: getTabNameSafe_(tab, idx),
      selected: !!selectedTabId && selectedTabId === id
    };
  });
}

function getRowDetail(sheetRow) {
  const row = getMappedRow_(sheetRow);
  if (!row.docId) return row;

  try {
    row.tabs = listDocumentTabs_(row.docId, row.tabId);
  } catch (e) {
    row.tabs = [];
    row.tabsError = String(e && e.message || e);
  }

  return row;
}

function updateCheckerFields(payload) {
  const sh = getCheckerSheet_();
  const row = Number(payload.sheetRow);
  if (!row || row < CHECKER_CFG.START_ROW) throw new Error('sheetRow ไม่ถูกต้อง');

  const boolFields = [
    { key: 'checked', col: CHECKER_CFG.COL.checked },
    { key: 'knownWords', col: CHECKER_CFG.COL.knownWords },
    { key: 'posted', col: CHECKER_CFG.COL.posted },
    { key: 'noThai', col: CHECKER_CFG.COL.noThai },
    { key: 'draftGroup', col: CHECKER_CFG.COL.draftGroup }
  ];
  const boolUpdates = boolFields.filter(function(item) {
    return Object.prototype.hasOwnProperty.call(payload, item.key);
  });

  if (boolUpdates.length > 1) {
    // F:J เป็นกลุ่ม checkbox ต่อเนื่อง: อ่าน/เขียนครั้งเดียวแทน setValue ทีละ cell
    const firstBoolCol = CHECKER_CFG.COL.checked;
    const width = CHECKER_CFG.COL.draftGroup - firstBoolCol + 1;
    const boolRange = sh.getRange(row, firstBoolCol, 1, width);
    const values = boolRange.getValues();
    boolUpdates.forEach(function(item) {
      values[0][item.col - firstBoolCol] = !!payload[item.key];
    });
    boolRange.setValues(values);
  } else if (boolUpdates.length === 1) {
    const item = boolUpdates[0];
    sh.getRange(row, item.col).setValue(!!payload[item.key]);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'note')) {
    sh.getRange(row, CHECKER_CFG.COL.note).setValue(payload.note || '');
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'pdfUrl')) {
    sh.getRange(row, CHECKER_CFG.COL.pdfUrl).setValue(payload.pdfUrl || '');
  }

  let updatedRow = null;
  try { updatedRow = getMappedRow_(row); } catch (e) {}
  return {
    ok: true,
    row: updatedRow
  };
}

function batchUpdateRows(items, options) {
  items = items || [];
  options = options || {};
  const startIndex = Math.max(0, Number(options.startIndex || 0));
  const configuredLimit = Number(PERFORMANCE_LOG_CONFIG_ && PERFORMANCE_LOG_CONFIG_.MAX_ROWS_PER_RUN || 0);
  const requestedLimit = Number(options.maxRows || configuredLimit || 0);
  const endIndex = requestedLimit > 0
    ? Math.min(items.length, startIndex + requestedLimit)
    : items.length;

  items.slice(startIndex, endIndex).forEach(function(item) {
    updateCheckerFields(item);
  });

  return {
    ok: true,
    count: Math.max(0, endIndex - startIndex),
    total: items.length,
    incomplete: endIndex < items.length,
    nextRowIndex: endIndex < items.length ? endIndex : null
  };
}

/* =========================
 * Paragraph helpers
 * ========================= */
function findFirstNonNoteParagraph_(body, limit) {
  limit = limit || 9999;
  const paras = body.getParagraphs();
  for (let i = 0; i < Math.min(paras.length, limit); i++) {
    const t = cleanText_(paras[i].getText());
    if (t && t !== NOTE_TEXT_) return paras[i];
  }
  return null;
}

function findChapterParagraph_(body, limit) {
  limit = limit || 120;
  const paras = body.getParagraphs();
  for (let i = 0; i < Math.min(paras.length, limit); i++) {
    const t = cleanText_(paras[i].getText());
    if (!t || t === NOTE_TEXT_) continue;
    if (isChapterLineText_(normalizeChapterLine_(t))) return paras[i];
  }
  return null;
}

function removeParaSafely_(p) {
  if (!p) return false;
  if (removeElementFromParentSafe_(p)) return true;

  try {
    const t = p.editAsText();
    const len = t.getText().length;
    if (len > 0) t.deleteText(0, len - 1);
    t.setBold(false);
    t.setUnderline(false);
    t.setForegroundColor(null);
    t.setBackgroundColor(null);
    return true;
  } catch (e) {}

  return false;
}

/* =========================
 * Foreign word / kaomoji
 * ========================= */
function isLikelyKaomojiV9_(text) {
  if (!text) return false;
  const s = String(text).trim();
  if (!s) return false;

  const wrappedFacePatterns = [
    /^[（(][^()\n]{1,20}[)）]$/,
    /^o[（(][^()\n]{1,20}[)）]o$/i,
    /^Σ[（(][^()\n]{1,25}[)）](?:っ)?$/,
    /^Φ[（(][^()\n]{1,20}[)）]Φ$/,
    /^╮[（(][^()\n]{1,25}[)）]╭$/,
    /^[ヽヾ][^ \n]{1,25}[ノﾉ]$/
  ];
  for (let i = 0; i < wrappedFacePatterns.length; i++) if (wrappedFacePatterns[i].test(s)) return true;

  const kaomojiChars = /[╥ಥＴ▽ωД><￣°ﾟ﹏ー_・；;︵^~ヽヾノﾉっゝΣΦ╮╯╰╭Oo]/;
  const faceBrackets = /[()（）<>＜＞【】]/;
  if (faceBrackets.test(s) && kaomojiChars.test(s)) return true;
  if (/[╮╯╰╭]/.test(s) && /[▽ωД﹏_ー]/.test(s)) return true;
  return false;
}

function buildKaomojiSkipMapV9_(text) {
  const s = String(text || ""), skip = new Array(s.length).fill(false);
  const patterns = [
    /[（(][^()\n]{1,20}[)）]/g,
    /o[（(][^()\n]{1,20}[)）]o/gi,
    /Σ[（(][^()\n]{1,30}[)）](?:っ)?/g,
    /Φ[（(][^()\n]{1,20}[)）]Φ/g,
    /╮[（(][^()\n]{1,30}[)）]╭/g
  ];

  for (let p = 0; p < patterns.length; p++) {
    const re = patterns[p];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (!isLikelyKaomojiV9_(m[0])) continue;
      for (let i = m.index; i < m.index + m[0].length; i++) skip[i] = true;
    }
  }
  return skip;
}
// ยกเว้นไฮไลต์ V11.6
// ไม่ใส่คำยกเว้นในโค้ดแล้ว ให้อ่านจากชีต CHECKER_CFG.EXCEPTION_SHEET_NAME หรือชีตชื่อ "คำยกเว้น"
// วิธีใช้: ใส่คำ/อักษรที่ต้องการละเว้นในคอลัมน์ A ทีละแถว เช่น 川, 大, 木
function normalizeForeignAllowWord_(word) {
  return String(word || '')
    .replace(INVIS_RE_, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resetForeignWordAllowListCache_() {
  __CHECKER_FOREIGN_ALLOW_WORDS_CACHE__ = null;
}

function getForeignWordAllowList_() {
  if (__CHECKER_FOREIGN_ALLOW_WORDS_CACHE__) {
    return __CHECKER_FOREIGN_ALLOW_WORDS_CACHE__;
  }

  var set = new Set();
  var sheetName = (CHECKER_CFG && CHECKER_CFG.EXCEPTION_SHEET_NAME) || 'คำยกเว้น';

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss ? ss.getSheetByName(sheetName) : null;
    if (!sh) {
      __CHECKER_FOREIGN_ALLOW_WORDS_CACHE__ = set;
      return set;
    }

    var lastRow = sh.getLastRow();
    if (lastRow < 1) {
      __CHECKER_FOREIGN_ALLOW_WORDS_CACHE__ = set;
      return set;
    }

    var values = sh.getRange(1, 1, lastRow, 1).getDisplayValues();
    values.forEach(function(row) {
      var v = normalizeForeignAllowWord_(row[0]);
      if (!v) return;
      if (/^#/.test(v)) return;
      set.add(v);
    });
  } catch (e) {
    // ถ้าอ่านชีตไม่ได้ ให้ทำงานต่อแบบไม่มีคำยกเว้น เพื่อไม่ให้การตรวจเอกสารล้มทั้งชุด
  }

  __CHECKER_FOREIGN_ALLOW_WORDS_CACHE__ = set;
  return set;
}

function isExplicitlyAllowedForeignWordV9_(word) {
  return getForeignWordAllowList_().has(normalizeForeignAllowWord_(word));
}

function isAllowedSpecialCharOnlyV9_(word) {
  return [...word].every(function(ch) { return EXTRA_ALLOWED_CHARS_V9_.has(ch); });
}

function getContextAroundWordV9_(text, start, end, radius) {
  const left = Math.max(0, start - radius);
  const right = Math.min(text.length, end + radius + 1);
  return text.slice(left, right);
}

function shouldSkipForeignWordV9_(word, fullText, start, end) {
  if (!word) return true;
  if (isExplicitlyAllowedForeignWordV9_(word)) return true;
  if (isAllowedSpecialCharOnlyV9_(word)) return true;

  const context = getContextAroundWordV9_(fullText, start, end, 20);
  return isLikelyKaomojiV9_(context);
}

/* =========================
 * Main checks
 * ========================= */
function runChecksCurrentTabWithAlert() {
  if (typeof resetForeignWordAllowListCache_ === 'function') resetForeignWordAllowListCache_();
  const r = runAllChecksWithBonusCleanup_();

  const lines = [
    '📄 แท็บ: ' + getCurrentTabTitle_(),
    '🔁 แทนที่ "—" เป็น "..." แล้ว ' + r.replacedEmDashCount + ' ตำแหน่ง',
    '🗑️ ลบอักษรละตินพิเศษแล้ว ' + (r.latinSpecialRemoved?.total || 0) + ' ตัว',
    r.nonThaiCount === 0 ? "✅ ไม่พบตัวอักษรต่างประเทศ" : '🔍 พบตัวอักษรต่างประเทศ ' + r.nonThaiCount + ' ตัว และไฮไลต์แล้ว',
    '↩️ แยกบรรทัด ' + (r.breakPairs?.total || 0) + ' จุด',
    '📑 จัดรูปแบบย่อหน้าแล้ว ' + r.paragraphCount + ' ย่อหน้า',
    '📏 เว้นระยะห่างแล้ว ' + r.spacingCount + ' ย่อหน้า',
    '🧹 ลบบรรทัดว่างแล้ว ' + r.blankRemoved + ' บรรทัด',
    '🗑️ ลบคำในวงเล็บแล้ว ' + r.removedCount + ' ตำแหน่ง',
    '🗑️ ลบวงเล็บ/บล็อกโปรโมตแล้ว ' + (r.removedBonusParens || 0) + ' จุด',
    '🧹 ลบบรรทัดว่างหลังลบวงเล็บแล้ว ' + (r.blankRemovedAfterBonus || 0) + ' บรรทัด',
    '🏷️ ลบวงเล็บท้ายชื่อตอนแล้ว ' + r.removedTitleParens + ' จุด',
    '',
    '🎉 แท็บนี้เสร็จแล้ว!'
  ];
  DocumentApp.getUi().alert(lines.join('\n'));
  return r;
}

function replaceEmDashWithEllipsis() {
  const body = getActiveBody_();
  const texts = getTextNodesInElement_(body);
  let emDashCount = 0;
  let wawCount = 0;

  texts.forEach(function(t) {
    let s = t.getText();
    if (!s) return;

    const em = (s.match(/—/g) || []).length;
    const waw = (s.match(/و/g) || []).length;
    if (!em && !waw) return;

    emDashCount += em;
    wawCount += waw;

    s = s.replace(/—/g, '...').replace(/و/g, 'ล');
    t.setText(s);
  });

  return { emDashCount: emDashCount, wawCount: wawCount };
}

function highlightForeignCharacters() {
  const body = getActiveBody_();
  const texts = getTextNodesInElement_(body);
  let count = 0;

  const KOREAN_RE_ = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]+/g;

  texts.forEach(function(textElement) {
    const text = textElement.getText();
    if (!text) return;

    // เดิมเขียน clear highlight ทุก text node แม้ไม่มีสีพื้นหลัง
    // ตรวจ attribute runs ก่อนเพื่อลด write calls โดยยังล้าง highlight เก่าครบ
    let hasBackground = false;
    try {
      const indices = textElement.getTextAttributeIndices();
      for (let ai = 0; ai < indices.length; ai++) {
        if (textElement.getBackgroundColor(indices[ai])) {
          hasBackground = true;
          break;
        }
      }
    } catch (e) {
      // ถ้า runtime อ่าน attribute runs ไม่ได้ ให้ fallback แบบเดิม
      hasBackground = true;
    }
    if (hasBackground) {
      try { textElement.setBackgroundColor(null); } catch (e) {}
    }

    // 1) บังคับไฮไลต์ภาษาเกาหลีก่อน
    const koreanRe = new RegExp(KOREAN_RE_.source, "g");
    let km;
    while ((km = koreanRe.exec(text)) !== null) {
      const start = km.index;
      const end = start + km[0].length - 1;
      try {
        textElement.setBackgroundColor(start, end, "#FF3333");
        count += km[0].length;
      } catch (e) {}
    }

    // 2) ตรวจภาษาต่างประเทศอื่นต่อ
    const re = new RegExp(FOREIGN_WORD_RE_V9_.source, "g");
    const kaomojiSkipMap = buildKaomojiSkipMapV9_(text);

    let match;
    while ((match = re.exec(text)) !== null) {
      const word = match[0];
      const start = match.index;
      const end = start + word.length - 1;

      // ถ้าเป็นเกาหลี ข้ามตรงนี้ไป เพราะเราไฮไลต์แล้วในขั้นแรก
      if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(word)) {
        continue;
      }

      if (kaomojiSkipMap[start] || shouldSkipForeignWordV9_(word, text, start, end)) continue;

      let allAllowed = true;
      for (let i = 0; i < word.length; i++) {
        if (!EXTRA_ALLOWED_CHARS_V9_.has(word[i])) {
          allAllowed = false;
          break;
        }
      }
      if (allAllowed) continue;

      try {
        textElement.setBackgroundColor(start, end, "#FF3333");
        count += word.length;
      } catch (e) {}
    }
  });

  const paragraphs = getParagraphsDeep_(body);
  const noteParas = [];
  for (let i = 0; i < Math.min(paragraphs.length, 20); i++) {
    if (cleanText_(paragraphs[i].getText()) === NOTE_TEXT_) noteParas.push(paragraphs[i]);
  }

  for (let i = noteParas.length - 1; i >= 0; i--) {
    removeParaSafely_(noteParas[i]);
  }

  if (count > 0) {
    body.insertParagraph(0, NOTE_TEXT_).setBold(true).setForegroundColor("#D62828");
  }

  return count;
}

function removeAllBlankLines() {
  const body = getActiveBody_();
  const paras = getParagraphsDeep_(body);
  let removed = 0;

  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i];
    const txt = cleanText_(p.getText());

    if (!txt) {
      const parent = p.getParent();
      const parentType = parent && parent.getType ? parent.getType() : null;

      if (parentType === DocumentApp.ElementType.TABLE_CELL) {
        let nonEmpty = 0;
        const siblings = parent.getNumChildren ? parent.getNumChildren() : 0;
        for (let j = 0; j < siblings; j++) {
          try {
            const ch = parent.getChild(j);
            if (ch.getType && ch.getType() === DocumentApp.ElementType.PARAGRAPH) {
              if (cleanText_(ch.asParagraph().getText())) nonEmpty++;
            }
          } catch (e) {}
        }
        if (nonEmpty === 0) continue;
      }

      if (removeParaSafely_(p)) removed++;
    }
  }

  return removed;
}

function isStatusPanelLine_(text) {
  const s = String(text || "").replace(INVIS_RE_, " ").replace(/\s+/g, " ").trim();
  return !!s && s.length <= 400 && /^【[^】]{1,380}】$/.test(s);
}

function formatParagraphIndent() {
  return formatParagraphLayout_(getActiveBody_(), {
    applyIndent: true,
    applySpacing: false,
    indent: 36,
    spacingAfter: 10
  }).indentCount;
}

function setParagraphSpacing(after) {
  after = after == null ? 10 : after;
  return formatParagraphLayout_(getActiveBody_(), {
    applyIndent: false,
    applySpacing: true,
    indent: 36,
    spacingAfter: after
  }).spacingCount;
}

/**
 * รวม paragraph layout เป็น pass เดียวสำหรับ runAllChecks()
 * ฟังก์ชัน public เดิมด้านบนยังอยู่และให้ผล count แบบเดิม
 */
function formatParagraphLayout_(body, options) {
  options = options || {};
  const paragraphs = getParagraphsDeep_(body || getActiveBody_());
  const applyIndent = options.applyIndent !== false;
  const applySpacing = options.applySpacing !== false;
  const indent = Number(options.indent == null ? 36 : options.indent);
  const after = Number(options.spacingAfter == null ? 10 : options.spacingAfter);
  let indentCount = 0;
  let spacingCount = 0;

  paragraphs.forEach(function(p) {
    const tx = (p.getText() || '').trim();
    if (!tx) return;

    const statusLine = isStatusPanelLine_(tx);
    if (applyIndent) {
      const targetFirstIndent = statusLine ? 0 : indent;
      try {
        const currentFirstIndent = typeof p.getIndentFirstLine === 'function' ? p.getIndentFirstLine() : null;
        const currentStartIndent = typeof p.getIndentStart === 'function' ? p.getIndentStart() : null;
        if (currentFirstIndent !== targetFirstIndent) p.setIndentFirstLine(targetFirstIndent);
        if (currentStartIndent !== 0) p.setIndentStart(0);
      } catch (e) {
        // Runtime เก่าบางรุ่นไม่มี getter: คง fallback behavior เดิม
        try { p.setIndentFirstLine(targetFirstIndent); p.setIndentStart(0); } catch (_) {}
      }
      indentCount++;
    }

    if (applySpacing) {
      const targetAfter = statusLine ? 0 : after;
      try {
        const currentBefore = typeof p.getSpacingBefore === 'function' ? p.getSpacingBefore() : null;
        const currentAfter = typeof p.getSpacingAfter === 'function' ? p.getSpacingAfter() : null;
        if (currentBefore !== 0) p.setSpacingBefore(0);
        if (currentAfter !== targetAfter) p.setSpacingAfter(targetAfter);
      } catch (e) {
        try { p.setSpacingBefore(0); p.setSpacingAfter(targetAfter); } catch (_) {}
      }
      spacingCount++;
    }
  });

  return {
    indentCount: indentCount,
    spacingCount: spacingCount,
    paragraphScanned: paragraphs.length
  };
}

function setFontToSarabun16() {
  const body = getActiveBody_();
  const texts = getTextNodesInElement_(body);

  texts.forEach(function(t) {
    try {
      t.setFontFamily("Sarabun");
      t.setFontSize(18);
      t.setForegroundColor("#000000");
    } catch (e) {}
  });

  const paras = getParagraphsDeep_(body);
  for (let i = 0; i < Math.min(paras.length, 5); i++) {
    if ((paras[i].getText() || "").trim() === NOTE_TEXT_) {
      try { paras[i].editAsText().setForegroundColor("#D62828"); } catch (e) {}
      try { paras[i].setBold(true); } catch (e) {}
      break;
    }
  }
  return true;
}

function clearHighlights() {
  const totalCleared = clearHighlightsInElement(getActiveBody_());
  DocumentApp.getUi().alert('🧽 ล้างสีไฮไลต์ทั้งหมดเรียบร้อยแล้ว (' + totalCleared + ' ย่อหน้า)');
}

function clearHighlightsAllTabs() {
  const doc = getActiveDocSafe_();
  if (!doc) throw new Error('ไม่พบเอกสารปลายทาง');

  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  let totalCleared = 0;
  let tabCount = 0;

  if (tabs.length) {
    tabs.forEach(function(tab, idx) {
      if (__CHECKER_DOC_CTX__) {
        __CHECKER_DOC_CTX__.tab = tab;
        __CHECKER_DOC_CTX__.tabId = tab.getId ? tab.getId() : '';
        __CHECKER_DOC_CTX__.tabTitle = getTabNameSafe_(tab, idx);
      }

      const body = getBodyFromTabSafe_(tab, doc);
      if (body) {
        totalCleared += clearHighlightsInElement(body);
        tabCount++;
      }
    });
  } else {
    totalCleared += clearHighlightsInElement(doc.getBody());
    tabCount = 1;
  }

  return { tabCount: tabCount, totalCleared: totalCleared };
}

function clearHighlightsInElement(element) {
  let count = 0;
  const type = element.getType();
  if (type === DocumentApp.ElementType.TEXT) {
    element.asText().setBackgroundColor(null);
    count++;
  } else if (element.getNumChildren) {
    const n = element.getNumChildren();
    for (let i = 0; i < n; i++) count += clearHighlightsInElement(element.getChild(i));
  }
  return count;
}

/* =========================
 * Chapter / title helpers
 * ========================= */
function removeEnglishInParentheses(showAlert) {
  showAlert = showAlert !== false;
  const body = getActiveBody_();
  const texts = getTextNodesInElement_(body);
  let count = 0;

  const isWs = function(ch) { return /[\s\u00A0\u200B-\u200F\u2060\uFEFF]/.test(ch); };
  const hasThai = function(s) { return /[\u0E00-\u0E7F]/.test(s); };
  const hasLatin = function(s) { return /[A-Za-z]/.test(s); };

  const whitelist = [
    /^Lv\.\d+$/i, /^KO$/i, /^K\.O\.?$/i, /^OK$/i, /^NG$/i, /^VIP$/i, /^SP$/i, /^SSR$/i
  ];

  const isWhitelisted = function(s) {
    const v = String(s || "").trim();
    if (!v) return false;
    return whitelist.some(function(re) { return re.test(v); });
  };

  const cleanupInner = function(s) {
    let out = String(s || "");
    out = out.replace(/[A-Za-z]+(?:'[A-Za-z]+)*/g, "");
    out = out.replace(/^[\s<>\-–—:|\/,·•∙⋅・･]+/, "");
    out = out.replace(/[\s<>\-–—:|\/,·•∙⋅・･]+$/, "");
    out = out.replace(/\s+/g, " ").trim();
    return out;
  };

  const processRange = function(textEl, full, start, end, openChar, closeChar) {
    const inner = full.substring(start + 1, end).trim();

    if (!hasLatin(inner)) return 0;
    if (isWhitelisted(inner)) return 0;

    const cleaned = cleanupInner(inner);

    if (!cleaned || !hasThai(cleaned)) {
      let delStart = start;
      let delEnd = end;

      if (delStart > 0 && isWs(full.charAt(delStart - 1))) delStart--;
      else if (delEnd + 1 < full.length && isWs(full.charAt(delEnd + 1))) delEnd++;

      textEl.deleteText(delStart, delEnd);
      return 1;
    }

    textEl.deleteText(start, end);
    textEl.insertText(start, openChar + cleaned + closeChar);
    return 1;
  };

  texts.forEach(function(t) {
    const s = t.getText();
    if (!s) return;

    const ranges = [];
    const re = /(\([^()\n]*\)|（[^（）\n]*）)/g;
    let m;

    while ((m = re.exec(s)) !== null) {
      ranges.push({
        start: m.index,
        end: m.index + m[0].length - 1,
        open: m[0].charAt(0),
        close: m[0].charAt(m[0].length - 1)
      });
    }

    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i];
      count += processRange(t, s, r.start, r.end, r.open, r.close);
    }
  });

  if (showAlert) {
    DocumentApp.getUi().alert('❌ จัดการวงเล็บที่มีภาษาอังกฤษแล้ว ' + count + ' ตำแหน่ง');
  }
  return count;
}

/**
 * V11.10: ลบวงเล็บ/บล็อกโปรโมตที่ไม่ใช่เนื้อเรื่อง
 * ตัวอย่างที่ลบทั้งบล็อก:
 * (อัปเดตครั้งที่ 6 โบนัส 280 โหวตรายเดือน)
 * (อัปเดตครั้งที่)
 * (ตอนโบนัส)
 * (โหวตรายเดือน)
 * (ขอบคุณผู้สนับสนุน)
 * (ผู้แต่ง)
 * 【เขียนถึงตรงนี้ หวังว่าผู้อ่านจะจดจำโดเมนของเรา เว็บไซต์นิยายไต้หวัน ไว้สำหรับอ่านคลายเครียดนะ ใช้งานลื่นไหลสุด ๆ】
 * 【เว็บไซต์นิยายไต้หวัน】
 */
function removeBonusVoteParentheses(showAlert) {
  showAlert = showAlert !== false;

  const body = getActiveBody_();
  const texts = getTextNodesInElement_(body);
  let count = 0;

  const isWs = function(ch) {
    return /[\s\u00A0\u200B-\u200F\u2060\uFEFF]/.test(ch);
  };

  const normalizeInner = function(s) {
    return String(s || '')
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const shouldRemove = function(inner) {
    const s = normalizeInner(inner);
    if (!s) return false;

    // ลบเฉพาะกลุ่มที่เป็นโน้ตระบบ/โปรโมต ไม่ลบวงเล็บทั่วไป
    return /(อัปเดต\s*ครั้ง\s*ที่|อัพเดต\s*ครั้ง\s*ที่|ตอน\s*โบนัส|โหวต\s*ราย\s*เดือน|ขอบคุณ\s*ผู้\s*สนับสนุน|ผู้\s*แต่ง|เขียน\s*ถึง\s*ตรง\s*นี้|จด\s*จำ\s*โดเมน\s*ของ\s*เรา|เว็บไซต์\s*นิยาย\s*ไต้หวัน|เว็บ\s*ไซต์\s*นิยาย\s*ไต้หวัน)/u.test(s);
  };

  texts.forEach(function(t) {
    const s = t.getText();
    if (!s) return;

    const ranges = [];

    // รองรับ (...) / （...） / 【...】
    const re = /(\([^()\n]{1,500}\)|（[^（）\n]{1,500}）|【[^】\n]{1,700}】)/g;
    let m;

    while ((m = re.exec(s)) !== null) {
      const fullMatch = m[0];
      const inner = fullMatch.substring(1, fullMatch.length - 1);

      if (!shouldRemove(inner)) continue;

      ranges.push({
        start: m.index,
        end: m.index + fullMatch.length - 1
      });
    }

    // ลบจากท้ายไปหน้า เพื่อไม่ให้ index เพี้ยน
    for (let i = ranges.length - 1; i >= 0; i--) {
      let delStart = ranges[i].start;
      let delEnd = ranges[i].end;

      // เก็บกวาดช่องว่างหน้า/หลังบล็อก ไม่ให้เหลือเว้นวรรคซ้อน
      const before = delStart > 0 ? s.charAt(delStart - 1) : '';
      const after = delEnd + 1 < s.length ? s.charAt(delEnd + 1) : '';

      if (isWs(before) && isWs(after)) {
        delStart--;
      } else if (isWs(before)) {
        delStart--;
      } else if (isWs(after)) {
        delEnd++;
      }

      try {
        t.deleteText(delStart, delEnd);
        count++;
      } catch (e) {}
    }
  });

  if (showAlert) {
    DocumentApp.getUi().alert('🗑️ ลบวงเล็บ/บล็อกโปรโมตแล้ว ' + count + ' ตำแหน่ง');
  }

  return count;
}




/**
 * V11.10: จุดเรียกตรวจกลางแบบสมบูรณ์
 * - เรียก runAllChecks() เดิม
 * - ลบวงเล็บโบนัส/โหวตรายเดือน/ผู้สนับสนุน/ผู้แต่ง/บล็อกโปรโมตเว็บ 1 ครั้งเท่านั้น
 * - ลบบรรทัดว่างซ้ำหลังลบวงเล็บ/บล็อก เผื่อทั้งย่อหน้ามีแต่ข้อความที่ถูกลบ
 * ใช้ฟังก์ชันนี้แทนการเรียก runAllChecks() โดยตรงใน Checker_Main
 */
function runAllChecksWithBonusCleanup_() {
  if (typeof runAllChecks !== 'function') {
    throw new Error('ไม่พบฟังก์ชัน runAllChecks: กรุณาตรวจว่าไฟล์หลักที่มี runAllChecks ถูกวางในโปรเจกต์ Apps Script แล้ว');
  }

  const startedAt = startTimer_();
  const result = runAllChecks() || {};
  const cleanupStartedAt = startTimer_();
  const finalResult = applyBonusVoteCleanupToRunResult_(result);
  finalResult.performanceTimings = finalResult.performanceTimings || {};
  finalResult.performanceTimings.bonusCleanup = endTimer_(cleanupStartedAt);
  finalResult.performanceTimings.totalWithBonusCleanup = endTimer_(startedAt);
  logSlowStep_(
    'total per tab with bonus cleanup',
    finalResult.performanceTimings.totalWithBonusCleanup,
    getCurrentTabTitle_(),
    false
  );
  return finalResult;
}

function applyBonusVoteCleanupToRunResult_(result) {
  result = result || {};

  const removedBonusParens = (typeof removeBonusVoteParentheses === 'function')
    ? Number(removeBonusVoteParentheses(false) || 0)
    : 0;

  let blankRemovedAfterBonus = 0;
  if (removedBonusParens > 0 && typeof removeAllBlankLines === 'function') {
    blankRemovedAfterBonus = Number(removeAllBlankLines() || 0);
  }

  result.removedBonusParens = Number(result.removedBonusParens || 0) + removedBonusParens;
  result.removedCount = Number(result.removedCount || 0) + removedBonusParens;
  result.blankRemovedAfterBonus = Number(result.blankRemovedAfterBonus || 0) + blankRemovedAfterBonus;
  result.blankRemoved = Number(result.blankRemoved || 0) + blankRemovedAfterBonus;

  return result;
}

function removeBonusVoteParenthesesWithAlert() {
  const removedBonusParens = removeBonusVoteParentheses(false);
  const blankRemovedAfterBonus = removedBonusParens > 0 && typeof removeAllBlankLines === 'function'
    ? removeAllBlankLines()
    : 0;

  DocumentApp.getUi().alert([
    '🗑️ ลบวงเล็บ/บล็อกโปรโมตแล้ว ' + removedBonusParens + ' ตำแหน่ง',
    '🧹 ลบบรรทัดว่างหลังลบวงเล็บแล้ว ' + blankRemovedAfterBonus + ' บรรทัด'
  ].join('\n'));

  return {
    removedBonusParens: removedBonusParens,
    blankRemovedAfterBonus: blankRemovedAfterBonus
  };
}

function removeParenthesesInChapterTitle() {
  const body = getActiveBody_(), paras = body.getParagraphs();
  let count = 0;

  for (let i = 0; i < Math.min(paras.length, 50); i++) {
    const p = paras[i], text = (p.getText() || "").trim();
    if (!text || text === NOTE_TEXT_) continue;

    const normalized = normalizeChapterLine_(text);
    const isChapter = isChapterLineText_(normalized);
    if (!isChapter) continue;

    const matches = text.match(/\s*\([^)]+\)/g);
    if (matches) {
      matches.forEach(function(m) {
        const isException = /\((จบ|ตอนที่\s*[0-9๐-๙]+(\s*จบ)?)\)/.test(m.trim());
        if (!isException) {
          p.replaceText(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "");
          count++;
        }
      });
      const clean = p.getText().trim();
      if (clean !== p.getText()) p.setText(clean);
    }
    break;
  }
  return count;
}

function fixChapterTitlePrefix() {
  const body = getActiveBody_(), target = findFirstNonNoteParagraph_(body);
  if (!target) return false;

  const oldText = target.getText(), newText = oldText.replace(/^(\s*)ตอนที่(\s*\d+)/, "$1บทที่$2");
  if (newText === oldText) return false;

  const te = target.editAsText(), len = te.getText().length;
  if (len > 0) te.deleteText(0, len - 1);
  te.insertText(0, newText);
  return true;
}

function escapeRegExp_(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 🔢 ตัวช่วยกลาง: ลบ "เลขบทย่อยจากต้นฉบับ" (source subchapter token) ที่ตกค้างหลังเลขบท
 *
 * ทุก chapter normalization flow ต้องเรียกฟังก์ชันนี้ตัวเดียวกัน เพื่อไม่ให้แต่ละฟังก์ชัน
 * ให้ผลต่างกัน และผลลัพธ์ต้อง idempotent (เรียกซ้ำแล้วข้อความไม่เปลี่ยนเพิ่ม)
 *
 * กฎที่ใช้ได้ มีเพียง 3 แบบ:
 *
 * 1) เลขเปล่า/ในวงเล็บ ที่เป็น zero-padded "3 หลักพอดี" ช่วง 001–099
 *    - บทที่ 584 093 ชื่อบท   -> บทที่ 584 ชื่อบท
 *    - บทที่ 584 [093] ชื่อบท -> บทที่ 584 ชื่อบท
 *    - บทที่ 584 007 ชื่อบท   -> บทที่ 584 ชื่อบท
 *
 * 2) เลขที่มี label ตอน/EP ชัดเจน (เลขใดก็ได้)
 *    - ตอนที่ 093 / EP 093 / EP.093 / Episode 093
 *
 * 3) เลขซ้ำกับเลขบทหลัก จะมี label หรือไม่มีก็ได้ (duplicate chapter marker เดิม)
 *    - บทที่ 584 584 ชื่อบท   -> บทที่ 584 ชื่อบท
 *    - บทที่ 584 บทที่ 584 ชื่อบท / Chapter 584
 *
 * ห้ามลบ (เลขที่เป็นส่วนหนึ่งของชื่อบทจริง):
 * - บทที่ 12 0900 นาฬิกา            (4 หลัก ไม่ใช่ 3)
 * - บทที่ 5 08 มกราคม ...           (2 หลัก)
 * - บทที่ 584 00 ชั่วโมงแห่งความตาย  (2 หลัก)
 * - บทที่ 584 100 ล้านเบรี / 3 ปีต่อมา / 2026 จุดเริ่มต้น  (ไม่มี leading zero)
 * - บทที่ 584 0.5 วินาที            (ทศนิยม)
 * - บทที่ 584 ห้องหมายเลข 7          (เลขไม่ได้อยู่ต้นชื่อบท)
 * - เลขช่วง (584-585, 093-094) และเลขทศนิยม
 * - label กำกวมที่ไม่มี "ที่": ตอน 3 ปีต่อมา / ตอน 2 ของความทรงจำ / บท 3 ของชีวิต
 *
 * จงใจไม่ใช้ regex กวาดตัวเลขหลังเลขบททั้งหมด และ token ต้องเป็น token แยกสมบูรณ์
 * ห้ามจับเพียงบางส่วนของเลขที่ยาวกว่า
 */
function stripSecondarySourceEpisodeToken_(rest, chapterNumber) {
  var out = String(rest == null ? '' : rest)
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return '';

  var rawNumber = String(chapterNumber == null ? '' : chapterNumber).trim();
  var thaiNumber = rawNumber.replace(/[0-9]/g, function(ch) {
    return '๐๑๒๓๔๕๖๗๘๙'.charAt(Number(ch));
  });
  // ถ้าไม่รู้เลขบท ให้ปิดกฎ "เลขซ้ำ" ด้วย pattern ที่จับคู่ไม่ได้เลย
  var numberAlt = rawNumber
    ? '(?:' + escapeRegExp_(rawNumber) + '|' + escapeRegExp_(thaiNumber) + ')'
    : '(?!)';

  var DIGIT = '[0-9๐-๙]';
  var ZERO = '[0๐]';
  var NONZERO = '[1-9๑-๙]';
  // zero-padded 3 หลักพอดี ช่วง 001–099 (รองรับเลขไทย) — ตัด 000 ออก
  var SOURCE_SUBCHAPTER = ZERO + '(?:' + ZERO + NONZERO + '|' + NONZERO + DIGIT + ')';
  var RANGE = '(?:[-–—]|\\.{2,})';
  var SEP = '(?:' + COLON_CLASS_ + '|[-–—]|\\.{2,})';
  // เลขเดี่ยว/ทศนิยม/ช่วง เช่น 093, 318.5, 584-585 (ใช้กับ label rule เท่านั้น)
  var NUM = DIGIT + '+(?:\\.' + DIGIT + '+)?' +
    '(?:\\s*' + RANGE + '\\s*' + DIGIT + '+(?:\\.' + DIGIT + '+)?)?';
  // ปิดท้าย token ของรูปแบบที่มี label กำกับ
  var TAIL = '(?![0-9๐-๙.])\\s*(?:' + SEP + '\\s*)?';
  // ปิดท้าย token ของ "เลขเปล่า": ต้องเป็น token สมบูรณ์
  // ห้ามเป็นครึ่งหนึ่งของเลขที่ยาวกว่า ของเลขทศนิยม หรือของช่วงบท
  var BARE_TAIL = '(?![0-9๐-๙.])(?!\\s*' + RANGE + '\\s*' + DIGIT + ')\\s*(?:' + SEP + '\\s*)?';
  var OPEN = '(?:[\\[\\(【（]\\s*)';
  var CLOSE = '(?:\\s*[\\]\\)】）])';
  // label ที่ไม่กำกวมเท่านั้น: "ตอน"/"บท" เปล่า ๆ เป็นคำปกติในชื่อบทไทย จึงไม่นับ
  var EPISODE_LABEL = '(?:ตอนที่|episodes?|eps?(?![A-Za-z]))\\s*(?:\\.\\s*)?';
  // label ของ "เลขบทซ้ำ" ต้องคู่กับเลขบทหลักเท่านั้น
  var CHAPTER_LABEL = '(?:บทที่|บท|ตอนที่|chapters?(?![A-Za-z]))\\s*(?:\\.\\s*)?';

  var rules = [
    // 1) label ตอน/EP ชัดเจน + เลขใดก็ได้: "ตอนที่ 093", "EP 093", "EP.093", "Episode 093"
    new RegExp(
      '^\\s*(?:' + SEP + '\\s*)?' + EPISODE_LABEL +
      OPEN + '?' + NUM + CLOSE + '?' + TAIL,
      'i'
    ),
    // 2) duplicate chapter marker: label + เลขที่ตรงกับเลขบทหลักเท่านั้น
    new RegExp(
      '^\\s*(?:' + SEP + '\\s*)?' + CHAPTER_LABEL +
      OPEN + '?' + numberAlt + CLOSE + '?' + TAIL,
      'i'
    ),
    // 3) เลขเปล่า/ในวงเล็บ ที่ซ้ำกับเลขบทหลัก: "บทที่ 584 584 ชื่อบท"
    new RegExp(
      '^\\s*(?:' + SEP + '\\s*)?' + OPEN + '?' + numberAlt + CLOSE + '?' + BARE_TAIL,
      'i'
    ),
    // 4) เลขบทย่อยจากต้นฉบับ: zero-padded 3 หลักพอดี 001–099 เปล่า ๆ หรือในวงเล็บ
    new RegExp(
      '^\\s*(?:' + SEP + '\\s*)?' + OPEN + '?' + SOURCE_SUBCHAPTER + CLOSE + '?' + BARE_TAIL,
      'i'
    )
  ];

  function tidy_(value) {
    return String(value || '')
      .replace(new RegExp('^\\s*(?:' + SEP + ')\\s*'), '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ลบทีละ token และหยุดทันทีที่ไม่มีอะไรถูกลบ (กัน loop ไม่รู้จบ)
  for (var pass = 0; pass < 4 && out; pass++) {
    var before = out;
    for (var i = 0; i < rules.length; i++) {
      var candidate = out.replace(rules[i], '');
      if (candidate !== out) {
        out = tidy_(candidate);
        break;
      }
    }
    if (out === before) break;
  }

  return tidy_(out);
}

/**
 * คงชื่อเดิมไว้ให้ caller เก่า แต่ให้ใช้ helper กลางตัวเดียวกัน
 * เพื่อไม่ให้ logic แตกออกเป็นสองชุด
 */
function stripDuplicateChapterMarkerAfterNumber_(rest, chapterNumber) {
  return stripSecondarySourceEpisodeToken_(rest, chapterNumber);
}

function normalizeChapterTitleFirstLine() {
  const body = getActiveBody_(), target = findFirstNonNoteParagraph_(body);
  if (!target) return false;

  const oldRaw = target.getText();
  const line = normalizeChapterLine_(oldRaw);
  const numberPattern = '[0-9๐-๙]+(?:(?:[-–—]|\\.{2,})[0-9๐-๙]+)?';
  let m = line.match(new RegExp('^(บท(?:ที่)?|ตอนที่)\\s*(' + numberPattern + ')\\s*(.*)$', 'i'));
  let num = '';
  let rest = '';

  if (m) {
    num = thaiDigitsToArabic_(m[2]).replace(/\.{2,}/g, '-');
    rest = m[3] || '';
  } else {
    m = line.match(new RegExp('^chapter\\s*(' + numberPattern + ')\\s*(.*)$', 'i'));
    if (!m) return false;
    num = thaiDigitsToArabic_(m[1]).replace(/\.{2,}/g, '-');
    rest = m[2] || '';
  }

  rest = String(rest || '')
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .replace(new RegExp('^\\s*' + COLON_CLASS_ + '\\s*'), '')
    .replace(/^\s*[\u2013\u2014\-–—]+\s*/, '')
    .trim();
  rest = stripDuplicateChapterMarkerAfterNumber_(rest, num);

  const newText = stripColonAfterChapterNumber_('บทที่ ' + num + (rest ? ' ' + rest : ''));
  if (newText === cleanText_(oldRaw)) return false;

  const te = target.editAsText(), len = te.getText().length;
  if (len > 0) te.deleteText(0, len - 1);
  te.insertText(0, newText);
  try {
    te.setBold(true);
    te.setUnderline(true);
    te.setFontFamily('Sarabun');
    te.setFontSize(18);
    te.setForegroundColor('#000000');
  } catch (e) {}
  return true;
}

function replaceThaiDigitsWithArabic() {
  const body = getActiveBody_(), original = body.getText();
  const map = { "๐": "0", "๑": "1", "๒": "2", "๓": "3", "๔": "4", "๕": "5", "๖": "6", "๗": "7", "๘": "8", "๙": "9" };
  let count = 0;

  for (const th in map) {
    const m = original.match(new RegExp(th, "g"));
    if (m) count += m.length;
    body.replaceText(th, map[th]);
  }
  return count;
}

function cleanupIntroAndFormatChapterLineSafe() {
  const body = getActiveBody_(), paras0 = body.getParagraphs();
  const shouldRemoveIntroLine = line =>
    /^(นี่คือการแปล|นี่คือคำแปล|บทนี้เป็นการแปล|แปลไทยเท่านั้น|แปลโดย|ผู้แปล|เครดิต|หมายเหตุ|คำเตือน|ประกาศ|รับทราบครับ|คิดว่าครับ|Gemini said|Gemini บอกว่า|จัดให้)/.test(line);

  let chapterIdx = -1;
  for (let i = 0; i < Math.min(paras0.length, 50); i++) {
    const t = cleanText_(paras0[i].getText());
    if (!t || t === NOTE_TEXT_) continue;
    if (isChapterLineText_(normalizeChapterLine_(t))) { chapterIdx = i; break; }
  }
  if (chapterIdx === -1) return false;

  const toRemove = [];
  for (let i = 0; i < chapterIdx; i++) {
    const t = cleanText_(paras0[i].getText());
    if (t && t !== NOTE_TEXT_ && shouldRemoveIntroLine(t)) toRemove.push(paras0[i]);
  }
  for (let i = toRemove.length - 1; i >= 0; i--) removeParaSafely_(toRemove[i]);

  const paras = body.getParagraphs();
  for (let i = 0; i < Math.min(paras.length, 50); i++) {
    let line = cleanText_(paras[i].getText());
    if (!line || line === NOTE_TEXT_) continue;
    line = normalizeChapterLine_(line);
    if (!isChapterLineText_(line)) continue;

    let num = "", rest = "", m = line.match(/^(บทที่|ตอนที่)\s*([0-9๐-๙]+)\s*(.*)$/);
    if (m) { num = m[2]; rest = m[3] || ""; }
    else {
      m = line.match(/^chapter\s*([0-9]+)\s*(.*)$/i);
      if (!m) return true;
      num = m[1]; rest = m[2] || "";
    }

    rest = rest.replace(/^\s*[:：]\s*/, "").replace(/^\s*[\u2013\u2014\-–—]+\s*/, "").trim();
    // ใช้ helper กลางตัวเดียวกับ normalizeChapterTitleFirstLine()
    // เพื่อไม่ให้เลขตอนต้นฉบับตกค้างกลับมาหลังเลขบทอีกรอบ
    rest = stripSecondarySourceEpisodeToken_(rest, thaiDigitsToArabic_(num));
    const te = paras[i].editAsText(), len = te.getText().length;
    if (len > 0) te.deleteText(0, len - 1);
    te.insertText(0, stripColonAfterChapterNumber_(`บทที่ ${num}${rest ? " " + rest : ""}`));
    te.setBold(true); te.setUnderline(true);
    return true;
  }
  return true;
}

/** 📋 แยก “【...】【...】” */
function splitBracketedStatusBlocks_() {
  const body = getActiveBody_(), paras = body.getParagraphs();
  const joinRe = /】[\s\u00A0\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060]*【/g, blockRe = /【[^】]{1,380}】/g;
  let paragraphsTouched = 0, newParagraphs = 0, blocks = 0;

  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i], raw = p.getText(), trimmed = String(raw || "").replace(INVIS_RE_, " ").replace(/\s+/g, " ").trim();
    if (!trimmed || trimmed === NOTE_TEXT_) continue;

    const matches = raw.match(blockRe);
    if (!matches || matches.length <= 1 || raw.length > 1600) continue;
    if (!matches.some(x => x.indexOf(":") >= 0 || x.indexOf("：") >= 0)) continue;

    const parts = raw.replace(joinRe, "】\n【").split("\n").map(s => String(s || "").replace(INVIS_RE_, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (parts.length <= 1) continue;

    const attrs = p.getAttributes ? p.getAttributes() : {};
    p.setText(parts[0]);
    try { p.setAttributes(attrs); p.setIndentFirstLine(0).setIndentStart(0); p.setSpacingBefore(0).setSpacingAfter(0); } catch (e) {}

    for (let k = parts.length - 1; k >= 1; k--) {
      const np = body.insertParagraph(i + 1, parts[k]);
      try { np.setAttributes(attrs); np.setIndentFirstLine(0).setIndentStart(0); np.setSpacingBefore(0).setSpacingAfter(0); } catch (e2) {}
      newParagraphs++;
    }
    paragraphsTouched++; blocks += parts.length;
  }
  return { paragraphsTouched, newParagraphs, blocks };
}

/** ↩️ แยกบรรทัดเมื่อเจออัญประกาศติดกัน */
function breakAdjacentQuoteAndBracketPairs() {
  const body = getActiveBody_(), paras = body.getParagraphs();
  const GAP_CHARS = "[\\s\\u00A0\\u200B\\u200C\\u200D\\u200E\\u200F\\uFEFF\\u2060]*";
  let quotePairs = 0, bracketPairs = 0;

  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i], raw = p.getText(), trimmed = String(raw || "").replace(INVIS_RE_, "").trim();
    if (!trimmed || trimmed === NOTE_TEXT_) continue;

    const qRe = new RegExp('(?:\"' + GAP_CHARS + '\"|”' + GAP_CHARS + '“|’' + GAP_CHARS + '‘)', "g");
    const bRe = new RegExp("\\]" + GAP_CHARS + "\\[", "g");
    const qMatches = raw.match(qRe) || [], bMatches = raw.match(bRe) || [];
    if (qMatches.length === 0 && bMatches.length === 0) continue;

    const parts = raw
      .replace(new RegExp('\"' + GAP_CHARS + '\"', "g"), '"\n"')
      .replace(new RegExp('”' + GAP_CHARS + '“', "g"), "”\n“")
      .replace(new RegExp('’' + GAP_CHARS + '‘', "g"), "’\n‘")
      .replace(new RegExp("\\]" + GAP_CHARS + "\\[", "g"), "]\n[")
      .split("\n")
      .map(s => s.replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, ""))
      .filter(Boolean);

    if (parts.length <= 1) continue;

    quotePairs += qMatches.length;
    bracketPairs += bMatches.length;

    const pAttrs = p.getAttributes(), te = p.editAsText(), len = te.getText().length;
    if (len > 0) te.deleteText(0, len - 1);
    te.insertText(0, parts[0]);

    for (let k = parts.length - 1; k >= 1; k--) body.insertParagraph(i + 1, parts[k]).setAttributes(pAttrs);
  }
  return { quotePairs, bracketPairs, total: quotePairs + bracketPairs };
}

/** 🗑️ ลบละตินพิเศษ + combining marks */
function removeLatinBasedSpecialCharacters() {
  const body = getActiveBody_();
  let preCount = 0, markCount = 0;
  const isCombiningMark = code => code >= 0x0300 && code <= 0x036F;
  const isLatinSpecial = code =>
    (code >= 0x00C0 && code <= 0x00FF) ||
    (code >= 0x0100 && code <= 0x02AF) ||
    (code >= 0x1E00 && code <= 0x1EFF) ||
    (code >= 0x2C60 && code <= 0x2C7F) ||
    (code >= 0xA720 && code <= 0xA7FF) ||
    (code >= 0xAB30 && code <= 0xAB6F);

  function processElement(el) {
    let removedHere = 0;
    if (el.getType && el.getType() === DocumentApp.ElementType.TEXT) {
      const t = el.asText(), s = t.getText();
      if (!s) return 0;

      const del = [];
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (isCombiningMark(code)) { del.push(i); markCount++; }
        else if (isLatinSpecial(code)) { del.push(i); preCount++; }
      }
      if (del.length === 0) return 0;

      const ranges = [];
      let start = del[0], end = del[0];
      for (let i = 1; i < del.length; i++) {
        if (del[i] === end + 1) end = del[i];
        else { ranges.push([start, end]); start = end = del[i]; }
      }
      ranges.push([start, end]);

      for (let i = ranges.length - 1; i >= 0; i--) {
        t.deleteText(ranges[i][0], ranges[i][1]);
        removedHere += (ranges[i][1] - ranges[i][0] + 1);
      }
      return removedHere;
    }

    if (el.getNumChildren) {
      const n = el.getNumChildren();
      for (let i = 0; i < n; i++) removedHere += processElement(el.getChild(i));
    }
    return removedHere;
  }

  return { preCount, markCount, total: processElement(body) };
}

function addWatermarkHeaderFooter() {
  applyWatermarkToAllTabs_(true);
  DocumentApp.getUi().alert("✅ ใส่ลายน้ำ (หัว+ท้าย) เรียบร้อยแล้ว");
}

function removeWatermarkHeaderFooter() {
  applyWatermarkToAllTabs_(false);
  DocumentApp.getUi().alert("🧼 ลบลายน้ำ (หัว+ท้าย) เรียบร้อยแล้ว");
}

function applyWatermarkToAllTabs_(add) {
  const doc = getActiveDocSafe_();
  if (!doc) throw new Error('ไม่พบเอกสารปลายทาง');

  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  let tabCount = 0;

  if (tabs.length) {
    tabs.forEach(function(tab, idx) {
      __CHECKER_DOC_CTX__.tab = tab;
      __CHECKER_DOC_CTX__.tabId = tab.getId ? tab.getId() : '';
      __CHECKER_DOC_CTX__.tabTitle = getTabNameSafe_(tab, idx);
      applyWatermarkToTab_(doc, tab, !!add);
      tabCount++;
    });
  } else {
    applyWatermarkToTab_(doc, null, !!add);
    tabCount = 1;
  }

  return { ok: true, tabCount: tabCount, watermarkAdded: !!add };
}

function applyWatermarkToTab_(doc, tab, add) {
  let header = getHeaderFromTabSafe_(tab, doc);
  let footer = getFooterFromTabSafe_(tab, doc);

  try {
    if (!header && tab && typeof tab.asDocumentTab === 'function') {
      const dt = tab.asDocumentTab();
      if (dt.addHeader) header = dt.addHeader();
    }
  } catch (e) {}

  try {
    if (!footer && tab && typeof tab.asDocumentTab === 'function') {
      const dt = tab.asDocumentTab();
      if (dt.addFooter) footer = dt.addFooter();
    }
  } catch (e) {}

  try {
    if (!header && !tab && doc.addHeader) header = doc.addHeader();
  } catch (e) {}

  try {
    if (!footer && !tab && doc.addFooter) footer = doc.addFooter();
  } catch (e) {}

  if (header) {
    if (add) {
      upsertWatermarkInSection_(header, WM_TEXT, {
        align: WM_HEADER_ALIGN,
        insert: WM_HEADER_INSERT,
        spacingBefore: WM_SPACING_BEFORE,
        spacingAfter: WM_SPACING_AFTER
      });
    } else {
      removeWatermarkInSection_(header, WM_TEXT);
    }
  }

  if (footer) {
    if (add) {
      upsertWatermarkInSection_(footer, WM_TEXT, {
        align: WM_FOOTER_ALIGN,
        insert: WM_FOOTER_INSERT,
        spacingBefore: WM_SPACING_BEFORE,
        spacingAfter: WM_SPACING_AFTER
      });
    } else {
      removeWatermarkInSection_(footer, WM_TEXT);
    }
  }
}

function removeWatermarkInSection_(section, text) {
  if (!section || !text) return 0;
  var paras = [];
  try {
    paras = section.getParagraphs ? section.getParagraphs() : [];
  } catch (e) {
    paras = [];
  }

  var removed = 0;
  for (var i = paras.length - 1; i >= 0; i--) {
    var tx = '';
    try { tx = (paras[i].getText() || '').trim(); } catch (e) { tx = ''; }
    if (tx === text) {
      try {
        section.removeChild(paras[i]);
        removed++;
      } catch (e2) {
        try {
          var t = paras[i].editAsText();
          var len = t.getText().length;
          if (len > 0) t.deleteText(0, len - 1);
          removed++;
        } catch (e3) {}
      }
    }
  }
  return removed;
}

/** ✅ รวมแท็บทั้งหมด + นับจำนวนแท็บที่ตรวจจริง */
function runAllChecksAllTabs(options) {
  options = options || {};
  const allTabsStartedAt = startTimer_();
  if (typeof resetForeignWordAllowListCache_ === 'function') resetForeignWordAllowListCache_();
  const doc = getActiveDocSafe_();
  if (!doc) throw new Error('ไม่พบเอกสารปลายทาง');

  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];

  if (!tabs.length) {
    const r = runAllChecksWithBonusCleanup_();

    const singleName = 'เอกสารหลัก';
    const epTabs = [], chTabs = [], changes = [];
    let epCount = 0, chCount = 0;

    if (r.titleReport && r.titleReport.changed) {
      if (r.titleReport.episodeChanged) {
        epCount = 1;
        epTabs.push(singleName);
        changes.push({ tab: singleName, type: 'ตอนที่→บทที่', from: r.titleReport.from, to: r.titleReport.to });
      } else if (r.titleReport.chapterChanged) {
        chCount = 1;
        chTabs.push(singleName);
        changes.push({ tab: singleName, type: 'Chapter→บทที่', from: r.titleReport.from, to: r.titleReport.to });
      }
    }

    const singleResult = {
      replacedEmDashCount: r.replacedEmDashCount || 0,
      replacedWawCount: r.replacedWawCount || 0,
      latinSpecialRemovedTotal: r.latinSpecialRemoved?.total || 0,
      nonThaiCount: r.nonThaiCount || 0,
      paragraphCount: r.paragraphCount || 0,
      spacingCount: r.spacingCount || 0,
      blankRemoved: r.blankRemoved || 0,
      removedCount: r.removedCount || 0,
      removedBonusParensTotal: r.removedBonusParens || 0,
      blankRemovedAfterBonusTotal: r.blankRemovedAfterBonus || 0,
      breakPairsTotal: r.breakPairs?.total || 0,
      removedTitleParensTotal: r.removedTitleParens || 0,
      tabChecked: 1,
      tabSucceeded: 1,
      tabFailed: 0,
      tabTotal: 1,
      foreignTabNames: r.nonThaiCount > 0 ? [singleName] : [],
      foreignTabCounts: r.nonThaiCount > 0 ? [{ name: singleName, count: r.nonThaiCount }] : [],
      longEnglishParagraphCount: Number(r.longEnglishParagraphCount || 0),
      longEnglishTabNumbers: (r.longEnglishParagraphCount || 0) > 0 ? [1] : [],
      longEnglishTabCounts: (r.longEnglishParagraphCount || 0) > 0
        ? [{ tabNo: 1, count: Number(r.longEnglishParagraphCount || 0) }]
        : [],
      titleEpisodeTabs: epTabs,
      titleChapterTabs: chTabs,
      titleChanges: changes,
      titleEpisodeCount: epCount,
      titleChapterCount: chCount,
      chapterHeadingCleanupChangedTotal: Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.changed || 0),
      episodePrefixRemovedTotal: Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.episodePrefixRemoved || 0),
      looseChapterFixedTotal: Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.looseChapterFixed || 0),
      chapterHeadingCleanupRemovedLinesTotal: Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.removedLines || 0),
      chapterSequenceIssues: (r.chapterSequence && r.chapterSequence.issues) || [],
      sourceEpisodeMarkers: ((r.chapterSequence && r.chapterSequence.sourceEpisodeMarkers) || []).map(function(marker) {
        return {
          tab: singleName,
          tabIndex: 1,
          chapterNumber: marker.chapterNumber,
          sourceEpisodeNumber: marker.sourceEpisodeNumber,
          paragraphIndex: marker.paragraphIndex,
          text: marker.text,
          type: marker.type
        };
      }),
      sourceEpisodeMarkerTotal: Number(
        r.chapterSequence && r.chapterSequence.sourceEpisodeMarkers &&
        r.chapterSequence.sourceEpisodeMarkers.length || 0
      ),
      reportEvents: (r.reportEvents || []).map(function(event) {
        const mapped = Object.assign({}, event);
        mapped.tab = singleName;
        mapped.tabIndex = 1;
        return mapped;
      }),
      tabErrors: [],
      chapterSequenceIncomplete: false,
      tabChapterItems: [getFirstChapterItemFromRunResult_(r, singleName, 1)],
      hasDuplicateChapter: !!((r.chapterSequence && r.chapterSequence.issues || []).some(function(issue) { return issue.type === 'เลขซ้ำ'; })),
      performanceTotalMs: endTimer_(allTabsStartedAt),
      incomplete: false,
      nextTabIndex: null
    };
    if (typeof accumulateWebAppExtrasIntoBatchTotals_ === 'function') {
      accumulateWebAppExtrasIntoBatchTotals_(singleResult, r, singleName, 1);
    }
    logSlowStep_('total all tabs', singleResult.performanceTotalMs, '1/1 แท็บ', true);
    return singleResult;
  }

  const startTabIndex = Math.max(0, Number(options.startTabIndex || 0));
  const configuredLimit = Number(PERFORMANCE_LOG_CONFIG_ && PERFORMANCE_LOG_CONFIG_.MAX_TABS_PER_RUN || 0);
  const requestedLimit = Number(options.maxTabs || configuredLimit || 0);
  const endTabIndex = requestedLimit > 0
    ? Math.min(tabs.length, startTabIndex + requestedLimit)
    : tabs.length;
  const tabsThisRun = tabs.slice(startTabIndex, endTabIndex);

  const total = {
    replacedEmDashCount: 0,
    replacedWawCount: 0,
    latinSpecialRemovedTotal: 0,
    nonThaiCount: 0,
    paragraphCount: 0,
    spacingCount: 0,
    blankRemoved: 0,
    removedCount: 0,
    removedBonusParensTotal: 0,
    blankRemovedAfterBonusTotal: 0,
    breakPairsTotal: 0,
    removedTitleParensTotal: 0,
    tabChecked: 0,
    tabSucceeded: 0,
    tabFailed: 0,
    tabTotal: tabs.length,
    startTabIndex: startTabIndex,
    nextTabIndex: endTabIndex < tabs.length ? endTabIndex : null,
    incomplete: endTabIndex < tabs.length,
    foreignTabNames: [],
    foreignTabCounts: [],
    longEnglishParagraphCount: 0,
    longEnglishTabNumbers: [],
    longEnglishTabCounts: [],
    titleEpisodeTabs: [],
    titleChapterTabs: [],
    titleChanges: [],
    titleEpisodeCount: 0,
    titleChapterCount: 0,
    chapterHeadingCleanupChangedTotal: 0,
    episodePrefixRemovedTotal: 0,
    looseChapterFixedTotal: 0,
    chapterHeadingCleanupRemovedLinesTotal: 0,
    chapterSequenceIssues: [],
    sourceEpisodeMarkers: [],
    sourceEpisodeMarkerTotal: 0,
    reportEvents: [],
    tabErrors: [],
    chapterSequenceIncomplete: false,
    tabChapterItems: [],
    hasDuplicateChapter: false,
    titleParagraphInsertedTotal: 0,
    titleParagraphUpdatedTotal: 0,
    titleLayoutSkippedTotal: 0,
    englishSourceDetectedTotal: 0,
    englishSourceRemovedTotal: 0,
    englishSourceRemovedParagraphsTotal: 0,
    englishSourceUncertainTabs: [],
    sourceNoChapterTabs: [],
    endingCleanupChangedTotal: 0,
    endingPromoRemovedTotal: 0,
    endingMarkerInsertedTotal: 0
  };

  const foreignSet = new Set();
  const epSet = new Set();
  const chSet = new Set();

  tabsThisRun.forEach((t, idxInRun) => {
    const idx = startTabIndex + idxInRun;
    const name = getTabNameSafe_(t, idx);
    // ใช้ doc/tab object ที่เปิดแล้วโดยตรง: ไม่ openById และไม่ setActiveTab ซ้ำ
    let r;
    try {
      r = withOpenDocTabContext_(doc, t, function() {
        return runAllChecksWithBonusCleanup_();
      });
    } catch (tabError) {
      const errorText = String(tabError && tabError.message ? tabError.message : tabError);
      total.tabErrors.push({
        tab: name,
        tabIndex: idx + 1,
        code: CHECKER_PROBLEM_CODES_.TAB_CHECK_ERROR,
        message: errorText
      });
      total.reportEvents.push({
        code: CHECKER_PROBLEM_CODES_.TAB_CHECK_ERROR,
        severity: 'ERROR',
        changed: false,
        tab: name,
        tabIndex: idx + 1,
        message: errorText
      });
      total.tabChecked++;
      total.tabFailed++;
      return;
    }

    total.tabChecked++;
    total.tabSucceeded++;
    total.replacedEmDashCount += Number(r.replacedEmDashCount || 0);
    total.replacedWawCount += Number(r.replacedWawCount || 0);
    total.latinSpecialRemovedTotal += Number(r.latinSpecialRemoved?.total || 0);
    total.nonThaiCount += Number(r.nonThaiCount || 0);
    total.paragraphCount += Number(r.paragraphCount || 0);
    total.spacingCount += Number(r.spacingCount || 0);
    total.blankRemoved += Number(r.blankRemoved || 0);
    total.removedCount += Number(r.removedCount || 0);
    total.removedBonusParensTotal += Number(r.removedBonusParens || 0);
    total.blankRemovedAfterBonusTotal += Number(r.blankRemovedAfterBonus || 0);
    total.breakPairsTotal += Number(r.breakPairs?.total || 0);
    total.removedTitleParensTotal += Number(r.removedTitleParens || 0);
    total.chapterHeadingCleanupChangedTotal += Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.changed || 0);
    total.episodePrefixRemovedTotal += Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.episodePrefixRemoved || 0);
    total.looseChapterFixedTotal += Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.looseChapterFixed || 0);
    total.chapterHeadingCleanupRemovedLinesTotal += Number(r.chapterHeadingCleanup && r.chapterHeadingCleanup.removedLines || 0);

    (r.reportEvents || []).forEach(function(event) {
      const mapped = Object.assign({}, event);
      mapped.tab = name;
      mapped.tabIndex = idx + 1;
      total.reportEvents.push(mapped);
    });

    total.tabChapterItems.push(getFirstChapterItemFromRunResult_(r, name, idx + 1));

    var seq = r.chapterSequence || {};
    (seq.sourceEpisodeMarkers || []).forEach(function(marker) {
      total.sourceEpisodeMarkers.push({
        tab: name,
        problemCode: marker.problemCode || CHECKER_PROBLEM_CODES_.SOURCE_EPISODE_MARKER,
        tabIndex: idx + 1,
        chapterNumber: marker.chapterNumber,
        sourceEpisodeNumber: marker.sourceEpisodeNumber,
        paragraphIndex: marker.paragraphIndex,
        text: marker.text,
        type: marker.type
      });
      total.sourceEpisodeMarkerTotal++;
    });

    (seq.issues || []).forEach(function(issue) {
      total.chapterSequenceIssues.push({
        tab: name,
        type: issue.type,
        expected: issue.expected,
        previous: issue.previous,
        current: issue.current,
        paragraphIndex: issue.paragraphIndex,
        text: issue.text
      });
      if (issue.type === 'เลขซ้ำ') total.hasDuplicateChapter = true;
    });

    if ((r.nonThaiCount || 0) > 0) {
      if (!foreignSet.has(name)) {
        foreignSet.add(name);
        total.foreignTabNames.push(name);
      }
      total.foreignTabCounts.push({ name: name, count: Number(r.nonThaiCount || 0) });
    }

    // ประโยคภาษาอังกฤษยาว: เก็บเฉพาะจำนวนย่อหน้าและหมายเลขแท็บ ห้ามเก็บข้อความดิบ
    const longEnglishInTab = Number(r.longEnglishParagraphCount || 0);
    if (longEnglishInTab > 0) {
      total.longEnglishParagraphCount += longEnglishInTab;
      if (total.longEnglishTabNumbers.indexOf(idx + 1) === -1) {
        total.longEnglishTabNumbers.push(idx + 1);
      }
      total.longEnglishTabCounts.push({ tabNo: idx + 1, count: longEnglishInTab });
    }

    if (r.titleReport && r.titleReport.changed) {
      if (r.titleReport.episodeChanged) {
        total.titleEpisodeCount++;
        if (!epSet.has(name)) {
          epSet.add(name);
          total.titleEpisodeTabs.push(name);
        }
        total.titleChanges.push({ tab: name, type: 'ตอนที่→บทที่', from: r.titleReport.from, to: r.titleReport.to });
      } else if (r.titleReport.chapterChanged) {
        total.titleChapterCount++;
        if (!chSet.has(name)) {
          chSet.add(name);
          total.titleChapterTabs.push(name);
        }
        total.titleChanges.push({ tab: name, type: 'Chapter→บทที่', from: r.titleReport.from, to: r.titleReport.to });
      }
    }

    if (typeof accumulateWebAppExtrasIntoBatchTotals_ === 'function') {
      accumulateWebAppExtrasIntoBatchTotals_(total, r, name, idx + 1);
    }
  });

  if (total.tabErrors.length || total.incomplete) {
    // ไม่สรุปลำดับข้ามแท็บจากข้อมูลที่ขาด/ยังรันไม่ครบ เพราะอาจแจ้งเลขข้ามผิด
    total.chapterSequenceIncomplete = true;
  } else if (typeof buildChapterSequenceIssuesFromTabItems_ === 'function') {
    const crossTabSeq = buildChapterSequenceIssuesFromTabItems_(total.tabChapterItems || []);
    (crossTabSeq.issues || []).forEach(function(issue) {
      total.chapterSequenceIssues.push(issue);
      total.reportEvents.push({
        code: issue.problemCode || getChapterIssueProblemCode_(issue.type),
        severity: issue.type === 'เลขซ้ำ' ? 'ERROR' : 'WARNING',
        changed: false,
        tab: issue.tab,
        tabIndex: issue.tabIndex,
        paragraphIndex: issue.paragraphIndex || null,
        chapterNumber: issue.current == null ? null : issue.current,
        expected: issue.expected == null ? null : issue.expected,
        text: String(issue.text || '')
      });
    });
    total.hasDuplicateChapter = total.hasDuplicateChapter || !!crossTabSeq.hasDuplicateChapter;
  }

  total.reportEvents = dedupeReportEvents_(total.reportEvents);
  total.performanceTotalMs = endTimer_(allTabsStartedAt);
  logSlowStep_(
    'total all tabs',
    total.performanceTotalMs,
    total.tabChecked + '/' + total.tabTotal + ' แท็บ' +
      (total.incomplete ? ' | ทำต่อที่ index ' + total.nextTabIndex : ''),
    true
  );

  return total;
}

/** ✅ หา/แปลงหัวบท แล้ว return รายงาน */
function titleConvertAndReport_() {
  const body = getActiveBody_(), pBefore = findChapterParagraph_(body, 120);
  if (!pBefore) return { episodeChanged: 0, chapterChanged: 0, changed: 0, changedWords: 0, from: "", to: "" };

  const from = normalizeChapterLine_(pBefore.getText());
  const wasEpisode = /^ตอนที่\s*[0-9๐-๙]+/i.test(from), wasChapter = /^chapter\s*[0-9]+/i.test(from);

  fixChapterTitlePrefix();
  normalizeChapterTitleFirstLine();
  replaceThaiDigitsWithArabic();
  cleanupIntroAndFormatChapterLineSafe();

  const pAfter = findChapterParagraph_(body, 120) || pBefore;
  let to = normalizeChapterLine_(pAfter.getText());

  if (/^ตอนที่\s*[0-9๐-๙]+/i.test(to)) {
    const te = pAfter.editAsText(), len = te.getText().length;
    if (len > 0) te.deleteText(0, len - 1);
    te.insertText(0, to.replace(/^(\s*)ตอนที่(\s*[0-9๐-๙]+)/i, "$1บทที่$2"));
    te.setBold(true); te.setUnderline(true);
    to = normalizeChapterLine_(pAfter.getText());
  }

  const fixedTo = stripColonAfterChapterNumber_(to);
  if (fixedTo !== to) {
    writeParaText_(pAfter, fixedTo);
    const te = pAfter.editAsText();
    te.setBold(true); te.setUnderline(true);
    to = normalizeChapterLine_(pAfter.getText());
  }

  if (/^chapter\s*[0-9]+/i.test(to)) {
    const m = to.match(/^chapter\s*([0-9]+)\s*(.*)$/i);
    const num = m ? m[1] : "";
    let rest = (m ? m[2] || "" : "").replace(/^\s*[:：]\s*/, "").replace(/^\s*[\u2013\u2014\-–—]+\s*/, "").trim();
    const te = pAfter.editAsText(), len = te.getText().length;
    if (len > 0) te.deleteText(0, len - 1);
    te.insertText(0, `บทที่ ${num}${rest ? " " + rest : ""}`);
    te.setBold(true); te.setUnderline(true);
    to = normalizeChapterLine_(pAfter.getText());
  }

  const episodeChanged = wasEpisode && /^บทที่\s*/.test(to) && to !== from ? 1 : 0;
  const chapterChanged = wasChapter && /^บทที่\s*/.test(to) && to !== from ? 1 : 0;
  const changed = episodeChanged || chapterChanged ? 1 : 0;
  return { episodeChanged, chapterChanged, changed, changedWords: changed, from, to };
}

function stripColonAfterChapterNumber_(s) {
  let out = String(s || "").replace(INVIS_RE_, " ").replace(/\s+/g, " ").trim();
  out = out.replace(new RegExp("^(\\s*(?:บทที่|ตอนที่)\\s*[0-9๐-๙]+)\\s*" + COLON_CLASS_ + "\\s*", "i"), "$1 ");
  out = out.replace(new RegExp("^(\\s*chapter\\s*[0-9]+)\\s*" + COLON_CLASS_ + "\\s*", "i"), "$1 ");
  return out.replace(/\s+/g, " ").trim();
}

/** 🗑️ ลบหมายเหตุภาษาไทยในวงเล็บ */
function removeThaiNoteParentheses() {
  const body = getActiveBody_();
  let count = 0;
  const pattern = "\\((?:หมายเหตุผู้แปล|หมายเหตุ|หมายเหตุผู้แต่ง|ผู้แปล)\\s*" + COLON_CLASS_ + "[^)]*\\)";
  let found = body.findText(pattern), ranges = [];

  while (found) {
    ranges.push(found);
    found = body.findText(pattern, found);
  }

  for (let i = ranges.length - 1; i >= 0; i--) {
    const el = ranges[i].getElement().asText();
    el.deleteText(ranges[i].getStartOffset(), ranges[i].getEndOffsetInclusive());
    count++;
  }
  return count;
}

/** 📝 เขียนทับข้อความใน Paragraph เดิม */
function writeParaText_(p, newText) {
  if (!p) return false;
  const oldText = p.getText();
  if (oldText === newText) return false;
  const attrs = p.getAttributes();
  p.setText(newText);
  try { p.setAttributes(attrs); } catch (e) {}
  return true;
}

/** 🧷 จัดสไตล์หัวบท */
function setHeadingLineStyle_(p) {
  if (!p) return;
  try {
    const t = p.editAsText();
    if (!t.getText()) return;

    t.setBold(true);
    t.setUnderline(true);
    t.setFontFamily("Sarabun");
    t.setFontSize(CHECKER_HEADING_FONT_SIZE_);
    t.setForegroundColor("#000000");
  } catch (e) {}
}

/** ✅ เช็คว่าย่อหน้านี้เป็นตัวหนา + ขีดเส้นใต้หรือไม่ */
function isBoldUnderlineParagraph_(p) {
  if (!p) return false;
  try {
    const t = p.editAsText();
    const s = t.getText();
    if (!s) return false;
    return t.isBold(0) === true && t.isUnderline(0) === true;
  } catch (e) {
    return false;
  }
}

function stripLeadingBracketTags_(text) {
  var raw = String(text || '');
  var prefixLen = getLeadingBracketTagPrefixLength_(raw);

  if (!prefixLen) {
    return raw.replace(INVIS_RE_, ' ').replace(/\s+/g, ' ').trim();
  }

  var s = raw.slice(prefixLen);
  s = s
    .replace(INVIS_RE_, ' ')
    .replace(/^\s*[:：﹕꞉∶։\-–—]+\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();

  return s;
}

function getLeadingBracketTagPrefixLength_(text) {
  var s = String(text || '');
  if (!s) return 0;

  // รองรับ:
  // [417]: ชื่อบท
  // [417] : ชื่อบท
  // [ ๔๑๗ ] - ชื่อบท
  // 【417】：ชื่อบท
  // ［417］ ชื่อบท
  // [โบนัส] / [bonus]
  var prefixRe = /^\s*(?:(?:[\[［【]\s*[0-9๐-๙]+\s*[\]］】]|[\[［【]\s*(?:โบนัส|bonus)\s*[\]］】])\s*(?:[:：﹕꞉∶։\-–—]\s*)?)+/iu;
  var m = s.match(prefixRe);
  return m ? m[0].length : 0;
}

function removeLeadingBracketTagsFromParagraphPreserveStyle_(p) {
  if (!p) return null;

  var raw = '';
  try { raw = p.getText() || ''; } catch (e) { raw = ''; }
  if (!raw) return null;

  var prefixLen = getLeadingBracketTagPrefixLength_(raw);
  if (!prefixLen) return null;

  var from = cleanText_(raw);
  var textEl = null;

  try {
    textEl = p.editAsText();
  } catch (e) {
    textEl = null;
  }

  // ใช้ deleteText แทน setText เพื่อรักษา style เดิมของชื่อบท เช่น ตัวหนา/ขีดเส้นใต้
  if (textEl) {
    try {
      textEl.deleteText(0, Math.max(0, prefixLen - 1));

      // เก็บกวาดตัวคั่น/ช่องว่างที่อาจเหลืออยู่หน้า title
      var guard = 0;
      while (textEl.getText() && /^[\s\u00A0\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060:：﹕꞉∶։\-–—]/u.test(textEl.getText().charAt(0)) && guard < 30) {
        textEl.deleteText(0, 0);
        guard++;
      }

      var after = cleanText_(textEl.getText());
      if (!after) {
        removeParaSafely_(p);
      }

      return {
        paragraphIndex: -1,
        from: from,
        to: after,
        removed: 1
      };
    } catch (e2) {
      // ถ้า deleteText ล้มเหลว ค่อย fallback เป็น setText แบบรักษา style แรกสุดที่เหลือ
    }
  }

  var cleaned = stripLeadingBracketTags_(raw);
  if (cleaned === from) return null;

  if (!cleaned) {
    removeParaSafely_(p);
  } else {
    var styleSourceIndex = findStyleSourceIndexAfterBracketStrip_(raw, cleaned);
    setParagraphTextPreserveFirstTextStyle_(p, cleaned, styleSourceIndex);
  }

  return {
    paragraphIndex: -1,
    from: from,
    to: cleaned,
    removed: 1
  };
}

function setParagraphTextPreserveFirstTextStyle_(p, newText, sourceIndex) {
  if (!p) return false;

  const paraAttrs = p.getAttributes ? p.getAttributes() : null;
  let textAttrs = null;

  try {
    const t = p.editAsText();
    const oldText = t.getText() || '';
    if (oldText.length > 0) {
      let idx = Number(sourceIndex || 0);
      if (isNaN(idx)) idx = 0;
      idx = Math.max(0, Math.min(idx, oldText.length - 1));
      textAttrs = t.getAttributes(idx);
    }
  } catch (e) {}

  p.setText(newText || '');

  try {
    if (paraAttrs) p.setAttributes(paraAttrs);
  } catch (e) {}

  try {
    const nt = p.editAsText();
    const len = nt.getText().length;
    if (textAttrs && len > 0) {
      nt.setAttributes(0, len - 1, textAttrs);
    }
  } catch (e) {}

  return true;
}

function findStyleSourceIndexAfterBracketStrip_(raw, cleaned) {
  raw = String(raw || '');
  cleaned = String(cleaned || '');
  if (!raw || !cleaned) return 0;

  let idx = raw.indexOf(cleaned);
  if (idx >= 0) return idx;

  const firstChar = cleaned.charAt(0);
  idx = raw.indexOf(firstChar);
  return idx >= 0 ? idx : 0;
}

function mergeLeadingBracketRemovalReports_() {
  var result = {
    changed: 0,
    changedCount: 0,
    from: '',
    to: '',
    paragraphIndex: -1,
    changes: []
  };

  for (var i = 0; i < arguments.length; i++) {
    var r = arguments[i] || {};
    if (!r.changed && !r.changedCount) continue;

    result.changed = 1;
    result.changedCount += Number(r.changedCount || r.changed || 0);
    (r.changes || []).forEach(function(item) {
      if (result.changes.length < 50) result.changes.push(item);
    });

    if (!result.from && r.from) result.from = r.from;
    if (!result.to && r.to) result.to = r.to;
    if (result.paragraphIndex === -1 && r.paragraphIndex) result.paragraphIndex = r.paragraphIndex;
  }

  return result;
}

function removeLeadingBracketTagsNearChapter_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const changes = [];
  let changedCount = 0;

  // V11.7: ลบ [เลขบท] : ทุกย่อหน้าในแท็บ ไม่จำกัดเฉพาะใกล้หัวบท
  // และใช้ deleteText เพื่อไม่ทำให้ตัวหนา/ขีดเส้นใต้ของชื่อบทหาย
  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i];
    const raw = cleanText_(p.getText());

    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;

    const r = removeLeadingBracketTagsFromParagraphPreserveStyle_(p);
    if (!r) continue;

    r.paragraphIndex = i + 1;
    changedCount++;
    if (changes.length < 30) changes.unshift({
      paragraphIndex: r.paragraphIndex,
      from: r.from,
      to: r.to
    });
  }

  return {
    changed: changedCount > 0 ? 1 : 0,
    changedCount: changedCount,
    from: changes.length ? changes[0].from : '',
    to: changes.length ? changes[0].to : '',
    paragraphIndex: changes.length ? changes[0].paragraphIndex : -1,
    changes: changes
  };
}

function removeLeadingBracketTagsAllTabs_() {
  const doc = getActiveDocSafe_();
  if (!doc) throw new Error('ไม่พบเอกสารปลายทาง');

  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  const result = {
    tabChecked: 0,
    tabTotal: tabs.length || 1,
    changedCount: 0,
    changedTabs: [],
    changes: []
  };

  if (!tabs.length) {
    const r = removeLeadingBracketTagsNearChapter_();
    result.tabChecked = 1;
    if (r.changed) {
      result.changedCount = Number(r.changedCount || 1);
      result.changedTabs.push('เอกสารหลัก');
      result.changes.push({
        tab: 'เอกสารหลัก',
        from: r.from,
        to: r.to,
        paragraphIndex: r.paragraphIndex
      });
    }
    return result;
  }

  tabs.forEach(function(tab, idx) {
    const r = withOpenDocTabContext_(doc, tab, function() {
      return removeLeadingBracketTagsNearChapter_();
    });

    result.tabChecked++;

    if (r && r.changed) {
      const name = getTabNameSafe_(tab, idx);
      result.changedCount += Number(r.changedCount || 1);
      result.changedTabs.push(name);
      result.changes.push({
        tab: name,
        from: r.from,
        to: r.to,
        paragraphIndex: r.paragraphIndex
      });
    }
  });

  return result;
}

function removeLeadingBracketTagsAllTabsWithAlert() {
  const r = removeLeadingBracketTagsAllTabs_();
  const lines = [
    '🧾 ตรวจแล้ว ' + r.tabChecked + '/' + r.tabTotal + ' แท็บ',
    '🗑️ ลบ [เลขบท] / [โบนัส] แล้ว ' + r.changedCount + ' แท็บ'
  ];

  if (r.changedTabs.length) {
    lines.push('', '📄 แท็บที่แก้ไข:');
    r.changedTabs.forEach(function(name) {
      lines.push('- ' + name);
    });
  } else {
    lines.push('', 'ℹ️ ไม่พบบรรทัดที่ต้องลบ');
  }

  DocumentApp.getUi().alert(lines.join('\n'));
  return r;
}

/**
 * จัดหัวบทก่อนรวมชื่อบทกลับด้วย mergeChapterTitleBackInActiveTab_()
 * - บท 255: ชื่อบท -> บทที่ 255 ชื่อบท
 * - บทที่ [319] ตอนที่ 318.5 – ชื่อบท -> บทที่ 319 ชื่อบท
 * - บทที่ 436 / ตอนที่ 465-466 – ชื่อบท -> คงหัวบทและเหลือชื่อบท
 *
 * ใช้ getActiveBody_() เพื่อให้ทำงานกับแท็บ Docs ที่ Checker_Main
 * กำหนดผ่าน withDocTabContext_() อยู่ในขณะนั้น
 */
function cleanChapterHeadingAndEpisodePrefix_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const limit = Math.min(paras.length, 120);
  const changes = [];
  let episodePrefixRemoved = 0;
  let looseChapterFixed = 0;
  let removedLines = 0;

  function toArabic_(value) {
    return String(value || '').replace(/[๐-๙]/g, function(ch) {
      return '๐๑๒๓๔๕๖๗๘๙'.indexOf(ch);
    });
  }

  function tidy_(value) {
    return String(value || '')
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function setText_(p, text) {
    const attrs = p.getAttributes ? p.getAttributes() : null;
    p.setText(text);
    if (attrs) {
      try { p.setAttributes(attrs); } catch (e) {}
    }
  }

  // รองรับเลขเดี่ยว/ทศนิยม/ช่วง รวมถึง em dash ที่ workflow เดิม
  // อาจแปลงเป็น "..." ไปก่อนแล้วโดย replaceEmDashWithEllipsis()
  const digit = '[0-9๐-๙]+';
  const decimal = digit + '(?:\\.' + digit + ')?';
  const rangeSep = '(?:[-–—]|\\.{2,})';
  const chapterNumber = decimal + '(?:\\s*' + rangeSep + '\\s*' + decimal + ')?';
  const chapterStartRe = new RegExp(
    '^บทที่\\s*\\[?\\s*(' + chapterNumber + ')\\s*\\]?\\s+(.*)$',
    'i'
  );
  const chapterOnlyRe = new RegExp(
    '^บทที่\\s*\\[?\\s*(' + chapterNumber + ')\\s*\\]?\\s*$',
    'i'
  );
  const looseChapterRe = new RegExp(
    '^บท(?!ที่)\\s+(' + chapterNumber + ')' +
    '(?:\\s*[:：\\-–—]\\s*|\\s+)?(.*)$',
    'i'
  );

  // รอบแรก: normalize "บท N" และลบ episode prefix ที่อยู่บรรทัดเดียวกับหัวบท
  for (let i = 0; i < limit; i++) {
    const p = paras[i];
    const before = tidy_(p.getText());
    if (!before || before === NOTE_TEXT_) continue;

    let text = before;
    const loose = text.match(looseChapterRe);
    if (loose) {
      const number = toArabic_(loose[1]).replace(/\s+/g, '').replace(/\.{2,}/g, '-');
      const rest = tidy_(loose[2]).replace(/^(?:[:：\-–—]|\.\.\.)\s*/, '').trim();
      text = 'บทที่ ' + number + (rest ? ' ' + rest : '');
      looseChapterFixed++;
    }

    // เอาวงเล็บเหลี่ยมรอบเลขบทออกเฉพาะหัวบท
    text = text.replace(
      new RegExp('^บทที่\\s*\\[\\s*(' + chapterNumber + ')\\s*\\]', 'i'),
      function(_, number) {
        return 'บทที่ ' + toArabic_(number).replace(/\s+/g, '').replace(/\.{2,}/g, '-');
      }
    );

    const chapter = text.match(chapterStartRe);
    if (chapter) {
      const chapterNo = toArabic_(chapter[1]).replace(/\s+/g, '').replace(/\.{2,}/g, '-');
      const restBefore = tidy_(chapter[2]);
      // helper กลาง: ครอบคลุมทั้ง "ตอนที่ 093", "EP 093", "[093]", "093" และเลขซ้ำเลขบท
      const restAfter = stripSecondarySourceEpisodeToken_(restBefore, chapterNo);
      if (restAfter !== restBefore) {
        text = 'บทที่ ' + chapterNo + (restAfter ? ' ' + restAfter : '');
        episodePrefixRemoved++;
      }
    }

    text = tidy_(text);
    if (text !== before) {
      setText_(p, text);
      changes.push({ paragraphIndex: i, from: before, to: text });
    }
  }

  // รอบสอง: หัวบทอยู่บรรทัดก่อนหน้า และ episode prefix อยู่หน้าชื่อบท
  for (let i = limit - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];
    const before = tidy_(curr.getText());
    const previousText = tidy_(prev.getText());
    if (!before || before === NOTE_TEXT_ || !chapterOnlyRe.test(previousText)) continue;

    // ใช้ helper กลางแทน regex เฉพาะกิจ เพื่อให้ครอบคลุมทั้ง "ตอนที่ 093",
    // "EP 093", "[093]" และเลขเปล่า zero-padded ที่ตกค้างหน้าชื่อบท
    const previousChapter = previousText.match(chapterOnlyRe);
    const previousChapterNo = previousChapter
      ? toArabic_(previousChapter[1]).replace(/\s+/g, '').replace(/\.{2,}/g, '-')
      : '';
    const title = stripSecondarySourceEpisodeToken_(before, previousChapterNo);
    if (title === before) continue;

    episodePrefixRemoved++;

    if (title) {
      setText_(curr, title);
      changes.push({ paragraphIndex: i, from: before, to: title });
    } else {
      changes.push({ paragraphIndex: i, from: before, to: '' });
      removeParaSafely_(curr);
      removedLines++;
    }
  }

  return {
    changed: changes.length,
    episodePrefixRemoved: episodePrefixRemoved,
    looseChapterFixed: looseChapterFixed,
    removedLines: removedLines,
    changes: changes
  };
}

/**
 * 🪟 @deprecated แยกชื่อบทที่ต่อท้าย "บทที่ xxx" ไปบรรทัดถัดไป
 *
 * ห้าม production flow เรียกอีก: หัวบทต้องอยู่ paragraph เดียวกับชื่อบทเสมอ
 * (runAllChecks() ใช้ mergeChapterTitleBackInActiveTab_() แทนแล้ว)
 * คงฟังก์ชันไว้เพื่อให้เมนู/สคริปต์เก่าที่อ้างชื่อนี้ไม่พัง
 */
function splitChapterTitleToNextLine_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const re = new RegExp(
    "^(บทที่)\\s*([0-9๐-๙]+(?:(?:[-–—]|\\.{2,})[0-9๐-๙]+)?)(?:\\s*" + COLON_CLASS_ + "\\s*|\\s+)(.+)$",
    "i"
  );

  for (let i = 0; i < Math.min(paras.length, 120); i++) {
    const p = paras[i];
    const raw = cleanText_(p.getText());
    if (!raw || raw === NOTE_TEXT_) continue;

    const line = normalizeChapterLine_(raw);
    const m = line.match(re);
    if (!m) continue;

    const normalizedNumber = thaiDigitsToArabic_(m[2]).replace(/\.{2,}/g, '-');
    const chapterOnly = `${m[1]} ${normalizedNumber}`.replace(/\s+/g, " ").trim();
    const titleOnly = String(m[3] || "").trim();
    if (!titleOnly) return { changed: 0, from: raw, to: raw };

    const attrs = p.getAttributes ? p.getAttributes() : {};
    p.setText(chapterOnly);
    try { p.setAttributes(attrs); } catch (e) {}

    const insertAt = body.getChildIndex ? body.getChildIndex(p) + 1 : i + 1;
    const np = body.insertParagraph(insertAt, titleOnly);
    try { np.setAttributes(attrs); } catch (e) {}

    setHeadingLineStyle_(p);
    setHeadingLineStyle_(np);

    return {
      changed: 1,
      from: raw,
      to: `${chapterOnly}\n${titleOnly}`
    };
  }

  return { changed: 0, from: "", to: "" };
}

/**
 * ✅ บรรทัดแรกเป็น "บทที่ N" ล้วนหรือไม่ (chapter-only)
 * รองรับเลขอารบิก/เลขไทย, เลขทศนิยม และช่วงบท 584-585 / 584–585 / 584—585
 * คืนเลขบทในรูปอารบิกเมื่อเป็น chapter-only เท่านั้น ถ้าไม่ใช่คืน null
 */
function parseChapterOnlyLineNumber_(text) {
  const line = normalizeChapterLine_(String(text || ''));
  const digit = '[0-9๐-๙]+';
  const decimal = digit + '(?:\\.' + digit + ')?';
  const rangeSep = '(?:\\s*(?:[-–—]|\\.{2,})\\s*)';
  const re = new RegExp(
    '^บทที่\\s*\\[?\\s*(' + decimal + '(?:' + rangeSep + decimal + ')?)\\s*\\]?\\s*$',
    'i'
  );

  const m = line.match(re);
  if (!m) return null;

  // ช่วงบทให้ normalize เป็นขีดกลางเดียว ไม่ว่าต้นฉบับจะใช้ - / – / —
  return thaiDigitsToArabic_(m[1])
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, '')
    .replace(/\.{2,}/g, '-');
}

/**
 * ✅ ย่อหน้านี้ "น่าเชื่อถือพอ" ที่จะเป็นชื่อบทของบรรทัดก่อนหน้าหรือไม่
 *
 * เงื่อนไขความปลอดภัย (ห้ามดึงย่อหน้าเนื้อเรื่องแรกขึ้นมาเป็นชื่อบท):
 * - ต้องไม่ว่าง, ไม่ใช่บรรทัดหมายเหตุ, ไม่ใช่หัวบทอีกบท, ไม่ใช่แผงสถานะ 【...】
 * - ต้องเป็นหัวเรื่องจริงตามที่ระบบสร้าง คือ bold + underline
 * - ต้องสั้นพอที่จะเป็นชื่อบท และไม่ขึ้นต้นด้วยเครื่องหมายคำพูด/บทสนทนา
 */
function isTrustedChapterTitleParagraph_(p, text) {
  const line = cleanText_(text == null ? (p ? p.getText() : '') : text);
  if (!line || line === NOTE_TEXT_) return false;
  if (isChapterLineText_(normalizeChapterLine_(line))) return false;
  if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(line)) return false;

  // ชื่อบทที่ระบบสร้างจะยาวไม่เกินหนึ่งบรรทัด และไม่ใช่บทสนทนา
  if (line.length > 160) return false;
  if (/^[“”"'‘’「『【(\[]/.test(line)) return false;

  return isBoldUnderlineParagraph_(p);
}

/** ↩️ รวมชื่อบทกลับมาต่อท้าย "บทที่ xxx" ในแท็บปัจจุบัน (ผลลัพธ์ต้องเป็น paragraph เดียว) */
function mergeChapterTitleBackInActiveTab_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  for (let i = 0; i < Math.min(paras.length, 120); i++) {
    const p1 = paras[i];
    const line1 = cleanText_(p1.getText());
    if (!line1 || line1 === NOTE_TEXT_) continue;

    // รวมเฉพาะเมื่อบรรทัดแรกเป็น chapter-only เท่านั้น
    const chapterNo = parseChapterOnlyLineNumber_(line1);
    if (chapterNo == null) continue;

    let nextIdx = -1;
    for (let j = i + 1; j < Math.min(paras.length, i + 6); j++) {
      const tx = cleanText_(paras[j].getText());
      if (!tx) continue;
      nextIdx = j;
      break;
    }
    if (nextIdx === -1) return { changed: 0, from: "", to: "" };

    const p2 = paras[nextIdx];
    const line2 = cleanText_(p2.getText());
    if (!isTrustedChapterTitleParagraph_(p2, line2)) return { changed: 0, from: "", to: "" };

    // เผื่อชื่อบทยังมีเลขตอนต้นฉบับติดมา ให้ใช้ helper กลางตัวเดียวกับ flow อื่น
    const titleOnly = stripSecondarySourceEpisodeToken_(line2, chapterNo);
    const merged = ('บทที่ ' + chapterNo + (titleOnly ? ' ' + titleOnly : ''))
      .replace(/\s+/g, " ")
      .trim();

    const attrs = p1.getAttributes ? p1.getAttributes() : {};
    p1.setText(merged);
    try { p1.setAttributes(attrs); } catch (e) {}

    // ใช้ style helper กลาง ไม่ hardcode ขนาดฟอนต์ในฟังก์ชันนี้
    setHeadingLineStyle_(p1);

    removeParaSafely_(p2);

    return {
      changed: 1,
      from: `${line1}\n${line2}`,
      to: merged
    };
  }

  return { changed: 0, from: "", to: "" };
}

/** ↩️ รวมชื่อบทกลับทุกแท็บ */
function mergeChapterTitleBackAllTabs_() {
  const doc = getActiveDocSafe_();
  if (!doc) throw new Error('ไม่พบเอกสารปลายทาง');

  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  const result = {
    tabChecked: 0,
    tabTotal: tabs.length || 1,
    changedCount: 0,
    changedTabs: []
  };

  if (!tabs.length) {
    const r = mergeChapterTitleBackInActiveTab_();
    result.tabChecked = 1;
    result.changedCount = r.changed ? 1 : 0;
    result.changedTabs = r.changed ? ['เอกสารหลัก'] : [];
    return result;
  }

  tabs.forEach((t, idx) => {
    const r = withOpenDocTabContext_(doc, t, function() {
      return mergeChapterTitleBackInActiveTab_();
    });

    result.tabChecked++;
    if (r && r.changed) {
      result.changedCount++;
      result.changedTabs.push(getTabNameSafe_(t, idx));
    }
  });

  return result;
}

function mergeChapterBackRow(sheetRow) {
  sheetRow = Number(sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  const row = getMappedRow_(sheetRow);
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  const result = withDocTabContext_(row.docId, row.tabId, function() {
    return mergeChapterTitleBackAllTabs_();
  });

  return {
    ok: true,
    sheetRow: sheetRow,
    docId: row.docId,
    tabId: row.tabId || '',
    result: result
  };
}

/** ↩️ รวมชื่อบทกลับทุกแท็บ + alert */
function mergeChapterTitleBackAllTabsWithAlert() {
  const r = mergeChapterTitleBackAllTabs_();
  const lines = [
    `🧾 ตรวจแล้ว ${r.tabChecked}/${r.tabTotal} แท็บ`,
    `↩️ ต่อชื่อบทกลับแล้ว ${r.changedCount} แท็บ`
  ];

  if (r.changedTabs.length) {
    lines.push("", `📄 แท็บที่แก้ไข:\n- ${r.changedTabs.join("\n- ")}`);
  } else {
    lines.push("", "ℹ️ ไม่พบชื่อบทที่ถูกแยกบรรทัด");
  }

  DocumentApp.getUi().alert(lines.join("\n"));
  return r;
}

function upsertWatermarkInSection_(section, text, opts) {
  opts = opts || {};
  if (!section || !text) return null;

  var align = opts.align || DocumentApp.HorizontalAlignment.CENTER;
  var insert = String(opts.insert || 'BOTTOM').toUpperCase();
  var spacingBefore = Number(opts.spacingBefore || 0);
  var spacingAfter = Number(opts.spacingAfter || 0);

  var paras = [];
  try {
    paras = section.getParagraphs ? section.getParagraphs() : [];
  } catch (e) {
    paras = [];
  }

  for (var i = 0; i < paras.length; i++) {
    var existingText = '';
    try {
      existingText = (paras[i].getText() || '').trim();
    } catch (e) {
      existingText = '';
    }

    if (existingText === text) {
      try {
        paras[i].setAlignment(align);
        paras[i].setSpacingBefore(spacingBefore);
        paras[i].setSpacingAfter(spacingAfter);
        var existingEdit = paras[i].editAsText();
        existingEdit.setForegroundColor(WM_COLOR);
        existingEdit.setFontSize(WM_FONT_SIZE);
        existingEdit.setBold(false);
        existingEdit.setUnderline(false);
      } catch (e) {}
      return paras[i];
    }
  }

  var p = null;

  if (insert === 'TOP') {
    try {
      if (paras.length > 0 && section.insertParagraph) {
        p = section.insertParagraph(0, text);
      } else if (section.appendParagraph) {
        p = section.appendParagraph(text);
      }
    } catch (e) {
      try {
        if (section.appendParagraph) p = section.appendParagraph(text);
      } catch (e2) {}
    }
  } else {
    try {
      if (section.appendParagraph) {
        p = section.appendParagraph(text);
      }
    } catch (e) {
      try {
        if (section.insertParagraph) p = section.insertParagraph(0, text);
      } catch (e2) {}
    }
  }

  if (!p) throw new Error('ไม่สามารถเพิ่มลายน้ำใน section นี้ได้');

  try { p.setAlignment(align); } catch (e) {}
  try { p.setSpacingBefore(spacingBefore); } catch (e) {}
  try { p.setSpacingAfter(spacingAfter); } catch (e) {}

  try {
    var t = p.editAsText();
    t.setForegroundColor(WM_COLOR);
    t.setFontSize(WM_FONT_SIZE);
    t.setBold(false);
    t.setUnderline(false);
  } catch (e) {}

  return p;
}

function watermarkRow(payload) {
  payload = payload || {};

  var sheetRow = Number(payload.sheetRow);
  var add = !!payload.add;

  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = getMappedRow_(sheetRow);
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var result = withDocTabContext_(row.docId, row.tabId, function() {
    return applyWatermarkToAllTabs_(add);
  });

  return {
    ok: true,
    sheetRow: sheetRow,
    docId: row.docId,
    tabId: row.tabId || '',
    action: add ? 'add' : 'remove',
    result: result
  };
}



/* =========================================================
 * V11.11 COMPLETE CORE PATCH
 * เติมฟังก์ชันแกนหลักที่ไฟล์นี้เรียกใช้อยู่ ให้เป็นไฟล์เดียวที่สมบูรณ์ขึ้น
 * - runAllChecks()
 * - runAllChecksWithAlert()
 * - openDocByIdSafe_()
 * - ระบบตรวจเลขบท / ลายเซ็นเนื้อหาซ้ำพื้นฐาน
 * - helper สำหรับ runAllChecksAllTabs()
 * ========================================================= */

function openDocByIdSafe_(docId) {
  var id = String(docId || '').trim();
  if (!id) throw new Error('docId ว่าง');

  var lastErr = null;
  for (var i = 0; i < 3; i++) {
    try {
      return DocumentApp.openById(id);
    } catch (e) {
      lastErr = e;
      try { Utilities.sleep(500 * (i + 1)); } catch (_) {}
    }
  }

  throw new Error('เปิดเอกสารไม่ได้: ' + id + ' | ' + (lastErr && lastErr.message ? lastErr.message : lastErr));
}

function underlineFirstLine() {
  const body = getActiveBody_();
  const paras = body.getParagraphs ? body.getParagraphs() : [];
  const p = paras && paras.length ? paras[0] : null;
  if (!p) return false;

  try {
    const t = p.editAsText();
    t.setUnderline(true);
    t.setBold(true);
    return true;
  } catch (e) {
    return false;
  }
}

/* =========================================================
 * Web app: Chapter title layout (KEEP_EXISTING default)
 * แนวคิด: parse เลขบท/ชื่อบทจากข้อความในหน่วยความจำ ไม่พึ่งพาว่าโครงสร้าง
 * paragraph ต้องแยกบรรทัดหรือไม่ - ตรวจได้ทั้งสองแบบโดยไม่ insert paragraph
 * ========================================================= */

/** แยกเลขบท + ข้อความที่เหลือบนบรรทัดเดียวกัน (ยังไม่รู้ว่ามีชื่อบทต่อท้ายหรือไม่) */
function parseChapterHeadingLinePure_(text) {
  const line = normalizeChapterLine_(text);
  const numberPattern = '[0-9๐-๙]+(?:(?:[-–—]|\\.{2,})[0-9๐-๙]+)?';

  let m = line.match(new RegExp(
    '^(?:บท(?:ที่)?|ตอนที่)\\s*\\[?\\s*(' + numberPattern + ')\\s*\\]?\\s*(?:' +
      COLON_CLASS_ + '\\s*|[-–—]\\s*)?(.*)$',
    'i'
  ));
  if (!m) {
    m = line.match(new RegExp(
      '^chapter\\s*\\[?\\s*(' + numberPattern + ')\\s*\\]?\\s*(?:' +
        COLON_CLASS_ + '\\s*|[-–—]\\s*)?(.*)$',
      'i'
    ));
  }
  if (!m) return null;

  return {
    chapterNumber: thaiDigitsToArabic_(m[1]).replace(/\.{2,}/g, '-'),
    inlineTitle: String(m[2] || '').trim()
  };
}

/**
 * หาเลขบท + ชื่อบท จากอาร์เรย์ข้อความ paragraph (ในหน่วยความจำล้วนๆ)
 * รองรับทั้ง "บทที่ N ชื่อบท" (บรรทัดเดียว) และ "บทที่ N" + "ชื่อบท" (แยกบรรทัด)
 * ไม่แก้ไข/ไม่ insert paragraph ใดๆ ทั้งสิ้น
 */
function parseChapterTitleFromLinesPure_(lines, headingIndex, windowSize) {
  windowSize = Math.max(1, Number(windowSize || 6));
  const headingText = String((lines && lines[headingIndex]) || '');
  const headingInfo = parseChapterHeadingLinePure_(headingText);
  if (!headingInfo) return null;

  if (headingInfo.inlineTitle) {
    return {
      chapterNumber: headingInfo.chapterNumber,
      title: headingInfo.inlineTitle,
      sameLine: true,
      headingParagraphIndex: headingIndex,
      titleParagraphIndex: headingIndex
    };
  }

  const limit = Math.min(lines.length, headingIndex + 1 + windowSize);
  for (let i = headingIndex + 1; i < limit; i++) {
    const t = cleanText_(lines[i]);
    if (!t || t === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(t)) continue;
    // เจอหัวบทถัดไปก่อนเจอชื่อบท แปลว่าบทนี้ไม่มีชื่อบท (ไม่ใช่ error)
    if (isChapterLineText_(normalizeChapterLine_(t))) break;

    return {
      chapterNumber: headingInfo.chapterNumber,
      title: t,
      sameLine: false,
      headingParagraphIndex: headingIndex,
      titleParagraphIndex: i
    };
  }

  return {
    chapterNumber: headingInfo.chapterNumber,
    title: '',
    sameLine: true,
    headingParagraphIndex: headingIndex,
    titleParagraphIndex: -1
  };
}

function findChapterHeadingIndexInTexts_(texts, limit) {
  limit = Math.min(texts.length, limit || 120);
  for (let i = 0; i < limit; i++) {
    const t = cleanText_(texts[i]);
    if (!t || t === NOTE_TEXT_) continue;
    if (isChapterLineText_(normalizeChapterLine_(t))) return i;
  }
  return -1;
}

function getChapterTitleInfoFromActiveBody_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const texts = paras.map(function(p) { return p.getText(); });
  const headingIndex = findChapterHeadingIndexInTexts_(texts, 120);
  if (headingIndex === -1) return null;
  return parseChapterTitleFromLinesPure_(texts, headingIndex, 6);
}

/**
 * ตัดสินใจ layout ของหัวบทตาม WEBAPP_CHAPTER_TITLE_CONFIG_.LAYOUT_MODE
 * KEEP_EXISTING (ค่าเริ่มต้นของ Web app): ไม่แก้โครงสร้าง paragraph เลย
 * - ไม่เรียก splitChapterTitleToNextLine_() อัตโนมัติ
 * - ฟังก์ชัน splitChapterTitleToNextLine_() ยังอยู่ครบเพื่อ compatibility
 *   (เมนู/โค้ดอื่นเรียกตรงได้ และโหมด SPLIT_NEXT_LINE ก็เรียกผ่านฟังก์ชันนี้)
 */
function resolveChapterTitleLayoutReport_() {
  const startedAt = startTimer_();
  const mode = (WEBAPP_CHAPTER_TITLE_CONFIG_ && WEBAPP_CHAPTER_TITLE_CONFIG_.LAYOUT_MODE) || 'KEEP_EXISTING';

  const report = {
    titleLayoutMode: mode,
    titleParagraphInserted: 0,
    titleParagraphUpdated: 0,
    titleLayoutSkipped: 0,
    chapterNumber: null,
    chapterTitle: '',
    sameLine: null,
    splitResult: { changed: 0, from: '', to: '' },
    elapsedMs: 0
  };

  const info = getChapterTitleInfoFromActiveBody_();
  if (!info) {
    report.elapsedMs = endTimer_(startedAt);
    return report;
  }

  report.chapterNumber = info.chapterNumber;
  report.chapterTitle = info.title;
  report.sameLine = info.sameLine;

  if (mode === 'SPLIT_NEXT_LINE') {
    if (info.sameLine && info.title && typeof splitChapterTitleToNextLine_ === 'function') {
      const splitResult = splitChapterTitleToNextLine_();
      report.splitResult = splitResult || report.splitResult;
      if (splitResult && splitResult.changed) {
        report.titleParagraphInserted = 1;
      } else {
        report.titleLayoutSkipped = 1;
      }
    } else {
      report.titleLayoutSkipped = 1;
    }
  } else if (mode === 'KEEP_SAME_LINE') {
    if (!info.sameLine && info.titleParagraphIndex !== -1 && typeof mergeChapterTitleBackInActiveTab_ === 'function') {
      const mergeResult = mergeChapterTitleBackInActiveTab_();
      if (mergeResult && mergeResult.changed) {
        report.titleParagraphUpdated = 1;
      } else {
        report.titleLayoutSkipped = 1;
      }
    } else {
      report.titleLayoutSkipped = 1;
    }
  } else {
    // KEEP_EXISTING: คงโครงสร้างเดิมเสมอ ไม่ว่าจะอยู่บรรทัดเดียวหรือแยกบรรทัด
    report.titleLayoutSkipped = 1;
  }

  report.elapsedMs = endTimer_(startedAt);
  return report;
}

/* =========================================================
 * Web app: ลบต้นฉบับภาษาอังกฤษที่ติดมาก่อนหัวบทแปลภาษาไทย
 * ต้องรันก่อน removeLatinBasedSpecialCharacters()/titleConvertAndReport_()/
 * checkChapterSequenceInBody_() ไม่เช่นนั้นหัว "Chapter N" ของต้นฉบับ
 * อาจถูกนับเป็นเลขบท หรือถูกแปลงเป็น "บทที่ N" ปลอมๆ
 * ========================================================= */

/** "Chapter 365" / "Chapter 365: Title" / "Ch. 365" / "Ch 365" / "Episode 365" / "EP 365" / "EP.365" */
function parseEnglishChapterHeading_(text) {
  const s = String(text || '').replace(INVIS_RE_, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const m = s.match(/^(Chapter|Episode|Ch\.?|EP\.?)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:[:\-–—]\s*(.*))?$/i);
  if (!m) return null;

  return {
    label: m[1],
    number: m[2],
    rest: String(m[3] || '').trim(),
    text: s
  };
}

/** "บทที่ 386" / "บท 386" / "ตอนที่ 386" / "บทที่ [386]" */
function findThaiTranslatedChapterHeading_(lines, fromIndex, maxScan) {
  const limit = Math.min(lines.length, fromIndex + Math.max(1, Number(maxScan || 300)));
  for (let i = fromIndex; i < limit; i++) {
    const t = cleanText_(lines[i]);
    if (!t || t === NOTE_TEXT_ || isStatusPanelLine_(t)) continue;
    if (/^(?:บทที่|บท|ตอนที่)\s*\[?\s*[0-9๐-๙]+/.test(t)) {
      return { index: i, text: t };
    }
    // เจอหัวอังกฤษซ้ำอีกจุดก่อนเจอหัวไทย: หยุดสแกนกันข้ามหลายบทเกินจำเป็น
    if (parseEnglishChapterHeading_(t)) return null;
  }
  return null;
}

/** สัดส่วนตัวอักษรละติน (a-z) เทียบตัวอักษรทั้งหมด (ทุกภาษา) ในข้อความ */
function calculateLatinRatio_(text) {
  const s = String(text || '');
  const letters = s.match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  const latin = s.match(/[A-Za-z]/g) || [];
  return latin.length / letters.length;
}

/**
 * ตรวจต้นฉบับอังกฤษที่ติดมาก่อนหัวบทแปลไทย จากอาร์เรย์ข้อความ paragraph ล้วนๆ
 * เงื่อนไขความมั่นใจสูง (HIGH) ต้องผ่านครบ:
 * 1) ย่อหน้าแรกที่มีความหมายของแท็บ ต้องเป็นหัวบทอังกฤษ (parseEnglishChapterHeading_)
 * 2) หลังจากนั้นต้องเจอหัวบทไทยก่อนจบช่วงสแกน (findThaiTranslatedChapterHeading_)
 * 3) จำนวนย่อหน้าเนื้อหาอังกฤษระหว่างหัวอังกฤษ-หัวไทย >= MIN_ENGLISH_PARAGRAPHS
 * 4) สัดส่วนตัวอักษรละตินของย่อหน้าช่วงนั้น >= MIN_LATIN_RATIO
 * 5) หลังหัวบทไทยมีย่อหน้าเนื้อหาไทยจริง >= MIN_THAI_PARAGRAPHS_AFTER_HEADING
 */
function detectEnglishSourceBlock_(lines, cfg) {
  cfg = cfg || ENGLISH_SOURCE_CLEANUP_CONFIG_;
  const maxScan = Math.max(10, Number(cfg.MAX_SCAN_PARAGRAPHS || 300));
  const n = Math.min(lines.length, maxScan);

  let firstIdx = -1;
  for (let i = 0; i < n; i++) {
    const t = cleanText_(lines[i]);
    if (!t || t === NOTE_TEXT_ || isStatusPanelLine_(t)) continue;
    firstIdx = i;
    break;
  }
  if (firstIdx === -1) return { detected: false, reason: 'empty' };

  const heading = parseEnglishChapterHeading_(cleanText_(lines[firstIdx]));
  if (!heading) return { detected: false, reason: 'no_english_heading' };

  const thaiHeading = findThaiTranslatedChapterHeading_(lines, firstIdx + 1, n - firstIdx);
  if (!thaiHeading) return { detected: false, reason: 'no_thai_heading_after' };
  const thaiIdx = thaiHeading.index;

  const englishParas = [];
  for (let k = firstIdx; k < thaiIdx; k++) {
    const tk = cleanText_(lines[k]);
    if (!tk || tk === NOTE_TEXT_ || isStatusPanelLine_(tk)) continue;
    englishParas.push({ index: k, text: tk });
  }
  const bodyOnlyParas = englishParas.slice(1); // ไม่นับบรรทัดหัวบทอังกฤษเอง

  const combinedText = bodyOnlyParas.map(function(p) { return p.text; }).join(' ') || heading.text;
  const latinRatio = calculateLatinRatio_(combinedText);

  const minEnglishParas = Math.max(0, Number(cfg.MIN_ENGLISH_PARAGRAPHS || 0));
  const minLatinRatio = cfg.MIN_LATIN_RATIO != null ? Number(cfg.MIN_LATIN_RATIO) : 0.65;
  const minThaiAfter = Math.max(0, Number(cfg.MIN_THAI_PARAGRAPHS_AFTER_HEADING || 0));

  let thaiAfterCount = 0;
  for (let m2 = thaiIdx + 1; m2 < n && thaiAfterCount < minThaiAfter + 3; m2++) {
    const tm = cleanText_(lines[m2]);
    if (!tm || tm === NOTE_TEXT_ || isStatusPanelLine_(tm)) continue;
    if (/^(?:บทที่|บท|ตอนที่)\s*\[?\s*[0-9๐-๙]+/.test(tm)) break;
    if (calculateLatinRatio_(tm) < minLatinRatio) thaiAfterCount++;
  }

  const hasEnoughEnglishParas = bodyOnlyParas.length >= minEnglishParas;
  const hasHighLatinRatio = latinRatio >= minLatinRatio;
  const hasThaiContentAfter = thaiAfterCount >= minThaiAfter;
  const confidence = (hasEnoughEnglishParas && hasHighLatinRatio && hasThaiContentAfter) ? 'HIGH' : 'LOW';

  return {
    detected: true,
    confidence: confidence,
    englishHeadingText: cleanText_(lines[firstIdx]),
    thaiHeadingText: thaiHeading.text,
    startIndex: firstIdx,
    endIndex: thaiIdx - 1,
    removedParagraphCount: thaiIdx - firstIdx,
    englishParagraphCount: bodyOnlyParas.length,
    latinRatio: latinRatio,
    thaiAfterCount: thaiAfterCount,
    examples: englishParas.slice(0, 3).map(function(p) { return p.text; })
  };
}

/** ลบ paragraph ตั้งแต่หัวบทอังกฤษถึง paragraph ก่อนหน้าหัวบทไทย (ความมั่นใจสูงเท่านั้น) */
function removeEnglishSourceBlock_(body, blockInfo, cfg, paras) {
  // Fix timeout: รับ paras ที่ผู้เรียกอ่านไว้แล้วได้ (getParagraphs() ซ้ำเป็น Docs API call ที่ไม่จำเป็น)
  paras = paras || body.getParagraphs();
  const keepHeading = !!(cfg && cfg.KEEP_ENGLISH_HEADING);
  const fromIdx = keepHeading ? blockInfo.startIndex + 1 : blockInfo.startIndex;
  const toIdx = blockInfo.endIndex;
  if (toIdx < fromIdx) return 0;

  for (let i = toIdx; i >= fromIdx; i--) {
    if (paras[i]) removeParaSafely_(paras[i]);
  }
  return toIdx - fromIdx + 1;
}

/**
 * Entry point: ตรวจ + ลบต้นฉบับภาษาอังกฤษก่อนบทแปล (เฉพาะความมั่นใจสูง)
 * กรณีไม่มั่นใจ: report ไว้เฉยๆ ไม่แก้เอกสาร
 */
function detectAndRemoveEnglishSourceBeforeThaiChapter_() {
  const cfg = ENGLISH_SOURCE_CLEANUP_CONFIG_;
  const emptyReport = {
    detected: 0,
    removed: 0,
    removedParagraphs: 0,
    englishHeading: '',
    thaiHeading: '',
    startParagraphIndex: null,
    endParagraphIndex: null,
    confidence: null,
    examples: []
  };

  if (!cfg || cfg.ENABLED === false) return emptyReport;

  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const texts = paras.map(function(p) { return p.getText(); });

  const blockInfo = detectEnglishSourceBlock_(texts, cfg);
  if (!blockInfo.detected) return emptyReport;

  if (blockInfo.confidence !== 'HIGH' && cfg.REPORT_UNCERTAIN_CASES === false) {
    return emptyReport;
  }

  const report = {
    detected: 1,
    removed: 0,
    removedParagraphs: 0,
    englishHeading: blockInfo.englishHeadingText,
    thaiHeading: blockInfo.thaiHeadingText,
    startParagraphIndex: blockInfo.startIndex + 1,
    endParagraphIndex: blockInfo.endIndex + 1,
    confidence: blockInfo.confidence,
    examples: blockInfo.confidence === 'HIGH' ? [] : blockInfo.examples
  };

  if (blockInfo.confidence === 'HIGH' && cfg.AUTO_REMOVE_HIGH_CONFIDENCE !== false) {
    const removedCount = removeEnglishSourceBlock_(body, blockInfo, cfg, paras);
    report.removed = removedCount > 0 ? 1 : 0;
    report.removedParagraphs = removedCount;
  }

  return report;
}

/* =========================================================
 * Web app: หมายเหตุ "ต้นฉบับไม่มีบทที่" (report-only)
 * ห้ามลบข้อความออกจาก Google Docs ในฟีเจอร์นี้ - บันทึกเป็นหมายเหตุเท่านั้น
 * ========================================================= */
const SOURCE_NO_CHAPTER_PATTERNS_ = [
  /ต้นฉบับไม่มีบทที่/,
  /ต้นฉบับไม่มีเลขบท/,
  /ต้นฉบับไม่ได้ระบุบทที่/,
  /ต้นฉบับไม่ได้ระบุเลขบท/,
  /ไม่มีเลขบทในต้นฉบับ/
];

function detectSourceNoChapterNoteInLines_(lines, cfg) {
  cfg = cfg || SOURCE_NO_CHAPTER_NOTE_CONFIG_;
  if (!cfg || cfg.ENABLED === false) return { found: false };

  const limit = Math.max(1, Number(cfg.TOP_MEANINGFUL_PARAGRAPH_LIMIT || 10));
  let scanned = 0;

  for (let i = 0; i < lines.length && scanned < limit; i++) {
    const t = cleanText_(lines[i]);
    if (!t) continue;
    if (t === NOTE_TEXT_) continue;
    if (t === WM_TEXT) continue;
    if (isStatusPanelLine_(t)) continue;
    scanned++;

    for (let p = 0; p < SOURCE_NO_CHAPTER_PATTERNS_.length; p++) {
      if (SOURCE_NO_CHAPTER_PATTERNS_[p].test(t)) {
        return { found: true, paragraphIndex: i, matchedText: t };
      }
    }
  }

  return { found: false };
}

function detectSourceNoChapterNote_() {
  const emptyReport = { found: 0, note: '', paragraphIndex: null, matchedText: '' };
  if (!SOURCE_NO_CHAPTER_NOTE_CONFIG_ || SOURCE_NO_CHAPTER_NOTE_CONFIG_.ENABLED === false) {
    return emptyReport;
  }

  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const texts = paras.map(function(p) { return p.getText(); });
  const result = detectSourceNoChapterNoteInLines_(texts, SOURCE_NO_CHAPTER_NOTE_CONFIG_);

  if (!result.found) return emptyReport;

  return {
    found: 1,
    note: 'ต้นฉบับไม่มีบทที่',
    paragraphIndex: result.paragraphIndex + 1,
    matchedText: result.matchedText
  };
}

/* =========================================================
 * Web app: ลบข้อความโปรโมต/ปิดท้ายที่ไม่ต้องการ + บังคับให้มี "จบตอน" ท้ายบท
 * ตรวจเฉพาะ ENDING_CLEANUP_CONFIG_.TAIL_PARAGRAPH_SCAN_LIMIT ย่อหน้าสุดท้ายของแท็บ
 * ห้ามลบเพียงเพราะเจอคำว่า "โปรดติดตามตอนต่อไป" กลางบท - ต้องอยู่ในช่วงท้ายเท่านั้น
 * ========================================================= */
const ENDING_PROMO_PATTERNS_ = [
  // "โปรดติดตามตอนต่อไป" / "...นะ" / "...ครับ" / "...ค่ะ" / ปิดท้ายด้วย ! . …
  /^โปรดติดตามตอนต่อไป(?:นะ|ครับ|ค่ะ)?[!.…]*$/,
  // "ฝากติดตามเพจ Ipe นิยายแปล" (case-insensitive เฉพาะ Ipe) / "...ด้วยนะ" / "...ครับ" / "...ค่ะ"
  /^ฝากติดตามเพจ\s*ipe\s*นิยายแปล(?:\s*(?:ด้วยนะ|นะ|ครับ|ค่ะ))?[!.…]*$/i
];

/** ตัด invisible char / NBSP / full-width space แล้วยุบช่องว่างซ้ำ ก่อนเทียบรูปแบบข้อความปิดท้าย */
function normalizeEndingLineText_(text) {
  return String(text || '')
    .replace(INVIS_RE_, '')
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ข้อความปิดท้ายที่ควรลบ เช่น "โปรดติดตามตอนต่อไป" / "ฝากติดตามเพจ Ipe นิยายแปล" (รองรับรูปแบบใกล้เคียง) */
function isRemovableEndingPromoLine_(text) {
  const normalized = normalizeEndingLineText_(text);
  if (!normalized) return false;
  return ENDING_PROMO_PATTERNS_.some(function(re) { return re.test(normalized); });
}

/** ตรวจว่าเป็นบรรทัด "จบตอน" (ยอมรับเครื่องหมาย ! . … ปิดท้ายเล็กน้อย) หรือไม่ */
function isEndMarkerLine_(text, cfg) {
  cfg = cfg || ENDING_CLEANUP_CONFIG_;
  const marker = normalizeEndingLineText_(cfg && cfg.END_MARKER_TEXT || 'จบตอน');
  if (!marker) return false;
  const normalized = normalizeEndingLineText_(text).replace(/[!.…]+$/, '').trim();
  return normalized === marker;
}

/**
 * ลบข้อความโปรโมตท้ายบท + บังคับให้มี "จบตอน" อยู่ท้ายบทเสมอ (ไม่ซ้ำ)
 * - ตรวจ/ลบเฉพาะย่อหน้าในช่วงท้ายแท็บ (TAIL_PARAGRAPH_SCAN_LIMIT) เท่านั้น
 * - ลบย่อหน้าโปรโมตจากล่างขึ้นบนเพื่อไม่ให้ index เอกสารเลื่อนผิด
 * - idempotent: รันซ้ำแล้ว changed=false ถ้าไม่มีอะไรต้องแก้เพิ่ม
 */
function cleanupEndingPromoAndEnsureEndMarker_() {
  const cfg = ENDING_CLEANUP_CONFIG_;
  const emptyReport = {
    changed: false,
    removedPromoLines: 0,
    removedPromoExamples: [],
    hadEndMarker: false,
    insertedEndMarker: false,
    dedupedEndMarker: 0,
    scannedTailParagraphs: 0
  };

  if (!cfg || cfg.ENABLED === false) return emptyReport;

  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const total = paras.length;
  const scanLimit = Math.max(1, Number(cfg.TAIL_PARAGRAPH_SCAN_LIMIT || 15));
  const startIdx = Math.max(0, total - scanLimit);

  const promoIndices = [];
  const endMarkerIndices = [];

  for (let i = startIdx; i < total; i++) {
    const text = cleanText_(paras[i].getText());
    if (!text || text === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(text)) continue;

    if (isEndMarkerLine_(text, cfg)) {
      endMarkerIndices.push(i);
    } else if (isRemovableEndingPromoLine_(text)) {
      promoIndices.push(i);
    }
  }

  const hadEndMarker = endMarkerIndices.length > 0;

  let removedPromoLines = 0;
  const removedPromoExamples = [];
  if (cfg.AUTO_REMOVE_PROMO_LINES !== false) {
    for (let i = promoIndices.length - 1; i >= 0; i--) {
      const idx = promoIndices[i];
      const p = paras[idx];
      const text = cleanText_(p.getText());
      if (removeParaSafely_(p)) {
        removedPromoLines++;
        removedPromoExamples.unshift(text);
      }
    }
  }

  // เหลือ "จบตอน" ไว้แค่บรรทัดสุดท้าย (ใกล้ท้ายบทที่สุด) ลบตัวซ้ำที่เหลือจากล่างขึ้นบน
  let dedupedEndMarker = 0;
  if (endMarkerIndices.length > 1) {
    const keepIdx = endMarkerIndices[endMarkerIndices.length - 1];
    for (let i = endMarkerIndices.length - 2; i >= 0; i--) {
      const idx = endMarkerIndices[i];
      if (idx === keepIdx) continue;
      if (removeParaSafely_(paras[idx])) dedupedEndMarker++;
    }
  }

  let insertedEndMarker = false;
  if (!hadEndMarker && cfg.AUTO_ENSURE_END_MARKER !== false) {
    body.appendParagraph(String(cfg.END_MARKER_TEXT || 'จบตอน'));
    insertedEndMarker = true;
  }

  return {
    changed: removedPromoLines > 0 || dedupedEndMarker > 0 || insertedEndMarker,
    removedPromoLines: removedPromoLines,
    removedPromoExamples: removedPromoExamples.slice(0, 10),
    hadEndMarker: hadEndMarker,
    insertedEndMarker: insertedEndMarker,
    dedupedEndMarker: dedupedEndMarker,
    scannedTailParagraphs: total - startIdx
  };
}

/**
 * V11.11: รวมการตรวจทั้งหมดแบบไฟล์เดียว
 * หมายเหตุ: ไม่เรียก removeBonusVoteParentheses() ในนี้
 * เพราะให้ runAllChecksWithBonusCleanup_() เป็นตัวครอบ เพื่อกันการลบ/นับซ้ำ
 */
function runAllChecks() {
  const totalStartedAt = startTimer_();
  const performanceTimings = {};

  // Fix timeout: เตรียมโครงสร้างโหมดตรวจแบบเบาไว้ล่วงหน้า (ยังไม่เปิด VALIDATE_ONLY เป็นค่าเริ่มต้น)
  // VALIDATE_ONLY จะข้ามเฉพาะ formatParagraphIndent/setParagraphSpacing/setFontToSarabun16
  // (จัดฟอนต์/indent/spacing ทั้งเอกสาร) ส่วนตรวจคำต่างประเทศ/เลขบท/หมายเหตุ/English source/
  // ข้อความท้ายบท ยังทำงานเหมือนเดิมทุกโหมด
  const checkerRunMode = (typeof CHECKER_RUN_MODE_CONFIG_ !== 'undefined' && CHECKER_RUN_MODE_CONFIG_ && CHECKER_RUN_MODE_CONFIG_.MODE) || 'FULL';
  const isValidateOnlyRun = checkerRunMode === 'VALIDATE_ONLY';

  // 1) บันทึกหมายเหตุ "ต้นฉบับไม่มีบทที่" ก่อนขั้นตอนอื่นใด (report-only ไม่แก้เอกสาร)
  const sourceNoChapterNote = (typeof detectSourceNoChapterNote_ === 'function')
    ? runTimedStep_(performanceTimings, 'detectSourceNoChapterNote', function() {
        return detectSourceNoChapterNote_();
      })
    : { found: 0, note: '', paragraphIndex: null, matchedText: '' };

  // 2) ลบต้นฉบับภาษาอังกฤษก่อนบทแปล (เฉพาะความมั่นใจสูง) ก่อน removeLatinBasedSpecialCharacters()/
  //    titleConvertAndReport_()/checkChapterSequenceInBody_() ไม่เช่นนั้นหัว "Chapter N" ของต้นฉบับ
  //    อาจถูกนับเป็นเลขบทจริง หรือถูกแปลงเป็น "บทที่ N" ปลอมๆ
  const englishSourceCleanup = (typeof detectAndRemoveEnglishSourceBeforeThaiChapter_ === 'function')
    ? runTimedStep_(performanceTimings, 'detectAndRemoveEnglishSourceBeforeThaiChapter', function() {
        return detectAndRemoveEnglishSourceBeforeThaiChapter_();
      })
    : { detected: 0, removed: 0, removedParagraphs: 0, englishHeading: '', thaiHeading: '', confidence: null, examples: [] };

  const rep = runTimedStep_(performanceTimings, 'replaceEmDashWithEllipsis', function() {
    return replaceEmDashWithEllipsis();
  });
  const replacedEmDashCount = Number(rep && rep.emDashCount || 0);
  const replacedWawCount = Number(rep && rep.wawCount || 0);

  const latinSpecialRemoved = (typeof removeLatinBasedSpecialCharacters === 'function')
    ? runTimedStep_(performanceTimings, 'removeLatinBasedSpecialCharacters', function() {
        return removeLatinBasedSpecialCharacters();
      })
    : { preCount: 0, markCount: 0, total: 0 };

  const nonThaiCount = (typeof highlightForeignCharacters === 'function')
    ? Number(runTimedStep_(performanceTimings, 'highlightForeignCharacters', function() {
        return highlightForeignCharacters();
      }) || 0)
    : 0;

  // ลบ [เลขบท] ที่ติดหัวบท / แปลงหัวบท / จัดหัวบท
  const removedLeadingBracketTagsBefore = (typeof removeLeadingBracketTagsNearChapter_ === 'function')
    ? runTimedStep_(performanceTimings, 'removeLeadingBracketTagsBefore', function() {
        return removeLeadingBracketTagsNearChapter_();
      })
    : { removed: 0, removedTexts: [] };

  const titleReport = (typeof titleConvertAndReport_ === 'function')
    ? runTimedStep_(performanceTimings, 'titleConvertAndReport', function() {
        return titleConvertAndReport_();
      })
    : { changed: false, episodeChanged: false, chapterChanged: false, from: '', to: '' };

  const removedLeadingBracketTagsAfterTitle = (typeof removeLeadingBracketTagsNearChapter_ === 'function')
    ? runTimedStep_(performanceTimings, 'removeLeadingBracketTagsAfterTitle', function() {
        return removeLeadingBracketTagsNearChapter_();
      })
    : { removed: 0, removedTexts: [] };

  // ต้องจัดหัวบท/ลบเลขตอนก่อนรวมชื่อบทกลับให้อยู่บรรทัดเดียวกับเลขบท
  const chapterHeadingCleanup = (typeof cleanChapterHeadingAndEpisodePrefix_ === 'function')
    ? runTimedStep_(performanceTimings, 'chapterHeadingCleanup', function() {
        return cleanChapterHeadingAndEpisodePrefix_();
      })
    : { changed: 0, episodePrefixRemoved: 0, looseChapterFixed: 0, removedLines: 0, changes: [] };

  const removedTitleParens = (typeof removeParenthesesInChapterTitle === 'function')
    ? Number(runTimedStep_(performanceTimings, 'removeParenthesesInChapterTitle', function() {
        return removeParenthesesInChapterTitle();
      }) || 0)
    : 0;

  // V11.12: เลิกแยกชื่อบทลง paragraph ใหม่ และรวมกลับให้เป็น paragraph เดียวเสมอ
  const mergedTitleLine = (typeof mergeChapterTitleBackInActiveTab_ === 'function')
    ? runTimedStep_(performanceTimings, 'mergeChapterTitleBackInActiveTab', function() {
        return mergeChapterTitleBackInActiveTab_();
      })
    : { changed: 0, from: '', to: '' };

  // เก็บ report รูปแบบเดียวกับ Web app main ล่าสุด เพื่อให้ batch/finalize สะสมผลได้ครบ
  const titleLayoutReport = (typeof resolveChapterTitleLayoutReport_ === 'function')
    ? runTimedStep_(performanceTimings, 'resolveChapterTitleLayout', function() {
        return resolveChapterTitleLayoutReport_();
      })
    : {
        titleLayoutMode: 'KEEP_EXISTING', titleParagraphInserted: 0, titleParagraphUpdated: 0,
        titleLayoutSkipped: 0, chapterNumber: null, chapterTitle: '', sameLine: null,
        splitResult: { changed: 0, from: '', to: '' }, elapsedMs: 0
      };
  if (mergedTitleLine && mergedTitleLine.changed) {
    titleLayoutReport.titleLayoutMode = 'KEEP_SAME_LINE';
    titleLayoutReport.titleParagraphUpdated = Math.max(1, Number(titleLayoutReport.titleParagraphUpdated || 0));
    titleLayoutReport.titleLayoutSkipped = 0;
    titleLayoutReport.sameLine = true;
  }
  const splitTitleLine = titleLayoutReport.splitResult || { changed: 0, from: '', to: '' };

  const redundantEpisodeTitleRemoved = runTimedStep_(
    performanceTimings,
    'removeRedundantEpisodeTitleAfterChapter',
    function() { return removeRedundantEpisodeTitleAfterChapter_(); }
  );

  const duplicateChapterHeadingRemoved = (typeof removeDuplicateChapterHeadingLines_ === 'function')
    ? removeDuplicateChapterHeadingLines_()
    : { removed: 0, removedTexts: [] };

  const duplicateChapterTitleRemoved = (typeof removeDuplicateChapterTitleLines_ === 'function')
    ? removeDuplicateChapterTitleLines_()
    : { removed: 0, removedTexts: [] };

  const duplicateBracketChapterRemoved = (typeof removeDuplicateBracketChapterLine_ === 'function')
    ? removeDuplicateBracketChapterLine_()
    : { removed: 0, removedTexts: [], chapterNumber: null };

  const removedLeadingBracketTagsAfterSplit = (typeof removeLeadingBracketTagsNearChapter_ === 'function')
    ? removeLeadingBracketTagsNearChapter_()
    : { removed: 0, removedTexts: [] };

  const removedLeadingBracketTags = (typeof mergeLeadingBracketRemovalReports_ === 'function')
    ? mergeLeadingBracketRemovalReports_(
        removedLeadingBracketTagsBefore,
        removedLeadingBracketTagsAfterTitle,
        removedLeadingBracketTagsAfterSplit
      )
    : removedLeadingBracketTagsAfterSplit;

  const breakPairs = (typeof breakAdjacentQuoteAndBracketPairs === 'function')
    ? breakAdjacentQuoteAndBracketPairs()
    : { quotePairs: 0, bracketPairs: 0, total: 0 };

  const bracketStatusSplit = (typeof splitBracketedStatusBlocks_ === 'function')
    ? splitBracketedStatusBlocks_()
    : { paragraphsTouched: 0, newParagraphs: 0, blocks: 0 };

  // เดิม formatParagraphIndent() และ setParagraphSpacing() สแกนทั้ง body คนละรอบ
  // ใน workflow หลักรวมเป็น pass เดียว แต่คงฟังก์ชัน public เดิมไว้ครบ
  // VALIDATE_ONLY: ข้ามการจัด indent/spacing ทั้งเอกสาร (ขั้นตอนที่กินเวลามากสุดขั้นหนึ่ง)
  const paragraphLayout = isValidateOnlyRun
    ? { indentCount: 0, spacingCount: 0 }
    : (typeof formatParagraphLayout_ === 'function')
    ? runTimedStep_(performanceTimings, 'formatParagraphLayout', function() {
        return formatParagraphLayout_(getActiveBody_(), {
          applyIndent: true,
          applySpacing: true,
          indent: 36,
          spacingAfter: 10
        });
      })
    : {
        indentCount: (typeof formatParagraphIndent === 'function') ? Number(formatParagraphIndent() || 0) : 0,
        spacingCount: (typeof setParagraphSpacing === 'function') ? Number(setParagraphSpacing(10) || 0) : 0
      };
  const paragraphCount = Number(paragraphLayout.indentCount || 0);
  const spacingCount = Number(paragraphLayout.spacingCount || 0);

  const blankRemoved = (typeof removeAllBlankLines === 'function')
    ? Number(runTimedStep_(performanceTimings, 'removeAllBlankLines', function() {
        return removeAllBlankLines();
      }) || 0)
    : 0;

  // VALIDATE_ONLY: ข้ามการจัดฟอนต์ทั้งเอกสาร (ต้องไล่ setFontFamily/setFontSize ทุก text node)
  if (!isValidateOnlyRun && typeof setFontToSarabun16 === 'function') {
    runTimedStep_(performanceTimings, 'setFontToSarabun16', function() {
      return setFontToSarabun16();
    });
  }

  const removedCount = (typeof removeEnglishInParentheses === 'function')
    ? Number(removeEnglishInParentheses(false) || 0)
    : 0;

  const removedThaiNoteParentheses = (typeof removeThaiNoteParentheses === 'function')
    ? Number(removeThaiNoteParentheses() || 0)
    : 0;

  if (nonThaiCount === 0 && typeof underlineFirstLine === 'function') {
    underlineFirstLine();
  }

  const chapterSequence = (typeof checkChapterSequenceInBody_ === 'function')
    ? runTimedStep_(performanceTimings, 'checkChapterSequenceInBody', function() {
        return checkChapterSequenceInBody_();
      })
    : { ok: true, totalFound: 0, chapters: [], issues: [] };

  // V11.12: ตรวจประโยคภาษาอังกฤษยาวที่ Gemini แปลไม่หมด (เก็บเฉพาะจำนวนย่อหน้า)
  const longEnglish = (typeof checkerScanLongEnglishParagraphsInActiveBody_ === 'function')
    ? runTimedStep_(performanceTimings, 'checkerScanLongEnglishParagraphs', function() {
        return checkerScanLongEnglishParagraphsInActiveBody_();
      })
    : { paragraphCount: 0 };
  const longEnglishParagraphCount = Number(longEnglish && longEnglish.paragraphCount || 0);

  // ลบข้อความปิดท้าย/โปรโมตท้ายบท + บังคับให้มี "จบตอน" - รันหลัง cleanup เนื้อหาหลักทั้งหมดแล้ว
  // เพื่อลดโอกาสที่ logic อื่นจะไปยุ่งกับ "จบตอน" ที่เพิ่งเพิ่ม
  const endingCleanup = (typeof cleanupEndingPromoAndEnsureEndMarker_ === 'function')
    ? runTimedStep_(performanceTimings, 'cleanupEndingPromoAndEnsureEndMarker', function() {
        return cleanupEndingPromoAndEnsureEndMarker_();
      })
    : {
        changed: false, removedPromoLines: 0, removedPromoExamples: [], hadEndMarker: false,
        insertedEndMarker: false, dedupedEndMarker: 0, scannedTailParagraphs: 0
      };
  const reportEvents = buildRunReportEvents_({
    longEnglishParagraphCount: longEnglishParagraphCount,
    nonThaiCount: nonThaiCount,
    chapterHeadingCleanup: chapterHeadingCleanup,
    chapterSequence: chapterSequence
  });

  performanceTimings.total = endTimer_(totalStartedAt);
  logSlowStep_(
    'total per tab',
    performanceTimings.total,
    getCurrentTabTitle_(),
    !!(PERFORMANCE_LOG_CONFIG_ && PERFORMANCE_LOG_CONFIG_.LOG_EACH_TAB)
  );

  return {
    replacedEmDashCount: replacedEmDashCount,
    replacedWawCount: replacedWawCount,
    latinSpecialRemoved: latinSpecialRemoved,
    nonThaiCount: nonThaiCount,
    paragraphCount: paragraphCount,
    spacingCount: spacingCount,
    blankRemoved: blankRemoved,
    removedCount: removedCount,
    removedThaiNoteParentheses: removedThaiNoteParentheses,
    breakPairs: breakPairs,
    titleReport: titleReport,
    chapterHeadingCleanup: chapterHeadingCleanup,
    removedLeadingBracketTags: removedLeadingBracketTags,
    bracketStatusSplit: bracketStatusSplit,
    removedTitleParens: removedTitleParens,
    splitTitleLine: { changed: 0, from: '', to: '' },
    mergedTitleLine: mergedTitleLine,
    duplicateChapterHeadingRemoved: duplicateChapterHeadingRemoved,
    duplicateChapterTitleRemoved: duplicateChapterTitleRemoved,
    duplicateBracketChapterRemoved: duplicateBracketChapterRemoved,
    chapterSequence: chapterSequence,
    longEnglishParagraphCount: longEnglishParagraphCount,
    redundantEpisodeTitleRemoved,
    sourceNoChapterNote: sourceNoChapterNote,
    englishSourceCleanup: englishSourceCleanup,
    titleLayoutReport: titleLayoutReport,
    endingCleanup: endingCleanup,
    checkerRunMode: checkerRunMode,
    performanceTimings: performanceTimings,
    reportEvents: reportEvents
  };
}

function runAllChecksWithAlert() {
  if (typeof resetForeignWordAllowListCache_ === 'function') resetForeignWordAllowListCache_();
  const result = runAllChecksAllTabs();

  const epTabs = result.titleEpisodeTabs || [];
  const chTabs = result.titleChapterTabs || [];
  const changedWords = Number(result.titleEpisodeCount || 0) + Number(result.titleChapterCount || 0);

  const lines = [
    '🧾 ตรวจแล้ว: ' + (result.tabChecked || 0) + '/' + (result.tabTotal || 0) + ' แท็บ',
    '🔁 แทนที่ "—" เป็น "..." แล้ว ' + (result.replacedEmDashCount || 0) + ' ตำแหน่ง',
    '🔁 แก้ "و" เป็น "ล" แล้ว ' + (result.replacedWawCount || 0) + ' ตำแหน่ง',
    '🗑️ ลบอักษรละตินพิเศษแล้ว ' + (result.latinSpecialRemovedTotal || 0) + ' ตัว',
    '🔍 พบตัวอักษรต่างประเทศรวม ' + (result.nonThaiCount || 0) + ' ตัว',
    '↩️ แยกบรรทัดรวม ' + (result.breakPairsTotal || 0) + ' จุด',
    '📑 จัดรูปแบบย่อหน้ารวม ' + (result.paragraphCount || 0) + ' ย่อหน้า',
    '📏 เว้นระยะห่างรวม ' + (result.spacingCount || 0) + ' ย่อหน้า',
    '🧹 ลบบรรทัดว่างรวม ' + (result.blankRemoved || 0) + ' บรรทัด',
    '🗑️ ลบคำในวงเล็บรวม ' + (result.removedCount || 0) + ' ตำแหน่ง',
    '🗑️ ลบวงเล็บ/บล็อกโปรโมตรวม ' + (result.removedBonusParensTotal || 0) + ' จุด',
    '🧹 ลบบรรทัดว่างหลังลบวงเล็บรวม ' + (result.blankRemovedAfterBonusTotal || 0) + ' บรรทัด',
    '🏷️ ลบวงเล็บท้ายชื่อตอนรวม ' + (result.removedTitleParensTotal || 0) + ' จุด',
    '🧹 แก้หัวบท/ลบเลขตอนหน้าชื่อบทรวม ' + (result.chapterHeadingCleanupChangedTotal || 0) + ' จุด',
    '- ลบ “ตอนที่ N / N-N” หน้าชื่อบท ' + (result.episodePrefixRemovedTotal || 0) + ' จุด',
    '- แก้ “บท N:” เป็น “บทที่ N” ' + (result.looseChapterFixedTotal || 0) + ' จุด',
    '',
    (result.foreignTabNames && result.foreignTabNames.length > 0)
      ? ('📌 แท็บที่พบตัวอักษรต่างประเทศ:\n- ' + result.foreignTabNames.join('\n- '))
      : '💯 ไม่พบตัวอักษรต่างประเทศในทุกแท็บ',
    '',
    '🪄 เปลี่ยนเป็นบทที่ ' + changedWords + ' คำ'
  ];

  if (result.incomplete) {
    lines.splice(
      1,
      0,
      '⏸️ หยุดตาม Batch Limit — เริ่มรอบถัดไปที่แท็บลำดับ ' +
        (Number(result.nextTabIndex || 0) + 1)
    );
  }

  if (changedWords) {
    if (epTabs.length) lines.push('- ตอนที่→บทที่: ' + epTabs.length + ' แท็บ\n  • ' + epTabs.join('\n  • '));
    if (chTabs.length) lines.push('- Chapter→บทที่: ' + chTabs.length + ' แท็บ\n  • ' + chTabs.join('\n  • '));
  }

  const chapterIssues = result.chapterSequenceIssues || [];
  const hasDuplicate = !!result.hasDuplicateChapter || chapterIssues.some(function(x) { return x.type === 'เลขซ้ำ'; });
  const hasNonContinuous = chapterIssues.some(function(x) { return x.type !== 'เลขซ้ำ'; });

  lines.push('');
  if (result.chapterSequenceIncomplete) {
    lines.push('⚠️ ยังสรุปลำดับเลขบทข้ามแท็บไม่ได้ เพราะมีแท็บที่ตรวจไม่สำเร็จ');
  } else {
    if (hasNonContinuous) lines.push('⚠️ เลขบทไม่ต่อเนื่อง');
    if (hasDuplicate) lines.push('⚠️ เลขบทซ้ำ');
    if (!hasNonContinuous && !hasDuplicate) lines.push('✅ เลขบทต่อเนื่อง');
  }

  const sourceEpisodeMarkers = result.sourceEpisodeMarkers || [];
  if (sourceEpisodeMarkers.length) {
    lines.push(
      '',
      '📚 พบต้นฉบับหลายตอนรวมอยู่ในแท็บเดียว ' + sourceEpisodeMarkers.length + ' จุด'
    );

    sourceEpisodeMarkers.slice(0, 20).forEach(function(marker) {
      lines.push(
        '',
        'แท็บ ' + (marker.tabIndex || marker.tab || '-'),
        marker.chapterNumber == null ? 'บทปัจจุบัน: ไม่พบเลขบท' : 'บทที่ ' + marker.chapterNumber,
        'พบหัวตอนต้นฉบับ: ตอนที่ ' + marker.sourceEpisodeNumber,
        'Paragraph ' + marker.paragraphIndex,
        String(marker.text || '')
      );
    });

    if (sourceEpisodeMarkers.length > 20) {
      lines.push('', '…และอีก ' + (sourceEpisodeMarkers.length - 20) + ' จุด');
    }
    lines.push('', 'คำแนะนำ: ควรแยกเป็นอีก 1 บท หรือยืนยันว่าตั้งใจรวมหลายตอน');
  }

  const tabErrors = result.tabErrors || [];
  if (tabErrors.length) {
    lines.push(
      '',
      '❌ ตรวจแท็บไม่สำเร็จ ' + tabErrors.length + ' แท็บ' +
        ' (สำเร็จ ' + Number(result.tabSucceeded || 0) + '/' + Number(result.tabTotal || 0) + ')'
    );
    tabErrors.slice(0, 20).forEach(function(error) {
      lines.push(
        '- แท็บ ' + (error.tabIndex || error.tab || '-') + ': ' + String(error.message || 'ไม่ทราบสาเหตุ')
      );
    });
  }

  const englishRemovedTabs = Number(result.englishSourceRemovedTotal || 0);
  if (englishRemovedTabs > 0) {
    lines.push(
      '',
      '🧹 ลบต้นฉบับภาษาอังกฤษก่อนบทแปล ' + englishRemovedTabs + ' แท็บ รวม ' +
        Number(result.englishSourceRemovedParagraphsTotal || 0) + ' ย่อหน้า'
    );
  }

  const englishUncertainTabs = result.englishSourceUncertainTabs || [];
  if (englishUncertainTabs.length) {
    lines.push(
      '',
      '⚠️ อาจพบต้นฉบับภาษาอังกฤษ แต่ยังไม่ลบ ' + englishUncertainTabs.length + ' แท็บ:'
    );
    englishUncertainTabs.forEach(function(item) {
      lines.push('- แท็บ ' + (item.tabIndex || item.tab || '-'));
    });
  }

  const sourceNoChapterTabs = result.sourceNoChapterTabs || [];
  if (sourceNoChapterTabs.length) {
    lines.push('', '📝 ต้นฉบับไม่มีบทที่:');
    sourceNoChapterTabs.forEach(function(item) {
      lines.push('- แท็บ ' + (item.tabIndex || item.tab || '-'));
    });
  }

  lines.push(
    '',
    '🏷️ การจัดชื่อบท:',
    '- คง layout เดิม ' + Number(result.titleLayoutSkippedTotal || 0) + ' แท็บ',
    '- แยกชื่อบท ' + Number(result.titleParagraphInsertedTotal || 0) + ' แท็บ',
    '- ลดการเขียน paragraph ที่ไม่จำเป็น ' + Number(result.titleLayoutSkippedTotal || 0) + ' ครั้ง'
  );

  const endingPromoRemovedTotal = Number(result.endingPromoRemovedTotal || 0);
  if (endingPromoRemovedTotal > 0) {
    lines.push('', '🧹 ลบข้อความปิดท้ายโปรโมต ' + endingPromoRemovedTotal + ' บรรทัด');
  }

  const endingMarkerInsertedTotal = Number(result.endingMarkerInsertedTotal || 0);
  if (endingMarkerInsertedTotal > 0) {
    lines.push('✅ เติม "จบตอน" เพิ่ม ' + endingMarkerInsertedTotal + ' แท็บ');
  }

  lines.push('', '🎉 ดำเนินการเรียบร้อยแล้ว!');
  DocumentApp.getUi().alert(lines.join('\n'));
  return result;
}

/* =========================
 * Chapter sequence / duplicate content helpers
 * ========================= */

function extractChapterNumberFromText_(text) {
  const s = thaiDigitsToArabic_(String(text || ''))
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return null;

  let m = s.match(/^(?:บท(?:ที่)?|ตอนที่)\s*\[?\s*([0-9]+)/i);
  if (m) return Number(m[1]);

  m = s.match(/^chapter\s*([0-9]+)/i);
  if (m) return Number(m[1]);

  m = s.match(/\b(?:บทที่|ตอนที่|chapter)\s*([0-9]+)\b/i);
  if (m) return Number(m[1]);

  m = s.match(/^\[\s*([0-9]+)\s*\]/);
  if (m) return Number(m[1]);

  return null;
}

function collectChapterNumbersFromBody_(body) {
  return collectChapterScanFromBody_(body).chapters;
}

function parseSourceEpisodeMarker_(text, paragraphIndex, currentChapterNumber) {
  if (!SOURCE_EPISODE_CONFIG_ || SOURCE_EPISODE_CONFIG_.ENABLED === false) return null;

  const headerLimit = Math.max(0, Number(SOURCE_EPISODE_CONFIG_.HEADER_PARAGRAPH_LIMIT || 0));
  if (Number(paragraphIndex || 0) <= headerLimit) return null;

  const normalized = thaiDigitsToArabic_(String(text || ''))
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const digit = '[0-9]+(?:\\.[0-9]+)?';
  const rangeSeparator = '(?:[-–—]|\\.{2,})';
  const markerRe = new RegExp(
    '^(ตอนที่|ตอน|episode|ep)\\s*\\[?\\s*(' + digit +
      '(?:\\s*' + rangeSeparator + '\\s*' + digit + ')?)\\s*\\]?' +
      '(?:\\s*(?:[:：\\-–—]|\\.{2,})\\s*|\\s+|$)',
    'i'
  );
  const match = normalized.match(markerRe);
  if (!match) return null;

  return {
    type: 'SOURCE_EPISODE_MARKER',
    problemCode: CHECKER_PROBLEM_CODES_.SOURCE_EPISODE_MARKER,
    sourceLabel: match[1],
    sourceEpisodeNumber: String(match[2] || '').replace(/\s+/g, ''),
    chapterNumber: currentChapterNumber == null ? null : Number(currentChapterNumber),
    paragraphIndex: Number(paragraphIndex || 0),
    text: cleanText_(text)
  };
}

function collectChapterScanFromBody_(body) {
  const paras = body && body.getParagraphs ? body.getParagraphs() : [];
  const chapters = [];
  const sourceEpisodeMarkers = [];
  const digestDocumentId = getCheckerContentDigestDocumentId_();
  let currentChapterNumber = null;

  for (let i = 0; i < paras.length; i++) {
    const text = cleanText_(paras[i].getText());
    if (!text || text === NOTE_TEXT_) continue;

    const line = normalizeChapterLine_(text);
    const sourceMarker = parseSourceEpisodeMarker_(line, i + 1, currentChapterNumber);
    if (sourceMarker) {
      sourceEpisodeMarkers.push(sourceMarker);
      if (SOURCE_EPISODE_CONFIG_.IGNORE_FOR_SEQUENCE_CHECK !== false) continue;
    }

    if (!isChapterLineText_(line)) continue;

    const num = extractChapterNumberFromText_(line);
    if (num != null && !isNaN(num)) {
      // Cross-tab duplicate reporting only carries the first chapter item from each tab.
      // Keep the exact digest for backward compatibility, and add a locality-sensitive hash only
      // for that first chapter so near-duplicate detection stays cheap even on multi-chapter tabs.
      const similarity = chapters.length === 0
        ? buildChapterContentSimilarityFingerprint_(paras, i, digestDocumentId)
        : { hash: '', length: 0 };
      chapters.push({
        paragraphIndex: i + 1,
        text: text,
        chapterNumber: num,
        contentDigest: buildChapterContentDigest_(paras, i, digestDocumentId),
        contentSimilarityHash: similarity.hash,
        contentSimilarityLength: similarity.length
      });
      currentChapterNumber = num;
    }
  }

  return {
    chapters: chapters,
    sourceEpisodeMarkers: sourceEpisodeMarkers
  };
}

const CHECKER_CONTENT_DIGEST_CONTEXT_ = 'checker-content-digest-v1';

function getCheckerContentDigestDocumentId_() {
  try {
    var doc = __CHECKER_DOC_CTX__ && __CHECKER_DOC_CTX__.doc;
    return doc && typeof doc.getId === 'function' ? String(doc.getId() || '').trim() : '';
  } catch (ignored) {
    return '';
  }
}

function buildChapterNormalizedComparisonInput_(paras, headingIndex) {
  var collected = '';
  var limit = Math.min(paras.length, headingIndex + 30);

  for (var j = headingIndex + 1; j < limit; j++) {
    var p = paras[j];
    var raw = cleanText_(p.getText());
    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;
    if (parseSourceEpisodeMarker_(raw, j + 1, null)) break;
    if (isChapterLineText_(normalizeChapterLine_(raw))) break;

    try {
      if (collected.length === 0 &&
          typeof isBoldUnderlineParagraph_ === 'function' &&
          isBoldUnderlineParagraph_(p)) continue;
    } catch (e) {}

    collected += raw + ' ';
    if (collected.length >= 160) break;
  }

  return normalizeContentSignature_(collected);
}

function computeCheckerContentDigest_(documentId, normalizedContent) {
  var scopedDocumentId = String(documentId || '').trim();
  var comparisonInput = String(normalizedContent || '');
  // รักษา threshold เดิมของ contentSignature: ข้อความสั้นกว่า 20 ตัวไม่ใช้เทียบ duplicate
  if (!scopedDocumentId || comparisonInput.length < 20) return '';

  var digestBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    CHECKER_CONTENT_DIGEST_CONTEXT_ + '\n' + scopedDocumentId + '\n' + comparisonInput,
    Utilities.Charset.UTF_8
  );
  return digestBytes.map(function(value) {
    var unsigned = value < 0 ? value + 256 : value;
    return (unsigned < 16 ? '0' : '') + unsigned.toString(16);
  }).join('');
}

function buildChapterContentDigest_(paras, headingIndex, documentId) {
  return computeCheckerContentDigest_(
    documentId,
    buildChapterNormalizedComparisonInput_(paras, headingIndex)
  );
}

// Build a longer normalized sample for locality-sensitive near-duplicate detection. Unlike the
// exact digest above, this intentionally looks deeper than the first 120 normalized characters so
// a short inserted note/prefix cannot hide an otherwise copied chapter.
function buildChapterNormalizedSimilarityInput_(paras, headingIndex) {
  var collected = '';
  var limit = Math.min(paras.length, headingIndex + 50);

  for (var j = headingIndex + 1; j < limit; j++) {
    var p = paras[j];
    var raw = cleanText_(p.getText());
    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;
    if (parseSourceEpisodeMarker_(raw, j + 1, null)) break;
    if (isChapterLineText_(normalizeChapterLine_(raw))) break;

    try {
      if (collected.length === 0 &&
          typeof isBoldUnderlineParagraph_ === 'function' &&
          isBoldUnderlineParagraph_(p)) continue;
    } catch (e) {}

    collected += raw + ' ';
    // 1,600 raw chars is enough headroom to retain roughly 1,200 normalized chars while keeping
    // Apps Script work bounded.
    if (collected.length >= 1600) break;
  }

  return String(collected || '')
    .replace(INVIS_RE_, '')
    .replace(/[\s\u00A0]+/g, '')
    .replace(/[“”\"'‘’.,!?…\-–—()（）\[\]【】]/g, '')
    .toLowerCase()
    .slice(0, 1200);
}

// 64-bit SimHash (two independent 32-bit FNV-1a projections) over 5-character shingles.
// The value is document-scoped and contains no raw novel text. Small insertions/removals preserve
// most shingles, so copied chapters remain close in Hamming distance instead of becoming completely
// unrelated as they do with a cryptographic digest.
function computeCheckerContentSimilarityFingerprint_(documentId, normalizedContent) {
  var scopedDocumentId = String(documentId || '').trim();
  var content = String(normalizedContent || '').slice(0, 1200);
  if (!scopedDocumentId || content.length < 80) return { hash: '', length: content.length };

  function hash32_(text, seed) {
    var hash = seed >>> 0;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  function toHex8_(value) {
    var hex = (value >>> 0).toString(16);
    return ('00000000' + hex).slice(-8);
  }

  var contextSeed = hash32_('checker-content-similarity-v1\n' + scopedDocumentId, 2166136261);
  var seedA = (contextSeed ^ 0x9e3779b9) >>> 0;
  var seedB = (contextSeed ^ 0x85ebca6b) >>> 0;
  var weightsA = [];
  var weightsB = [];
  for (var bit = 0; bit < 32; bit++) {
    weightsA[bit] = 0;
    weightsB[bit] = 0;
  }

  var shingleSize = 5;
  for (var pos = 0; pos <= content.length - shingleSize; pos++) {
    var shingle = content.slice(pos, pos + shingleSize);
    var hashA = hash32_(shingle, seedA);
    var hashB = hash32_(shingle, seedB);
    for (var b = 0; b < 32; b++) {
      weightsA[b] += ((hashA >>> b) & 1) ? 1 : -1;
      weightsB[b] += ((hashB >>> b) & 1) ? 1 : -1;
    }
  }

  var bitsA = 0;
  var bitsB = 0;
  for (var k = 0; k < 32; k++) {
    if (weightsA[k] >= 0) bitsA = (bitsA | (1 << k)) >>> 0;
    if (weightsB[k] >= 0) bitsB = (bitsB | (1 << k)) >>> 0;
  }

  return {
    hash: toHex8_(bitsA) + toHex8_(bitsB),
    length: content.length
  };
}

function buildChapterContentSimilarityFingerprint_(paras, headingIndex, documentId) {
  return computeCheckerContentSimilarityFingerprint_(
    documentId,
    buildChapterNormalizedSimilarityInput_(paras, headingIndex)
  );
}

function normalizeContentSignature_(s) {
  return String(s || '')
    .replace(INVIS_RE_, '')
    .replace(/[\s\u00A0]+/g, '')
    .replace(/[“”"'‘’.,!?…\-–—()（）\[\]【】]/g, '')
    .slice(0, 120);
}

function checkChapterSequenceInBody_() {
  const body = getActiveBody_();
  const scan = collectChapterScanFromBody_(body);
  const chapters = scan.chapters;
  const issues = [];

  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1];
    const curr = chapters[i];
    const expected = Number(prev.chapterNumber) + 1;

    if (Number(curr.chapterNumber) !== expected) {
      let type = 'ไม่ต่อเนื่อง';
      if (Number(curr.chapterNumber) === Number(prev.chapterNumber)) type = 'เลขซ้ำ';
      else if (Number(curr.chapterNumber) < Number(prev.chapterNumber)) type = 'เลขย้อนหลัง';
      else if (Number(curr.chapterNumber) > expected) type = 'เลขข้าม';

      issues.push({
        type: type,
        problemCode: getChapterIssueProblemCode_(type),
        expected: expected,
        previous: prev.chapterNumber,
        current: curr.chapterNumber,
        paragraphIndex: curr.paragraphIndex,
        text: curr.text
      });
    }
  }

  return {
    ok: issues.length === 0,
    totalFound: chapters.length,
    chapters: chapters,
    issues: issues,
    sourceEpisodeMarkers: scan.sourceEpisodeMarkers || []
  };
}

function getFirstChapterItemFromRunResult_(result, tabName, tabIndex) {
  result = result || {};
  var seq = result.chapterSequence || {};
  var chapters = seq.chapters || [];
  var first = chapters.length ? chapters[0] : null;

  return {
    tab: tabName,
    tabIndex: Number(tabIndex || 0),
    chapterNumber: first ? Number(first.chapterNumber) : null,
    paragraphIndex: first ? Number(first.paragraphIndex || 0) : null,
    contentDigest: first ? String(first.contentDigest || '') : '',
    contentSimilarityHash: first ? String(first.contentSimilarityHash || '') : '',
    contentSimilarityLength: first ? Number(first.contentSimilarityLength || 0) : 0
  };
}

function buildChapterSequenceIssuesFromTabItems_(items) {
  items = (items || []).slice().sort(function(a, b) {
    return Number(a.tabIndex || 0) - Number(b.tabIndex || 0);
  });

  var issues = [];
  var hasDuplicateChapter = false;
  var seen = {};
  var numbered = [];

  items.forEach(function(item) {
    var num = item.chapterNumber == null || item.chapterNumber === '' ? null : Number(item.chapterNumber);

    if (num == null || isNaN(num)) {
      issues.push({
        tab: item.tab,
        tabIndex: item.tabIndex,
        type: 'ไม่พบเลขบท',
        problemCode: CHECKER_PROBLEM_CODES_.CHAPTER_NOT_FOUND,
        expected: null,
        previous: null,
        current: null,
        paragraphIndex: item.paragraphIndex || null,
        text: item.text || ''
      });
      return;
    }

    if (seen[String(num)]) {
      hasDuplicateChapter = true;
      issues.push({
        tab: item.tab,
        tabIndex: item.tabIndex,
        type: 'เลขซ้ำ',
        problemCode: CHECKER_PROBLEM_CODES_.CHAPTER_DUPLICATE,
        expected: Number(seen[String(num)].chapterNumber) + 1,
        previous: seen[String(num)].chapterNumber,
        current: num,
        previousTab: seen[String(num)].tab,
        paragraphIndex: item.paragraphIndex || null,
        text: item.text || ''
      });
    } else {
      seen[String(num)] = item;
    }

    numbered.push({
      tab: item.tab,
      tabIndex: item.tabIndex,
      chapterNumber: num,
      paragraphIndex: item.paragraphIndex || null,
      text: item.text || ''
    });
  });

  for (var i = 1; i < numbered.length; i++) {
    var prev = numbered[i - 1];
    var curr = numbered[i];
    var expected = Number(prev.chapterNumber) + 1;

    if (Number(curr.chapterNumber) !== expected) {
      var type = 'ไม่ต่อเนื่อง';
      if (Number(curr.chapterNumber) === Number(prev.chapterNumber)) {
        type = 'เลขซ้ำ';
        hasDuplicateChapter = true;
      } else if (Number(curr.chapterNumber) < Number(prev.chapterNumber)) {
        type = 'เลขย้อนหลัง';
      } else if (Number(curr.chapterNumber) > expected) {
        type = 'เลขข้าม';
      }

      var alreadyDuplicate = issues.some(function(x) {
        return x.type === 'เลขซ้ำ' &&
               Number(x.current) === Number(curr.chapterNumber) &&
               Number(x.tabIndex) === Number(curr.tabIndex);
      });

      if (!(type === 'เลขซ้ำ' && alreadyDuplicate)) {
        issues.push({
          tab: curr.tab,
          tabIndex: curr.tabIndex,
          type: type,
          problemCode: getChapterIssueProblemCode_(type),
          expected: expected,
          previous: prev.chapterNumber,
          current: curr.chapterNumber,
          previousTab: prev.tab,
          paragraphIndex: curr.paragraphIndex || null,
          text: curr.text || ''
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues: issues,
    hasDuplicateChapter: hasDuplicateChapter,
    totalFound: numbered.length,
    items: items
  };
}

/* =========================
 * Duplicate chapter cleanup helpers
 * ========================= */

function removeDuplicateChapterHeadingLines_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let removed = 0;
  const removedTexts = [];

  function normalizeChapterOnlyKey_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!s || s === NOTE_TEXT_) return null;

    let m = s.match(/^(บทที่|ตอนที่)\s*([0-9]+)$/i);
    if (m) return 'บทที่ ' + Number(m[2]);

    m = s.match(/^chapter\s*([0-9]+)$/i);
    if (m) return 'บทที่ ' + Number(m[1]);

    return null;
  }

  function fixInlineDuplicateHeading_(p) {
    const raw = cleanText_(p.getText());
    if (!raw || raw === NOTE_TEXT_) return 0;

    const s = thaiDigitsToArabic_(raw)
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let m = s.match(/^(บทที่|ตอนที่)\s*([0-9]+)\s*(?:(?:บทที่|ตอนที่)\s*\2\s*)+$/i);
    if (m) {
      const newText = 'บทที่ ' + Number(m[2]);
      if (raw !== newText) {
        removedTexts.push(raw);
        p.setText(newText);
        if (typeof setHeadingLineStyle_ === 'function') setHeadingLineStyle_(p);
        return 1;
      }
      return 0;
    }

    m = s.match(/^chapter\s*([0-9]+)\s*(?:chapter\s*\1\s*)+$/i);
    if (m) {
      const newText = 'บทที่ ' + Number(m[1]);
      if (raw !== newText) {
        removedTexts.push(raw);
        p.setText(newText);
        if (typeof setHeadingLineStyle_ === 'function') setHeadingLineStyle_(p);
        return 1;
      }
    }

    return 0;
  }

  for (let i = 0; i < paras.length; i++) {
    removed += fixInlineDuplicateHeading_(paras[i]);
  }

  for (let i = paras.length - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];

    const currKey = normalizeChapterOnlyKey_(curr.getText());
    const prevKey = normalizeChapterOnlyKey_(prev.getText());

    if (!currKey || !prevKey) continue;

    if (currKey === prevKey) {
      removedTexts.push(cleanText_(curr.getText()));
      removeParaSafely_(curr);
      removed++;
    }
  }

  return {
    removed: removed,
    removedTexts: removedTexts
  };
}

function removeDuplicateChapterTitleLines_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let removed = 0;
  const removedTexts = [];

  function isChapterOnlyHeadingText_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!s || s === NOTE_TEXT_) return false;
    return /^(บทที่|ตอนที่)\s*[0-9]+$/i.test(s) || /^chapter\s*[0-9]+$/i.test(s);
  }

  function normalizeTitleKey_(text) {
    const s = cleanText_(text)
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!s || s === NOTE_TEXT_) return null;
    if (isStatusPanelLine_(s)) return null;
    if (isChapterOnlyHeadingText_(s)) return null;
    if (isChapterLineText_(normalizeChapterLine_(s))) return null;

    return s;
  }

  function findPrevMeaningfulIndex_(startIndex) {
    for (let i = startIndex; i >= 0; i--) {
      const t = cleanText_(paras[i].getText());
      if (!t || t === NOTE_TEXT_) continue;
      return i;
    }
    return -1;
  }

  for (let i = paras.length - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];

    const currKey = normalizeTitleKey_(curr.getText());
    const prevKey = normalizeTitleKey_(prev.getText());

    if (!currKey || !prevKey) continue;
    if (currKey !== prevKey) continue;

    const beforeIdx = findPrevMeaningfulIndex_(i - 2);
    if (beforeIdx < 0) continue;

    const beforeText = paras[beforeIdx].getText();
    if (!isChapterOnlyHeadingText_(beforeText)) continue;

    removedTexts.push(cleanText_(curr.getText()));
    removeParaSafely_(curr);
    removed++;
  }

  return {
    removed: removed,
    removedTexts: removedTexts
  };
}

function removeDuplicateBracketChapterLine_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let headingIdx = -1;
  let headingNumber = null;

  for (let i = 0; i < Math.min(paras.length, 20); i++) {
    const text = cleanText_(paras[i].getText());
    if (!text || text === NOTE_TEXT_) continue;

    const num = extractChapterNumberFromText_(text);
    if (num != null && isChapterLineText_(normalizeChapterLine_(text))) {
      headingIdx = i;
      headingNumber = num;
      break;
    }
  }

  if (headingIdx === -1 || headingNumber == null) {
    return { removed: 0, chapterNumber: null, removedTexts: [] };
  }

  let removed = 0;
  let removedTexts = [];

  const bracketOnlyRe = /^\[\s*([0-9]+)\s*\]$/;
  const bracketAtEndRe = /\s*\[\s*([0-9]+)\s*\]\s*$/;

  for (let j = headingIdx + 1; j < Math.min(paras.length, headingIdx + 6); j++) {
    const p = paras[j];
    const text = cleanText_(p.getText());
    if (!text) continue;

    if (text === NOTE_TEXT_) continue;
    if (isChapterLineText_(normalizeChapterLine_(text))) break;
    if (isStatusPanelLine_(text)) break;

    const onlyMatch = text.match(bracketOnlyRe);
    if (onlyMatch) {
      const num = Number(onlyMatch[1]);
      if (num === headingNumber) {
        removedTexts.push(text);
        removeParaSafely_(p);
        removed++;
      }
      continue;
    }

    const endMatch = text.match(bracketAtEndRe);
    if (endMatch) {
      const num = Number(endMatch[1]);
      if (num === headingNumber) {
        const newText = text.replace(bracketAtEndRe, '').replace(/\s+$/g, '');
        if (newText && newText !== text) {
          p.setText(newText);
          removedTexts.push(text);
          removed++;
        }
      }
    }
  }

  return {
    removed: removed,
    chapterNumber: headingNumber,
    removedTexts: removedTexts
  };
}


/**
 * 🧹 แก้หัวบทซ้ำ/เลขบทมีวงเล็บ
 *
 * เคสที่แก้:
 * 1) บทที่ [319] ชื่อบท -> บทที่ 319 ชื่อบท
 * 2) บทที่ 1 ตอนที่ 1 - ชื่อบท -> บทที่ 1 ชื่อบท
 * 3) บทที่ 1
 *    ตอนที่ 1 - ชื่อบท
 *    -> บทที่ 1
 *       ชื่อบท
 * 4) ถ้าเจอบรรทัด "ตอนที่ N" ล้วน ๆ หลัง "บทที่ N" จะลบบรรทัดนั้น
 */
function removeRedundantEpisodeTitleAfterChapter_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let changed = 0;
  const changedTexts = [];

  function normalizeSpaces_(s) {
    return String(s || '')
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toArabic_(s) {
    if (typeof thaiDigitsToArabic_ === 'function') return thaiDigitsToArabic_(s);
    return String(s || '').replace(/[๐-๙]/g, function(ch) {
      return {
        '๐':'0','๑':'1','๒':'2','๓':'3','๔':'4',
        '๕':'5','๖':'6','๗':'7','๘':'8','๙':'9'
      }[ch] || ch;
    });
  }

  function escapeRegExp_(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseChapterHeading_(text) {
    const raw = normalizeSpaces_(text);
    const s = toArabic_(raw);

    // บทที่ [319] ชื่อบท
    let m = s.match(/^(บทที่)\s*\[\s*([0-9]+)\s*\]\s*(.*)$/i);
    if (m) {
      return {
        ok: true,
        type: 'chapter',
        number: Number(m[2]),
        rest: String(m[3] || '').trim(),
        hasBracketNumber: true
      };
    }

    // บทที่ 319 ชื่อบท
    m = s.match(/^(บทที่)\s*([0-9]+)\s*(.*)$/i);
    if (m) {
      return {
        ok: true,
        type: 'chapter',
        number: Number(m[2]),
        rest: String(m[3] || '').trim(),
        hasBracketNumber: false
      };
    }

    return { ok: false };
  }

  function isChapterOnly_(text) {
    const p = parseChapterHeading_(text);
    return p.ok && p.number != null && !p.rest;
  }

  function getChapterNumber_(text) {
    const p = parseChapterHeading_(text);
    return p.ok ? p.number : null;
  }

  function removeEpisodePrefixFromTitle_(text, chapterNo) {
    const raw = normalizeSpaces_(text);
    const s = toArabic_(raw);
    const n = escapeRegExp_(String(Number(chapterNo)));

    // ตอนที่ 1 – ชื่อบท / ตอนที่ 1 - ชื่อบท / ตอนที่ 1: ชื่อบท
    const re = new RegExp(
      '^ตอนที่\\s*0*' + n + '\\s*(?:[-–—:：]+\\s*)?(.*)$',
      'i'
    );

    const m = s.match(re);
    if (!m) return null;

    const rest = String(m[1] || '').trim();

    return {
      matched: true,
      rest: rest
    };
  }

  function setParaTextKeepBasicStyle_(p, newText) {
    const oldText = p.getText();
    if (oldText === newText) return false;

    p.setText(newText);

    try {
      // ถ้าเป็นบรรทัดหัวบท/ชื่อบท ให้คง bold+underline ตามงานเดิม
      if (
        isChapterLineText_(normalizeChapterLine_(newText)) ||
        /^.+/.test(newText)
      ) {
        p.editAsText().setBold(true).setUnderline(true);
      }
    } catch (e) {}

    return true;
  }

  // 1) แก้ในบรรทัดเดียวก่อน
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const raw = p.getText();
    const clean = normalizeSpaces_(raw);

    if (!clean || clean === NOTE_TEXT_) continue;
    if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(clean)) continue;

    let text = toArabic_(clean);

    // 1.1 บทที่ [319] xxx -> บทที่ 319 xxx
    text = text.replace(/^บทที่\s*\[\s*([0-9]+)\s*\]\s*/i, 'บทที่ $1 ');

    // 1.2 บทที่ 1 ตอนที่ 1 - xxx -> บทที่ 1 xxx
    const sameLine = text.match(/^บทที่\s*([0-9]+)\s+ตอนที่\s*0*\1\s*(?:[-–—:：]+)?\s*(.*)$/i);
    if (sameLine) {
      text = 'บทที่ ' + Number(sameLine[1]) + (sameLine[2] ? ' ' + sameLine[2].trim() : '');
    }

    text = text.replace(/\s+/g, ' ').trim();

    if (text && text !== clean) {
      changedTexts.push(clean + ' -> ' + text);
      setParaTextKeepBasicStyle_(p, text);
      changed++;
    }
  }

  // 2) แก้กรณีแยก 2 บรรทัด:
  // บทที่ 1
  // ตอนที่ 1 - ชื่อบท
  for (let i = paras.length - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];

    const currText = normalizeSpaces_(curr.getText());
    const prevText = normalizeSpaces_(prev.getText());

    if (!currText || currText === NOTE_TEXT_) continue;
    if (!prevText || prevText === NOTE_TEXT_) continue;

    if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(currText)) continue;

    if (!isChapterOnly_(prevText)) continue;

    const chapterNo = getChapterNumber_(prevText);
    if (chapterNo == null) continue;

    const removed = removeEpisodePrefixFromTitle_(currText, chapterNo);
    if (!removed || !removed.matched) continue;

    // ถ้าเหลือชื่อบท ให้แทนที่บรรทัดปัจจุบันด้วยชื่อบท
    if (removed.rest) {
      changedTexts.push(currText + ' -> ' + removed.rest);
      setParaTextKeepBasicStyle_(curr, removed.rest);
      changed++;
    } else {
      // ถ้าเป็นแค่ "ตอนที่ N" ล้วน ๆ ให้ลบบรรทัด
      changedTexts.push('ลบบรรทัด: ' + currText);
      removeParaSafely_(curr);
      changed++;
    }
  }

  return {
    changed: changed,
    changedTexts: changedTexts
  };
}

function removeRedundantEpisodeTitleAfterChapterWithAlert() {
  const r = removeRedundantEpisodeTitleAfterChapter_();

  SpreadsheetApp.getUi().alert(
    '🧹 แก้หัวบท/ชื่อบทแล้ว ' + r.changed + ' จุด' +
    (r.changedTexts.length ? '\n\n' + r.changedTexts.slice(0, 20).join('\n') : '')
  );

  return r;
}
