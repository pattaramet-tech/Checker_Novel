/****************************************************
 * Novel Tab Audit
 *
 * ตรวจ Google Docs Tabs จาก:
 * Sheet: นิยายยังไม่จบ/ยังไม่ยื่น
 * B = ชื่อเรื่อง
 * C = Google Docs
 * L = หมายเหตุ
 *
 * Reuse helper เดิม:
 * - getRichTextUrlSafe_()
 * - parseGoogleDocUrl_()
 * - openDocByIdSafe_()
 * - getAllTabsFlat_()
 * - getBodyFromTabSafe_()
 * - getTabNameSafe_()
 * - appendCheckerNote_()
 * - compressNumberRanges_()
 ****************************************************/

const NOVEL_TAB_AUDIT_CFG = {
  SHEET_NAME: 'นิยายยังไม่จบ/ยังไม่ยื่น',

  TITLE_COL: 2,     // B
  DOC_URL_COL: 3,   // C
  NOTE_COL: 12,     // L

  // จำนวน Google Docs ที่ตรวจต่อ 1 google.script.run
  // ตั้งต่ำไว้เพื่อเลี่ยง Apps Script timeout
  DOCS_PER_CALL: 2,

  // หลังตัดหัวบท / จบตอน / marker ออกแล้ว
  // ต้องเหลือข้อความจริงอย่างน้อยกี่ตัวอักษร
  MIN_REAL_CONTENT_CHARS: 30
};


/**
 * เรียกจาก Sidebar ทีละ batch
 *
 * payload:
 * {
 *   rowsSpec: "1500-1550",
 *   cursor: 0
 * }
 */
