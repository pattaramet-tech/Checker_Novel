/****************************************************
 *code.gs
 *  ตั้งค่าการแชร์ไฟล์จากลิงก์ในคอลัมน์ C
 * เขียนสถานะที่คอลัมน์ D
 *
 * เวอร์ชันแก้ Error:
 * - ไม่ใช้ DriveApp.getFileById()
 * - ไม่ใช้ Drive.Files.patch()
 * - ใช้ UrlFetchApp เรียก Drive API โดยตรง
 * - ลดงานต่อรอบเพื่อเลี่ยง timeout / quota
 ****************************************************/

const DRIVE_SHARE_CONFIG = {
  START_ROW: 2,

  LINK_COL: 3,        // C
  STATUS_COL: 13,      // D

  MAX_ROWS_PER_RUN: 15,       // แนะนำ 10-20 สำหรับไฟล์จำนวนมาก
  MAX_RUN_MS: 3.5 * 60 * 1000,
  SLEEP_MS: 800,              // เพิ่มหน่วง กัน quota / bandwidth

  TRIGGER_AFTER_MS: 2 * 60 * 1000,
  WORKER_FUNCTION: 'continueUpdateFileSettingsFromColumnC',

  PROP_SPREADSHEET_ID: 'UPDATE_FILE_SETTINGS_SPREADSHEET_ID',
  PROP_SHEET_ID: 'UPDATE_FILE_SETTINGS_SHEET_ID',
  PROP_NEXT_ROW: 'UPDATE_FILE_SETTINGS_NEXT_ROW',
  PROP_SUCCESS: 'UPDATE_FILE_SETTINGS_SUCCESS',
  PROP_ERROR: 'UPDATE_FILE_SETTINGS_ERROR',
  PROP_SKIP: 'UPDATE_FILE_SETTINGS_SKIP'
};

function addDriveShareMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('เครื่องมือจัดการ Docs')
    .addItem('เริ่มตั้งค่าไฟล์คอลัมน์ C', 'startUpdateFileSettingsFromColumnC')
    .addItem('ทำต่อจากจุดเดิม', 'continueUpdateFileSettingsFromColumnC')
    .addSeparator()
    .addItem('หยุดและรีเซ็ตงาน', 'resetUpdateFileSettingsJob')
    .addToUi();
}

function startUpdateFileSettingsFromColumnC() {
  clearUpdateFileSettingsTriggers();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const props = PropertiesService.getScriptProperties();

  props.setProperty(DRIVE_SHARE_CONFIG.PROP_SPREADSHEET_ID, ss.getId());
  props.setProperty(DRIVE_SHARE_CONFIG.PROP_SHEET_ID, String(sheet.getSheetId()));
  props.setProperty(DRIVE_SHARE_CONFIG.PROP_NEXT_ROW, String(DRIVE_SHARE_CONFIG.START_ROW));
  props.setProperty(DRIVE_SHARE_CONFIG.PROP_SUCCESS, '0');
  props.setProperty(DRIVE_SHARE_CONFIG.PROP_ERROR, '0');
  props.setProperty(DRIVE_SHARE_CONFIG.PROP_SKIP, '0');

  sheet.getRange(1, DRIVE_SHARE_CONFIG.STATUS_COL).setValue('สถานะ');
  sheet.getRange(1, DRIVE_SHARE_CONFIG.STATUS_COL).setNote(
    'ระบบจะทำทีละชุดและรันต่อเองจนจบ'
  );

  processUpdateFileSettingsBatch_();
}

function continueUpdateFileSettingsFromColumnC() {
  processUpdateFileSettingsBatch_();
}

