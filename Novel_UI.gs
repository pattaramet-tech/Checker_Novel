function addNovelHelperMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('Novel Helper')
    .addItem('Open Sidebar', 'showNovelHelperSidebar')
    .addSeparator()
    .addItem('Build Queue: 3 rows', 'buildNovelQueueDefault')
    .addItem('Apply Ready Edits', 'applyNovelReadyEdits')
    .addToUi();
}

function showNovelHelperSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Novel Helper');
  SpreadsheetApp.getUi().showSidebar(html);
}

// CGS-013: the user-facing synchronous Build starts a fresh active-only queue lifecycle.
// Prior rows are archived to AI_LOG before AI_QUEUE data is compacted; raw buildNovelQueue()
// keeps its compatibility default unless the caller explicitly opts into this lifecycle boundary.
function buildNovelQueueDefault() {
  return buildNovelQueue({
    maxRows: NOVEL_HELPER_CONFIG.DEFAULT_MAX_ROWS,
    activeOnlyReset: true
  });
}

function buildNovelQueueFromSidebar(settings) {
  return startNovelBuildQueueJob_(settings || {});
}

// ===========================================================================================
// CGS-005: Resumable Build Queue — job state, cursor, time budget, trigger continuation
// ===========================================================================================

function getNovelPromptForClaude() {
  return `คุณคือผู้ช่วยตรวจแก้นิยายภาษาไทย

ฉันจะส่ง JSON array ที่มี taskId, sourceRow, tabNo, tabTitle, highlightedText และ paragraphText ให้
หน้าที่ของคุณคือแก้เฉพาะคำต่างประเทศ/คำผิด/คำแปลหลุดในบริบทของย่อหน้านั้น

กติกาการแก้:
- อ่านทั้ง paragraphText ก่อนแก้
- แก้ให้อ่านลื่นเป็นไทย
- ห้าม rewrite ทั้งย่อหน้าโดยไม่จำเป็น
- ห้ามเปลี่ยนโครงเรื่อง
- ห้ามเพิ่มคำอธิบาย
- คงย่อหน้าเดิม ไม่แตกบรรทัดเพิ่ม
- ถ้าไม่มั่นใจ ให้ status เป็น needs_review

กติกาสำหรับภาษาอังกฤษต้นฉบับที่แปลไม่หมด:
- ถ้าย่อหน้ามีภาษาอังกฤษต้นฉบับพร้อมคำแปลไทยของข้อความเดียวกันอยู่แล้ว
  ให้ลบเฉพาะภาษาอังกฤษต้นฉบับ และรักษาคำแปลไทยไว้ครบถ้วน
- ถ้าย่อหน้าเป็นภาษาอังกฤษล้วนและไม่มีคำแปลไทย ให้แปลเป็นไทยให้ครบ
  ห้ามลบทิ้งจน finalParagraph ว่าง และห้ามคืน finalParagraph เป็นข้อความว่าง
- รักษาชื่อเฉพาะ (ชื่อคน ชื่อสถานที่ ชื่อสกิล) บทสนทนา เครื่องหมายคำพูด และความหมายเดิม
- คำภาษาอังกฤษสั้น ๆ ที่ตั้งใจให้คงไว้ เช่น ชื่อสกิลหรือชื่อเฉพาะ ไม่ต้องแปลและไม่ต้องลบ

กติกา JSON สำคัญมาก:
- ตอบกลับเป็น JSON array เท่านั้น
- ห้ามใส่ Markdown
- ห้ามใส่ \`\`\`json
- ห้ามใส่คำอธิบายก่อนหรือหลัง JSON
- key และ string ทุกตัวต้องใช้ double quote ตามมาตรฐาน JSON
- ห้ามใช้ single quote ' แทน double quote ของ JSON
- ห้ามมี comma เกินท้าย object หรือ array
- finalParagraph ต้องเป็นข้อความย่อหน้าเต็มหลังแก้แล้ว

กติกาเครื่องหมายคำพูด:
- ใน oldText, newText, finalParagraph, reason ห้ามใช้เครื่องหมาย double quote แบบตรง " ภายในข้อความ
- ให้เปลี่ยนคำพูดในเนื้อหาเป็นเครื่องหมายคำพูดไทย “ ” เสมอ
- ตัวอย่างถูกต้อง:
  "finalParagraph": "เขาพูดว่า “รัก” แล้วเดินจากไป"
- ตัวอย่างผิด:
  "finalParagraph": "เขาพูดว่า "รัก" แล้วเดินจากไป"
- ถ้าจำเป็นต้องใช้ " จริง ๆ ต้อง escape เป็น \\" แต่แนะนำให้ใช้ “ ” แทน

ตอบกลับเป็น JSON array รูปแบบนี้เท่านั้น:
[
  {
    "taskId": "...",
    "status": "ready",
    "oldText": "...",
    "newText": "...",
    "finalParagraph": "...",
    "reason": "สั้น ๆ"
  }
]`;
}