function checkNovelTabsBatchFromSidebar(payload) {
  payload = payload || {};

  const rowsSpec = String(payload.rowsSpec || '').trim();
  const cursor = Math.max(0, Number(payload.cursor || 0));

  if (!rowsSpec) {
    throw new Error('กรุณาระบุเลขแถว เช่น 1500-1550');
  }

  const rows = parseNovelTabAuditRows_(rowsSpec);

  if (!rows.length) {
    throw new Error('ไม่พบเลขแถวที่ถูกต้อง');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(NOVEL_TAB_AUDIT_CFG.SHEET_NAME);

  if (!sheet) {
    throw new Error(
      'ไม่พบแท็บ "' + NOVEL_TAB_AUDIT_CFG.SHEET_NAME + '"'
    );
  }

  const lastRow = sheet.getLastRow();

  const batchRows = rows.slice(
    cursor,
    cursor + NOVEL_TAB_AUDIT_CFG.DOCS_PER_CALL
  );

  const results = [];

  for (let i = 0; i < batchRows.length; i++) {
    const row = batchRows[i];

    try {
      if (row < 2 || row > lastRow) {
        results.push({
          row: row,
          ok: false,
          error: 'เลขแถวอยู่นอกช่วงข้อมูล'
        });

        continue;
      }

      const result = inspectNovelTabsForSheetRow_(sheet, row);

      results.push(result);

    } catch (error) {
      results.push({
        row: row,
        ok: false,
        error: error && error.message
          ? error.message
          : String(error)
      });
    }
  }

  SpreadsheetApp.flush();

  const nextCursor = cursor + batchRows.length;
  const done = nextCursor >= rows.length;

  return {
    ok: true,

    rowsSpec: rowsSpec,

    totalRows: rows.length,
    processed: Math.min(nextCursor, rows.length),

    cursor: cursor,
    nextCursor: nextCursor,

    done: done,

    results: results
  };
}


/**
 * ตรวจ Google Docs ของ 1 แถว
 */
function inspectNovelTabsForSheetRow_(sheet, row) {
  const title = String(
    sheet
      .getRange(row, NOVEL_TAB_AUDIT_CFG.TITLE_COL)
      .getDisplayValue() || ''
  ).trim();

  const linkCell = sheet.getRange(
    row,
    NOVEL_TAB_AUDIT_CFG.DOC_URL_COL
  );

  /*
   * ใช้ helper เดิมจาก Checker_Main ก่อน
   * รองรับ Rich Text hyperlink
   */
  let url = '';

  if (typeof getRichTextUrlSafe_ === 'function') {
    url = getRichTextUrlSafe_(linkCell) || '';
  }

  if (!url) {
    url = String(linkCell.getDisplayValue() || '').trim();
  }

  if (!url) {
    throw new Error('คอลัมน์ C ไม่มี Google Docs URL');
  }


  /*
   * ใช้ parser เดิม
   */
  let parsed;

  if (typeof parseGoogleDocUrl_ === 'function') {
    parsed = parseGoogleDocUrl_(url);
  } else {
    parsed = parseNovelTabAuditDocUrlFallback_(url);
  }

  const docId = parsed && parsed.docId
    ? String(parsed.docId)
    : '';

  if (!docId) {
    throw new Error('ไม่พบ Google Docs ID');
  }


  /*
   * ใช้ openDocByIdSafe_ เดิม
   * ซึ่งมี retry อยู่แล้ว
   */
  const doc =
    typeof openDocByIdSafe_ === 'function'
      ? openDocByIdSafe_(docId)
      : DocumentApp.openById(docId);


  /*
   * ใช้ getAllTabsFlat_ เดิม
   * จึงรองรับทั้ง Top-level Tabs และ Child Tabs
   */
  let tabs = [];

  if (
    doc &&
    typeof doc.getTabs === 'function' &&
    typeof getAllTabsFlat_ === 'function'
  ) {
    tabs = getAllTabsFlat_(doc) || [];
  }


  const emptyTabNumbers = [];
  const emptyTabTitles = [];

  let totalTabs = 0;
  let contentTabs = 0;


  /*
   * Google Docs แบบไม่มี Tabs API / fallback
   */
  if (!tabs.length) {
    totalTabs = 1;

    const body = doc.getBody
      ? doc.getBody()
      : null;

    const text = body
      ? String(body.getText() || '')
      : '';

    if (novelTabAuditHasRealContent_(text)) {
      contentTabs = 1;
    } else {
      emptyTabNumbers.push(1);
      emptyTabTitles.push('เอกสารหลัก');
    }

  } else {

    totalTabs = tabs.length;

    for (let t = 0; t < tabs.length; t++) {
      const tab = tabs[t];

      /*
       * ใช้ helper เดิมของ Checker_Main
       */
      let body = null;

      if (typeof getBodyFromTabSafe_ === 'function') {
        body = getBodyFromTabSafe_(tab, doc);
      } else {
        try {
          body = tab.asDocumentTab().getBody();
        } catch (e) {
          body = null;
        }
      }

      const text = body
        ? String(body.getText() || '')
        : '';

      if (novelTabAuditHasRealContent_(text)) {
        contentTabs++;

      } else {
        const tabNo = t + 1;

        emptyTabNumbers.push(tabNo);

        let tabTitle = 'แท็บ ' + tabNo;

        if (typeof getTabNameSafe_ === 'function') {
          tabTitle = getTabNameSafe_(tab, t);
        }

        emptyTabTitles.push(tabTitle);
      }
    }
  }


  const emptyTabs = emptyTabNumbers.length;

  const emptyDisplay = novelTabAuditFormatNumbers_(
    emptyTabNumbers
  );


  /*
   * ตัวอย่าง:
   *
   * รวม 50 แท็บ มีเนื้อหา 47 แท็บ
   * ไม่มีเนื้อหา 3 แท็บ (แท็บ 22-24)
   */
  let auditNote =
    'รวม ' + totalTabs + ' แท็บ ' +
    'มีเนื้อหา ' + contentTabs + ' แท็บ ' +
    'ไม่มีเนื้อหา ' + emptyTabs + ' แท็บ';

  if (emptyTabs > 0) {
    auditNote += ' (แท็บ ' + emptyDisplay + ')';
  }


  /*
   * ไม่ทับหมายเหตุเก่า
   *
   * แต่ถ้าเคยตรวจ Tab Audit มาแล้ว
   * จะลบผล Audit เก่าแล้วใส่ผลล่าสุดแทน
   */
  const noteCell = sheet.getRange(
    row,
    NOVEL_TAB_AUDIT_CFG.NOTE_COL
  );

  const oldNote = String(
    noteCell.getDisplayValue() || ''
  ).trim();

  const newNote = mergeNovelTabAuditNote_(
    oldNote,
    auditNote
  );

  if (newNote !== oldNote) {
    noteCell.setValue(newNote);
  }


  return {
    ok: true,

    row: row,
    title: title,

    docId: docId,

    totalTabs: totalTabs,
    contentTabs: contentTabs,
    emptyTabs: emptyTabs,

    emptyTabNumbers: emptyTabNumbers,
    emptyTabTitles: emptyTabTitles,

    note: auditNote
  };
}


/**
 * ตรวจว่า Tab มี "เนื้อหานิยายจริง" หรือไม่
 *
 * ไม่ถือว่าสิ่งเหล่านี้เป็นเนื้อหา:
 * - บทที่ 202 ...
 * - ตอนที่ 202 ...
 * - Chapter 202 ...
 * - Episode 202 ...
 * - จบตอน
 * - พบคำต่างประเทศ
 *
 * ดังนั้น Tab ที่เหลือแค่
 *
 * บทที่ 202
 * จบตอน
 *
 * จะถูกนับว่า "ไม่มีเนื้อหา"
 */
function novelTabAuditHasRealContent_(text) {
  let value = String(text || '');

  value = value
    .replace(
      /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g,
      ' '
    )
    .replace(/\r/g, '\n');

  let lines = value
    .split('\n')
    .map(function(line) {
      return String(line || '').trim();
    })
    .filter(function(line) {
      return !!line;
    });


  lines = lines.filter(function(line) {

    // จบตอน
    if (/^จบตอน[\s.!！。…]*$/i.test(line)) {
      return false;
    }

    // marker ของระบบ
    if (/^พบคำต่างประเทศ[\s.!！。…]*$/i.test(line)) {
      return false;
    }

    // หัวบทภาษาไทย
    if (
      /^(?:บท(?:ที่)?|ตอนที่)\s*[0-9๐-๙]+(?:\s|$)/i.test(line)
    ) {
      return false;
    }

    // หัวบทภาษาอังกฤษ
    if (
      /^(?:chapter|episode)\s*\d+(?:\s|$)/i.test(line)
    ) {
      return false;
    }

    return true;
  });


  const meaningful = lines
    .join(' ')
    .replace(/\s+/g, '')
    .trim();

  return (
    meaningful.length >=
    NOVEL_TAB_AUDIT_CFG.MIN_REAL_CONTENT_CHARS
  );
}


/**
 * ลบ Audit เก่าออกก่อน
 * แล้วต่อผล Audit ล่าสุดลงหมายเหตุเดิม
 */
function mergeNovelTabAuditNote_(oldNote, auditNote) {
  let parts = String(oldNote || '')
    .split('|')
    .map(function(part) {
      return part.trim();
    })
    .filter(Boolean);


  /*
   * ลบเฉพาะ note ที่ฟังก์ชันนี้เคยสร้าง
   *
   * ตัวอย่าง:
   * รวม 50 แท็บ มีเนื้อหา 47 แท็บ ไม่มีเนื้อหา 3 แท็บ (แท็บ 22-24)
   */
  parts = parts.filter(function(part) {
    return !/^รวม\s+\d+\s+แท็บ\s+มีเนื้อหา\s+\d+\s+แท็บ\s+ไม่มีเนื้อหา\s+\d+\s+แท็บ(?:\s+\(แท็บ[^)]*\))?$/i
      .test(part);
  });


  const baseNote = parts.join(' | ');

  /*
   * ใช้ระบบ append/dedupe เดิมถ้ามี
   */
  if (typeof appendCheckerNote_ === 'function') {
    return appendCheckerNote_(
      baseNote,
      auditNote
    );
  }

  return baseNote
    ? baseNote + ' | ' + auditNote
    : auditNote;
}


