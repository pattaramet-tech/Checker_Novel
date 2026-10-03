/**
 * Ipe Docs Tools — V11.4.9-CENTRAL.1
 * โค้ดกลาง: ติดตั้งครั้งเดียวใน Apps Script แล้วเปลี่ยน DOCS_ID ตามไฟล์ที่ต้องการ
 * ฐาน: โค้ด V11.4.9 ที่ผู้ใช้ส่งมา กฎ cleanup หลักคงเดิม
 *
 * เริ่มต้น: previewCentral() -> ตรวจชื่อไฟล์/แท็บ/เลขบทใน Execution log
 * แก้จริง: ตั้ง DRY_RUN: false แล้วรัน runCentral()
 * สำรองเอกสารก่อนแก้จริง การรัน ALL_CHECKS มีทั้งแก้ไขและลบข้อความตามกฎเดิม
 * ไม่มีเมนู/กล่อง alert ในเอกสารปลายทาง และไม่มี trigger ทำงานต่ออัตโนมัติ
 */
const CENTRAL_CONFIG_ = {
  DOCS_ID: '1ilVFj7IaOmVxxmghB307CoqDlkB0EkP1Nk2QWjWDnIo',  // ใส่ Docs ID หรือ URL ของ Google Docs
  ACTION: 'ALL_CHECKS',             // ดูรายการ ACTION ด้านล่าง
  DRY_RUN: true,                    // true = ดูเป้าหมายเท่านั้น; false = เขียนจริง
  EXPECTED_DOCUMENT_NAME: '',       // ไม่บังคับ: ใส่ชื่อไฟล์เต็มเพื่อกันเลือกผิดไฟล์
  FORCE_CHAPTER_NUMBERS: true,      // ALL_CHECKS จะเขียนเลขบทใหม่ด้วยเมื่อเป็น true
  START_NUMBER: null,               // null = อ่านจากช่วงเลขในชื่อไฟล์; หรือใส่ 70 เป็นต้น
  TAB_FROM: 1,                      // ลำดับแท็บแรกที่จะทำ รวมแท็บย่อย จากบนลงล่าง
  TAB_TO: 0,                        // 0 = ถึงแท็บสุดท้าย; เลขอื่น = ลำดับแท็บสุดท้าย
  MAX_TABS_PER_RUN: 0,              // 0 = ไม่จำกัดจำนวนต่อรอบ (ยังมี SOFT_LIMIT_MS)
  SOFT_LIMIT_MS: 240000             // หยุดก่อนเริ่มแท็บใหม่เมื่อครบเวลานี้
};

/* ACTION:
 * ALL_CHECKS        ตรวจ/จัดเอกสารด้วย runAllChecks() เดิมทีละแท็บ
 * FORCE_NUMBERS     เขียนเลขหัวบทตามลำดับแท็บ (เปิด FORCE_CHAPTER_NUMBERS ด้วย)
 * REMOVE_BRACKETS   ลบ [เลขบท]/[โบนัส] ด้วยกฎเดิม
 * CLEAN_HEADINGS    ลบ prefix ตอนที่ N / [] จากหัวบท ด้วยกฎเดิม
 * CLEAR_HIGHLIGHTS  ล้างไฮไลต์ในแท็บที่เลือก
 * MERGE_TITLES      รวมชื่อบทกลับมาต่อท้ายเลขบท ด้วยกฎเดิม
 * CLEAN_ENDINGS     ล้างข้อความโปรโมตท้ายบท/เติมจบตอน ด้วยกฎเดิม
 * ADD_WATERMARK     ใส่ลายน้ำหัว/ท้ายของแต่ละแท็บ
 * REMOVE_WATERMARK  ลบลายน้ำหัว/ท้ายของแต่ละแท็บ
 * RENAME_TABS       เรียงชื่อแท็บ (ต้องเปิด Google Docs API; Identifier: Docs)
 */
const CENTRAL_ACTIONS_ = [
  'ALL_CHECKS', 'FORCE_NUMBERS', 'REMOVE_BRACKETS', 'CLEAN_HEADINGS',
  'CLEAR_HIGHLIGHTS', 'MERGE_TITLES', 'CLEAN_ENDINGS',
  'ADD_WATERMARK', 'REMOVE_WATERMARK', 'RENAME_TABS'
];
let CENTRAL_CONTEXT_ = null;

/** ดูเป้าหมาย/ช่วงแท็บเท่านั้น ไม่จำลองผล cleanup และไม่เขียนลงเอกสาร */
function previewCentral() {
  return centralExecute_(true);
}

/** รัน ACTION; เมื่อ DRY_RUN เป็น true จะยังไม่แก้เอกสาร */
function runCentral() {
  if (typeof CENTRAL_CONFIG_.DRY_RUN !== 'boolean') {
    throw new Error('DRY_RUN ต้องเป็น true หรือ false โดยไม่ใส่เครื่องหมายคำพูด');
  }
  return centralExecute_(CENTRAL_CONFIG_.DRY_RUN);
}

/** รับเฉพาะ Docs ID หรือ Google Docs edit URL ไม่เดา ID จากข้อความอื่น */
function parseCentralDocumentId_(value) {
  const s = String(value || '').trim();
  if (!s) throw new Error('กรุณาระบุ CENTRAL_CONFIG_.DOCS_ID ก่อนรัน');
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
  const m = s.match(/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i);
  if (!m || m[1] === 'e') {
    throw new Error('DOCS_ID ไม่ถูกต้อง: ใช้ ID หรือ URL ของเอกสาร Google Docs (ไม่ใช่ลิงก์เผยแพร่ /d/e/)');
  }
  return m[1];
}

function centralInteger_(value, label, min) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(label + ' ต้องเป็นจำนวนเต็มตั้งแต่ ' + min + ' ขึ้นไป');
  }
  return value;
}

function centralRequireContext_() {
  if (!CENTRAL_CONTEXT_) {
    throw new Error('ฉบับโค้ดกลาง: ให้รัน previewCentral หรือ runCentral แทนฟังก์ชันเมนูเดิม');
  }
  return CENTRAL_CONTEXT_;
}

function centralAssertWriting_() {
  const ctx = centralRequireContext_();
  if (ctx.readOnly) throw new Error('ห้ามเขียนเอกสารระหว่าง preview/DRY_RUN');
  return ctx;
}

function getTargetDocument_() {
  return centralRequireContext_().doc;
}

/** แท็บที่ runner ระบุ ไม่ใช่แท็บที่ผู้ใช้กำลังเปิดในเบราว์เซอร์ */
function getProcessingTab_() {
  const ctx = centralRequireContext_();
  if (ctx.activeIndex < 0 || !ctx.tabs[ctx.activeIndex]) {
    throw new Error('ยังไม่ได้ระบุแท็บเป้าหมาย');
  }
  return ctx.tabs[ctx.activeIndex];
}

function selectProcessingTab_(doc, tabId) {
  const ctx = centralRequireContext_();
  if (doc.getId() !== ctx.doc.getId()) throw new Error('เอกสารไม่ตรงกับ DOCS_ID');
  const index = ctx.tabIndexById[String(tabId)];
  if (!Number.isInteger(index)) throw new Error('ไม่พบ Tab ID ในเอกสารเป้าหมาย: ' + tabId);
  ctx.activeIndex = index;
  return ctx.tabs[index];
}

/** แทน alert: ไม่เรียก UI ของเอกสารอื่น */
function centralNotify_(message) {
  console.log(String(message));
}

function centralLogJson_(label, object) {
  const text = JSON.stringify(object, null, 2);
  // แยกข้อความยาว เพื่อลดโอกาสถูกตัดในแต่ละ log entry
  for (let offset = 0; offset < text.length; offset += 6000) {
    console.log(label + (text.length > 6000 ? ' [' + (offset / 6000 + 1) + ']' : '') + '\n' + text.slice(offset, offset + 6000));
  }
}

/** runner เปิดไฟล์เพียง DOCS_ID เดียว ไม่มี fallback ไปเอกสารที่เปิดค้างไว้ */
function centralExecute_(readOnly) {
  const startedAt = Date.now();
  const cfg = CENTRAL_CONFIG_;
  const docId = parseCentralDocumentId_(cfg.DOCS_ID);
  const action = String(cfg.ACTION || '').trim().toUpperCase();
  if (CENTRAL_ACTIONS_.indexOf(action) < 0) throw new Error('ไม่รู้จัก ACTION: ' + cfg.ACTION);
  if (typeof cfg.FORCE_CHAPTER_NUMBERS !== 'boolean') throw new Error('FORCE_CHAPTER_NUMBERS ต้องเป็น true/false');
  if (cfg.START_NUMBER !== null) centralInteger_(cfg.START_NUMBER, 'START_NUMBER', 1);
  const from = centralInteger_(cfg.TAB_FROM, 'TAB_FROM', 1);
  const requestedTo = centralInteger_(cfg.TAB_TO, 'TAB_TO', 0);
  const maxTabs = centralInteger_(cfg.MAX_TABS_PER_RUN, 'MAX_TABS_PER_RUN', 0);
  const softLimit = centralInteger_(cfg.SOFT_LIMIT_MS, 'SOFT_LIMIT_MS', 1000);
  if (softLimit > 270000) throw new Error('ตั้ง SOFT_LIMIT_MS ไม่เกิน 270000 เพื่อเหลือเวลาบันทึกผล');
  if (CENTRAL_CONTEXT_) throw new Error('มีการเรียก runner ซ้อนกันใน execution เดียว');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('โค้ดกลางนี้กำลังทำงานอยู่ กรุณาอย่ารันซ้อน');
  let doc = null;
  let writesStarted = false;
  let currentIndex = -1;
  let report = null;
  try {
    doc = DocumentApp.openById(docId);
    if (doc.getId() !== docId) throw new Error('ID ที่เปิดได้ไม่ตรงกับ DOCS_ID');
    const documentName = doc.getName();
    if (cfg.EXPECTED_DOCUMENT_NAME && documentName !== cfg.EXPECTED_DOCUMENT_NAME) {
      throw new Error('ชื่อไฟล์ไม่ตรง EXPECTED_DOCUMENT_NAME: เปิดได้ "' + documentName + '"');
    }
    const tabs = getAllTabsFlat_(doc);
    if (!tabs.length) throw new Error('ไม่พบแท็บเอกสาร');
    const to = requestedTo === 0 ? tabs.length : requestedTo;
    if (from > tabs.length || to > tabs.length || to < from) {
      throw new Error('ช่วงแท็บไม่ถูกต้อง: ไฟล์นี้มี ' + tabs.length + ' แท็บ แต่ขอ ' + from + '-' + to);
    }
    const tabIndexById = Object.create(null);
    tabs.forEach(function(tab, index) { tabIndexById[String(tab.getId())] = index; });
    CENTRAL_CONTEXT_ = { doc: doc, tabs: tabs, tabIndexById: tabIndexById, activeIndex: from - 1, readOnly: readOnly };
    const startNumber = getForcedChapterStartNumber_();
    const needsNumber = (action === 'ALL_CHECKS' && cfg.FORCE_CHAPTER_NUMBERS) || action === 'FORCE_NUMBERS';
    const warnings = [];
    if (needsNumber && startNumber === null) {
      warnings.push('หาเลขเริ่มต้นไม่ได้: กำหนด START_NUMBER หรือใช้ชื่อไฟล์ที่มีช่วงเลข เช่น 70 - 119');
    }
    if (action === 'FORCE_NUMBERS' && !cfg.FORCE_CHAPTER_NUMBERS) {
      warnings.push('ACTION FORCE_NUMBERS ต้องตั้ง FORCE_CHAPTER_NUMBERS: true');
    }
    const blocked = warnings.length > 0;
    if (needsNumber) {
      warnings.push('เลขบท = START_NUMBER + ลำดับแท็บทั้งเอกสาร - 1; รวมแท็บย่อย/แท็บว่าง/แท็บคำนำตามลำดับเดิม');
    }
    if (action === 'ALL_CHECKS' || action === 'FORCE_NUMBERS') {
      warnings.push('คงกฎ V11.4.9 เดิม: ฟังก์ชันบังคับเลขบทอาจแยกชื่อบทเป็นย่อหน้าถัดไป แม้ตั้ง KEEP_EXISTING');
    }
    if (action === 'ALL_CHECKS') {
      warnings.push('ALL_CHECKS มีการลบ/แทนที่ข้อความและเติมจบตอนตามกฎเดิม รวมถึงแท็บว่าง; ควรทดสอบสำเนาก่อน');
    }
    report = {
      version: 'V11.4.9-CENTRAL.1', status: readOnly ? 'PREVIEW_ONLY' : 'RUNNING',
      documentId: docId, documentName: documentName, action: action,
      tabTotal: tabs.length, tabFrom: from, tabTo: to,
      startNumber: needsNumber ? startNumber : null,
      canRun: !blocked, warnings: warnings,
      tabProcessed: 0, lastCompletedTab: null, nextTabFrom: from, results: []
    };
    centralLogJson_('TARGET', {
      documentId: docId, documentName: documentName, action: action,
      mode: readOnly ? 'PREVIEW_ONLY (ไม่แก้เอกสาร)' : 'WRITE (แก้เอกสารจริง)',
      tabTotal: tabs.length, tabFrom: from, tabTo: to, startNumber: report.startNumber,
      canRun: !blocked, warnings: warnings
    });

    if (readOnly) {
      for (let i = from - 1; i < to; i++) {
        const tab = tabs[i];
        const paragraphs = tab.asDocumentTab().getBody().getParagraphs();
        const limit = Math.min(paragraphs.length, FORCE_CHAPTER_NUMBER_CONFIG_.MAX_LOOKUP_PARAGRAPHS || 120);
        let firstHeading = '';
        for (let p = 0; p < limit; p++) {
          const text = paragraphs[p].getText();
          if (parseChapterHeadingLinePure_(text)) { firstHeading = text; break; }
        }
        const entry = {
          tabIndex: i + 1, tabId: tab.getId(), tabTitle: tab.getTitle(),
          firstHeading: firstHeading, paragraphCount: paragraphs.length,
          expectedNumber: needsNumber && startNumber !== null ? startNumber + i : null
        };
        report.results.push(entry);
        centralLogJson_('PREVIEW TAB', entry);
      }
      console.log('PREVIEW_ONLY: ดูเป้าหมายเท่านั้น ไม่ได้จำลองการลบข้อความ และไม่ได้ทดสอบสิทธิ์เขียน');
      return report;
    }

    if (blocked) throw new Error('หยุดก่อนแก้เอกสาร: ' + warnings[0]);
    if (action === 'RENAME_TABS') ensureDocsAdvancedService_();
    const chapterItems = [];
    for (let i = from - 1; i < to; i++) {
      // ตรวจระหว่างแท็บเท่านั้น: แท็บเดียวที่ใหญ่มากยังอาจชนเวลาสูงสุดของ Apps Script
      if (report.tabProcessed > 0 && ((maxTabs > 0 && report.tabProcessed >= maxTabs) || Date.now() - startedAt >= softLimit)) {
        report.status = 'PARTIAL';
        report.nextTabFrom = i + 1;
        break;
      }
      currentIndex = i;
      selectProcessingTab_(doc, tabs[i].getId());
      console.log('เริ่มแท็บ ' + (i + 1) + '/' + tabs.length + ': ' + tabs[i].getTitle());
      writesStarted = true;
      const result = centralRunActionInTab_(action, i);
      const entry = { tabIndex: i + 1, tabId: tabs[i].getId(), tabTitle: tabs[i].getTitle(), result: result };
      report.results.push(entry);
      report.tabProcessed++;
      report.lastCompletedTab = i + 1;
      report.nextTabFrom = i + 2 <= to ? i + 2 : null;
      if (action === 'ALL_CHECKS') {
        collectChapterSequenceItemsFromResult_(result, entry.tabTitle, i + 1).forEach(function(item) { chapterItems.push(item); });
      }
      centralLogJson_('TAB RESULT', entry);
    }
    if (report.status === 'RUNNING') report.status = 'COMPLETE';
    if (action === 'ALL_CHECKS') {
      report.chapterSequence = analyzeChapterSequenceAcrossItems_(chapterItems);
      report.chapterSequenceScope = 'เฉพาะแท็บที่ประมวลผลใน execution นี้ ไม่รวมรอบก่อน';
    }
    doc.saveAndClose();
    doc = null;
    report.elapsedMs = Date.now() - startedAt;
    centralLogJson_('SUMMARY', {
      status: report.status, documentId: docId, documentName: documentName,
      action: action, tabProcessed: report.tabProcessed, tabFrom: from, tabTo: to,
      lastCompletedTab: report.lastCompletedTab, nextTabFrom: report.nextTabFrom,
      chapterSequence: report.chapterSequence || null, elapsedMs: report.elapsedMs
    });
    if (report.status === 'PARTIAL') {
      console.log('ยังไม่ครบ: ตั้ง TAB_FROM: ' + report.nextTabFrom + ' แล้วรัน runCentral ใหม่ โดยคง DOCS_ID/START_NUMBER/ACTION/TAB_TO เดิม ห้ามสลับลำดับแท็บระหว่างรอบ');
    }
    return report;
  } catch (error) {
    console.error('FAILED: ' + String(error && error.message || error));
    if (writesStarted) {
      console.error('อาจมีการแก้ไขบางส่วนแล้ว ไม่มี rollback อัตโนมัติ; แท็บที่กำลังทำ: ' + (currentIndex + 1) + '; แท็บล่าสุดที่ประมวลผลครบ: ' + (report && report.lastCompletedTab || 'ยังไม่มี'));
    }
    throw error;
  } finally {
    // ไม่เรียก saveAndClose ใน preview; เมื่อเริ่มเขียนแล้วให้พยายามบันทึกแม้เกิด error
    try {
      if (doc && writesStarted) doc.saveAndClose();
    } catch (saveError) {
      console.error('บันทึกปิดท้ายไม่สำเร็จ: ' + String(saveError && saveError.message || saveError));
    }
    CENTRAL_CONTEXT_ = null;
    lock.releaseLock();
  }
}

