function appendNovelLog_(meta, fieldsObject) {
  const row = novelObjectToRow_(meta.logMap, meta.logHeaders.length, fieldsObject || {});
  meta.log.appendRow(row);
}

function getNovelLogObjects_() {
  const meta = ensureNovelHelperSheets_();
  const log = meta.log;
  const lastRow = log.getLastRow();
  if (lastRow < 2) return [];

  const width = meta.logHeaders.length;
  const values = log.getRange(2, 1, lastRow - 1, width).getValues();
  return values.map(function(row, i) {
    const obj = { _sheetRow: i + 2 };
    meta.logHeaders.forEach(function(h, idx) { obj[h] = row[idx]; });
    return obj;
  });
}

function novelQueueHistoryEventType_(queueRow) {
  if (String(queueRow && queueRow.applyStatus || '') === 'APPLIED') return 'QUEUE_APPLIED';
  if (String(queueRow && queueRow.supersededAt || '') !== '') return 'QUEUE_SUPERSEDED';
  return '';
}

function novelQueueHistoryKey_(queueRow, eventType) {
  const taskId = String(queueRow && queueRow.taskId || '').trim();
  return taskId && eventType ? 'QUEUE_HISTORY|' + eventType + '|' + taskId : '';
}

function novelQueueHistoryLogFields_(queueRow, eventType, archivedAt) {
  const claudeStatus = String(queueRow && queueRow.claudeStatus || '').trim();
  const applyStatus = String(queueRow && queueRow.applyStatus || '').trim();
  return {
    time: archivedAt || new Date(),
    sourceSheetName: queueRow.sourceSheetName || '',
    sourceRowAtExport: queueRow.sourceRow || '',
    sourceRowAtApply: '',
    docUrl: queueRow.docUrl || '',
    documentId: queueRow.documentId || '',
    tabId: queueRow.tabId || '',
    tabNoAtExport: queueRow.tabNo || '',
    tabNoAtApply: '',
    tabTitle: queueRow.tabTitle || '',
    paragraphIndex: queueRow.paragraphIndex || '',
    taskId: queueRow.taskId || '',
    paragraphFingerprint: queueRow.paragraphFingerprint || '',
    // CGS-013: preserve the prior queue payload in durable history before active-only compaction.
    oldText: queueRow.paragraphText || '',
    newText: queueRow.finalParagraph || '',
    actor: 'Apps Script',
    status: eventType === 'QUEUE_APPLIED' ? 'APPLIED_HISTORY' : 'SUPERSEDED_HISTORY',
    message: 'AI_QUEUE history archive | claudeStatus=' + claudeStatus + ' | applyStatus=' + applyStatus,
    eventType: eventType,
    historyKey: novelQueueHistoryKey_(queueRow, eventType),
    queueCreatedAt: queueRow.createdAt || '',
    queueApplyStatus: queueRow.applyStatus || '',
    queueAppliedAt: queueRow.appliedAt || '',
    supersededAt: queueRow.supersededAt || '',
    buildJobId: queueRow.buildJobId || '',
    occurrenceIndex: queueRow.occurrenceIndex || '',
    occurrenceCount: queueRow.occurrenceCount || '',
    tabParagraphCountAtExport: queueRow.tabParagraphCountAtExport || '',
    tabFingerprintSequenceAtExport: queueRow.tabFingerprintSequenceAtExport || '',
    paragraphText: queueRow.paragraphText || ''
  };
}