/**
 * รองรับ:
 *
 * 1500-1550
 *
 * 1500,1501,1505
 *
 * 1500-1510,1520,1530-1540
 *
 * หรือขึ้นบรรทัดใหม่
 */
function parseNovelTabAuditRows_(input) {
  const text = String(input || '').trim();

  if (!text) return [];

  const tokens = text
    .split(/[,\n]+/)
    .map(function(x) {
      return x.trim();
    })
    .filter(Boolean);

  const rows = [];
  const seen = {};

  tokens.forEach(function(token) {

    const rangeMatch = token.match(
      /^(\d+)\s*[-–—]\s*(\d+)$/
    );

    if (rangeMatch) {
      let start = Number(rangeMatch[1]);
      let end = Number(rangeMatch[2]);

      if (end < start) {
        const tmp = start;
        start = end;
        end = tmp;
      }

      for (let row = start; row <= end; row++) {
        if (row < 2) continue;
        if (seen[row]) continue;

        seen[row] = true;
        rows.push(row);
      }

      return;
    }


    if (/^\d+$/.test(token)) {
      const row = Number(token);

      if (row >= 2 && !seen[row]) {
        seen[row] = true;
        rows.push(row);
      }
    }
  });

  return rows;
}


/**
 * แสดง 22,23,24 เป็น 22-24
 *
 * ใช้ compressNumberRanges_ เดิมก่อน
 */
function novelTabAuditFormatNumbers_(numbers) {
  if (
    typeof compressNumberRanges_ === 'function'
  ) {
    return compressNumberRanges_(numbers);
  }

  return (numbers || []).join(', ');
}


/**
 * fallback กรณี parseGoogleDocUrl_ ไม่มี
 */
function parseNovelTabAuditDocUrlFallback_(url) {
  const text = String(url || '').trim();

  const match = text.match(
    /\/document\/d\/([a-zA-Z0-9_-]+)/
  );

  return {
    docId: match ? match[1] : '',
    tabId: ''
  };
}