function centralRunActionInTab_(action, absoluteIndex) {
  centralAssertWriting_();
  switch (action) {
    case 'ALL_CHECKS': return runAllChecks();
    case 'FORCE_NUMBERS': return forceFirstChapterHeadingNumberInActiveTab_();
    case 'REMOVE_BRACKETS': return removeLeadingBracketTagsEverywhere_();
    case 'CLEAN_HEADINGS': return removeEpisodeTitlePrefixAndBracketChapterNumber_();
    case 'CLEAR_HIGHLIGHTS': return { cleared: clearHighlightsInElement(getActiveBody_()) };
    case 'MERGE_TITLES': return mergeChapterTitleBackInActiveTab_();
    case 'CLEAN_ENDINGS': return cleanupEndingPromoAndEnsureEndMarker_();
    case 'ADD_WATERMARK':
      applyWatermarkToDoc_(getTargetDocument_(), true);
      return { completed: true, action: action };
    case 'REMOVE_WATERMARK':
      applyWatermarkToDoc_(getTargetDocument_(), false);
      return { completed: true, action: action };
    case 'RENAME_TABS': {
      const tab = getProcessingTab_();
      const oldTitle = tab.getTitle();
      const newTitle = buildSequentialTabTitle_(absoluteIndex);
      if (oldTitle === newTitle) return { renamed: 0, oldTitle: oldTitle, newTitle: newTitle };
      const apiResult = updateDocumentTabTitlesByApi_(getTargetDocument_().getId(), [{ tabId: tab.getId(), newTitle: newTitle }]);
      return { renamed: 1, oldTitle: oldTitle, newTitle: newTitle, apiResult: apiResult };
    }
    default: throw new Error('ACTION ไม่รองรับ: ' + action);
  }
}

// ====================================================================
// CORE V11.4.9 — คงกฎ cleanup จากไฟล์ต้นฉบับ ปรับเฉพาะจุดเชื่อมเอกสาร/แท็บ/UI
// ====================================================================

// V11.4.9 - เพิ่ม KEEP_EXISTING chapter title layout, ลบต้นฉบับอังกฤษก่อนบทแปล (HIGH confidence เท่านั้น),
//           รายงาน "ต้นฉบับไม่มีบทที่", ล้างข้อความโปรโมตท้ายบท + เติม "จบตอน" อัตโนมัติ,
//           แยก SOURCE_EPISODE_MARKER กลางเนื้อหาออกจาก chapter sequence
// V11.4.8 - เพิ่มรองรับการแปลง "บท N:" เป็น "บทที่ N" + ลบเครื่องหมายคั่นหลังเลขบท
// V11.4.7 - เพิ่มรองรับการลบเลขตอนแบบช่วง เช่น "ตอนที่ 465-466" / "ตอนที่ 465–466" / "ตอนที่ 465—466"
// V11.4.6 - คงพฤติกรรม V11.4.5 + เขียนเลขบทใหม่ตามเลขเริ่มต้น/ลำดับแท็บ
const NOTE_TEXT_ = "พบคำต่างประเทศ";
const INVIS_RE_ = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g;
const COLON_CLASS_ = "[:：﹕꞉∶։]";
const EXTRA_ALLOWED_CHARS_V9_ = new Set(["・"]);
const FOREIGN_WORD_RE_V9_ = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u0400-\u04FF\u1E00-\u1EFF\u0300-\u036F]+/g;

// ===== V11.4.6 Force Chapter Number =====
// ใช้แก้เคสเว็บ/AI เอาเลขด้านบนผิดมาเป็นหัวบท เช่น หน้าเว็บ Ch.451 แต่เนื้อหาจริงคือ Chapter 436
// วิธีทำงาน:
// 1) ถ้า AUTO_FROM_DOCUMENT_TITLE = true จะดึงเลขเริ่มจากชื่อไฟล์ Docs เช่น "436 - 485" => เริ่ม 436
// 2) CENTRAL: กำหนด START_NUMBER เองได้; ถ้าเป็น null และชื่อไฟล์ไม่มีช่วงเลข ให้หยุด ไม่ใช้ 46 เดิม
// 3) เลขบทเรียงตามแท็บทั้งเอกสาร: แท็บ 1 = START_NUMBER; แม้ TAB_FROM > 1 ก็ยังนับจากแท็บแรก
const FORCE_CHAPTER_NUMBER_CONFIG_ = {
  ENABLED: CENTRAL_CONFIG_.FORCE_CHAPTER_NUMBERS,
  AUTO_FROM_DOCUMENT_TITLE: CENTRAL_CONFIG_.START_NUMBER === null,
  START_NUMBER: CENTRAL_CONFIG_.START_NUMBER,
  MAX_LOOKUP_PARAGRAPHS: 120
};

/**
 * V11.4.9: layout ของหัวบท/ชื่อบท
 * KEEP_EXISTING (ค่าเริ่มต้น): ไม่แก้โครงสร้าง paragraph ไม่ว่าหัวบทเดิมจะอยู่บรรทัดเดียวหรือแยกบรรทัด
 * KEEP_SAME_LINE: ถ้าแยกบรรทัดอยู่ ให้พยายามรวมกลับเป็นบรรทัดเดียวผ่าน mergeChapterTitleBackInActiveTab_()
 * SPLIT_NEXT_LINE: ถ้าอยู่บรรทัดเดียว ให้แยกชื่อบทไปบรรทัดถัดไปผ่าน splitChapterTitleToNextLine_() (พฤติกรรมเดิมก่อน V11.4.9)
 */
const STANDALONE_CHAPTER_TITLE_CONFIG_ = {
  LAYOUT_MODE: 'KEEP_EXISTING'
};

/**
 * V11.4.9: ตรวจ/ลบต้นฉบับภาษาอังกฤษที่ติดมาก่อนหัวบทแปลภาษาไทยในแท็บเดียวกัน
 * ลบเฉพาะกรณีความมั่นใจสูง (ผ่านเงื่อนไขครบทุกข้อ) เท่านั้น กรณีไม่มั่นใจให้ report ไว้ ไม่ลบ
 */
const ENGLISH_SOURCE_CLEANUP_CONFIG_ = {
  ENABLED: true,
  AUTO_REMOVE_HIGH_CONFIDENCE: true,
  REPORT_UNCERTAIN_CASES: true,
  MIN_ENGLISH_PARAGRAPHS: 2,
  MIN_LATIN_RATIO: 0.65,
  MIN_THAI_PARAGRAPHS_AFTER_HEADING: 2,
  MAX_SCAN_PARAGRAPHS: 300
};

/**
 * V11.4.9: ตรวจข้อความ "ต้นฉบับไม่มีบทที่" (และข้อความใกล้เคียง) ช่วงต้นแท็บ
 * report-only เท่านั้น: ห้ามลบข้อความออกจาก Google Docs (Standalone ไม่มี Google Sheets ให้บันทึกคอลัมน์ L)
 */
const SOURCE_NO_CHAPTER_NOTE_CONFIG_ = {
  ENABLED: true,
  TOP_MEANINGFUL_PARAGRAPH_LIMIT: 10,
  REMOVE_FROM_DOCUMENT: false
};

/**
 * V11.4.9: ลบข้อความโปรโมต/ปิดท้ายที่ไม่ต้องการ (เช่น "โปรดติดตามตอนต่อไป",
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

/**
 * V11.4.9: หัวตอนต้นฉบับ (เช่น "ตอนที่ 365-366 – ชื่อบท") ที่โผล่กลางเนื้อหา ห่างจากหัวบทเกิน
 * HEADER_PARAGRAPH_LIMIT ย่อหน้าแรกของแท็บ ให้ถือเป็น source episode marker: report-only เท่านั้น
 * ไม่ลบอัตโนมัติ และไม่นำไปตรวจ chapter sequence (กันเลขบทไม่ต่อเนื่อง/ซ้ำหลอกจากต้นฉบับ)
 * ส่วน episode prefix ที่ติดอยู่บรรทัดเดียวกัน/บรรทัดถัดจากหัวบทจริง ยังลบได้ตามปกติผ่าน
 * removeEpisodeTitlePrefixAndBracketChapterNumber_() เหมือนเดิม - ไม่เกี่ยวกับ config นี้
 */
const SOURCE_EPISODE_MARKER_CONFIG_ = {
  ENABLED: true,
  HEADER_PARAGRAPH_LIMIT: 5,
  IGNORE_FOR_SEQUENCE_CHECK: true
};

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

/** 🧭 เพิ่มเมนูใน Google Docs */
function onOpen() {
  centralNotify_('ฉบับโค้ดกลาง: ใช้ previewCentral หรือ runCentral ใน Apps Script ไม่สร้างเมนูที่เอกสารปลายทาง');
}

function getActiveBody_() {
  centralAssertWriting_();
  return getProcessingTab_().asDocumentTab().getBody();
}

function getCurrentTabTitle_() {
  return getProcessingTab_().getTitle();
}

function cleanText_(s) { return String(s || "").replace(INVIS_RE_, "").trim(); }
function normalizeChapterLine_(s) { return cleanText_(s).replace(/^[\s\u2013\u2014\-–—]+/, "").trim(); }
function isChapterLineText_(s) { return /^(บท(?:ที่)?|ตอนที่)\s*[0-9๐-๙]+/.test(s) || /^chapter\s*[0-9]+/i.test(s); }

function findFirstNonNoteParagraph_(body, limit = 9999) {
  const paras = body.getParagraphs();
  for (let i = 0; i < Math.min(paras.length, limit); i++) {
    const t = cleanText_(paras[i].getText());
    if (t && t !== NOTE_TEXT_) return paras[i];
  }
  return null;
}

function findChapterParagraph_(body, limit = 120) {
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
  try {
    const parent = p.getParent();
    if (parent && typeof parent.removeChild === "function") {
      parent.removeChild(p);
      return true;
    }
  } catch (e) {}
  try {
    const t = p.editAsText(), len = t.getText().length;
    if (len > 0) t.deleteText(0, len - 1);
    t.setBold(false); t.setUnderline(false); t.setForegroundColor(null); t.setBackgroundColor(null);
  } catch (e2) {}
  return false;
}

// ===============================
// ✅ ตรวจ “แท็บนี้”
// ===============================
function runChecksCurrentTabWithAlert() {
  const r = runAllChecks();
  const lines = [
    `📄 แท็บ: ${getCurrentTabTitle_()}`,
    `🔁 แทนที่ "—" เป็น "..." แล้ว ${r.replacedEmDashCount} ตำแหน่ง`,
    `🗑️ ลบอักษรละตินพิเศษแล้ว ${(r.latinSpecialRemoved?.total || 0)} ตัว`,
    r.nonThaiCount === 0 ? "✅ ไม่พบตัวอักษรต่างประเทศ" : `🔍 พบตัวอักษรต่างประเทศ ${r.nonThaiCount} ตัว และไฮไลต์แล้ว`,
    `↩️ แยกบรรทัด ${r.breakPairs?.total || 0} จุด`,
    `📑 จัดรูปแบบย่อหน้าแล้ว ${r.paragraphCount} ย่อหน้า`,
    `📏 เว้นระยะห่างแล้ว ${r.spacingCount} ย่อหน้า`,
    `🧹 ลบบรรทัดว่างแล้ว ${r.blankRemoved} บรรทัด`,
    `🗑️ ลบคำในวงเล็บแล้ว ${r.removedCount} ตำแหน่ง`,
    `🏷️ ลบวงเล็บท้ายชื่อตอนแล้ว ${r.removedTitleParens} จุด`,
`🧹 แก้ "ตอนที่ N" หลัง "บทที่ N" / ลบ [] เลขบทแล้ว ${(r.episodeTitlePrefixAndBracketFixed?.changed || 0)} จุด`,
    `🧹 ลบหัวบทซ้ำหน้าชื่อบทแล้ว ${(r.repeatedChapterPrefixRemoved?.changed || 0)} จุด`,
    `🧹 ลบเลขบท/ชื่อบทซ้ำท้ายชื่อบทแล้ว ${(r.trailingChapterNumberRemoved?.changed || 0)} จุด`,
    `🔢 เขียนเลขบทใหม่ตามแท็บแล้ว ${(r.forcedChapterNumber?.changed || 0)} จุด${r.forcedChapterNumber?.expectedNumber ? ` (ควรเป็นบทที่ ${r.forcedChapterNumber.expectedNumber})` : ""}`,
    `🧹 ลบบรรทัดหัวบทซ้ำแล้ว ${(r.duplicateChapterHeadingRemoved?.removed || 0)} บรรทัด`,
    `🧹 ลบชื่อบทซ้ำแล้ว ${(r.duplicateChapterTitleRemoved?.removed || 0)} บรรทัด`,
    `🧾 ลบ [เลขบท] / [โบนัส] แล้ว ${(r.removedLeadingBracketTags?.changedCount || 0)} จุด`,
    r.chapterSequence && r.chapterSequence.ok ? "🔢 เลขบทในแท็บนี้ต่อเนื่อง" : "⚠️ พบเลขบทในแท็บนี้ไม่ต่อเนื่อง/ซ้ำ",
    `🏷️ layout หัวบท: ${r.chapterTitleLayout?.mode || 'KEEP_EXISTING'} (${r.chapterTitleLayout?.detectedLayout || 'ไม่พบหัวบท'})`
  ];

  const eng = r.englishSourceCleanup || {};
  if (eng.detected) {
    lines.push(
      eng.removed
        ? `🧹 ลบต้นฉบับภาษาอังกฤษก่อนบทแปล ${eng.removedParagraphs} ย่อหน้า (${eng.englishHeading} → ${eng.thaiHeading})`
        : `⚠️ อาจพบต้นฉบับภาษาอังกฤษก่อนบทแปล แต่ยังไม่ลบ (confidence: ${eng.confidence})`
    );
  }

  if (r.sourceNoChapterNote && r.sourceNoChapterNote.found) {
    lines.push(`📝 ${r.sourceNoChapterNote.note} (ย่อหน้าที่ ${r.sourceNoChapterNote.paragraphIndex})`);
  }

  const sourceMarkers = (r.chapterSequence && r.chapterSequence.sourceEpisodeMarkers) || [];
  if (sourceMarkers.length) {
    lines.push(`📚 พบต้นฉบับหลายตอนรวมอยู่ในแท็บเดียว ${sourceMarkers.length} จุด (report-only ไม่เข้า chapter sequence)`);
  }

  const ending = r.endingCleanup || {};
  lines.push(
    `🧹 ลบข้อความโปรโมตท้ายบทแล้ว ${ending.removedPromoLines || 0} บรรทัด`,
    `✅ "จบตอน": ${ending.insertedEndMarker ? 'เพิ่มแล้ว' : (ending.hadEndMarker ? 'มีอยู่แล้ว' : 'ไม่ได้เพิ่ม')}${ending.dedupedEndMarker ? ` (ลบซ้ำ ${ending.dedupedEndMarker} บรรทัด)` : ''}`
  );

  lines.push("", "🎉 แท็บนี้เสร็จแล้ว!");
  centralNotify_(lines.join("\n"));
  return r;
}

/** 🔁 แทนที่ — เป็น ... และแก้ و เป็น ล */
function replaceEmDashWithEllipsis() {
  const body = getActiveBody_(), text = body.getText();
  const emDashCount = (text.match(/—/g) || []).length, wawCount = (text.match(/و/g) || []).length;
  if (emDashCount > 0) body.replaceText("—", "...");
  if (wawCount > 0) body.replaceText("و", "ล");
  return { emDashCount, wawCount };
}

/** ✅ ตรวจว่าเป็น kaomoji หรือไม่ */
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

/** ✅ สร้าง map ตำแหน่งที่ควร skip เพราะเป็น kaomoji */
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

//ยกเว้นไฮไลต์
const EXTRA_ALLOWED_FOREIGN_WORDS_V9_ = new Set([
  "川",
  "大",
  "木"
]);

function shouldSkipForeignWordV9_(word, fullText, start, end) {
  if (!word) return true;

  if (isExplicitlyAllowedForeignWordV9_(word)) return true;
  if (isAllowedSpecialCharOnlyV9_(word)) return true;

  const context = getContextAroundWordV9_(fullText, start, end, 20);
  return isLikelyKaomojiV9_(context);
}

function isExplicitlyAllowedForeignWordV9_(word) {
  return EXTRA_ALLOWED_FOREIGN_WORDS_V9_.has(word);
}

function isAllowedSpecialCharOnlyV9_(word) {
  return [...word].every(ch => EXTRA_ALLOWED_CHARS_V9_.has(ch));
}

function getContextAroundWordV9_(text, start, end, radius) {
  const left = Math.max(0, start - radius);
  const right = Math.min(text.length, end + radius + 1);
  return text.slice(left, right);
}

