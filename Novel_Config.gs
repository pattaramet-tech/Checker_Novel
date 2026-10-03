
/****************************************************
 * Novel_Config.gs
 * Novel Helper: อ่านคิวจาก Sheet → ดึงย่อหน้าใน Docs tabs
 * → ส่งให้ Claude แก้ → นำกลับมา Apply → อัปเดต column L
 *
 * วิธีใช้:
 * - สร้างไฟล์ HTML ชื่อ Sidebar แล้ววาง Sidebar.html ที่ให้คู่กัน
 * - Reload Google Sheet
 * - เปิดเมนู Novel Helper → Open Sidebar
 ****************************************************/

const NOVEL_HELPER_CONFIG = {
  // ถ้าเวิร์กชีตหลักมีชื่อแน่นอน ให้ใส่ชื่อ เช่น 'รวมนิยาย'
  // ถ้าปล่อยว่าง จะใช้ชีตที่เปิดอยู่
  MAIN_SHEET_NAME: '',

  HEADER_ROW: 1,
  FIRST_DATA_ROW: 2,

  // ตั้งค่าให้ตรงกับชีตจริง
  // ตอนนี้ตั้ง DOC_URL_COL เป็น 3 เพื่อให้ตรงกับ code.gs เดิมที่ใช้ลิงก์คอลัมน์ C
  // ถ้าลิงก์ Google Docs ที่ต้องแก้อยู่คอลัมน์ E ให้เปลี่ยนเป็น 5
  DOC_URL_COL: 3,       // C = ลิงก์ Google Docs
  REVIEWED_COL: 7,      // G = Reviewed checkbox
  PROGRAM_NOTE_COL: 12, // L = หมายเหตุโปรแกรม

  QUEUE_SHEET: 'AI_QUEUE',
  LOG_SHEET: 'AI_LOG',

  DEFAULT_MAX_ROWS: 3,
  // Mirror of FOREIGN_WORD_RE_V9_ (Checker_Main.txt), without the g flag.
  // Kept as a local copy so Novel Helper still detects foreign words correctly
  // even when Checker_Main.txt isn't loaded in the same runtime (e.g. isolated tests).
  FOREIGN_RE: /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u0400-\u04ff\u1e00-\u1eff\u0300-\u036f]/,
  WHITE_COLORS: new Set(['#ffffff', '#fff', 'white'])
};

const NOVEL_APPLY_FONT_FAMILY = 'Sarabun';
const NOVEL_APPLY_FONT_SIZE = 18;
const NOVEL_APPLY_HIGHLIGHT_COLOR = '#d62828';
const NOVEL_APPLY_HIGHLIGHT_TEXT_COLOR = '#ffffff';

// Authoritative identity of a task is documentId + tabId + paragraphFingerprint (real paragraph content).
// sourceRow / tabNo / paragraphIndex are metadata-only fast-path hints, never trusted blindly during Apply.
// supersededAt (round 10/C11): a persisted, auditable "this row is prior-generation history, not the
// current representation of live work" signal. A blank applyStatus alone is NOT proof a READY row is
// still current — a re-export that scanned this row's tab and could not carry it forward (its recorded
// paragraph moved unsafely, was resolved elsewhere, or became ambiguous) stamps supersededAt here.
// Apply then skips such rows entirely (no mutation, no fresh error/log) while the row itself is kept
// forever as history. Never set for a row a re-export could still safely reconcile to a live paragraph.
const NOVEL_QUEUE_HEADERS = [
  'taskId', 'createdAt', 'sourceSheetName', 'sourceRow', 'documentId', 'docUrl', 'originalNote',
  'targetTabCount', 'tabId', 'tabNo', 'tabTitle', 'paragraphIndex', 'paragraphFingerprint',
  'occurrenceIndex', 'occurrenceCount', 'tabParagraphCountAtExport', 'tabFingerprintSequenceAtExport',
  'highlightedText', 'paragraphText', 'claudeStatus', 'finalParagraph', 'applyStatus', 'appliedAt', 'message',
  'supersededAt', 'buildJobId'
];

const NOVEL_LOG_HEADERS = [
  'time', 'sourceSheetName', 'sourceRowAtExport', 'sourceRowAtApply', 'docUrl', 'documentId',
  'tabId', 'tabNoAtExport', 'tabNoAtApply', 'tabTitle', 'paragraphIndex', 'taskId',
  'paragraphFingerprint', 'oldText', 'newText', 'actor', 'status', 'message',
  // CGS-012: durable queue-history fields. These are append-only so every pre-existing AI_LOG
  // column keeps its original position. historyKey makes compatibility migration idempotent.
  'eventType', 'historyKey', 'queueCreatedAt', 'queueApplyStatus', 'queueAppliedAt', 'supersededAt',
  'buildJobId', 'occurrenceIndex', 'occurrenceCount', 'tabParagraphCountAtExport',
  'tabFingerprintSequenceAtExport', 'paragraphText'
];