function processUpdateFileSettingsBatch_() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(10000)) {
    scheduleNextUpdateFileSettingsRun_();
    return;
  }

  try {
    clearUpdateFileSettingsTriggers();

    const startedAt = Date.now();
    const props = PropertiesService.getScriptProperties();
    const sheet = getWorkingSheet_();

    const lastRow = sheet.getLastRow();

    let nextRow = Number(props.getProperty(DRIVE_SHARE_CONFIG.PROP_NEXT_ROW) || DRIVE_SHARE_CONFIG.START_ROW);
    let success = Number(props.getProperty(DRIVE_SHARE_CONFIG.PROP_SUCCESS) || 0);
    let error = Number(props.getProperty(DRIVE_SHARE_CONFIG.PROP_ERROR) || 0);
    let skip = Number(props.getProperty(DRIVE_SHARE_CONFIG.PROP_SKIP) || 0);

    if (nextRow > lastRow) {
      finishUpdateFileSettingsJob_(sheet, success, error, skip);
      return;
    }

    const rowsLeft = lastRow - nextRow + 1;
    const rowsToRead = Math.min(rowsLeft, DRIVE_SHARE_CONFIG.MAX_ROWS_PER_RUN);

    const linkValues = sheet
      .getRange(nextRow, DRIVE_SHARE_CONFIG.LINK_COL, rowsToRead, 1)
      .getValues();

    const oldStatuses = sheet
      .getRange(nextRow, DRIVE_SHARE_CONFIG.STATUS_COL, rowsToRead, 1)
      .getValues();

    const newStatuses = [];
    const processedIdsInThisRun = new Set();

    let processedRows = 0;

    for (let i = 0; i < rowsToRead; i++) {
      if (Date.now() - startedAt > DRIVE_SHARE_CONFIG.MAX_RUN_MS) {
        break;
      }

      const rowNumber = nextRow + i;
      const url = String(linkValues[i][0] || '').trim();
      const oldStatus = String(oldStatuses[i][0] || '').trim();

      processedRows++;

      if (!url) {
        newStatuses.push(['']);
        skip++;
        continue;
      }

      if (oldStatus.startsWith('✅')) {
        newStatuses.push([oldStatus]);
        skip++;
        continue;
      }

      const fileId = extractGoogleFileId_(url);

      if (!fileId) {
        newStatuses.push(['❌ แถว ' + rowNumber + ': ไม่พบ File ID']);
        error++;
        continue;
      }

      if (processedIdsInThisRun.has(fileId)) {
        newStatuses.push(['ข้าม: ไฟล์ซ้ำในรอบนี้']);
        skip++;
        continue;
      }

      processedIdsInThisRun.add(fileId);

      try {
        const result = updateDriveFileSettingsDirect_(fileId);

        const fileName = result.name || fileId;

        newStatuses.push(['✅ ตั้งค่าแล้ว: ' + fileName]);
        success++;

      } catch (e) {
        newStatuses.push(['❌ แถว ' + rowNumber + ': ' + cleanErrorMessage_(e)]);
        error++;
      }

      Utilities.sleep(DRIVE_SHARE_CONFIG.SLEEP_MS);
    }

    if (processedRows > 0) {
      sheet
        .getRange(nextRow, DRIVE_SHARE_CONFIG.STATUS_COL, processedRows, 1)
        .setValues(newStatuses);

      nextRow += processedRows;

      props.setProperty(DRIVE_SHARE_CONFIG.PROP_NEXT_ROW, String(nextRow));
      props.setProperty(DRIVE_SHARE_CONFIG.PROP_SUCCESS, String(success));
      props.setProperty(DRIVE_SHARE_CONFIG.PROP_ERROR, String(error));
      props.setProperty(DRIVE_SHARE_CONFIG.PROP_SKIP, String(skip));
    }

    sheet.getRange(1, DRIVE_SHARE_CONFIG.STATUS_COL).setValue(
      'กำลังทำงาน... แถวถัดไป: ' +
      nextRow +
      ' / ' +
      lastRow +
      ' | สำเร็จ: ' +
      success +
      ' | ผิดพลาด: ' +
      error +
      ' | ข้าม: ' +
      skip
    );

    SpreadsheetApp.flush();

    if (nextRow <= lastRow) {
      scheduleNextUpdateFileSettingsRun_();
    } else {
      finishUpdateFileSettingsJob_(sheet, success, error, skip);
    }

  } finally {
    lock.releaseLock();
  }
}

/**
 * ใช้ Drive API โดยตรง
 * ตั้งค่าตามรูป:
 * - Editors can change permissions and share = ON
 * - Viewers/commenters can download, print, copy = OFF
 */