/** 🔍 ตรวจคำต่างประเทศ + ยกเว้น kaomoji */
function highlightForeignCharacters() {
  const body = getActiveBody_(), textElement = body.editAsText(), text = textElement.getText();
  textElement.setBackgroundColor(null);

  let count = 0;
  const re = new RegExp(FOREIGN_WORD_RE_V9_.source, "g");
  const kaomojiSkipMap = buildKaomojiSkipMapV9_(text);

  let match;
  while ((match = re.exec(text)) !== null) {
    const word = match[0], start = match.index, end = start + word.length - 1;
    if (kaomojiSkipMap[start] || shouldSkipForeignWordV9_(word, text, start, end)) continue;

    let allAllowed = true;
    for (let i = 0; i < word.length; i++) {
      if (!EXTRA_ALLOWED_CHARS_V9_.has(word[i])) { allAllowed = false; break; }
    }
    if (allAllowed) continue;

    textElement.setBackgroundColor(start, end, "#FF3333");
    count += word.length;
  }

  const paragraphs = body.getParagraphs(), noteIndexes = [];
  for (let i = 0; i < Math.min(paragraphs.length, 20); i++) {
    if (cleanText_(paragraphs[i].getText()) === NOTE_TEXT_) noteIndexes.push(i);
  }
  for (let i = noteIndexes.length - 1; i >= 0; i--) removeParaSafely_(paragraphs[noteIndexes[i]]);
  if (count > 0) body.insertParagraph(0, NOTE_TEXT_).setBold(true).setForegroundColor("#D62828");
  return count;
}

/** ❌ ลบบรรทัดว่างทั้งหมด */
function removeAllBlankLines() {
  const body = getActiveBody_(), paras = body.getParagraphs();
  let removed = 0;
  for (let i = paras.length - 1; i >= 0; i--) {
    if (i === paras.length - 1) continue;
    if (cleanText_(paras[i].getText()) === "") { body.removeChild(paras[i]); removed++; }
  }
  return removed;
}

/** 📑 จัดรูปแบบย่อหน้า */
function formatParagraphIndent() {
  const paragraphs = getActiveBody_().getParagraphs(), indent = 36;
  let count = 0;
  paragraphs.forEach(p => {
    const tx = (p.getText() || "").trim();
    if (!tx) return;
    try {
      if (isStatusPanelLine_(tx)) { p.setIndentFirstLine(0); p.setIndentStart(0); }
      else { p.setIndentFirstLine(indent); p.setIndentStart(0); }
    } catch (e) {}
    count++;
  });
  return count;
}

/** 📏 เว้นระยะห่างหลังพารากราฟ */
function setParagraphSpacing(after = 10) {
  const paragraphs = getActiveBody_().getParagraphs();
  let count = 0;
  paragraphs.forEach(p => {
    const tx = (p.getText() || "").trim();
    if (!tx) return;
    try {
      p.setSpacingBefore(0);
      p.setSpacingAfter(isStatusPanelLine_(tx) ? 0 : after);
    } catch (e) {}
    count++;
  });
  return count;
}

/** 🔠 ปรับฟอนต์เป็น Sarabun 16 สีดำ */
function setFontToSarabun16() {
  const body = getActiveBody_(), text = body.editAsText();
  text.setFontFamily("Sarabun"); text.setFontSize(18); text.setForegroundColor("#000000");

  const paras = body.getParagraphs();
  for (let i = 0; i < Math.min(paras.length, 5); i++) {
    if ((paras[i].getText() || "").trim() === NOTE_TEXT_) {
      paras[i].editAsText().setForegroundColor("#D62828");
      paras[i].setBold(true);
      break;
    }
  }
  return true;
}

/** 🧽 ล้างไฮไลต์แท็บปัจจุบัน */
function clearHighlights() {
  const totalCleared = clearHighlightsInElement(getActiveBody_());
  centralNotify_(`🧽 ล้างสีไฮไลต์ทั้งหมดเรียบร้อยแล้ว (${totalCleared} ย่อหน้า)`);
}

/** 🧽 ล้างไฮไลต์ทุกแท็บ */
function clearHighlightsAllTabs() {
  const doc = getTargetDocument_();
  let totalCleared = 0, tabCount = 0;
  const currentTab = getProcessingTab_();
  const currentTabId = currentTab && currentTab.getId ? currentTab.getId() : null;

  if (doc.getTabs) {
    const tabs = getAllTabsFlat_(doc);
    tabs.forEach(t => {
      selectProcessingTab_(doc, t.getId());
      totalCleared += clearHighlightsInElement(getActiveBody_());
      tabCount++;
    });
    if (currentTabId) try { selectProcessingTab_(doc, currentTabId); } catch (e) {}
  } else {
    totalCleared += clearHighlightsInElement(doc.getBody());
    tabCount = 1;
  }

  centralNotify_(`🧽 ล้างสีไฮไลต์เรียบร้อยแล้ว\n📄 จำนวนแท็บ: ${tabCount}\n🧹 ล้างแล้ว: ${totalCleared} องค์ประกอบ`);
}

/** 🧱 ล้างสีภายใน element (recursive) */
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

function thaiDigitsToArabic_(s) {
  return String(s || '').replace(/[๐-๙]/g, function(ch) {
    return {
      '๐': '0',
      '๑': '1',
      '๒': '2',
      '๓': '3',
      '๔': '4',
      '๕': '5',
      '๖': '6',
      '๗': '7',
      '๘': '8',
      '๙': '9'
    }[ch] || ch;
  });
}

function extractChapterNumberFromText_(text) {
  const s = thaiDigitsToArabic_(String(text || ''))
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return null;

  let m = s.match(/^(?:บท(?:ที่)?|ตอนที่)\s*([0-9]+)/i);
  if (m) return Number(m[1]);

  m = s.match(/^chapter\s*([0-9]+)/i);
  if (m) return Number(m[1]);

  m = s.match(/(?:บท(?:ที่)?|ตอนที่|chapter)\s*([0-9]+)/i);
  if (m) return Number(m[1]);

  return null;
}

/**
 * V11.4.9: ตรวจว่าเป็นหัวตอนต้นฉบับ (เช่น "ตอนที่ 365-366 – ชื่อบท") ที่อยู่ไกลจากต้นแท็บเกิน
 * SOURCE_EPISODE_MARKER_CONFIG_.HEADER_PARAGRAPH_LIMIT ย่อหน้าแรกหรือไม่ - ถ้าใกล้ต้นแท็บ
 * (<= limit) ถือว่าอาจเป็นหัวบทของแท็บเอง (บางไฟล์ใช้ "ตอนที่ N" แทน "บทที่ N") ไม่ใช่ marker
 */
function parseSourceEpisodeMarker_(text, paragraphIndex) {
  if (!SOURCE_EPISODE_MARKER_CONFIG_ || SOURCE_EPISODE_MARKER_CONFIG_.ENABLED === false) return null;

  const headerLimit = Math.max(0, Number(SOURCE_EPISODE_MARKER_CONFIG_.HEADER_PARAGRAPH_LIMIT || 0));
  if (Number(paragraphIndex || 0) <= headerLimit) return null;

  const normalized = thaiDigitsToArabic_(String(text || ''))
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const digit = '[0-9]+(?:\\.[0-9]+)?';
  const rangeSep = '(?:[-–—]|\\.{2,})';
  const markerRe = new RegExp(
    '^(ตอนที่|ตอน|episode|ep)\\s*\\[?\\s*(' + digit + '(?:\\s*' + rangeSep + '\\s*' + digit + ')?)\\s*\\]?' +
      '(?:\\s*(?:[:：\\-–—]|\\.{2,})\\s*|\\s+|$)',
    'i'
  );
  const m = normalized.match(markerRe);
  if (!m) return null;

  return {
    sourceLabel: m[1],
    sourceEpisodeNumber: String(m[2] || '').replace(/\s+/g, ''),
    paragraphIndex: Number(paragraphIndex || 0),
    text: cleanText_(text)
  };
}

/**
 * เก็บเฉพาะ paragraph ที่ "ขึ้นต้น" ด้วยหัวบท/หัวตอน (isChapterLineText_) เท่านั้น
 * V11.4.8 เดิมใช้ extractChapterNumberFromText_() ที่มี fallback regex แบบไม่ยึด ^
 * ทำให้ประโยคกลางเนื้อหาที่มีคำว่า "บทที่"/"ตอนที่" ปนอยู่ (เช่นบทสนทนา) หลุดเข้ามานับเป็น
 * เลขบทผิดๆ ได้ V11.4.9 จึงกรองด้วย isChapterLineText_ ก่อนเสมอ แล้วแยกหัวตอนต้นฉบับ
 * (SOURCE_EPISODE_MARKER) ออกจากเลขบทจริง ไม่ให้เข้า chapter sequence
 */
function collectChapterNumbersFromBody_(body) {
  const paras = body.getParagraphs();
  const chapters = [];
  const sourceEpisodeMarkers = [];

  for (let i = 0; i < paras.length; i++) {
    const text = cleanText_(paras[i].getText());
    if (!text || text === NOTE_TEXT_) continue;

    const line = normalizeChapterLine_(text);
    if (!isChapterLineText_(line)) continue;

    const marker = parseSourceEpisodeMarker_(line, i + 1);
    if (marker) {
      sourceEpisodeMarkers.push(marker);
      if (!SOURCE_EPISODE_MARKER_CONFIG_ || SOURCE_EPISODE_MARKER_CONFIG_.IGNORE_FOR_SEQUENCE_CHECK !== false) continue;
    }

    const num = extractChapterNumberFromText_(text);
    if (num != null) {
      chapters.push({
        paragraphIndex: i + 1,
        text: text,
        chapterNumber: num
      });
    }
  }

  return { chapters: chapters, sourceEpisodeMarkers: sourceEpisodeMarkers };
}

function checkChapterSequenceInBody_() {
  const body = getActiveBody_();
  const scan = collectChapterNumbersFromBody_(body);
  const chapters = scan.chapters;
  const issues = [];

  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1];
    const curr = chapters[i];
    const expected = prev.chapterNumber + 1;

    if (curr.chapterNumber !== expected) {
      let type = 'ไม่ต่อเนื่อง';
      if (curr.chapterNumber === prev.chapterNumber) type = 'เลขซ้ำ';
      else if (curr.chapterNumber < prev.chapterNumber) type = 'เลขย้อนหลัง';
      else if (curr.chapterNumber > expected) type = 'เลขข้าม';

      issues.push({
        type: type,
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


function classifyChapterSequenceIssue_(previous, current) {
  const expected = Number(previous || 0) + 1;
  let type = 'ไม่ต่อเนื่อง';
  if (Number(current) === Number(previous)) type = 'เลขซ้ำ';
  else if (Number(current) < Number(previous)) type = 'เลขย้อนหลัง';
  else if (Number(current) > expected) type = 'เลขข้าม';
  return { type: type, expected: expected };
}

function collectChapterSequenceItemsFromResult_(result, tabName, tabIndex) {
  const seq = result && result.chapterSequence ? result.chapterSequence : {};
  const chapters = seq.chapters || [];
  return chapters.map(function(ch) {
    return {
      tab: tabName,
      tabIndex: tabIndex,
      paragraphIndex: ch.paragraphIndex,
      text: ch.text,
      chapterNumber: ch.chapterNumber
    };
  });
}

function analyzeChapterSequenceAcrossItems_(items) {
  items = (items || []).filter(function(x) {
    return x && x.chapterNumber != null && !isNaN(Number(x.chapterNumber));
  });

  const issues = [];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const curr = items[i];
    const issueBase = classifyChapterSequenceIssue_(prev.chapterNumber, curr.chapterNumber);

    if (Number(curr.chapterNumber) !== issueBase.expected) {
      issues.push({
        type: issueBase.type,
        expected: issueBase.expected,
        previous: prev.chapterNumber,
        current: curr.chapterNumber,
        previousTab: prev.tab,
        tab: curr.tab,
        tabIndex: curr.tabIndex,
        paragraphIndex: curr.paragraphIndex,
        text: curr.text
      });
    }
  }

  return {
    ok: issues.length === 0,
    totalFound: items.length,
    items: items,
    issues: issues,
    hasDuplicateChapter: issues.some(function(x) { return x.type === 'เลขซ้ำ'; })
  };
}

function buildChapterSequenceAlertLines_(summary) {
  const lines = [];
  const issues = summary && summary.chapterSequenceIssues ? summary.chapterSequenceIssues : [];

  if (!summary || !summary.chapterTotalFound) {
    lines.push('🔢 เลขบท: ไม่พบเลขบท');
    return lines;
  }

  if (!issues.length) {
    lines.push('🔢 เลขบท: ต่อเนื่อง');
    return lines;
  }

  const hasDup = issues.some(function(x) { return x.type === 'เลขซ้ำ'; });
  const title = hasDup ? '⚠️ เลขบทซ้ำ' : '⚠️ เลขบทไม่ต่อเนื่อง';
  lines.push(title + ' (' + issues.length + ' จุด)');

  issues.slice(0, 20).forEach(function(issue) {
    const tabName = issue.tab || 'ไม่ทราบแท็บ';
    if (issue.type === 'เลขซ้ำ') {
      lines.push('- ' + tabName + ': ซ้ำเลข ' + issue.current);
    } else {
      lines.push('- ' + tabName + ': หลัง ' + issue.previous + ' ควรเป็น ' + issue.expected + ' แต่พบ ' + issue.current);
    }
  });

  if (issues.length > 20) {
    lines.push('- ...และอีก ' + (issues.length - 20) + ' จุด');
  }

  return lines;
}



/**
 * 🔢 V11.4.6 เขียนเลขบทใหม่ตามเลขเริ่มต้น + ลำดับแท็บ
 * ตัวอย่างเอกสารชื่อ "... 436 - 485":
 * - แท็บ 1 จะถูกเขียนเป็น "บทที่ 436"
 * - แท็บ 2 จะถูกเขียนเป็น "บทที่ 437"
 * ใช้สำหรับแก้เคส AI เอาเลขเว็บด้านบนผิดมาเป็นหัวบท เช่น บทที่ 451 ทั้งที่ควรเป็น บทที่ 436
 */
function getDocumentTitleStartChapterNumber_() {
  try {
    const doc = getTargetDocument_();
    const name = doc && doc.getName ? thaiDigitsToArabic_(doc.getName()) : '';
    const s = String(name || '')
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!s) return null;

    // จับช่วงเลขในชื่อไฟล์ เช่น "31 - 100", "436-485", "436 – 485", "436 ถึง 485"
    const rangeRe = /(?:^|[^0-9])([0-9]{1,5})\s*(?:-|–|—|ถึง|to)\s*([0-9]{1,5})(?:[^0-9]|$)/i;
    const m = s.match(rangeRe);
    if (!m) return null;

    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!isFinite(start) || !isFinite(end) || start <= 0) return null;
    if (end < start) return null;
    return start;
  } catch (e) {
    return null;
  }
}

function getForcedChapterStartNumber_() {
  const cfg = FORCE_CHAPTER_NUMBER_CONFIG_ || {};
  if (!cfg.ENABLED) return null;

  if (cfg.AUTO_FROM_DOCUMENT_TITLE) {
    const fromTitle = getDocumentTitleStartChapterNumber_();
    if (fromTitle != null) return fromTitle;
  }

  const n = Number(cfg.START_NUMBER || 0);
  return isFinite(n) && n > 0 ? n : null;
}

function getActiveTabOrderIndex_() {
  return centralRequireContext_().activeIndex;
}

function getExpectedChapterNumberForActiveTab_() {
  const start = getForcedChapterStartNumber_();
  if (start == null) return null;
  return start + getActiveTabOrderIndex_();
}

function parseChapterLineInfoV1146_(text) {
  const raw = cleanText_(text);
  if (!raw || raw === NOTE_TEXT_) return null;

  const line = normalizeChapterLine_(raw)
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let m = line.match(/^(?:บท(?:ที่)?|ตอนที่)\s*([0-9๐-๙]+)\s*(.*)$/i);
  if (m) {
    return {
      number: Number(thaiDigitsToArabic_(m[1])),
      rest: String(m[2] || '').replace(/^\s*[:：﹕꞉∶։\-–—]+\s*/u, '').trim(),
      raw: raw
    };
  }

  m = line.match(/^chapter\s*([0-9๐-๙]+)\s*(.*)$/i);
  if (m) {
    return {
      number: Number(thaiDigitsToArabic_(m[1])),
      rest: String(m[2] || '').replace(/^\s*[:：﹕꞉∶։\-–—]+\s*/u, '').trim(),
      raw: raw
    };
  }

  return null;
}

function findFirstChapterParagraphIndexV1146_(paras, limit) {
  const max = Math.min(paras.length, Number(limit || 120));
  for (let i = 0; i < max; i++) {
    const t = cleanText_(paras[i].getText());
    if (!t || t === NOTE_TEXT_) continue;
    const info = parseChapterLineInfoV1146_(t);
    if (info) return i;
  }
  return -1;
}

function findNextMeaningfulParagraphIndexV1146_(paras, startIndex, maxForward) {
  const end = Math.min(paras.length, startIndex + 1 + Number(maxForward || 6));
  for (let i = startIndex + 1; i < end; i++) {
    const t = cleanText_(paras[i].getText());
    if (!t || t === NOTE_TEXT_) continue;
    return i;
  }
  return -1;
}

