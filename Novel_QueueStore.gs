function novelReadHeaderRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function(h) { return String(h || '').trim(); })
    .filter(function(h) { return h !== ''; });
}

function novelBuildHeaderMap_(headers) {
  const map = {};
  headers.forEach(function(h, i) { if (h) map[h] = i + 1; });
  return map;
}

// Non-destructive header migration: missing canonical columns are appended to the right,
// existing columns/data/order are left untouched. Never clears/wipes existing rows.
function novelEnsureHeadersMigrated_(sheet, canonicalHeaders) {
  let headers = novelReadHeaderRow_(sheet);
  if (!headers.length) {
    sheet.appendRow(canonicalHeaders);
    headers = canonicalHeaders.slice();
  } else {
    const missing = canonicalHeaders.filter(function(h) { return headers.indexOf(h) === -1; });
    if (missing.length) {
      sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
      headers = headers.concat(missing);
    }
  }
  return { headers: headers, map: novelBuildHeaderMap_(headers) };
}

// Convert a { headerName: value } object into a positional row array according to the sheet's
// actual (possibly migrated / reordered) header map. Keys with no matching column are dropped.
function novelObjectToRow_(map, width, obj) {
  const row = new Array(width).fill('');
  Object.keys(obj).forEach(function(key) {
    const col = map[key];
    if (col) row[col - 1] = obj[key];
  });
  return row;
}

function ensureNovelHelperSheets_() {
  const ss = SpreadsheetApp.getActive();

  let queue = ss.getSheetByName(NOVEL_HELPER_CONFIG.QUEUE_SHEET);
  if (!queue) queue = ss.insertSheet(NOVEL_HELPER_CONFIG.QUEUE_SHEET);
  const queueMeta = novelEnsureHeadersMigrated_(queue, NOVEL_QUEUE_HEADERS);

  let log = ss.getSheetByName(NOVEL_HELPER_CONFIG.LOG_SHEET);
  if (!log) log = ss.insertSheet(NOVEL_HELPER_CONFIG.LOG_SHEET);
  const logMeta = novelEnsureHeadersMigrated_(log, NOVEL_LOG_HEADERS);

  return {
    queue: queue,
    log: log,
    queueHeaders: queueMeta.headers,
    queueMap: queueMeta.map,
    logHeaders: logMeta.headers,
    logMap: logMeta.map
  };
}

// Deliberate full-wipe, only ever run when a caller explicitly opts in with clearQueue: true.
// No current UI path does this (F7) — kept available for a future explicit full-reset action.
function clearNovelQueue_(existingQueue) {
  const queue = existingQueue || ensureNovelHelperSheets_().queue;
  queue.clear();
  queue.appendRow(NOVEL_QUEUE_HEADERS);
}

// CGS-013: lifecycle boundary for a genuinely new Build Queue run.
// Archive first, flush it durably, then remove only AI_QUEUE data cells while preserving headers,
// formatting, and AI_LOG. Safe to retry after an archive-before-clear interruption because the
// history archive is keyed idempotently by eventType + taskId.
function prepareNovelQueueForNewBuild_(options) {
  options = options || {};
  const meta = options.meta || ensureNovelHelperSheets_();
  const queueRows = Array.isArray(options.queueRows) ? options.queueRows : getNovelQueueObjects_();
  if (!queueRows.length) {
    return { scanned: 0, archived: 0, retiredActive: 0, clearedQueueRows: 0 };
  }

  const archivedAt = options.archivedAt || new Date();
  const logRows = Array.isArray(options.logRows) ? options.logRows : getNovelLogObjects_();
  const archiveResult = archiveNovelQueueHistoryToLog_({
    meta: meta,
    queueRows: queueRows,
    logRows: logRows,
    archivedAt: archivedAt,
    retireActive: true
  });

  // Force the history write to the spreadsheet before any queue data can disappear.
  SpreadsheetApp.flush();

  const queue = meta.queue;
  const lastRow = queue.getLastRow();
  if (lastRow >= 2) {
    const width = Math.max(queue.getLastColumn(), meta.queueHeaders.length);
    queue.getRange(2, 1, lastRow - 1, width).clearContent();
    SpreadsheetApp.flush();
  }

  return {
    scanned: queueRows.length,
    archived: Number(archiveResult.archived || 0),
    retiredActive: Number(archiveResult.retiredActive || 0),
    clearedQueueRows: queueRows.length
  };
}

function getNovelQueueObjects_() {
  const meta = ensureNovelHelperSheets_();
  const queue = meta.queue;
  const lastRow = queue.getLastRow();
  if (lastRow < 2) return [];

  const width = meta.queueHeaders.length;
  const values = queue.getRange(2, 1, lastRow - 1, width).getValues();
  return values.map((row, i) => {
    const obj = { _sheetRow: i + 2 };
    meta.queueHeaders.forEach(function(h, idx) { obj[h] = row[idx]; });
    return obj;
  });
}

function updateNovelQueueTask_(taskId, patch) {
  const meta = ensureNovelHelperSheets_();
  const queue = meta.queue;
  const data = getNovelQueueObjects_();
  const task = data.find(r => String(r.taskId) === String(taskId));

  if (!task) throw new Error(`ไม่พบ taskId ${taskId}`);

  for (const [key, value] of Object.entries(patch)) {
    const col = meta.queueMap[key] || 0;
    if (col > 0) queue.getRange(task._sheetRow, col).setValue(value);
  }
}

// meta ต้องมาจาก ensureNovelHelperSheets_() (มี log + logMap + logHeaders)
// fieldsObject คีย์ตรงกับชื่อ header ใน NOVEL_LOG_HEADERS