// CGS-012 compatibility migration + CGS-013 active-only lifecycle archive.
// Default behavior still archives only terminal/superseded rows. With retireActive:true, every
// remaining prior-build row is archived as QUEUE_SUPERSEDED before AI_QUEUE compaction. historyKey
// keeps retries idempotent even if an execution stops after the log write but before queue cleanup.
function archiveNovelQueueHistoryToLog_(options) {
  options = options || {};
  const meta = options.meta || ensureNovelHelperSheets_();
  const queueRows = Array.isArray(options.queueRows) ? options.queueRows : getNovelQueueObjects_();
  const logRows = Array.isArray(options.logRows) ? options.logRows : getNovelLogObjects_();
  const archivedAt = options.archivedAt || new Date();
  const existingKeys = new Set(logRows.map(function(row) { return String(row.historyKey || '').trim(); }).filter(Boolean));
  const toAppend = [];

  let retiredActive = 0;
  queueRows.forEach(function(queueRow) {
    let archiveRow = queueRow;
    let eventType = novelQueueHistoryEventType_(archiveRow);
    if (!eventType && options.retireActive === true) {
      archiveRow = Object.assign({}, queueRow, { supersededAt: queueRow.supersededAt || archivedAt });
      eventType = 'QUEUE_SUPERSEDED';
      retiredActive++;
    }
    if (!eventType) return;
    const historyKey = novelQueueHistoryKey_(archiveRow, eventType);
    if (!historyKey || existingKeys.has(historyKey)) return;
    existingKeys.add(historyKey);
    toAppend.push(novelQueueHistoryLogFields_(archiveRow, eventType, archivedAt));
  });

  if (toAppend.length) {
    const values = toAppend.map(function(obj) {
      return novelObjectToRow_(meta.logMap, meta.logHeaders.length, obj);
    });
    meta.log.getRange(meta.log.getLastRow() + 1, 1, values.length, meta.logHeaders.length).setValues(values);
  }

  return { archived: toAppend.length, scanned: queueRows.length, retiredActive: retiredActive, deletedQueueRows: 0 };
}

// Build-time history index. AI_LOG is authoritative when migrated history is present, while
// terminal/superseded AI_QUEUE rows remain a compatibility fallback until the later active-only
// queue lifecycle phase. Sets dedupe by taskId so mixed log+queue history cannot double-count.
function novelBuildHistoryIndex_(logRows, queueRows, documentId) {
  const terminalTaskIds = new Set();
  const supersededTaskIds = new Set();
  const docId = String(documentId || '');

  (logRows || []).forEach(function(row) {
    if (docId && String(row.documentId || '') !== docId) return;
    const taskId = String(row.taskId || '').trim();
    if (!taskId) return;
    const eventType = String(row.eventType || '').trim();
    const status = String(row.status || '').trim();
    if (eventType === 'QUEUE_APPLIED' || status === 'APPLIED' || status === 'APPLIED_HISTORY') terminalTaskIds.add(taskId);
    if (eventType === 'QUEUE_SUPERSEDED' || status === 'SUPERSEDED_HISTORY') supersededTaskIds.add(taskId);
  });

  (queueRows || []).forEach(function(row) {
    if (docId && String(row.documentId || '') !== docId) return;
    const taskId = String(row.taskId || '').trim();
    if (!taskId) return;
    if (String(row.applyStatus || '') === 'APPLIED') terminalTaskIds.add(taskId);
    if (String(row.supersededAt || '') !== '') supersededTaskIds.add(taskId);
  });

  return { terminalTaskIds: terminalTaskIds, supersededTaskIds: supersededTaskIds };
}

function novelNextAvailableTaskIdFromHistory_(documentId, tabId, paragraphFingerprint, paragraphPosition, terminalTaskIds, orphanTaskIds, supersededTaskIds) {
  terminalTaskIds = terminalTaskIds || new Set();
  orphanTaskIds = orphanTaskIds || new Set();
  supersededTaskIds = supersededTaskIds || new Set();
  let generation = 0;
  let taskId = novelComputeTaskId_(documentId, tabId, paragraphFingerprint, paragraphPosition);
  while (terminalTaskIds.has(taskId) || orphanTaskIds.has(taskId) || supersededTaskIds.has(taskId)) {
    generation++;
    taskId = novelComputeTaskId_(documentId, tabId, paragraphFingerprint, paragraphPosition + ':gen' + generation);
  }
  return taskId;
}