function sameNormalizedTextV1146_(a, b) {
  return String(a || '')
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim() === String(b || '')
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function writeForcedChapterHeadingV1146_(p, expectedNumber) {
  const attrs = p.getAttributes ? p.getAttributes() : {};
  const textAttrs = getFirstTextAttributesSafe_(p);
  const newText = 'บทที่ ' + Number(expectedNumber);

  p.setText(newText);
  try { p.setAttributes(attrs); } catch (e) {}
  restoreHeadingStyleIfNeeded_(p, true, textAttrs);
  setHeadingLineStyle_(p);
  return newText;
}

function forceFirstChapterHeadingNumberInActiveTab_() {
  const expected = getExpectedChapterNumberForActiveTab_();
  const start = getForcedChapterStartNumber_();
  const tabIndex = getActiveTabOrderIndex_() + 1;

  if (expected == null) {
    return { changed: 0, expectedNumber: null, startNumber: null, tabIndex: tabIndex, reason: 'disabled_or_no_start_number' };
  }

  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const idx = findFirstChapterParagraphIndexV1146_(paras, FORCE_CHAPTER_NUMBER_CONFIG_.MAX_LOOKUP_PARAGRAPHS || 120);

  if (idx < 0) {
    return { changed: 0, expectedNumber: expected, startNumber: start, tabIndex: tabIndex, reason: 'no_chapter_heading' };
  }

  const p = paras[idx];
  const before = cleanText_(p.getText());
  const info = parseChapterLineInfoV1146_(before);
  const currentNumber = info ? info.number : null;
  const titlePart = info && info.rest ? String(info.rest || '').trim() : '';

  // ถ้าหัวบทมาในบรรทัดเดียวกับชื่อบท เช่น "บทที่ 451 ลูกเสิร์ฟ..."
  // ให้เก็บชื่อบทไว้เป็นบรรทัดถัดไปก่อนเขียนหัวบทใหม่
  let insertedTitle = 0;
  if (titlePart && !isStatusPanelLine_(titlePart) && !parseChapterLineInfoV1146_(titlePart)) {
    const nextIdx = findNextMeaningfulParagraphIndexV1146_(paras, idx, 3);
    const nextText = nextIdx >= 0 ? cleanText_(paras[nextIdx].getText()) : '';
    if (!nextText || !sameNormalizedTextV1146_(nextText, titlePart)) {
      const insertAt = body.getChildIndex ? body.getChildIndex(p) + 1 : idx + 1;
      const np = body.insertParagraph(insertAt, titlePart);
      try { np.setAttributes(p.getAttributes ? p.getAttributes() : {}); } catch (e) {}
      setHeadingLineStyle_(np);
      insertedTitle = 1;
    }
  }

  const after = writeForcedChapterHeadingV1146_(p, expected);
  const changed = before !== after || Number(currentNumber) !== Number(expected) || insertedTitle ? 1 : 0;

  return {
    changed: changed,
    expectedNumber: expected,
    startNumber: start,
    tabIndex: tabIndex,
    paragraphIndex: idx + 1,
    currentNumber: currentNumber,
    from: before,
    to: after,
    insertedTitle: insertedTitle
  };
}

function forceChapterNumbersAllTabs_() {
  const doc = getTargetDocument_();
  const currentTab = getProcessingTab_();
  const currentTabId = currentTab && currentTab.getId ? currentTab.getId() : null;

  if (!doc.getTabs) {
    const r = forceFirstChapterHeadingNumberInActiveTab_();
    return {
      tabChecked: 1,
      tabTotal: 1,
      changedCount: r.changed || 0,
      startNumber: r.startNumber,
      changedTabs: r.changed ? ['เอกสารหลัก'] : [],
      changes: r.changed ? [{ tab: 'เอกสารหลัก', from: r.from, to: r.to, expectedNumber: r.expectedNumber }] : []
    };
  }

  const tabs = getAllTabsFlat_(doc);
  const result = {
    tabChecked: 0,
    tabTotal: tabs.length,
    changedCount: 0,
    startNumber: getForcedChapterStartNumber_(),
    changedTabs: [],
    changes: []
  };

  tabs.forEach(function(tab, idx) {
    selectProcessingTab_(doc, tab.getId());
    const r = forceFirstChapterHeadingNumberInActiveTab_();
    result.tabChecked++;

    if (r && r.changed) {
      const name = getTabNameSafe_(tab, idx);
      result.changedCount += 1;
      result.changedTabs.push(name);
      result.changes.push({
        tab: name,
        from: r.from,
        to: r.to,
        expectedNumber: r.expectedNumber,
        paragraphIndex: r.paragraphIndex
      });
    }
  });

  if (currentTabId) {
    try { selectProcessingTab_(doc, currentTabId); } catch (e) {}
  }

  return result;
}

function forceChapterNumbersAllTabsWithAlert() {
  const r = forceChapterNumbersAllTabs_();
  const lines = [
    '🔢 เขียนเลขบทตามแท็บเรียบร้อย',
    '🧾 ตรวจแล้ว ' + r.tabChecked + '/' + r.tabTotal + ' แท็บ',
    'ตั้งต้นที่บท: ' + (r.startNumber || 'ไม่พบเลขเริ่มต้น'),
    '✅ แก้ไขแล้ว: ' + r.changedCount + ' แท็บ'
  ];

  if (r.changedTabs && r.changedTabs.length) {
    lines.push('', 'ตัวอย่างที่แก้ไข:');
    (r.changes || []).slice(0, 20).forEach(function(item) {
      lines.push('- ' + item.tab + ': ' + item.from + ' → ' + item.to);
    });
    if (r.changes.length > 20) lines.push('...อีก ' + (r.changes.length - 20) + ' แท็บ');
  } else {
    lines.push('', 'ℹ️ ไม่พบหัวบทที่ต้องเปลี่ยน หรือเลขบทถูกต้องอยู่แล้ว');
  }

  centralNotify_(lines.join('\n'));
  return r;
}

/** 🧹 ลบบรรทัดหัวบทซ้ำติดกัน เช่น
 * บทที่ 393
 * บทที่ 393
 * ให้เหลือแค่ 1 บรรทัด
 * รองรับ: บทที่ / ตอนที่ / Chapter และเลขไทย
 */
function removeDuplicateChapterHeadingLines_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let removed = 0;
  const removedTexts = [];

  function normalizeChapterOnlyKey_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return null;

    let m = s.match(/^(บทที่|ตอนที่)\s*([0-9]+)$/i);
    if (m) return "บทที่ " + Number(m[2]);

    m = s.match(/^chapter\s*([0-9]+)$/i);
    if (m) return "บทที่ " + Number(m[1]);

    return null;
  }

  // วนจากล่างขึ้นบน เพื่อให้ removeChild แล้ว index ไม่เพี้ยน
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

/** 🧹 ลบชื่อบทซ้ำติดกันหลังหัวบท เช่น
 * บทที่ 236
 * ความกังวลขององค์ไทเฮาเจียงหนานเฟิ่ง!
 * ความกังวลขององค์ไทเฮาเจียงหนานเฟิ่ง!
 * ให้เหลือชื่อบทแค่ 1 บรรทัด
 */
function removeDuplicateChapterTitleLines_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let removed = 0;
  const removedTexts = [];

  function isChapterOnlyHeadingText_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return false;

    return /^(บทที่|ตอนที่)\s*[0-9]+$/i.test(s) || /^chapter\s*[0-9]+$/i.test(s);
  }

  function normalizeTitleKey_(text) {
    const s = cleanText_(text)
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
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

  // วนจากล่างขึ้นบน ป้องกัน index เพี้ยนตอนลบ paragraph
  for (let i = paras.length - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];

    const currKey = normalizeTitleKey_(curr.getText());
    const prevKey = normalizeTitleKey_(prev.getText());

    if (!currKey || !prevKey) continue;
    if (currKey !== prevKey) continue;

    // เช็กว่าบรรทัดก่อนหน้าคู่ซ้ำคือหัวบท เช่น บทที่ 236
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


/** 🧹 V11.4.2 เคลียร์หัวบทที่ซ้ำแล้วหลุดมาอยู่หน้าชื่อบท เช่น
 * บทที่ 12
 * บทที่ 12 ความจริงแล้ว...
 * ให้เหลือ:
 * บทที่ 12
 * ความจริงแล้ว...
 *
 * หมายเหตุ: V11.4 เดิมจัดการเคส "บทที่ 12บทที่ 12" ได้ผ่านลำดับ
 * normalize -> split -> removeDuplicateChapterHeadingLines_ อยู่แล้ว
 * ฟังก์ชันนี้เพิ่มเฉพาะเคสที่หลังเลขบทซ้ำยังมีชื่อบทต่อท้าย
 */
function removeRepeatedChapterPrefixFromTitleLine_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let changed = 0;
  let removed = 0;
  const changes = [];

  function getChapterOnlyInfo_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return null;

    let m = s.match(/^(บทที่|ตอนที่)\s*([0-9]+)$/i);
    if (m) return { num: Number(m[2]), key: "บทที่ " + Number(m[2]) };

    m = s.match(/^chapter\s*([0-9]+)$/i);
    if (m) return { num: Number(m[1]), key: "บทที่ " + Number(m[1]) };

    return null;
  }

  function stripSameChapterPrefix_(text, num) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return null;

    // รองรับทั้ง "บทที่ 12 ชื่อบท", "บทที่ 12ชื่อบท", "ตอนที่ 12 ...", "Chapter 12 ..."
    const n = String(Number(num));
    const reThai = new RegExp("^(?:บท(?:ที่)?|ตอนที่)\\s*" + n + "(?:\\s+|(?=[^0-9])|$)(.*)$", "i");
    const reChapter = new RegExp("^chapter\\s*" + n + "(?:\\s+|(?=[^0-9])|$)(.*)$", "i");

    let m = s.match(reThai) || s.match(reChapter);
    if (!m) return null;

    return String(m[1] || "")
      .replace(/^\s*[:：﹕꞉∶։\-–—]+\s*/u, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // วนบนลงล่าง เพราะเราต้องเทียบหัวบทกับบรรทัดถัดไป
  for (let i = 0; i < paras.length - 1; i++) {
    const headingInfo = getChapterOnlyInfo_(paras[i].getText());
    if (!headingInfo) continue;

    // หา paragraph ถัดไปที่มีข้อความจริง เผื่อมีบรรทัดว่างหรือ NOTE คั่น
    let nextIdx = -1;
    for (let j = i + 1; j < Math.min(paras.length, i + 6); j++) {
      const t = cleanText_(paras[j].getText());
      if (!t || t === NOTE_TEXT_) continue;
      nextIdx = j;
      break;
    }
    if (nextIdx < 0) continue;

    const p = paras[nextIdx];
    const before = cleanText_(p.getText());
    const rest = stripSameChapterPrefix_(before, headingInfo.num);
    if (rest === null) continue;

    if (!rest) {
      removeParaSafely_(p);
      removed++;
      changed++;
      changes.push({ paragraphIndex: nextIdx + 1, from: before, to: "" });
      continue;
    }

    if (rest !== before) {
      const attrs = p.getAttributes ? p.getAttributes() : {};
      p.setText(rest);
      try { p.setAttributes(attrs); } catch (e) {}
      if (typeof setHeadingLineStyle_ === "function") setHeadingLineStyle_(p);
      changed++;
      changes.push({ paragraphIndex: nextIdx + 1, from: before, to: rest });
    }
  }

  return {
    changed: changed,
    removed: removed,
    changes: changes
  };
}


/** 🧹 V11.4.5 ลบเลขบท/ชื่อบทซ้ำที่หลุดไปท้ายชื่อบท เช่น
 * บทที่ 100
 * ปฏิบัติมันให้ถึงที่สุด แม้ต้องแลกด้วยชีวิต!บทที่ 100
 * ให้เหลือ:
 * บทที่ 100
 * ปฏิบัติมันให้ถึงที่สุด แม้ต้องแลกด้วยชีวิต!
 *
 * รองรับท้ายบรรทัด: บทที่ 100 / บท 100 / ตอนที่ 100 / Chapter 100
 * ใช้เฉพาะบรรทัดชื่อบทที่อยู่ถัดจากหัวบทเลขเดียวกันภายใน 6 ย่อหน้า เพื่อลดโอกาสตัดผิด
 */