function updateDriveFileSettingsDirect_(fileId) {
  const url =
    'https://www.googleapis.com/drive/v3/files/' +
    encodeURIComponent(fileId) +
    '?supportsAllDrives=true' +
    '&fields=id,name,mimeType,copyRequiresWriterPermission,writersCanShare,downloadRestrictions,capabilities';

  const payload = {
    // อนุญาตให้เอดิเตอร์เปลี่ยนสิทธิ์และแชร์ได้
    writersCanShare: true,

    // ปิด viewer/commenter ไม่ให้ดาวน์โหลด คัดลอก พิมพ์
    copyRequiresWriterPermission: true,

    // ปิด "เครื่องมือแก้ไข" ด้วย
    // ทำให้ Editor/Writer ก็ไม่สามารถดาวน์โหลด/คัดลอกได้
    downloadRestrictions: {
      itemDownloadRestriction: {
        restrictedForWriters: true,
        restrictedForReaders: true
      }
    }
  };

  const options = {
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  };

  const maxRetries = 4;
  let lastMessage = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      const text = response.getContentText();

      if (code >= 200 && code < 300) {
        return JSON.parse(text || '{}');
      }

      lastMessage = parseDriveApiError_(code, text);

      if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504) {
        Utilities.sleep(1500 * attempt);
        continue;
      }

      throw new Error(lastMessage);

    } catch (e) {
      lastMessage = e && e.message ? e.message : String(e);

      if (
        lastMessage.includes('เกินโควต้า') ||
        lastMessage.includes('quota') ||
        lastMessage.includes('Quota') ||
        lastMessage.includes('Bandwidth') ||
        lastMessage.includes('Service invoked too many times')
      ) {
        Utilities.sleep(3000 * attempt);
        continue;
      }

      throw new Error(lastMessage);
    }
  }

  throw new Error(lastMessage || 'เรียก Drive API ไม่สำเร็จ');
}

function parseDriveApiError_(code, text) {
  try {
    const obj = JSON.parse(text);

    const reason =
      obj &&
      obj.error &&
      obj.error.errors &&
      obj.error.errors[0] &&
      obj.error.errors[0].reason
        ? obj.error.errors[0].reason
        : '';

    const message =
      obj && obj.error && obj.error.message
        ? obj.error.message
        : text;

    return 'HTTP ' + code + (reason ? ' / ' + reason : '') + ': ' + message;

  } catch (e) {
    return 'HTTP ' + code + ': ' + text;
  }
}

function scheduleNextUpdateFileSettingsRun_() {
  clearUpdateFileSettingsTriggers();

  ScriptApp.newTrigger(DRIVE_SHARE_CONFIG.WORKER_FUNCTION)
    .timeBased()
    .after(DRIVE_SHARE_CONFIG.TRIGGER_AFTER_MS)
    .create();
}

function clearUpdateFileSettingsTriggers() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === DRIVE_SHARE_CONFIG.WORKER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function resetUpdateFileSettingsJob() {
  clearUpdateFileSettingsTriggers();

  const props = PropertiesService.getScriptProperties();

  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SPREADSHEET_ID);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SHEET_ID);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_NEXT_ROW);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SUCCESS);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_ERROR);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SKIP);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  sheet.getRange(1, DRIVE_SHARE_CONFIG.STATUS_COL).setValue('หยุดและรีเซ็ตงานแล้ว');

  SpreadsheetApp.getUi().alert('หยุดและรีเซ็ตงานแล้ว');
}

function finishUpdateFileSettingsJob_(sheet, success, error, skip) {
  clearUpdateFileSettingsTriggers();

  const props = PropertiesService.getScriptProperties();

  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SPREADSHEET_ID);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SHEET_ID);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_NEXT_ROW);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SUCCESS);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_ERROR);
  props.deleteProperty(DRIVE_SHARE_CONFIG.PROP_SKIP);

  sheet.getRange(1, DRIVE_SHARE_CONFIG.STATUS_COL).setValue(
    'เสร็จสิ้น | สำเร็จ: ' +
    success +
    ' | ผิดพลาด: ' +
    error +
    ' | ข้าม: ' +
    skip
  );
}

function getWorkingSheet_() {
  const props = PropertiesService.getScriptProperties();

  const spreadsheetId = props.getProperty(DRIVE_SHARE_CONFIG.PROP_SPREADSHEET_ID);
  const sheetId = Number(props.getProperty(DRIVE_SHARE_CONFIG.PROP_SHEET_ID));

  let ss;

  if (spreadsheetId) {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }

  if (!sheetId) {
    return ss.getActiveSheet();
  }

  const sheets = ss.getSheets();

  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === sheetId) {
      return sheets[i];
    }
  }

  throw new Error('ไม่พบชีตเดิมที่เริ่มงานไว้');
}

function extractGoogleFileId_(input) {
  const text = String(input || '').trim();

  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]+)/,
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    /\/presentation\/d\/([a-zA-Z0-9_-]+)/,
    /\/forms\/d\/([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (match && match[1]) {
      return match[1];
    }
  }

  if (/^[a-zA-Z0-9_-]{25,}$/.test(text)) {
    return text;
  }

  return null;
}

function cleanErrorMessage_(e) {
  const message = e && e.message ? e.message : String(e);

  if (message.length > 500) {
    return message.slice(0, 500) + '...';
  }

  return message;
}