function removeTrailingChapterMarkerFromTitleLine_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let changed = 0;
  const changes = [];

  function getChapterOnlyInfo_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return null;

    let m = s.match(/^(บท(?:ที่)?|ตอนที่)\s*([0-9]+)$/i);
    if (m) return { num: Number(m[2]) };

    m = s.match(/^chapter\s*([0-9]+)$/i);
    if (m) return { num: Number(m[1]) };

    return null;
  }

  function arabicToThaiDigits_(num) {
    return String(num).replace(/[0-9]/g, function(ch) {
      return {'0':'๐','1':'๑','2':'๒','3':'๓','4':'๔','5':'๕','6':'๖','7':'๗','8':'๘','9':'๙'}[ch] || ch;
    });
  }

  function buildSameChapterMarkerRe_(num) {
    const n = String(Number(num));
    const nThai = arabicToThaiDigits_(n);
    const numAlt = '(?:' + escapeRegExp_(n) + '|' + escapeRegExp_(nThai) + ')';
    const sep = COLON_CLASS_ + '|[-–—]';

    // รองรับทั้งไม่มีช่องว่าง เช่น "ชื่อบท!บทที่ 100" และมีตัวคั่น เช่น "ชื่อบท : Chapter 100 :"
    return new RegExp(
      '\\s*(?:(?:' + sep + ')\\s*)?(?:(?:บท(?:ที่)?|ตอนที่)\\s*' + numAlt + '|chapter\\s*' + numAlt + ')(?:(?:' + sep + ')\\s*)?',
      'ig'
    );
  }

  function normalizeLineForCompare_(s) {
    return String(s || '')
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripEdgeSeparators_(s) {
    return String(s || '')
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .replace(new RegExp('^\\s*(?:' + COLON_CLASS_ + '|[-–—])\\s*'), '')
      .replace(new RegExp('\\s*(?:' + COLON_CLASS_ + '|[-–—])\\s*$'), '')
      .trim();
  }

  function normalizeTitleCompareKey_(s) {
    return thaiDigitsToArabic_(stripEdgeSeparators_(s))
      .replace(/[“”„‟＂"'‘’‚‛`´]/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function finalCleanTitle_(text) {
    let cleaned = String(text || '')
      .replace(new RegExp('^\\s*(?:' + COLON_CLASS_ + '|[-–—])\\s*'), '')
      .replace(new RegExp('\\s*(?:' + COLON_CLASS_ + '|[-–—])\\s*$'), '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    cleaned = dedupeTitleLines_(cleaned);
    cleaned = collapseDuplicatedTitleText_(cleaned);
    return cleaned;
  }

  function dedupeTitleLines_(text) {
    const rawLines = String(text || '')
      .split(/\r?\n+/)
      .map(function(line) { return normalizeLineForCompare_(line); })
      .filter(Boolean);

    if (!rawLines.length) return '';

    const out = [];
    rawLines.forEach(function(line) {
      const prev = out.length ? out[out.length - 1] : '';
      if (line !== prev) out.push(line);
    });

    // ถ้าในย่อหน้าเดียวกันซ้ำแบบ A\nA ให้เหลือ A
    return out.join('\n');
  }

  function collapseDuplicatedTitleText_(text) {
    const s = normalizeLineForCompare_(text);
    const allKey = normalizeTitleCompareKey_(s);

    // สั้นเกินไปไม่คุ้มเสี่ยงตัดผิด
    if (!s || allKey.length < 12 || s.length > 800) return s;

    // แก้เคสหลังลบ marker แล้วกลายเป็น "ชื่อบทชื่อบท"
    for (let k = 1; k < s.length; k++) {
      const left = s.slice(0, k).trim();
      const right = s.slice(k).trim();
      if (!left || !right) continue;

      const leftKey = normalizeTitleCompareKey_(left);
      const rightKey = normalizeTitleCompareKey_(right);
      if (leftKey.length >= 6 && leftKey === rightKey) return left;
    }

    return s;
  }

  function stripDuplicateTitleAroundSameChapterMarker_(text, num) {
    const raw = String(text || '');
    const markerRe = buildSameChapterMarkerRe_(num);
    let m;

    markerRe.lastIndex = 0;
    while ((m = markerRe.exec(raw)) !== null) {
      const left = stripEdgeSeparators_(raw.slice(0, m.index));
      const right = stripEdgeSeparators_(raw.slice(m.index + m[0].length));

      if (left && right) {
        const leftKey = normalizeTitleCompareKey_(left);
        const rightKey = normalizeTitleCompareKey_(right);

        // เคสหลักจากภาพ: "ชื่อบทบทที่ 68 ชื่อบท" หรือ "ชื่อบท : Chapter 68 : ชื่อบท"
        if (leftKey && leftKey === rightKey) return left;
      }

      // เคสเลขบทหลุดท้ายชื่อบทอย่างเดียว: "ชื่อบทบทที่ 68"
      if (left && !right) return left;

      // เคสเลขบทหลุดหน้าชื่อบทอย่างเดียว: "บทที่ 68 ชื่อบท"
      if (!left && right) return right;
    }

    return null;
  }

  function hasSameChapterMarker_(text, num) {
    const markerRe = buildSameChapterMarkerRe_(num);
    markerRe.lastIndex = 0;
    if (markerRe.test(String(text || ''))) return true;

    markerRe.lastIndex = 0;
    return markerRe.test(thaiDigitsToArabic_(String(text || '')));
  }

  function stripSameChapterMarkerAnywhere_(text, num) {
    const raw = String(text || '');
    if (!cleanText_(raw) || cleanText_(raw) === NOTE_TEXT_) return null;
    if (!hasSameChapterMarker_(raw, num)) return null;

    const duplicateAroundMarker = stripDuplicateTitleAroundSameChapterMarker_(raw, num);
    if (duplicateAroundMarker !== null) return finalCleanTitle_(duplicateAroundMarker);

    const markerRe = buildSameChapterMarkerRe_(num);
    markerRe.lastIndex = 0;
    let cleaned = raw.replace(markerRe, '');

    // ถ้าต้นฉบับเป็นเลขไทย แต่ regex บน raw ไม่โดน ให้ลองบน normalized อีกชั้น
    if (cleaned === raw) {
      const n = String(Number(num));
      const sep = COLON_CLASS_ + '|[-–—]';
      const normalizedMarkerRe = new RegExp(
        '\\s*(?:(?:' + sep + ')\\s*)?(?:(?:บท(?:ที่)?|ตอนที่)\\s*' + n + '|chapter\\s*' + n + ')(?:(?:' + sep + ')\\s*)?',
        'ig'
      );
      cleaned = thaiDigitsToArabic_(raw).replace(normalizedMarkerRe, '');
    }

    return finalCleanTitle_(cleaned);
  }

  // วนบนลงล่าง เทียบหัวบทกับย่อหน้าถัดไปที่เป็นชื่อบท
  for (let i = 0; i < paras.length - 1; i++) {
    const headingInfo = getChapterOnlyInfo_(paras[i].getText());
    if (!headingInfo) continue;

    // ตรวจย่อหน้าถัดไปไม่เกิน 6 ย่อหน้า เผื่อมีบรรทัดว่าง/NOTE คั่น
    for (let j = i + 1; j < Math.min(paras.length, i + 7); j++) {
      const p = paras[j];
      const beforeRaw = p.getText();
      const before = cleanText_(beforeRaw);
      if (!before || before === NOTE_TEXT_) continue;
      if (isStatusPanelLine_(before)) break;

      // ถ้าเจอหัวบทใหม่ ให้หยุด ไม่ข้ามไปแก้เนื้อหาบทถัดไป
      const maybeNewHeading = getChapterOnlyInfo_(before);
      if (maybeNewHeading) break;

      const after = stripSameChapterMarkerAnywhere_(beforeRaw, headingInfo.num);
      if (after === null || normalizeLineForCompare_(after) === normalizeLineForCompare_(beforeRaw)) {
        // ถ้าย่อหน้าแรกหลังหัวบทไม่ใช่เคสนี้ ให้ไม่ไปไกลกว่านี้ เพื่อลดตัดผิด
        break;
      }

      if (!after) {
        removeParaSafely_(p);
        changed++;
        changes.push({ paragraphIndex: j + 1, from: before, to: '' });
        break;
      }

      const attrs = p.getAttributes ? p.getAttributes() : {};
      p.setText(after);
      try { p.setAttributes(attrs); } catch (e) {}
      if (typeof setHeadingLineStyle_ === 'function') setHeadingLineStyle_(p);

      changed++;
      changes.push({ paragraphIndex: j + 1, from: before, to: after });
      break;
    }
  }

  return {
    changed: changed,
    changes: changes
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
  const removedTexts = [];

  const bracketOnlyRe = /^\[\s*([0-9]+)\s*\]$/;
  const bracketAtEndRe = /\s*\[\s*([0-9]+)\s*\]\s*$/;

  for (let j = headingIdx + 1; j < Math.min(paras.length, headingIdx + 6); j++) {
    const p = paras[j];
    const text = cleanText_(p.getText());
    if (!text) continue;

    if (text === NOTE_TEXT_) continue;
    if (isChapterLineText_(normalizeChapterLine_(text))) break;
    if (isStatusPanelLine_(text)) break;

    const normalized = thaiDigitsToArabic_(text);

    const onlyMatch = normalized.match(bracketOnlyRe);
    if (onlyMatch) {
      const num = Number(onlyMatch[1]);
      if (num === headingNumber) {
        removedTexts.push(text);
        removeParaSafely_(p);
        removed++;
      }
      continue;
    }

    const endMatch = normalized.match(bracketAtEndRe);
    if (endMatch) {
      const num = Number(endMatch[1]);
      if (num === headingNumber) {
        const newText = text.replace(/\s*\[\s*[0-9๐-๙]+\s*\]\s*$/, '').replace(/\s+$/g, '');
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

/** 🧹 ลบ "ตอนที่ N" หลัง "บทที่ N" + แก้ "บทที่ [N]" เป็น "บทที่ N"
 *
 * ตัวอย่าง:
 * บทที่ 1
 * ตอนที่ 1 – เพชิญหน้ามังกรฟ้า
 * =>
 * บทที่ 1
 * เพชิญหน้ามังกรฟ้า
 *
 * บทที่ [319] พรสวรรค์ของชั้นก็ค่อนข้างธรรมดา
 * =>
 * บทที่ 319 พรสวรรค์ของชั้นก็ค่อนข้างธรรมดา
 */
function removeEpisodeTitlePrefixAndBracketChapterNumber_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let changed = 0;
  let bracketFixed = 0;
  let episodePrefixRemoved = 0;
  let removedLines = 0;
  const changes = [];

  function norm_(text) {
    return thaiDigitsToArabic_(String(text || ''))
      .replace(INVIS_RE_, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isSkipLine_(text) {
    const s = cleanText_(text);
    if (!s || s === NOTE_TEXT_) return true;
    if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(s)) return true;
    return false;
  }

  function parseChapterOnly_(text) {
    const s = norm_(text);
    if (!s) return null;

    // บทที่ 1 / บทที่ [1]
    let m = s.match(/^บทที่\s*\[?\s*([0-9]+(?:[.,][0-9]+)?)\s*\]?\s*$/i);
    if (m) return Number(String(m[1]).replace(',', '.'));

    // เผื่อมี "บท 1"
    m = s.match(/^บท\s*\[?\s*([0-9]+(?:[.,][0-9]+)?)\s*\]?\s*$/i);
    if (m) return Number(String(m[1]).replace(',', '.'));

    return null;
  }

  function fixBracketInChapterLine_(text) {
    let s = norm_(text);
    if (!s) return null;

    // บทที่ [319] xxx -> บทที่ 319 xxx
    let after = s.replace(/^บทที่\s*\[\s*([0-9]+)\s*\]\s*/i, 'บทที่ $1 ');

    // บท [319] xxx -> บทที่ 319 xxx
    after = after.replace(/^บท\s*\[\s*([0-9]+)\s*\]\s*/i, 'บทที่ $1 ');

    after = after.replace(/\s+/g, ' ').trim();

    return after !== s ? after : null;
  }

function removeEpisodePrefixSameLine_(text) {
  const s = norm_(text);
  if (!s) return null;

  // รองรับ:
  // บทที่ 79 ตอนที่ 72.5 – จิ้งจอกสาวขี้อาย
  // บทที่ [319] ตอนที่ 318.5 – ชื่อบท
  // บทที่ 436 ตอนที่ 465-466 – ไปพาตัวอาร์ตันกลับมา
  // บทที่ 436 ตอนที่ 465–466 – ไปพาตัวอาร์ตันกลับมา
  const m = s.match(
    /^บทที่\s*\[?\s*([0-9]+(?:[.,][0-9]+)?)\s*\]?\s+(?:ตอนที่|ตอน|episode|ep\.?)\s*\[?\s*([0-9]+(?:[.,][0-9]+)?(?:[-–—][0-9]+)?)\s*\]?\s*(?:[-–—:：]\s*)?(.*)$/i
  );

  if (!m) return null;

  const chNoText = String(m[1]).replace(',', '.');
  const title = String(m[3] || '').trim();

  // ไม่เช็ก chNo === epNo แล้ว
  return {
    text: ('บทที่ ' + chNoText + (title ? ' ' + title : '')).replace(/\s+/g, ' ').trim(),
    chapterNo: Number(chNoText)
  };
}

function removeEpisodePrefixTitleLine_(text, chapterNo) {
  const s = norm_(text);
  if (!s) return null;

  // รองรับ:
  // ตอนที่ 51 – ชื่อบท
  // ตอนที่ 72.5 – ชื่อบท
  // ตอนที่ [72.5] – ชื่อบท
  // ตอน 72.5 – ชื่อบท
  // Episode 72.5 – ชื่อบท
  // EP 72.5 – ชื่อบท
  // ตอนที่ 465-466 – ชื่อบท
  // ตอนที่ 465–466 – ชื่อบท
  // ตอนที่ 465—466 – ชื่อบท
  // ตอนที่ [465-466] – ชื่อบท
  const m = s.match(
    /^(?:ตอนที่|ตอน|episode|ep\.?)\s*\[?\s*([0-9]+(?:[.,][0-9]+)?(?:[-–—][0-9]+)?)\s*\]?\s*(?:[-–—:：]\s*)?(.*)$/i
  );

  if (!m) return null;

  // ไม่เช็กว่าเลขตอนต้องตรงกับเลขบท
  // เพราะบางไฟล์มี บทที่ 79 แต่ชื่อบรรทัดถัดไปเป็น ตอนที่ 72.5 หรือ ตอนที่ 465-466
  return String(m[2] || '').trim();
}

  function setParaText_(p, newText, forceHeadingStyle) {
    const before = cleanText_(p.getText());
    if (before === newText) return false;

    const attrs = p.getAttributes ? p.getAttributes() : {};
    const textAttrs = typeof getFirstTextAttributesSafe_ === 'function'
      ? getFirstTextAttributesSafe_(p)
      : null;
    const wasBoldUnderline = typeof isBoldUnderlineParagraph_ === 'function'
      ? isBoldUnderlineParagraph_(p)
      : false;

    p.setText(newText);

    try { p.setAttributes(attrs); } catch (e) {}

    if (typeof restoreHeadingStyleIfNeeded_ === 'function') {
      restoreHeadingStyleIfNeeded_(p, wasBoldUnderline || forceHeadingStyle, textAttrs);
    }

    if (forceHeadingStyle && typeof setHeadingLineStyle_ === 'function') {
      setHeadingLineStyle_(p);
    }

    return true;
  }

  // 1) แก้ในบรรทัดเดียวก่อน เช่น บทที่ [319] xxx / บทที่ 1 ตอนที่ 1 - xxx
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const before = cleanText_(p.getText());
    if (isSkipLine_(before)) continue;

    let after = null;

    const sameLine = removeEpisodePrefixSameLine_(before);
    if (sameLine && sameLine.text) {
      after = sameLine.text;
      episodePrefixRemoved++;
    } else {
      const bracketFixedText = fixBracketInChapterLine_(before);
      if (bracketFixedText) {
        after = bracketFixedText;
        bracketFixed++;
      }
    }

    if (after && after !== before) {
      setParaText_(p, after, /^บทที่\s*[0-9]+/.test(after));
      changed++;
      changes.push({
        paragraphIndex: i + 1,
        from: before,
        to: after
      });
    }
  }

  // 2) แก้กรณีแยกบรรทัด:
  // บทที่ 1
  // ตอนที่ 1 - ชื่อบท
  for (let i = paras.length - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];

    const currText = cleanText_(curr.getText());
    const prevText = cleanText_(prev.getText());

    if (isSkipLine_(currText) || isSkipLine_(prevText)) continue;

    const chapterNo = parseChapterOnly_(prevText);
    if (chapterNo == null) continue;

    const titleOnly = removeEpisodePrefixTitleLine_(currText, chapterNo);
    if (titleOnly === null) continue;

    if (titleOnly) {
      setParaText_(curr, titleOnly, true);
      changed++;
      episodePrefixRemoved++;
      changes.push({
        paragraphIndex: i + 1,
        from: currText,
        to: titleOnly
      });
    } else {
      removeParaSafely_(curr);
      changed++;
      episodePrefixRemoved++;
      removedLines++;
      changes.push({
        paragraphIndex: i + 1,
        from: currText,
        to: ''
      });
    }
  }

  return {
    changed: changed,
    bracketFixed: bracketFixed,
    episodePrefixRemoved: episodePrefixRemoved,
    removedLines: removedLines,
    changes: changes
  };
}

function removeEpisodeTitlePrefixAndBracketChapterNumberWithAlert() {
  const r = removeEpisodeTitlePrefixAndBracketChapterNumber_();

  const lines = [
    '🧹 แก้หัวบทเรียบร้อย',
    'แก้ทั้งหมด: ' + r.changed + ' จุด',
    'ลบ [] จากเลขบท: ' + r.bracketFixed + ' จุด',
    'ลบ "ตอนที่ N" หลัง "บทที่ N": ' + r.episodePrefixRemoved + ' จุด'
  ];

  if (r.changes && r.changes.length) {
    lines.push('', 'ตัวอย่างที่แก้:');
    r.changes.slice(0, 20).forEach(function(x) {
      lines.push('- ' + x.from + ' → ' + x.to);
    });
  }

  centralNotify_(lines.join('\n'));
  return r;
}

/* =========================================================
 * V11.4.9: Chapter title layout (KEEP_EXISTING default)
 * parse เลขบท/ชื่อบทจากข้อความในหน่วยความจำ ไม่พึ่งพาว่า paragraph ต้องแยกบรรทัดหรือไม่
 * ไม่ insert/merge paragraph เมื่อ LAYOUT_MODE = KEEP_EXISTING (ค่าเริ่มต้น)
 * ========================================================= */
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

  const rawNumber = thaiDigitsToArabic_(m[1]).replace(/\.{2,}/g, '-');
  const firstNumMatch = rawNumber.match(/^[0-9]+/);

  return {
    chapterNumber: firstNumMatch ? Number(firstNumMatch[0]) : null,
    chapterNumberText: rawNumber,
    inlineTitle: String(m[2] || '').trim()
  };
}

/**
 * หาเลขบท + ชื่อบท จากอาร์เรย์ข้อความ paragraph (ในหน่วยความจำล้วนๆ) รองรับทั้ง
 * "บทที่ N ชื่อบท" (บรรทัดเดียว) และ "บทที่ N" + "ชื่อบท" (แยกบรรทัด) ไม่แก้ไข/ไม่ insert paragraph
 */
function parseChapterTitleFromLinesPure_(paragraphTexts, headingIndex, windowSize) {
  headingIndex = Math.max(0, Number(headingIndex || 0));
  windowSize = Math.max(1, Number(windowSize || 6));

  const headingText = String((paragraphTexts && paragraphTexts[headingIndex]) || '');
  const headingInfo = parseChapterHeadingLinePure_(headingText);
  if (!headingInfo) return { found: false, chapterNumber: null, chapterText: '', title: '', layout: null };

  const chapterText = ('บทที่ ' + headingInfo.chapterNumberText).trim();

  if (headingInfo.inlineTitle) {
    return {
      found: true,
      chapterNumber: headingInfo.chapterNumber,
      chapterText: chapterText,
      title: headingInfo.inlineTitle,
      layout: 'SAME_LINE',
      headingParagraphIndex: headingIndex,
      titleParagraphIndex: headingIndex
    };
  }

  const limit = Math.min(paragraphTexts.length, headingIndex + 1 + windowSize);
  for (let i = headingIndex + 1; i < limit; i++) {
    const t = cleanText_(paragraphTexts[i]);
    if (!t || t === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(t)) continue;
    // เจอหัวบทถัดไปก่อนเจอชื่อบท แปลว่าบทนี้ไม่มีชื่อบท (ไม่ใช่ error)
    if (isChapterLineText_(normalizeChapterLine_(t))) break;

    return {
      found: true,
      chapterNumber: headingInfo.chapterNumber,
      chapterText: chapterText,
      title: t,
      layout: 'NEXT_LINE',
      headingParagraphIndex: headingIndex,
      titleParagraphIndex: i
    };
  }

  return {
    found: true,
    chapterNumber: headingInfo.chapterNumber,
    chapterText: chapterText,
    title: '',
    layout: 'SAME_LINE',
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
 * ตัดสินใจ layout ของหัวบทตาม STANDALONE_CHAPTER_TITLE_CONFIG_.LAYOUT_MODE
 * KEEP_EXISTING (ค่าเริ่มต้น): ไม่แก้โครงสร้าง paragraph เลย ไม่ว่าจะอยู่บรรทัดเดียวหรือแยกบรรทัด
 * splitChapterTitleToNextLine_()/mergeChapterTitleBackInActiveTab_() ยังอยู่ครบเพื่อ compatibility
 * (เมนู/โค้ดอื่นเรียกตรงได้) และถูกเรียกผ่านฟังก์ชันนี้เฉพาะโหมด SPLIT_NEXT_LINE/KEEP_SAME_LINE เท่านั้น
 */
function resolveChapterTitleLayoutReport_() {
  const mode = (STANDALONE_CHAPTER_TITLE_CONFIG_ && STANDALONE_CHAPTER_TITLE_CONFIG_.LAYOUT_MODE) || 'KEEP_EXISTING';

  const report = {
    mode: mode,
    detectedLayout: null,
    paragraphInserted: 0,
    paragraphUpdated: 0,
    layoutSkipped: 0
  };

  const info = getChapterTitleInfoFromActiveBody_();
  if (!info || !info.found) {
    report.layoutSkipped = 1;
    return report;
  }

  report.detectedLayout = info.layout;

  if (mode === 'SPLIT_NEXT_LINE') {
    if (info.layout === 'SAME_LINE' && info.title) {
      const splitResult = splitChapterTitleToNextLine_();
      if (splitResult && splitResult.changed) {
        report.paragraphInserted = 1;
      } else {
        report.layoutSkipped = 1;
      }
    } else {
      report.layoutSkipped = 1;
    }
  } else if (mode === 'KEEP_SAME_LINE') {
    if (info.layout === 'NEXT_LINE' && info.titleParagraphIndex !== -1) {
      const mergeResult = mergeChapterTitleBackInActiveTab_();
      if (mergeResult && mergeResult.changed) {
        report.paragraphUpdated = 1;
      } else {
        report.layoutSkipped = 1;
      }
    } else {
      report.layoutSkipped = 1;
    }
  } else {
    // KEEP_EXISTING: คงโครงสร้างเดิมเสมอ ไม่ insert/merge paragraph
    report.layoutSkipped = 1;
  }

  return report;
}

/* =========================================================
 * V11.4.9: ลบต้นฉบับภาษาอังกฤษที่ติดมาก่อนหัวบทแปลภาษาไทย
 * ต้องรันก่อน removeLatinBasedSpecialCharacters()/highlightForeignCharacters()/titleConvertAndReport_()
 * ไม่เช่นนั้นหัว "Chapter N" ของต้นฉบับอาจถูกนับเป็นเลขบทจริง หรือถูกแปลงเป็น "บทที่ N" ปลอมๆ
 * ========================================================= */

/** "Chapter 365" / "Chapter 365: Title" / "Ch. 365" / "Ch 365" / "Episode 365" / "EP 365" / "EP.365" */
function parseEnglishChapterHeading_(text) {
  const s = String(text || '').replace(INVIS_RE_, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const m = s.match(/^(Chapter|Episode|Ch\.?|EP\.?)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:[:\-–—]\s*(.*))?$/i);
  if (!m) return null;

  return { label: m[1], number: m[2], rest: String(m[3] || '').trim(), text: s };
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

/** สัดส่วนตัวอักษรไทยเทียบตัวอักษรทั้งหมด (ทุกภาษา) ในข้อความ */
function calculateThaiRatio_(text) {
  const s = String(text || '');
  const letters = s.match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  const thai = s.match(/[฀-๿]/g) || [];
  return thai.length / letters.length;
}

/**
 * ตรวจต้นฉบับอังกฤษที่ติดมาก่อนหัวบทแปลไทย จากอาร์เรย์ข้อความ paragraph ล้วนๆ
 * เงื่อนไขความมั่นใจสูง (HIGH) ต้องผ่านครบ:
 * 1) ย่อหน้าแรกที่มีความหมายของแท็บ ต้องเป็นหัวบทอังกฤษ (parseEnglishChapterHeading_)
 * 2) หลังจากนั้นต้องเจอหัวบทไทยก่อนจบช่วงสแกน (findThaiTranslatedChapterHeading_)
 * 3) จำนวนย่อหน้าเนื้อหาอังกฤษระหว่างหัวอังกฤษ-หัวไทย >= MIN_ENGLISH_PARAGRAPHS
 * 4) สัดส่วนตัวอักษรละตินของย่อหน้าช่วงนั้น >= MIN_LATIN_RATIO
 * 5) หลังหัวบทไทยมีย่อหน้าเนื้อหาไทยจริง (calculateThaiRatio_ > 0) >= MIN_THAI_PARAGRAPHS_AFTER_HEADING
 * ไม่บังคับว่าเลข Chapter อังกฤษต้องตรงกับเลขบทไทย
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
    if (calculateThaiRatio_(tm) > 0) thaiAfterCount++;
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

/** ลบ paragraph ตั้งแต่หัวบทอังกฤษถึง paragraph ก่อนหน้าหัวบทไทย (ความมั่นใจสูงเท่านั้น) - ลบจากล่างขึ้นบน */
function removeEnglishSourceBlock_(body, blockInfo) {
  const paras = body.getParagraphs();
  const fromIdx = blockInfo.startIndex;
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
  if (blockInfo.confidence !== 'HIGH' && cfg.REPORT_UNCERTAIN_CASES === false) return emptyReport;

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
    const removedCount = removeEnglishSourceBlock_(body, blockInfo);
    report.removed = removedCount > 0 ? 1 : 0;
    report.removedParagraphs = removedCount;
  }

  return report;
}

/* =========================================================
 * V11.4.9: หมายเหตุ "ต้นฉบับไม่มีบทที่" (report-only)
 * Standalone ไม่มี Google Sheets จึงห้ามเพิ่มระบบคอลัมน์ L หรือ SpreadsheetApp ตรงนี้
 * ห้ามลบข้อความออกจาก Google Docs ในฟีเจอร์นี้ - บันทึกเป็นหมายเหตุใน report เท่านั้น
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
 * V11.4.9: ลบข้อความโปรโมต/ปิดท้ายที่ไม่ต้องการ + บังคับให้มี "จบตอน" ท้ายบท
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
 * จัดสไตล์ "จบตอน" ที่เพิ่มใหม่แบบเนื้อหาปกติของ Standalone (Sarabun/18/ดำ/ไม่หนา/ไม่ขีดเส้นใต้
 * indent/spacing แบบ formatParagraphIndent()/setParagraphSpacing() ปกติ) ห้ามใช้ setHeadingLineStyle_()
 */
function applyBodyStyleToEndMarkerParagraph_(p) {
  if (!p) return;
  try {
    const t = p.editAsText();
    t.setFontFamily('Sarabun');
    t.setFontSize(18);
    t.setForegroundColor('#000000');
    t.setBold(false);
    t.setUnderline(false);
  } catch (e) {}
  try {
    p.setIndentFirstLine(36);
    p.setIndentStart(0);
    p.setSpacingBefore(0);
    p.setSpacingAfter(10);
  } catch (e2) {}
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
    const newPara = body.appendParagraph(String(cfg.END_MARKER_TEXT || 'จบตอน'));
    applyBodyStyleToEndMarkerParagraph_(newPara);
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

/** 🧹 เมนู: ล้างข้อความท้ายบท/เติมจบตอน (เฉพาะแท็บปัจจุบัน) */
function cleanupEndingPromoAndEnsureEndMarkerWithAlert() {
  const r = cleanupEndingPromoAndEnsureEndMarker_();

  const lines = [
    '📄 แท็บ: ' + getCurrentTabTitle_(),
    '🧹 ลบข้อความโปรโมตท้ายบท: ' + r.removedPromoLines + ' บรรทัด',
    '✅ เติม "จบตอน": ' + (r.insertedEndMarker ? 'เพิ่มแล้ว' : (r.hadEndMarker ? 'มีอยู่แล้ว' : 'ไม่ได้เพิ่ม (ปิดใช้งานอยู่)')),
    '🗑️ ลบ "จบตอน" ซ้ำ: ' + r.dedupedEndMarker + ' บรรทัด'
  ];

  if (r.removedPromoExamples && r.removedPromoExamples.length) {
    lines.push('', 'ตัวอย่างที่ลบ:');
    r.removedPromoExamples.forEach(function(x) { lines.push('- ' + x); });
  }

  centralNotify_(lines.join('\n'));
  return r;
}

/** รวม source episode marker ของแท็บหนึ่งจากผล runAllChecks() พร้อมชื่อ/ลำดับแท็บ สำหรับ alert รวมทุกแท็บ */
function collectSourceEpisodeMarkersFromResult_(result, tabName, tabIndex) {
  const seq = result && result.chapterSequence ? result.chapterSequence : {};
  const markers = seq.sourceEpisodeMarkers || [];
  return markers.map(function(mk) {
    return {
      tab: tabName,
      tabIndex: tabIndex,
      paragraphIndex: mk.paragraphIndex,
      text: mk.text,
      sourceLabel: mk.sourceLabel,
      sourceEpisodeNumber: mk.sourceEpisodeNumber
    };
  });
}

/** ✅ รวมการตรวจทั้งหมด */
function runAllChecks() {
  // 1) บันทึกหมายเหตุ "ต้นฉบับไม่มีบทที่" ก่อนขั้นตอนอื่นใด (report-only ไม่แก้เอกสาร)
  const sourceNoChapterNote = detectSourceNoChapterNote_();

  // 2) ลบต้นฉบับภาษาอังกฤษก่อนบทแปล (เฉพาะความมั่นใจสูง) ก่อน removeLatinBasedSpecialCharacters()/
  //    highlightForeignCharacters()/titleConvertAndReport_()/checkChapterSequenceInBody_() ไม่เช่นนั้น
  //    หัว "Chapter N" ของต้นฉบับอาจถูกนับเป็นเลขบทจริง หรือถูกแปลงเป็น "บทที่ N" ปลอมๆ
  const englishSourceCleanup = detectAndRemoveEnglishSourceBeforeThaiChapter_();

  const rep = replaceEmDashWithEllipsis();
  const replacedEmDashCount = Number(rep?.emDashCount || 0), replacedWawCount = Number(rep?.wawCount || 0);
  const latinSpecialRemoved = removeLatinBasedSpecialCharacters();

  // highlightForeignCharacters() คงอยู่ตำแหน่งใกล้เดิม (หลัง Latin cleanup) แทนที่จะย้ายไปท้ายสุด
  // เพื่อให้ paragraph "พบคำต่างประเทศ" ที่อาจถูก insert ยังได้รับ formatParagraphIndent()/
  // setParagraphSpacing()/setFontToSarabun16() ตามปกติเหมือน V11.4.8 เดิม (ฟังก์ชันเหล่านั้นรันทีหลัง)
  // เงื่อนไขบังคับเดียวที่ต้องคง คือต้องมาหลัง englishSourceCleanup เท่านั้น ซึ่งข้อนี้เป็นไปตามนั้นแล้ว
  const nonThaiCount = highlightForeignCharacters();

  const titleReport = titleConvertAndReport_();
  const removedLeadingBracketTags = removeLeadingBracketTagsEverywhere_();
  const removedTitleParens = removeParenthesesInChapterTitle();
  const episodeTitlePrefixAndBracketFixed = removeEpisodeTitlePrefixAndBracketChapterNumber_();

  // V11.4.9: ไม่แยกชื่อบทขึ้นบรรทัดใหม่อัตโนมัติเมื่อ LAYOUT_MODE = KEEP_EXISTING (ค่าเริ่มต้น)
  // splitChapterTitleToNextLine_()/mergeChapterTitleBackInActiveTab_() ยังอยู่ครบเพื่อ compatibility
  // และถูกเรียกผ่าน resolveChapterTitleLayoutReport_() เฉพาะโหมด SPLIT_NEXT_LINE/KEEP_SAME_LINE เท่านั้น
  const chapterTitleLayout = resolveChapterTitleLayoutReport_();
  const splitTitleLine = { changed: chapterTitleLayout.paragraphInserted > 0 ? 1 : 0, from: '', to: '' };

  const repeatedChapterPrefixRemoved = removeRepeatedChapterPrefixFromTitleLine_();
  const trailingChapterNumberRemoved = removeTrailingChapterMarkerFromTitleLine_();
  const duplicateChapterHeadingRemoved = removeDuplicateChapterHeadingLines_();
  const duplicateChapterTitleRemoved = removeDuplicateChapterTitleLines_();
  const duplicateBracketChapterRemoved = removeDuplicateBracketChapterLine_();
  const forcedChapterNumber = forceFirstChapterHeadingNumberInActiveTab_();
  const breakPairs = breakAdjacentQuoteAndBracketPairs();
  const bracketStatusSplit = splitBracketedStatusBlocks_();

  // ลบข้อความปิดท้าย/โปรโมตท้ายบท + บังคับให้มี "จบตอน" - รันหลัง cleanup เนื้อหาหลักทั้งหมดแล้ว
  // แต่ก่อน formatParagraphIndent()/setParagraphSpacing()/setFontToSarabun16() เพื่อให้ "จบตอน"
  // ที่เพิ่งเพิ่มได้รับ body formatting ตามปกติเหมือนย่อหน้าอื่นด้วย (ซ้ำกับที่ apply เองในฟังก์ชันนั้นแล้ว)
  const endingCleanup = cleanupEndingPromoAndEnsureEndMarker_();

  const paragraphCount = formatParagraphIndent();
  const spacingCount = setParagraphSpacing(10);
  const blankRemoved = removeAllBlankLines();
  setFontToSarabun16();
  const removedCount = removeEnglishInParentheses(false);
  removeThaiNoteParentheses();
  if (nonThaiCount === 0) underlineFirstLine();

  const chapterSequence = checkChapterSequenceInBody_();

  return {
    replacedEmDashCount,
    replacedWawCount,
    latinSpecialRemoved,
    nonThaiCount,
    paragraphCount,
    spacingCount,
    blankRemoved,
    removedCount,
    breakPairs,
    titleReport,
    removedLeadingBracketTags,
    bracketStatusSplit,
    removedTitleParens,
    episodeTitlePrefixAndBracketFixed,
    splitTitleLine,
    repeatedChapterPrefixRemoved,
    trailingChapterNumberRemoved,
    duplicateChapterHeadingRemoved,
    duplicateBracketChapterRemoved,
    duplicateChapterTitleRemoved,
    forcedChapterNumber,
    chapterSequence,
    sourceNoChapterNote,
    englishSourceCleanup,
    chapterTitleLayout,
    endingCleanup
  };
}

/** ✅ ตรวจทั้งหมดทุกแท็บ */
function runAllChecksWithAlert() {
  const result = runAllChecksAllTabs();
  const epTabs = result.titleEpisodeTabs || [], chTabs = result.titleChapterTabs || [];
  const changedWords = (result.titleEpisodeCount || 0) + (result.titleChapterCount || 0);
  const lines = [
    `🧾 ตรวจแล้ว: ${result.tabChecked}/${result.tabTotal} แท็บ`,
    `🔁 แทนที่ "—" เป็น "..." แล้ว ${result.replacedEmDashCount} ตำแหน่ง`,
    `🔁 แก้ "و" เป็น "ล" แล้ว ${result.replacedWawCount} ตำแหน่ง`,
    `🗑️ ลบอักษรละตินพิเศษแล้ว ${result.latinSpecialRemovedTotal} ตัว`,
    `🔍 พบตัวอักษรต่างประเทศรวม ${result.nonThaiCount} ตัว`,
    `↩️ แยกบรรทัดรวม ${result.breakPairsTotal} จุด`,
    `📑 จัดรูปแบบย่อหน้ารวม ${result.paragraphCount} ย่อหน้า`,
    `📏 เว้นระยะห่างรวม ${result.spacingCount} ย่อหน้า`,
    `🧹 ลบบรรทัดว่างรวม ${result.blankRemoved} บรรทัด`,
    `🗑️ ลบคำในวงเล็บรวม ${result.removedCount} ตำแหน่ง`,
    `🏷️ ลบวงเล็บท้ายชื่อตอนรวม ${result.removedTitleParensTotal} จุด`,
    `🧹 ลบหัวบทซ้ำหน้าชื่อบทรวม ${result.repeatedChapterPrefixRemovedTotal || 0} จุด`,
    `🧹 ลบเลขบท/ชื่อบทซ้ำท้ายชื่อบทรวม ${result.trailingChapterNumberRemovedTotal || 0} จุด`,
    `🔢 เขียนเลขบทใหม่ตามแท็บรวม ${result.forcedChapterNumberChangedTotal || 0} จุด${result.forcedChapterStartNumber ? ` (เริ่มที่บท ${result.forcedChapterStartNumber})` : ""}`,
    `🧹 ลบบรรทัดหัวบทซ้ำรวม ${result.duplicateChapterHeadingRemovedTotal || 0} บรรทัด`,
    `🧹 ลบชื่อบทซ้ำรวม ${result.duplicateChapterTitleRemovedTotal || 0} บรรทัด`,
    "",
    result.foreignTabNames && result.foreignTabNames.length > 0
      ? `📌 แท็บที่พบตัวอักษรต่างประเทศ:\n- ${result.foreignTabNames.join("\n- ")}`
      : "💯 ไม่พบตัวอักษรต่างประเทศในทุกแท็บ",
    "",
    `🪄 เปลี่ยนเป็นบทที่ ${changedWords} คำ`
  ];

  if (changedWords) {
    if (epTabs.length) lines.push(`- ตอนที่→บทที่: ${epTabs.length} แท็บ\n  • ${epTabs.join("\n  • ")}`);
    if (chTabs.length) lines.push(`- Chapter→บทที่: ${chTabs.length} แท็บ\n  • ${chTabs.join("\n  • ")}`);
  }

  lines.push("", `🧾 ลบ [เลขบท] / [โบนัส] รวม ${result.removedLeadingBracketTagsTotal || 0} จุด`);
  lines.push("");
  buildChapterSequenceAlertLines_(result).forEach(function(line) { lines.push(line); });

  lines.push("", `🏷️ คงรูปแบบชื่อบทเดิม ${Number(result.chapterTitleLayoutSkippedTotal || 0)} แท็บ`);

  const englishRemovedTabs = Number(result.englishSourceRemovedTotal || 0);
  if (englishRemovedTabs > 0) {
    lines.push(
      "",
      `🧹 ลบต้นฉบับภาษาอังกฤษก่อนบทแปล ${englishRemovedTabs} แท็บ`,
      `รวม ${Number(result.englishSourceRemovedParagraphsTotal || 0)} ย่อหน้า`
    );
  }

  const englishUncertainTabs = result.englishSourceUncertainTabs || [];
  if (englishUncertainTabs.length) {
    lines.push("", "⚠️ อาจพบต้นฉบับภาษาอังกฤษ แต่ยังไม่ลบ:");
    englishUncertainTabs.forEach(function(item) {
      lines.push("- แท็บ " + (item.tabIndex || item.tab || "-"));
    });
  }

  const sourceNoChapterTabs = result.sourceNoChapterTabs || [];
  if (sourceNoChapterTabs.length) {
    lines.push("", "📝 ต้นฉบับไม่มีบทที่:");
    sourceNoChapterTabs.forEach(function(item) {
      lines.push("- แท็บ " + (item.tabIndex || item.tab || "-"));
    });
  }

  const sourceEpisodeMarkers = result.sourceEpisodeMarkers || [];
  if (sourceEpisodeMarkers.length) {
    lines.push("", `📚 พบต้นฉบับหลายตอนรวมอยู่ในแท็บเดียว ${sourceEpisodeMarkers.length} จุด`);
    sourceEpisodeMarkers.slice(0, 20).forEach(function(marker) {
      lines.push(
        "",
        "แท็บ " + (marker.tabIndex || marker.tab || "-"),
        "พบหัวตอนต้นฉบับ: " + marker.sourceLabel + " " + marker.sourceEpisodeNumber,
        "Paragraph " + marker.paragraphIndex,
        String(marker.text || "")
      );
    });
    if (sourceEpisodeMarkers.length > 20) {
      lines.push("", `…และอีก ${sourceEpisodeMarkers.length - 20} จุด`);
    }
  }

  lines.push(
    "",
    `🧹 ลบข้อความโปรโมตท้ายบท ${Number(result.endingPromoRemovedTotal || 0)} บรรทัด`,
    `✅ เติม "จบตอน" ${Number(result.endingMarkerInsertedTotal || 0)} แท็บ`,
    `🗑️ ลบ "จบตอน" ซ้ำ ${Number(result.endingMarkerDedupedTotal || 0)} บรรทัด`
  );

  lines.push("", "🎉 ดำเนินการเรียบร้อยแล้ว!");
  centralNotify_(lines.join("\n"));
  return result;
}

/** 📝 ขีดเส้นใต้ + ตัวหนา บรรทัดแรก */
function underlineFirstLine() {
  const paras = getActiveBody_().getParagraphs(), p = paras[0];
  if (!p) return false;
  const t = p.editAsText();
  t.setUnderline(true); t.setBold(true);
  return true;
}

/** 🗑️ ลบคำอังกฤษในวงเล็บ */
function removeEnglishInParentheses(showAlert = true) {
  const body = getActiveBody_();
  let count = 0;
  const searchPattern = "\\([A-Za-z !+\\-+\\.\\/\\:\\'\\_?–,]+\\)";
  let foundElement = body.findText(searchPattern), ranges = [];

  while (foundElement) {
    ranges.push(foundElement);
    foundElement = body.findText(searchPattern, foundElement);
  }

  for (let i = ranges.length - 1; i >= 0; i--) {
    const element = ranges[i].getElement().asText();
    const start = ranges[i].getStartOffset(), end = ranges[i].getEndOffsetInclusive();
    const matchedText = element.getText().substring(start, end + 1);
    const content = matchedText.substring(1, matchedText.length - 1).trim();
    const hasDigit = /\d/.test(content), isUpper = content === content.toUpperCase();
    if (!hasDigit && content.length > 3 && !isUpper) { element.deleteText(start, end); count++; }
  }

  if (showAlert) centralNotify_(`❌ ลบคำในวงเล็บแล้ว ${count} ตำแหน่ง`);
  return count;
}

/** ✅ ลบวงเล็บในชื่อตอน แต่ยกเว้น (ตอนที่...), (จบ), (ตอนที่...จบ) */
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
      matches.forEach(m => {
        const isException = /\((จบ|ตอนที่\s*[0-9๐-๙]+(\s*จบ)?)\)/.test(m.trim());
        if (!isException) {
          p.replaceText(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "");
          count++;
        }
      });
      const cleanText = p.getText().trim();
      if (cleanText !== p.getText()) p.setText(cleanText);
    }
    break;
  }
  return count;
}

function stripLeadingBracketTags_(text) {
  let s = String(text || '')
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ลบ:
  // [47] :
  // [๔๗] :
  // [โบนัส]
  // [โบนัส] -
  // [47] : [โบนัส] - ...
  const prefixRe = /^\s*(?:(?:\[\s*[0-9๐-๙]+\s*\]|\[\s*โบนัส\s*\]|\[\s*bonus\s*\])\s*(?:[:：\-–—]\s*)?)+/iu;

  let prev = '';
  while (s && s !== prev) {
    prev = s;
    s = s.replace(prefixRe, '')
         .replace(/^\s*[:：\-–—]+\s*/u, '')
         .trim();
  }

  return s;
}



function getFirstTextAttributesSafe_(p) {
  try {
    const t = p.editAsText();
    const s = t.getText();
    if (!s) return null;
    return t.getAttributes(0);
  } catch (e) {
    return null;
  }
}

function applyTextAttributesToWholeParagraphSafe_(p, attrs) {
  if (!p || !attrs) return false;
  try {
    const t = p.editAsText();
    const s = t.getText();
    if (!s) return false;
    t.setAttributes(0, s.length - 1, attrs);
    return true;
  } catch (e) {
    return false;
  }
}

function restoreHeadingStyleIfNeeded_(p, wasBoldUnderline, textAttrs) {
  applyTextAttributesToWholeParagraphSafe_(p, textAttrs);

  if (wasBoldUnderline) {
    try {
      const t = p.editAsText();
      const s = t.getText();
      if (!s) return;
      t.setBold(0, s.length - 1, true);
      t.setUnderline(0, s.length - 1, true);
      t.setFontFamily(0, s.length - 1, "Sarabun");
      t.setFontSize(0, s.length - 1, 18);
      t.setForegroundColor(0, s.length - 1, "#000000");
    } catch (e) {}
  }
}

function removeLeadingBracketTagsEverywhere_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const changes = [];

  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const raw = cleanText_(p.getText());

    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;

    const cleaned = stripLeadingBracketTags_(raw);
    if (!cleaned || cleaned === raw) continue;

    // V11.1: p.setText() จะล้าง style ระดับตัวอักษร เช่น ตัวหนา/ขีดเส้นใต้
    // จึงต้องจำ text attributes ก่อนลบ [เลขบท] แล้วใส่กลับให้ข้อความที่เหลือ
    const attrs = p.getAttributes ? p.getAttributes() : {};
    const textAttrs = getFirstTextAttributesSafe_(p);
    const wasBoldUnderline = isBoldUnderlineParagraph_(p);

    p.setText(cleaned);
    try { p.setAttributes(attrs); } catch (e) {}
    restoreHeadingStyleIfNeeded_(p, wasBoldUnderline, textAttrs);

    changes.push({
      paragraphIndex: i + 1,
      from: raw,
      to: cleaned
    });
  }

  return {
    changed: changes.length ? 1 : 0,
    changedCount: changes.length,
    from: changes.length ? changes[0].from : '',
    to: changes.length ? changes[0].to : '',
    paragraphIndex: changes.length ? changes[0].paragraphIndex : -1,
    changes: changes
  };
}

function removeLeadingBracketTagsNearChapter_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let headingIdx = -1;

  // หา "บทที่ xx" / "ตอนที่ xx" / "chapter xx"
  for (let i = 0; i < Math.min(paras.length, 50); i++) {
    const t = cleanText_(paras[i].getText());
    if (!t || t === NOTE_TEXT_) continue;

    if (isChapterLineText_(normalizeChapterLine_(t))) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) {
    return { changed: 0, from: '', to: '', paragraphIndex: -1 };
  }

  // เช็กตั้งแต่หัวบทไปอีกไม่เกิน 6 บรรทัด
  for (let j = headingIdx; j < Math.min(paras.length, headingIdx + 6); j++) {
    const p = paras[j];
    const raw = cleanText_(p.getText());

    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;

    const cleaned = stripLeadingBracketTags_(raw);
    if (!cleaned || cleaned === raw) continue;

    const attrs = p.getAttributes ? p.getAttributes() : {};
    const textAttrs = getFirstTextAttributesSafe_(p);
    const wasBoldUnderline = isBoldUnderlineParagraph_(p);

    p.setText(cleaned);
    try { p.setAttributes(attrs); } catch (e) {}
    restoreHeadingStyleIfNeeded_(p, wasBoldUnderline, textAttrs);

    return {
      changed: 1,
      from: raw,
      to: cleaned,
      paragraphIndex: j + 1
    };
  }

  return { changed: 0, from: '', to: '', paragraphIndex: -1 };
}

function removeLeadingBracketTagsAllTabs_() {
  const doc = getTargetDocument_();
  const currentTab = getProcessingTab_();
  const currentTabId = currentTab && currentTab.getId ? currentTab.getId() : null;

  if (!doc.getTabs) {
    const r = removeLeadingBracketTagsEverywhere_();
    return {
      tabChecked: 1,
      tabTotal: 1,
      changedCount: r.changedCount || 0,
      changedTabs: r.changed ? ['เอกสารหลัก'] : [],
      changes: r.changed ? [{
        tab: 'เอกสารหลัก',
        from: r.from,
        to: r.to,
        paragraphIndex: r.paragraphIndex
      }] : []
    };
  }

  const tabs = getAllTabsFlat_(doc);
  const result = {
    tabChecked: 0,
    tabTotal: tabs.length,
    changedCount: 0,
    changedTabs: [],
    changes: []
  };

  tabs.forEach(function(tab, idx) {
    selectProcessingTab_(doc, tab.getId());
    const r = removeLeadingBracketTagsEverywhere_();

    result.tabChecked++;

    if (r && r.changed) {
      const name = getTabNameSafe_(tab, idx);
      result.changedCount += r.changedCount || 0;
      result.changedTabs.push(name);
      (r.changes || []).forEach(function(change) {
        result.changes.push({
          tab: name,
          from: change.from,
          to: change.to,
          paragraphIndex: change.paragraphIndex
        });
      });
    }
  });

  if (currentTabId) {
    try { selectProcessingTab_(doc, currentTabId); } catch (e) {}
  }

  return result;
}

function removeLeadingBracketTagsAllTabsWithAlert() {
  const r = removeLeadingBracketTagsAllTabs_();
  const lines = [
    '🧾 ตรวจแล้ว ' + r.tabChecked + '/' + r.tabTotal + ' แท็บ',
    '🗑️ ลบ [เลขบท] / [โบนัส] แล้ว ' + r.changedCount + ' จุด'
  ];

  if (r.changedTabs.length) {
    lines.push('', '📄 แท็บที่แก้ไข:');
    r.changedTabs.forEach(function(name) {
      lines.push('- ' + name);
    });
  } else {
    lines.push('', 'ℹ️ ไม่พบบรรทัดที่ต้องลบ');
  }

  centralNotify_(lines.join('\n'));
  return r;
}

/** 🪄 ตอนที่ -> บทที่ */
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

/** 🪄 จัดรูปแบบหัวบทบรรทัดแรก */
function escapeRegExp_(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripDuplicateChapterMarkerAfterNumber_(rest, chapterNumber) {
  let out = String(rest || '')
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!out) return '';

  const n = escapeRegExp_(String(chapterNumber || '').trim());
  const sep = COLON_CLASS_ + '|[-–—]';

  // ลบส่วนซ้ำหลังเลขบท เช่น
  // : Chapter 401 : ชื่อบท
  // Chapter 401 : ชื่อบท
  // : บทที่ 401 : ชื่อบท
  const patterns = [
    new RegExp('^\\s*(?:' + sep + ')?\\s*chapter\\s*' + n + '\\s*(?:(?:' + sep + ')\\s*)?', 'i'),
    new RegExp('^\\s*(?:' + sep + ')?\\s*(?:บท(?:ที่)?|ตอนที่)\\s*' + n + '\\s*(?:(?:' + sep + ')\\s*)?', 'i')
  ];

  let prev = '';
  while (out && out !== prev) {
    prev = out;
    patterns.forEach(function(re) {
      out = out.replace(re, '');
    });
    out = out
      .replace(new RegExp('^\\s*(?:' + sep + ')\\s*'), '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return out;
}

/** 🪄 จัดรูปแบบหัวบทบรรทัดแรก
 * รองรับ:
 * - บท 401: Chapter 401 : ชื่อบท
 * - บทที่ 401: Chapter 401 : ชื่อบท
 * - ตอนที่ 401: Chapter 401 : ชื่อบท
 * - Chapter 401 : ชื่อบท
 * ผลลัพธ์ก่อนจัดฟอร์แมต: บทที่ 401 ชื่อบท
 */
function normalizeChapterTitleFirstLine() {
  const body = getActiveBody_(), target = findFirstNonNoteParagraph_(body);
  if (!target) return false;

  const oldRaw = target.getText();
  const line = normalizeChapterLine_(oldRaw);
  // รองรับ: บท 255: ชื่อบท, บทที่ 255: ชื่อบท, บท 245-246: ชื่อบท (เลขช่วง)
  let m = line.match(/^(บท(?:ที่)?|ตอนที่)\s*([0-9๐-๙]+(?:[-–—][0-9๐-๙]+)?)\s*(.*)$/i);

  let num = '';
  let rest = '';

  if (m) {
    num = thaiDigitsToArabic_(m[2]);
    rest = m[3] || '';
  } else {
    m = line.match(/^chapter\s*([0-9๐-๙]+)\s*(.*)$/i);
    if (!m) return false;
    num = thaiDigitsToArabic_(m[1]);
    rest = m[2] || '';
  }

  rest = String(rest || '')
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .replace(new RegExp('^\\s*' + COLON_CLASS_ + '\\s*'), '')
    .replace(/^\s*[\u2013\u2014\-–—]+\s*/, '')
    .trim();

  rest = stripDuplicateChapterMarkerAfterNumber_(rest, num);

  const newText = stripColonAfterChapterNumber_(`บทที่ ${num}${rest ? ' ' + rest : ''}`);
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

/** 🔢 แปลงเลขไทย -> อารบิก */
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

/** ✅ ลบเกริ่น/เครดิต + จัดหัวบท */
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

    let num = "", rest = "", m = line.match(/^(บท(?:ที่)?|ตอนที่)\s*([0-9๐-๙]+)\s*(.*)$/);
    if (m) { num = m[2]; rest = m[3] || ""; }
    else {
      m = line.match(/^chapter\s*([0-9]+)\s*(.*)$/i);
      if (!m) return true;
      num = m[1]; rest = m[2] || "";
    }

    rest = rest.replace(/^\s*[:：]\s*/, "").replace(/^\s*[\u2013\u2014\-–—]+\s*/, "").trim();
    const te = paras[i].editAsText(), len = te.getText().length;
    if (len > 0) te.deleteText(0, len - 1);
    te.insertText(0, stripColonAfterChapterNumber_(`บทที่ ${num}${rest ? " " + rest : ""}`));
    te.setBold(true); te.setUnderline(true);
    return true;
  }
  return true;
}

/** ✅ แยกแผงสถานะ */
function isStatusPanelLine_(text) {
  const s = String(text || "").replace(INVIS_RE_, " ").replace(/\s+/g, " ").trim();
  return !!s && s.length <= 400 && /^【[^】]{1,380}】$/.test(s);
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
  centralNotify_("✅ ใส่ลายน้ำ (หัว+ท้าย) เรียบร้อยแล้ว");
}

function removeWatermarkHeaderFooter() {
  applyWatermarkToAllTabs_(false);
  centralNotify_("🧼 ลบลายน้ำ (หัว+ท้าย) เรียบร้อยแล้ว");
}

function applyWatermarkToAllTabs_(add) {
  const doc = getTargetDocument_();
  if (doc.getTabs) getAllTabsFlat_(doc).forEach(t => { selectProcessingTab_(doc, t.getId()); applyWatermarkToDoc_(doc, add); });
  else applyWatermarkToDoc_(doc, add);
}

function applyWatermarkToDoc_(doc, add) {
  centralAssertWriting_();
  if (doc.getId() !== getTargetDocument_().getId()) throw new Error('Docs ID ไม่ตรงกัน');
  const documentTab = getProcessingTab_().asDocumentTab();
  let header = documentTab.getHeader(), footer = documentTab.getFooter();
  // ลบลายน้ำไม่ควรสร้าง header/footer ใหม่ในแท็บที่ไม่มีอยู่เดิม
  if (add && !header) header = documentTab.addHeader();
  if (add && !footer) footer = documentTab.addFooter();

  if (header) add
    ? upsertWatermarkInSection_(header, WM_TEXT, { align: WM_HEADER_ALIGN, insert: WM_HEADER_INSERT, spacingBefore: WM_SPACING_BEFORE, spacingAfter: WM_SPACING_AFTER })
    : removeWatermarkInSection_(header, WM_TEXT);

  if (footer) add
    ? upsertWatermarkInSection_(footer, WM_TEXT, { align: WM_FOOTER_ALIGN, insert: WM_FOOTER_INSERT, spacingBefore: WM_SPACING_BEFORE, spacingAfter: WM_SPACING_AFTER })
    : removeWatermarkInSection_(footer, WM_TEXT);
}

function upsertWatermarkInSection_(section, text, opts = {}) {
  const align = opts.align || DocumentApp.HorizontalAlignment.CENTER;
  const insert = (opts.insert || "BOTTOM").toUpperCase();
  const spacingBefore = Number(opts.spacingBefore || 0), spacingAfter = Number(opts.spacingAfter || 0);
  const paras = section.getParagraphs();
  if (paras.some(p => (p.getText() || "").trim() === text)) return;

  const p = insert === "TOP" ? section.insertParagraph(0, text) : section.appendParagraph(text);
  p.setAlignment(align); p.setSpacingBefore(spacingBefore); p.setSpacingAfter(spacingAfter);
  const t = p.editAsText();
  t.setForegroundColor(WM_COLOR); t.setFontSize(WM_FONT_SIZE); t.setBold(false); t.setUnderline(false);
}

function removeWatermarkInSection_(section, text) {
  const paras = section.getParagraphs();
  for (let i = paras.length - 1; i >= 0; i--) {
    if ((paras[i].getText() || "").trim() !== text) continue;
    try { section.removeChild(paras[i]); }
    catch (e) {
      try {
        const te = paras[i].editAsText(), len = te.getText().length;
        if (len > 0) te.deleteText(0, len - 1);
        te.setForegroundColor(null); te.setBold(false); te.setUnderline(false);
      } catch (_) {}
    }
  }
}

function getAllTabsFlat_(doc) {
  const out = [];
  const walk = arr => arr.forEach(t => {
    out.push(t);
    const kids = t.getChildTabs ? t.getChildTabs() : [];
    if (kids && kids.length) walk(kids);
  });
  walk(doc.getTabs());
  return out;
}

/** ✅ รวมแท็บทั้งหมด + นับจำนวนแท็บที่ตรวจจริง */
/**
 * V11.4.9: รวมผลลัพธ์เฉพาะฟีเจอร์ใหม่ (chapter title layout / english source cleanup /
 * source no-chapter note / ending cleanup / source episode marker) จาก runAllChecks()
 * ของแท็บหนึ่งเข้า totals ใช้ร่วมกันทั้งสาขาเอกสารไม่มีแท็บและสาขาหลายแท็บ กันโค้ดสะสมผลซ้ำ
 */
function accumulateStandaloneExtrasIntoTotals_(total, r, tabName, tabIndex) {
  r = r || {};

  const layout = r.chapterTitleLayout || {};
  total.chapterTitleLayoutSkippedTotal = Number(total.chapterTitleLayoutSkippedTotal || 0) + Number(layout.layoutSkipped || 0);

  const eng = r.englishSourceCleanup || {};
  if (Number(eng.detected || 0) > 0) {
    total.englishSourceDetectedTotal = Number(total.englishSourceDetectedTotal || 0) + 1;
    if (Number(eng.removed || 0) > 0) {
      total.englishSourceRemovedTotal = Number(total.englishSourceRemovedTotal || 0) + 1;
      total.englishSourceRemovedParagraphsTotal = Number(total.englishSourceRemovedParagraphsTotal || 0) + Number(eng.removedParagraphs || 0);
    } else {
      total.englishSourceUncertainTabs = total.englishSourceUncertainTabs || [];
      total.englishSourceUncertainTabs.push({ tab: tabName, tabIndex: tabIndex });
    }
  }

  const srcNote = r.sourceNoChapterNote || {};
  if (Number(srcNote.found || 0) > 0) {
    total.sourceNoChapterTabs = total.sourceNoChapterTabs || [];
    total.sourceNoChapterTabs.push({ tab: tabName, tabIndex: tabIndex });
  }

  const ending = r.endingCleanup || {};
  if (ending.changed) {
    total.endingCleanupChangedTotal = Number(total.endingCleanupChangedTotal || 0) + 1;
  }
  total.endingPromoRemovedTotal = Number(total.endingPromoRemovedTotal || 0) + Number(ending.removedPromoLines || 0);
  if (ending.insertedEndMarker) {
    total.endingMarkerInsertedTotal = Number(total.endingMarkerInsertedTotal || 0) + 1;
  }
  total.endingMarkerDedupedTotal = Number(total.endingMarkerDedupedTotal || 0) + Number(ending.dedupedEndMarker || 0);

  total.sourceEpisodeMarkers = (total.sourceEpisodeMarkers || []).concat(
    collectSourceEpisodeMarkersFromResult_(r, tabName, tabIndex)
  );

  return total;
}

function runAllChecksAllTabs() {
  const doc = getTargetDocument_();
  if (!doc.getTabs) {
    const r = runAllChecks(), singleName = "เอกสารหลัก";
    const epTabs = [], chTabs = [], changes = [];
    let epCount = 0, chCount = 0;

    if (r.titleReport?.changed) {
      if (r.titleReport.episodeChanged) {
        epCount = 1; epTabs.push(singleName);
        changes.push({ tab: singleName, type: "ตอนที่→บทที่", from: r.titleReport.from, to: r.titleReport.to });
      } else if (r.titleReport.chapterChanged) {
        chCount = 1; chTabs.push(singleName);
        changes.push({ tab: singleName, type: "Chapter→บทที่", from: r.titleReport.from, to: r.titleReport.to });
      }
    }

    const singleTotal = {
      replacedEmDashCount: r.replacedEmDashCount || 0,
      replacedWawCount: r.replacedWawCount || 0,
      latinSpecialRemovedTotal: r.latinSpecialRemoved?.total || 0,
      nonThaiCount: r.nonThaiCount || 0,
      paragraphCount: r.paragraphCount || 0,
      spacingCount: r.spacingCount || 0,
      blankRemoved: r.blankRemoved || 0,
      removedCount: r.removedCount || 0,
      breakPairsTotal: r.breakPairs?.total || 0,
      removedTitleParensTotal: r.removedTitleParens || 0,
      duplicateChapterHeadingRemovedTotal: r.duplicateChapterHeadingRemoved?.removed || 0,
      repeatedChapterPrefixRemovedTotal: r.repeatedChapterPrefixRemoved?.changed || 0,
      trailingChapterNumberRemovedTotal: r.trailingChapterNumberRemoved?.changed || 0,
      forcedChapterNumberChangedTotal: r.forcedChapterNumber?.changed || 0,
      forcedChapterStartNumber: r.forcedChapterNumber?.startNumber || null,
      duplicateChapterTitleRemovedTotal: r.duplicateChapterTitleRemoved?.removed || 0,
      removedLeadingBracketTagsTotal: r.removedLeadingBracketTags?.changedCount || 0,
      tabChecked: 1,
      tabTotal: 1,
      foreignTabNames: r.nonThaiCount > 0 ? [singleName] : [],
      foreignTabCounts: r.nonThaiCount > 0 ? [{ name: singleName, count: r.nonThaiCount }] : [],
      titleEpisodeTabs: epTabs,
      titleChapterTabs: chTabs,
      titleChanges: changes,
      titleEpisodeCount: epCount,
      titleChapterCount: chCount,
      chapterItems: collectChapterSequenceItemsFromResult_(r, singleName, 1),
      chapterTotalFound: (r.chapterSequence && r.chapterSequence.totalFound) || 0,
      chapterSequenceIssues: (r.chapterSequence && r.chapterSequence.issues || []).map(function(issue) {
        return {
          type: issue.type,
          expected: issue.expected,
          previous: issue.previous,
          current: issue.current,
          previousTab: singleName,
          tab: singleName,
          tabIndex: 1,
          paragraphIndex: issue.paragraphIndex,
          text: issue.text
        };
      }),
      hasDuplicateChapter: !!(r.chapterSequence && r.chapterSequence.issues || []).some(function(issue) { return issue.type === 'เลขซ้ำ'; })
    };

    accumulateStandaloneExtrasIntoTotals_(singleTotal, r, singleName, 1);
    return singleTotal;
  }

  const tabs = getAllTabsFlat_(doc);
  const total = {
    replacedEmDashCount: 0, replacedWawCount: 0, latinSpecialRemovedTotal: 0, nonThaiCount: 0,
    paragraphCount: 0, spacingCount: 0, blankRemoved: 0, removedCount: 0, breakPairsTotal: 0,
    removedTitleParensTotal: 0, duplicateChapterHeadingRemovedTotal: 0, repeatedChapterPrefixRemovedTotal: 0, trailingChapterNumberRemovedTotal: 0, forcedChapterNumberChangedTotal: 0, forcedChapterStartNumber: getForcedChapterStartNumber_(), duplicateChapterTitleRemovedTotal: 0, tabChecked: 0, tabTotal: tabs.length, foreignTabNames: [],
    foreignTabCounts: [], titleEpisodeTabs: [], titleChapterTabs: [], titleChanges: [],
    titleEpisodeCount: 0, titleChapterCount: 0,
    removedLeadingBracketTagsTotal: 0,
    chapterItems: [],
    chapterTotalFound: 0,
    chapterSequenceIssues: [],
    hasDuplicateChapter: false,
    chapterTitleLayoutSkippedTotal: 0,
    englishSourceDetectedTotal: 0,
    englishSourceRemovedTotal: 0,
    englishSourceRemovedParagraphsTotal: 0,
    englishSourceUncertainTabs: [],
    sourceNoChapterTabs: [],
    endingCleanupChangedTotal: 0,
    endingPromoRemovedTotal: 0,
    endingMarkerInsertedTotal: 0,
    endingMarkerDedupedTotal: 0,
    sourceEpisodeMarkers: []
  };

  const foreignSet = new Set(), epSet = new Set(), chSet = new Set();

  tabs.forEach((t, idx) => {
    selectProcessingTab_(doc, t.getId());
    const r = runAllChecks();
    total.tabChecked++;
    total.replacedEmDashCount += Number(r.replacedEmDashCount || 0);
    total.replacedWawCount += Number(r.replacedWawCount || 0);
    total.latinSpecialRemovedTotal += r.latinSpecialRemoved?.total || 0;
    total.nonThaiCount += r.nonThaiCount || 0;
    total.paragraphCount += r.paragraphCount || 0;
    total.spacingCount += r.spacingCount || 0;
    total.blankRemoved += r.blankRemoved || 0;
    total.removedCount += r.removedCount || 0;
    total.breakPairsTotal += r.breakPairs?.total || 0;
    total.removedTitleParensTotal += r.removedTitleParens || 0;
    total.duplicateChapterHeadingRemovedTotal += r.duplicateChapterHeadingRemoved?.removed || 0;
    total.repeatedChapterPrefixRemovedTotal += r.repeatedChapterPrefixRemoved?.changed || 0;
    total.trailingChapterNumberRemovedTotal += r.trailingChapterNumberRemoved?.changed || 0;
    total.forcedChapterNumberChangedTotal += r.forcedChapterNumber?.changed || 0;
    if (!total.forcedChapterStartNumber && r.forcedChapterNumber?.startNumber) total.forcedChapterStartNumber = r.forcedChapterNumber.startNumber;
    total.duplicateChapterTitleRemovedTotal += r.duplicateChapterTitleRemoved?.removed || 0;
    total.removedLeadingBracketTagsTotal += r.removedLeadingBracketTags?.changedCount || 0;

    const chapterTabNameForSeq = getTabNameSafe_(t, idx);
    total.chapterItems = total.chapterItems.concat(collectChapterSequenceItemsFromResult_(r, chapterTabNameForSeq, idx + 1));

    if ((r.nonThaiCount || 0) > 0) {
      const name = getTabNameSafe_(t, idx);
      if (!foreignSet.has(name)) { foreignSet.add(name); total.foreignTabNames.push(name); }
      total.foreignTabCounts.push({ name, count: r.nonThaiCount || 0 });
    }

    if (r.titleReport?.changed) {
      const name = getTabNameSafe_(t, idx);
      if (r.titleReport.episodeChanged) {
        total.titleEpisodeCount++;
        if (!epSet.has(name)) { epSet.add(name); total.titleEpisodeTabs.push(name); }
        total.titleChanges.push({ tab: name, type: "ตอนที่→บทที่", from: r.titleReport.from, to: r.titleReport.to });
      } else if (r.titleReport.chapterChanged) {
        total.titleChapterCount++;
        if (!chSet.has(name)) { chSet.add(name); total.titleChapterTabs.push(name); }
        total.titleChanges.push({ tab: name, type: "Chapter→บทที่", from: r.titleReport.from, to: r.titleReport.to });
      }
    }

    accumulateStandaloneExtrasIntoTotals_(total, r, getTabNameSafe_(t, idx), idx + 1);
  });

  const chapterAnalysis = analyzeChapterSequenceAcrossItems_(total.chapterItems);
  total.chapterTotalFound = chapterAnalysis.totalFound;
  total.chapterSequenceIssues = chapterAnalysis.issues;
  total.hasDuplicateChapter = chapterAnalysis.hasDuplicateChapter;

  return total;
}

function getTabNameSafe_(t, index) {
  try {
    if (t && typeof t.getTitle === "function") return t.getTitle();
    if (t && typeof t.getName === "function") return t.getName();
  } catch (e) {}
  return `แท็บ ${index + 1}`;
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
  out = out.replace(new RegExp("^(\\s*(?:บท(?:ที่)?|ตอนที่)\\s*[0-9๐-๙]+)\\s*" + COLON_CLASS_ + "\\s*", "i"), "$1 ");
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
  const attrs = p.getAttributes();
  p.setText(newText);
  try { p.setAttributes(attrs); } catch (e) {}
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
    t.setFontSize(18);
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

/** 🪟 แยกชื่อบทที่ต่อท้าย "บทที่ xxx" ไปบรรทัดถัดไป */
function splitChapterTitleToNextLine_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();
  // รองรับเลขช่วง เช่น บทที่ 245-246: ชื่อบท
  const re = new RegExp(
    "^(บทที่)\\s*([0-9๐-๙]+(?:[-–—][0-9๐-๙]+)?)(?:\\s*" + COLON_CLASS_ + "\\s*|\\s+)(.+)$",
    "i"
  );

  for (let i = 0; i < Math.min(paras.length, 120); i++) {
    const p = paras[i];
    const raw = cleanText_(p.getText());
    if (!raw || raw === NOTE_TEXT_) continue;

    const line = normalizeChapterLine_(raw);
    const m = line.match(re);
    if (!m) continue;

    const chapterOnly = `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim();
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

/** ↩️ รวมชื่อบทกลับมาต่อท้าย "บทที่ xxx" ในแท็บปัจจุบัน */
function mergeChapterTitleBackInActiveTab_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();
  const re = /^(บทที่)\s*([0-9๐-๙]+)$/i;

  for (let i = 0; i < Math.min(paras.length, 120); i++) {
    const p1 = paras[i];
    const line1 = cleanText_(p1.getText());
    if (!line1 || line1 === NOTE_TEXT_) continue;

    const m = normalizeChapterLine_(line1).match(re);
    if (!m) continue;

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

    if (!line2 || line2 === NOTE_TEXT_) return { changed: 0, from: "", to: "" };
    if (isChapterLineText_(normalizeChapterLine_(line2))) return { changed: 0, from: "", to: "" };
    if (isStatusPanelLine_(line2)) return { changed: 0, from: "", to: "" };
    if (!isBoldUnderlineParagraph_(p2)) return { changed: 0, from: "", to: "" };

    const merged = `${m[1]} ${m[2]} ${line2}`.replace(/\s+/g, " ").trim();
    const attrs = p1.getAttributes ? p1.getAttributes() : {};

    p1.setText(merged);
    try { p1.setAttributes(attrs); } catch (e) {}

    try {
      const t = p1.editAsText();
      t.setFontFamily("Sarabun");
      t.setFontSize(18);
      t.setForegroundColor("#000000");
      t.setBold(true);
      t.setUnderline(true);
    } catch (e) {}

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
  const doc = getTargetDocument_();
  const currentTab = getProcessingTab_();
  const currentTabId = currentTab && currentTab.getId ? currentTab.getId() : null;

  if (!doc.getTabs) {
    const r = mergeChapterTitleBackInActiveTab_();
    return {
      tabChecked: 1,
      tabTotal: 1,
      changedCount: r.changed || 0,
      changedTabs: r.changed ? ["เอกสารหลัก"] : []
    };
  }

  const tabs = getAllTabsFlat_(doc);
  const result = {
    tabChecked: 0,
    tabTotal: tabs.length,
    changedCount: 0,
    changedTabs: []
  };

  tabs.forEach((t, idx) => {
    selectProcessingTab_(doc, t.getId());
    const r = mergeChapterTitleBackInActiveTab_();
    result.tabChecked++;
    if (r.changed) {
      result.changedCount++;
      result.changedTabs.push(getTabNameSafe_(t, idx));
    }
  });

  if (currentTabId) {
    try { selectProcessingTab_(doc, currentTabId); } catch (e) {}
  }

  return result;
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

  centralNotify_(lines.join("\n"));
  return r;
}

/* =========================
 * V11.3: เรียงชื่อแท็บเป็น แท็บ 1, แท็บ 2, ... ด้วย Google Docs API
 * ต้องเปิด Advanced Google Service: Google Docs API (Identifier: Docs)
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
  const out = [];
  size = Math.max(1, Number(size || 50));
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function updateDocumentTabTitlesByApi_(docId, renames) {
  renames = renames || [];
  if (!renames.length) return { ok: true, requestCount: 0, batchCount: 0 };
  ensureDocsAdvancedService_();

  const requests = renames.map(r => ({
    updateDocumentTabProperties: {
      tabProperties: {
        tabId: String(r.tabId || ''),
        title: String(r.newTitle || r.title || '').trim()
      },
      fields: 'title'
    }
  })).filter(req => {
    const p = req.updateDocumentTabProperties.tabProperties;
    return !!p.tabId && !!p.title;
  });

  const batches = chunkArray_(requests, 50);
  batches.forEach((batch, idx) => {
    Docs.Documents.batchUpdate({ requests: batch }, docId);
    if (idx < batches.length - 1) Utilities.sleep(250);
  });

  return { ok: true, requestCount: requests.length, batchCount: batches.length };
}

function resetTabNamesInDoc_(doc) {
  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  const renames = [];

  tabs.forEach((tab, idx) => {
    const tabId = tab && tab.getId ? tab.getId() : '';
    const oldTitle = getTabNameSafe_(tab, idx);
    const newTitle = buildSequentialTabTitle_(idx);

    if (tabId && oldTitle !== newTitle) {
      renames.push({
        tabId: tabId,
        tabIndex: idx + 1,
        oldTitle: oldTitle,
        newTitle: newTitle
      });
    }
  });

  const apiResult = updateDocumentTabTitlesByApi_(doc.getId(), renames);

  return {
    ok: true,
    tabTotal: tabs.length,
    renamedCount: renames.length,
    renamed: renames,
    apiResult: apiResult
  };
}

function resetTabNamesSequentialWithAlert() {
  const doc = getTargetDocument_();
  const currentTab = getProcessingTab_();
  const currentTabId = currentTab && currentTab.getId ? currentTab.getId() : null;

  const r = resetTabNamesInDoc_(doc);

  if (currentTabId) {
    try { selectProcessingTab_(doc, currentTabId); } catch (e) {}
  }

  const lines = [
    '🏷️ เรียงชื่อแท็บเป็น แท็บ 1, แท็บ 2, ... แล้ว',
    `📄 จำนวนแท็บทั้งหมด: ${r.tabTotal}`,
    `✅ เปลี่ยนชื่อ: ${r.renamedCount}`
  ];

  if (r.renamed && r.renamed.length) {
    lines.push('', 'ตัวอย่างที่เปลี่ยน:');
    r.renamed.slice(0, 12).forEach(item => {
      lines.push(`- ${item.oldTitle} → ${item.newTitle}`);
    });
    if (r.renamed.length > 12) lines.push(`...อีก ${r.renamed.length - 12} แท็บ`);
  } else {
    lines.push('', 'ℹ️ ชื่อแท็บเรียงถูกต้องอยู่แล้ว');
  }

  centralNotify_(lines.join('\n'));
  return r;
}

// aliases กันปุ่ม/โค้ดเดิมที่เคยเรียกชื่อเก่า
function restoreTabNamesFromContentWithAlert() {
  return resetTabNamesSequentialWithAlert();
}


