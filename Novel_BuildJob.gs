const NOVEL_JOB_CONFIG = {
  MAX_ROWS_PER_RUN: 5,            // source rows per execution (AC2/AC3)
  MAX_RUN_MS: 4.5 * 60 * 1000,   // stop before Apps Script 6-min hard limit (AC3)
  CONTINUE_AFTER_MS: 30 * 1000,  // trigger delay between runs (AC3/AC8)
  TRIGGER_FUNC: 'continueNovelBuildQueueJob',
  PROP_JOB: 'NOVEL_JOB_V1',
  PROP_SNAP_PFX: 'NOVEL_JOB_SNAP_V1_',
  SNAP_CHUNK: 50,                 // snapshot items per ScriptProperty chunk (~6 KB each)
  MAX_ERRORS: 20                  // bounded per-doc error log (AC12)
};

// ===========================================================================================
// CGS-006: Persistent Next Batch cycle for keyword-mode Build Queue
// ===========================================================================================

const NOVEL_NEXT_BATCH_CONFIG = {
  META_PREFIX: 'NOVEL_NEXT_BATCH_V1_',
  IDS_PREFIX: 'NOVEL_NEXT_BATCH_IDS_V1_',
  IDS_PER_CHUNK: 80
};

function novelNextBatchNormalizeKeywords_(input) {
  var raw = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  var seen = new Set();
  raw.forEach(function(v) {
    var k = String(v || '').trim().toLowerCase();
    if (k) seen.add(k);
  });
  return Array.from(seen).sort();
}

function novelNextBatchHash_(text) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text || ''),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(v) {
    var u = v < 0 ? v + 256 : v;
    return (u < 16 ? '0' : '') + u.toString(16);
  }).join('');
}

function novelNextBatchBuildScope_(settings, main) {
  settings = settings || {};
  main = main || getNovelMainSheet_();
  var ss = SpreadsheetApp.getActive();
  var spreadsheetId = ss.getId();
  var sheetId = String(main.getSheetId());
  var normalizedKeywords = novelNextBatchNormalizeKeywords_(settings.noteKeywords || '');
  var identity = ['keyword', spreadsheetId, sheetId, normalizedKeywords.join('\n')].join('|');
  return {
    scopeKey: novelNextBatchHash_(identity).slice(0, 24),
    spreadsheetId: spreadsheetId,
    sheetId: sheetId,
    normalizedKeywords: normalizedKeywords,
    mode: 'keyword'
  };
}

function novelNextBatchMetaKey_(scopeKey) {
  return NOVEL_NEXT_BATCH_CONFIG.META_PREFIX + String(scopeKey || '');
}

function novelNextBatchIdsKey_(scopeKey, index, slot) {
  var slotPart = slot ? ('_' + String(slot)) : '';
  return NOVEL_NEXT_BATCH_CONFIG.IDS_PREFIX + String(scopeKey || '') + slotPart + '_' + Number(index || 0);
}

function novelNextBatchLoadCycle_(scopeKey) {
  var key = String(scopeKey || '').trim();
  if (!key) throw new Error('Next Batch scopeKey ว่าง');
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(novelNextBatchMetaKey_(key));
  if (!raw) return { meta: null, processedIds: new Set() };

  var meta;
  try { meta = JSON.parse(raw); }
  catch (e) { throw new Error('Next Batch state เสียหาย: อ่าน metadata ไม่ได้'); }

  var ids = [];
  var chunks = Number(meta.chunks || 0);
  var activeSlot = meta.activeSlot ? String(meta.activeSlot) : '';
  for (var i = 0; i < chunks; i++) {
    var chunkRaw = props.getProperty(novelNextBatchIdsKey_(key, i, activeSlot));
    if (chunkRaw === null) throw new Error('Next Batch state เสียหาย: ขาด processed chunk ' + i);
    var chunk;
    try { chunk = JSON.parse(chunkRaw); }
    catch (e2) { throw new Error('Next Batch state เสียหาย: อ่าน processed chunk ' + i + ' ไม่ได้'); }
    Array.prototype.push.apply(ids, chunk || []);
  }
  return { meta: meta, processedIds: new Set(ids.map(function(x) { return String(x); })) };
}

function novelNextBatchSaveCycle_(scope, processedIds) {
  if (!scope || !scope.scopeKey) throw new Error('Next Batch scope ไม่ครบ');
  var props = PropertiesService.getScriptProperties();
  var previous = novelNextBatchLoadCycle_(scope.scopeKey);
  var activeSlot = previous.meta && previous.meta.activeSlot ? String(previous.meta.activeSlot) : 'B';
  var targetSlot = activeSlot === 'A' ? 'B' : 'A';
  var ids = Array.from(processedIds || []).map(function(x) { return String(x); }).filter(Boolean).sort();
  var size = NOVEL_NEXT_BATCH_CONFIG.IDS_PER_CHUNK;
  var chunks = 0;

  // Atomic A/B slot protocol: write a complete inactive copy first. The currently active
  // slot remains untouched until the metadata pointer is flipped as the final write.
  for (var i = 0; i < ids.length; i += size) {
    props.setProperty(novelNextBatchIdsKey_(scope.scopeKey, chunks, targetSlot), JSON.stringify(ids.slice(i, i + size)));
    chunks++;
  }

  var meta = {
    version: 2,
    scopeKey: scope.scopeKey,
    spreadsheetId: scope.spreadsheetId,
    sheetId: String(scope.sheetId),
    normalizedKeywords: (scope.normalizedKeywords || []).slice(),
    activeSlot: targetSlot,
    chunks: chunks,
    processedCount: ids.length,
    updatedAt: new Date().toISOString()
  };
  // Pointer flip is last: crash before this line leaves the previous complete slot authoritative.
  props.setProperty(novelNextBatchMetaKey_(scope.scopeKey), JSON.stringify(meta));
  return { meta: meta, processedIds: new Set(ids) };
}

function novelNextBatchClearCycle_(scopeKey) {
  var key = String(scopeKey || '').trim();
  if (!key) throw new Error('Next Batch scopeKey ว่าง');
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(novelNextBatchMetaKey_(key));

  // Both A/B slots plus legacy unslotted keys are private cycle metadata only.
  // Chunks are contiguous from index 0, so first missing key is the high-water boundary.
  ['', 'A', 'B'].forEach(function(slot) {
    for (var i = 0; i < 10000; i++) {
      var chunkKey = novelNextBatchIdsKey_(key, i, slot);
      if (props.getProperty(chunkKey) === null) break;
      props.deleteProperty(chunkKey);
    }
  });
}

function novelNextBatchCollectKeywordCandidates_(main, normalizedKeywords) {
  main = main || getNovelMainSheet_();
  var firstData = NOVEL_HELPER_CONFIG.FIRST_DATA_ROW;
  var lastRow = main.getLastRow();
  var targets = [];
  var seen = new Set();
  var invalidIdentityCount = 0;
  if (lastRow < firstData) return { targets: targets, invalidIdentityCount: 0 };

  var rowCount = lastRow - firstData + 1;
  var lastCol = Math.max(main.getLastColumn(), NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL);
  var rows = main.getRange(firstData, 1, rowCount, lastCol).getValues();
  var docUrls = getNovelDocUrlsBatch_(main, firstData, rowCount, rows);
  var keywords = novelNextBatchNormalizeKeywords_(normalizedKeywords || []);

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var reviewed = row[NOVEL_HELPER_CONFIG.REVIEWED_COL - 1];
    var note = String(row[NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL - 1] || '').trim();
    if (!note) continue;
    if (reviewed === true || String(reviewed).toUpperCase() === 'TRUE') continue;
    if (/^(?:รอ\s+\d+\s+แท็บ|รอตรวจ\s+\d+\s+แท็บ(?:\s*:)?)/.test(note)) continue;
    if (keywords.length) {
      var noteLower = note.toLowerCase();
      if (!keywords.some(function(kw) { return noteLower.indexOf(kw) !== -1; })) continue;
    }

    var docUrl = String(docUrls[i] || '').trim();
    if (!docUrl) continue;
    var docId = novelExtractDocId_(docUrl);
    if (!docId) {
      invalidIdentityCount++;
      continue;
    }
    if (seen.has(docId)) continue;
    seen.add(docId);
    targets.push({ sourceRow: firstData + i, docUrl: docUrl, docId: docId });
  }
  return { targets: targets, invalidIdentityCount: invalidIdentityCount };
}

function novelNextBatchPrepareKeywordJob_(settings) {
  settings = settings || {};
  var main = getNovelMainSheet_();
  var scope = novelNextBatchBuildScope_(settings, main);
  var cycle = novelNextBatchLoadCycle_(scope.scopeKey);
  var candidates = novelNextBatchCollectKeywordCandidates_(main, scope.normalizedKeywords);
  var available = candidates.targets.filter(function(t) { return !cycle.processedIds.has(String(t.docId)); });
  var maxRows = Math.max(1, Number(settings.maxRows || NOVEL_HELPER_CONFIG.DEFAULT_MAX_ROWS));
  return {
    scope: scope,
    snapshot: available.slice(0, maxRows),
    eligibleCount: candidates.targets.length,
    cycleProcessedCount: cycle.processedIds.size,
    remainingCandidates: available.length,
    invalidIdentityCount: candidates.invalidIdentityCount
  };
}

function novelNextBatchCommitProcessed_(state, docIds) {
  if (!state || !state.nextBatchEnabled || !state.nextBatchScopeKey) return null;
  var scope = {
    scopeKey: state.nextBatchScopeKey,
    spreadsheetId: state.spreadsheetId,
    sheetId: String(state.nextBatchSheetId || ''),
    normalizedKeywords: (state.nextBatchKeywords || []).slice(),
    mode: 'keyword'
  };
  var cycle = novelNextBatchLoadCycle_(scope.scopeKey);
  (docIds || []).forEach(function(id) {
    var v = String(id || '').trim();
    if (v) cycle.processedIds.add(v);
  });
  return novelNextBatchSaveCycle_(scope, cycle.processedIds);
}

function getNovelNextBatchCycleStatus(settings) {
  settings = settings || {};
  if (String(settings.buildMode || 'keyword') === 'manualRows') {
    return { ok: true, enabled: false, message: 'โหมดระบุแถวเองไม่ใช้ Next Batch cycle' };
  }
  var main = getNovelMainSheet_();
  var scope = novelNextBatchBuildScope_(settings, main);
  var cycle = novelNextBatchLoadCycle_(scope.scopeKey);
  var candidates = novelNextBatchCollectKeywordCandidates_(main, scope.normalizedKeywords);
  var remaining = candidates.targets.filter(function(t) { return !cycle.processedIds.has(String(t.docId)); }).length;
  return {
    ok: true, enabled: true, scopeKey: scope.scopeKey,
    processedCount: cycle.processedIds.size,
    remainingCandidates: remaining,
    eligibleCount: candidates.targets.length,
    invalidIdentityCount: candidates.invalidIdentityCount
  };
}

function resetNovelNextBatchCycle(settings) {
  settings = settings || {};
  if (String(settings.buildMode || 'keyword') === 'manualRows') {
    return { ok: false, error: 'โหมดระบุแถวเองไม่ใช้ Next Batch cycle' };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'ระบบล็อคอยู่ กรุณาลองใหม่' };
  try {
    var active = novelJobLoad_();
    if (active && (active.status === 'RUNNING' || active.status === 'SCHEDULED')) {
      return { ok: false, error: 'มี Build Queue กำลังทำงานอยู่ กรุณารอให้เสร็จหรือ Cancel ก่อน Reset cycle' };
    }
    var main = getNovelMainSheet_();
    var scope = novelNextBatchBuildScope_(settings, main);
    novelNextBatchClearCycle_(scope.scopeKey);
    var candidates = novelNextBatchCollectKeywordCandidates_(main, scope.normalizedKeywords);
    return {
      ok: true, enabled: true, scopeKey: scope.scopeKey,
      processedCount: 0,
      remainingCandidates: candidates.targets.length,
      eligibleCount: candidates.targets.length,
      message: 'Reset Next Batch cycle แล้ว / คิวและประวัติเดิมไม่ถูกลบ'
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Extract Google Doc ID from a URL without depending on Checker_Main.txt at runtime.
function novelExtractDocId_(url) {
  var m = String(url || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Freeze the list of target rows at job-start time.
 * Newly-qualifying docs wait for the next job (AC15).
 * Stores {sourceRow, docUrl, docId} — note is re-read at processing time for sort-safety (AC4).
 */
function novelBuildQueueSnapshotTargets_(settings) {
  settings = settings || {};
  var buildMode = String(settings.buildMode || 'keyword').trim();
  var main = getNovelMainSheet_();
  var lastRow = main.getLastRow();
  var firstData = NOVEL_HELPER_CONFIG.FIRST_DATA_ROW;
  var snapshot = [];
  var seenDocumentIds = new Set();

  function addTarget_(sourceRow, docUrl) {
    var normalizedUrl = String(docUrl || '').trim();
    var docId = novelExtractDocId_(normalizedUrl);
    if (docId && seenDocumentIds.has(docId)) return false;
    if (docId) seenDocumentIds.add(docId);
    snapshot.push({ sourceRow: sourceRow, docUrl: normalizedUrl, docId: docId });
    return true;
  }

  if (buildMode === 'manualRows') {
    var parsedRows = parseNovelHelperManualRows_(settings.manualRows);
    for (var i = 0; i < parsedRows.length; i++) {
      var r = parsedRows[i];
      var docUrl = (r >= firstData && r <= lastRow) ? getNovelDocUrlFromRow_(main, r) : '';
      addTarget_(r, docUrl);
    }
  } else {
    var maxRows = Number(settings.maxRows || NOVEL_HELPER_CONFIG.DEFAULT_MAX_ROWS);
    var noteKeywords = String(settings.noteKeywords || '')
      .split(/\r?\n/).map(function(k) { return k.trim(); }).filter(Boolean);

    if (lastRow >= firstData) {
      var rowCount = lastRow - firstData + 1;
      var lastCol = Math.max(main.getLastColumn(), NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL);
      var rows = main.getRange(firstData, 1, rowCount, lastCol).getValues();
      var docUrls = getNovelDocUrlsBatch_(main, firstData, rowCount, rows);

      for (var j = 0; j < rows.length && snapshot.length < maxRows; j++) {
        var row = rows[j];
        var reviewed = row[NOVEL_HELPER_CONFIG.REVIEWED_COL - 1];
        var note = String(row[NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL - 1] || '').trim();
        if (!note) continue;
        if (reviewed === true || String(reviewed).toUpperCase() === 'TRUE') continue;
        if (/^(?:รอ\s+\d+\s+แท็บ|รอตรวจ\s+\d+\s+แท็บ(?:\s*:)?)/.test(note)) continue;
        if (noteKeywords.length) {
          var noteLower = note.toLowerCase();
          if (!noteKeywords.some(function(kw) { return noteLower.indexOf(kw.toLowerCase()) !== -1; })) continue;
        }
        var du = docUrls[j];
        if (!du) continue;
        addTarget_(firstData + j, du);
      }
    }
  }
  return snapshot;
}

/**
 * Re-resolve the current sheet row for a document by stable docId (AC4/AC14).
 * Uses hintRow as a fast-path; falls back to a linear scan if the hint mismatches (e.g. sheet sorted).
 */
function novelResolveMainRowByDocId_(sheet, docId, hintRow) {
  var id = String(docId || '').trim();
  if (!id) {
    throw new Error('ไม่พบ documentId ที่ใช้ยืนยันแถวต้นทาง จึงไม่ใช้ sourceRow เดิมแทน');
  }

  var firstData = NOVEL_HELPER_CONFIG.FIRST_DATA_ROW;
  var lastRow = sheet.getLastRow();
  if (lastRow < firstData) {
    throw new Error('ไม่พบแถวต้นทางปัจจุบันสำหรับ documentId ' + id);
  }

  var rowCount = lastRow - firstData + 1;
  var urls = getNovelDocUrlsBatch_(sheet, firstData, rowCount, null);
  var matches = [];
  for (var i = 0; i < urls.length; i++) {
    if (novelExtractDocId_(urls[i]) === id) matches.push(firstData + i);
  }

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error('ไม่พบแถวต้นทางปัจจุบันสำหรับ documentId ' + id);
  }
  throw new Error('พบ documentId ซ้ำหลายแถว: ' + id + ' (' + matches.join(', ') + ') จึงไม่เลือกแถวอัตโนมัติ');
}

function novelBuildQueueIsTransientError_(err) {
  var msg = String(err && err.message ? err.message : err || '');
  if (!msg) return false;
  return /(?:Service invoked too many times|quota|bandwidth|rate\s*limit|HTTP\s*(?:429|500|502|503|504)\b|\b429\b|backend(?:\s+error)?|server\s+error|internal\s+error|service\s+unavailable|temporar(?:y|ily)|timed?\s*out|timeout|try\s+again)/i.test(msg);
}

// ─── Job state CRUD (ScriptProperties) ──────────────────────────────────────────────────

function novelJobSave_(state) {
  var props = PropertiesService.getScriptProperties();
  var snapshot = state.snapshot || [];
  var payload = {};
  Object.keys(state).forEach(function(k) { if (k !== 'snapshot') payload[k] = state[k]; });

  var chunkSize = NOVEL_JOB_CONFIG.SNAP_CHUNK;
  var chunks = 0;
  for (var i = 0; i < snapshot.length; i += chunkSize) {
    props.setProperty(NOVEL_JOB_CONFIG.PROP_SNAP_PFX + chunks, JSON.stringify(snapshot.slice(i, i + chunkSize)));
    chunks++;
  }
  payload.snapshotChunks = chunks;
  props.setProperty(NOVEL_JOB_CONFIG.PROP_JOB, JSON.stringify(payload));
}

function novelJobLoad_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(NOVEL_JOB_CONFIG.PROP_JOB);
  if (!raw) return null;
  try {
    var state = JSON.parse(raw);
    var snapshot = [];
    var chunks = Number(state.snapshotChunks || 0);
    for (var i = 0; i < chunks; i++) {
      var cr = props.getProperty(NOVEL_JOB_CONFIG.PROP_SNAP_PFX + i);
      if (cr) Array.prototype.push.apply(snapshot, JSON.parse(cr));
    }
    state.snapshot = snapshot;
    return state;
  } catch (e) {
    return null;
  }
}

function novelJobClear_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(NOVEL_JOB_CONFIG.PROP_JOB);
  var chunks = 0;
  if (raw) { try { chunks = Number(JSON.parse(raw).snapshotChunks || 0); } catch (e) {} }
  props.deleteProperty(NOVEL_JOB_CONFIG.PROP_JOB);
  for (var i = 0; i < chunks + 5; i++) {
    var key = NOVEL_JOB_CONFIG.PROP_SNAP_PFX + i;
    try { if (props.getProperty(key) !== null) props.deleteProperty(key); else if (i >= chunks) break; } catch (e) { break; }
  }
}

// ─── Trigger management (AC8: deduplication) ────────────────────────────────────────────

function novelClearBuildQueueTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === NOVEL_JOB_CONFIG.TRIGGER_FUNC) ScriptApp.deleteTrigger(t);
  });
}

function novelScheduleBuildQueueContinue_(afterMs) {
  novelClearBuildQueueTriggers_(); // dedupe: clear existing before creating new (AC8)
  var delayMs = Number(afterMs);
  if (!Number.isFinite(delayMs) || delayMs <= 0) delayMs = NOVEL_JOB_CONFIG.CONTINUE_AFTER_MS;
  return ScriptApp.newTrigger(NOVEL_JOB_CONFIG.TRIGGER_FUNC)
    .timeBased()
    .after(delayMs)
    .create()
    .getUniqueId();
}

// ─── Worker: processes one bounded batch from cursor, persists state ─────────────────────

function novelBuildQueueWorker_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    // Another execution is active; leave exactly one continuation trigger behind.
    try { novelScheduleBuildQueueContinue_(); } catch (e) {}
    return { ok: false, status: 'SCHEDULED', error: 'ระบบล็อคอยู่ ได้กำหนดให้รันต่อโดยอัตโนมัติ' };
  }
  try {
    var state = novelJobLoad_();
    if (!state) return { ok: false, error: 'ไม่พบข้อมูลงาน' };
    if (state.status === 'CANCELLED' || state.status === 'DONE' || state.status === 'FAILED') {
      try { novelClearBuildQueueTriggers_(); } catch (ignoredTerminalTriggerError) {}
      return { ok: true, status: state.status, jobId: state.jobId };
    }

    state.status = 'RUNNING';
    state.lastRunAt = new Date().toISOString();

    var startedAt = Date.now();
    var snapshot = state.snapshot || [];
    var total = snapshot.length;
    var cursor = Number(state.cursor || 0);

    // Crash watchdog: if this execution is hard-killed after a durable Sheet write but
    // before cursor commit/scheduling, this later trigger will replay the same cursor.
    // Normal completion replaces/clears it before it fires.
    state.triggerId = novelScheduleBuildQueueContinue_(
      NOVEL_JOB_CONFIG.MAX_RUN_MS + NOVEL_JOB_CONFIG.CONTINUE_AFTER_MS
    );

    var main = getNovelMainSheet_();
    var meta = ensureNovelHelperSheets_();
    var now = new Date();

    // Re-read durable queue state every execution so a replay after a crash dedupes any
    // task rows that were already written before the cursor could be committed.
    var existingQueueRows = getNovelQueueObjects_();
    // CGS-012-C02: resumable Build must consult the same durable AI_LOG history as synchronous
    // Build. AI_QUEUE terminal/superseded rows remain a compatibility fallback inside
    // novelBuildHistoryIndex_ until the later active-only queue migration.
    var existingLogRows = typeof getNovelLogObjects_ === 'function' ? getNovelLogObjects_() : [];
    // C03: buildJobId is durable queue metadata. Reconstruct the number of tasks already
    // created by THIS job on every execution so a crash after AI_QUEUE write but before
    // job-state save cannot make queuedTasks undercount on replay.
    var durableQueuedTasksForJob = existingQueueRows.filter(function(r) {
      return String(r.buildJobId || '') === String(state.jobId || '');
    }).length;
    var existingTaskIds = new Set(
      existingQueueRows
        .filter(function(r) { return String(r.applyStatus || '') !== 'APPLIED' && String(r.supersededAt || '') === ''; })
        .map(function(r) { return String(r.taskId); })
    );
    var supersededTaskIds = new Set();

    var output = [];
    var logRowsArr = [];
    var batchStats = {
      queuedTasks: 0, sequenceDone: 0, notesUpdated: 0,
      unchangedRows: 0, problemRows: 0, noteResultRows: new Set()
    };
    var errors = (state.errors || []).slice();
    var errorCount = Number(state.errorCount || 0);
    var rowsThisRun = 0;
    var deferredTransient = null;
    var cycleProcessedDocIds = new Set();

    function addBoundedError_(item, itemIndex, msg) {
      if (errors.length < NOVEL_JOB_CONFIG.MAX_ERRORS) {
        errors.push({
          snapshotIndex: itemIndex,
          documentId: item && item.docId ? String(item.docId) : '',
          sourceRow: item && item.sourceRow,
          message: String(msg || '').slice(0, 400)
        });
      }
      errorCount++;
    }

    function addWorkerErrorLog_(item, msg) {
      logRowsArr.push({
        time: now,
        sourceSheetName: main.getName(),
        sourceRowAtExport: item && item.sourceRow ? item.sourceRow : '',
        sourceRowAtApply: '',
        docUrl: item && item.docUrl ? item.docUrl : '',
        documentId: item && item.docId ? item.docId : '',
        tabId: '', tabNoAtExport: '', tabNoAtApply: '', tabTitle: '',
        paragraphIndex: '', taskId: '', paragraphFingerprint: '',
        oldText: '', newText: '', actor: 'Apps Script', status: 'ERROR',
        message: String(msg || '').slice(0, 400)
      });
    }

    function mergeRowStats_(rowStats, includeQueuedTasks) {
      if (includeQueuedTasks) batchStats.queuedTasks += Number(rowStats.queuedTasks || 0);
      batchStats.sequenceDone += Number(rowStats.sequenceDone || 0);
      batchStats.notesUpdated += Number(rowStats.notesUpdated || 0);
      batchStats.unchangedRows += Number(rowStats.unchangedRows || 0);
      batchStats.problemRows += Number(rowStats.problemRows || 0);
    }

    while (cursor < total &&
           rowsThisRun < NOVEL_JOB_CONFIG.MAX_ROWS_PER_RUN &&
           (Date.now() - startedAt) < NOVEL_JOB_CONFIG.MAX_RUN_MS) {
      var itemIndex = cursor;
      var item = snapshot[itemIndex];

      if (!item || !item.docUrl) {
        var missingUrlMsg = 'ไม่พบ docUrl';
        addBoundedError_(item, itemIndex, missingUrlMsg);
        addWorkerErrorLog_(item, missingUrlMsg);
        cursor++;
        rowsThisRun++;
        continue;
      }

      // One source row is the atomic processing unit. Buffer every queue/log/superseded
      // mutation for this row separately; only merge it into the execution batch after
      // the row has completed without a transient service failure.
      var rowOutput = [];
      var rowLogs = [];
      var rowSupersededTaskIds = new Set();
      var rowExistingTaskIds = new Set(existingTaskIds);
      var rowStats = {
        queuedTasks: 0, sequenceDone: 0, notesUpdated: 0,
        unchangedRows: 0, problemRows: 0, noteResultRows: new Set()
      };

      try {
        // Strictly sort-safe: sourceRowAtStart is metadata only. Missing or ambiguous
        // document identity throws before Column L can be touched.
        var resolvedRow = novelResolveMainRowByDocId_(main, item.docId, item.sourceRow);
        var currentNote = String(main.getRange(resolvedRow, NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL).getValue() || '').trim();

        processNovelQueueSourceRow_(
          main, meta.log, resolvedRow, item.docUrl, currentNote,
          rowOutput, now, rowStats, rowLogs,
          rowExistingTaskIds, existingQueueRows, rowSupersededTaskIds,
          { rethrowTransient: true, historyLogRows: existingLogRows }
        );

        var rowErrorLog = null;
        for (var rl = 0; rl < rowLogs.length; rl++) {
          if (String(rowLogs[rl].status || '') === 'ERROR') {
            rowErrorLog = rowLogs[rl];
            break;
          }
        }

        Array.prototype.push.apply(logRowsArr, rowLogs);
        if (rowErrorLog) {
          // processNovelQueueSourceRow_ already wrote the safe Column L error and audit
          // record. Discard any task rows buffered before the permanent Doc failure so a
          // partially-scanned source row never becomes a partial queue export.
          addBoundedError_(item, itemIndex, rowErrorLog.message || 'ประมวลผลเอกสารไม่สำเร็จ');
          mergeRowStats_(rowStats, false);
        } else {
          rowOutput.forEach(function(entry) { entry.buildJobId = state.jobId; });
          Array.prototype.push.apply(output, rowOutput);
          rowExistingTaskIds.forEach(function(taskId) { existingTaskIds.add(taskId); });
          rowSupersededTaskIds.forEach(function(taskId) { supersededTaskIds.add(taskId); });
          mergeRowStats_(rowStats, true);
        }

        if (state.nextBatchEnabled && item.docId) cycleProcessedDocIds.add(String(item.docId));
        cursor++;
        rowsThisRun++;
      } catch (e) {
        var msg = String(e && e.message ? e.message : e).slice(0, 400);
        if (novelBuildQueueIsTransientError_(e)) {
          // Do not consume this item. Discard row-local buffers and let a continuation
          // retry the identical stable document target from the same cursor.
          deferredTransient = {
            snapshotIndex: itemIndex,
            documentId: String(item.docId || ''),
            sourceRow: item.sourceRow,
            message: msg
          };
          break;
        }

        // Permanent identity/permission/file errors are audited and then consumed so one
        // bad Doc does not stop the whole job. Resolver failures happen before Column L.
        addBoundedError_(item, itemIndex, msg);
        addWorkerErrorLog_(item, msg);
        if (state.nextBatchEnabled && item.docId) cycleProcessedDocIds.add(String(item.docId));
        cursor++;
        rowsThisRun++;
      }
    }

    if (output.length) {
      var qrows = output.map(function(obj) { return novelObjectToRow_(meta.queueMap, meta.queueHeaders.length, obj); });
      meta.queue.getRange(meta.queue.getLastRow() + 1, 1, qrows.length, meta.queueHeaders.length).setValues(qrows);
    }
    if (logRowsArr.length) {
      var lrows = logRowsArr.map(function(obj) { return novelObjectToRow_(meta.logMap, meta.logHeaders.length, obj); });
      meta.log.getRange(meta.log.getLastRow() + 1, 1, lrows.length, meta.logHeaders.length).setValues(lrows);
    }

    if (supersededTaskIds.size) {
      var supCol = meta.queueMap.supersededAt || 0;
      if (supCol > 0) {
        var byId = new Map();
        existingQueueRows.forEach(function(r) { byId.set(String(r.taskId), r); });
        supersededTaskIds.forEach(function(taskId) {
          var r = byId.get(taskId);
          if (r && r._sheetRow && String(r.applyStatus || '') !== 'APPLIED' && String(r.supersededAt || '') === '') {
            meta.queue.getRange(r._sheetRow, supCol).setValue(now);
          }
        });
      }
    }

    SpreadsheetApp.flush();

    if (state.nextBatchEnabled && cycleProcessedDocIds.size) {
      var cycleCommit = novelNextBatchCommitProcessed_(state, cycleProcessedDocIds);
      state.cycleProcessedCount = cycleCommit ? cycleCommit.processedIds.size : Number(state.cycleProcessedCount || 0);
      state.cycleProcessedInJob = Number(state.cycleProcessedInJob || 0) + cycleProcessedDocIds.size;
      state.cycleRemainingCandidates = Math.max(
        0,
        Number(state.cycleRemainingAtStart || 0) - Number(state.cycleProcessedInJob || 0)
      );
    }

    // Commit the durable cursor only after all batch Sheet writes and Next Batch cycle progress are durable.
    state.cursor = cursor;
    state.processedRows = Number(state.processedRows || 0) + rowsThisRun;
    // C03: exact-once accounting across crash/replay. Previous job rows are reconstructed
    // from durable AI_QUEUE buildJobId metadata; output.length is the only new durable append
    // from this execution (existingTaskIds already dedupes replayed rows).
    state.queuedTasks = durableQueuedTasksForJob + output.length;
    state.sequenceDone = Number(state.sequenceDone || 0) + batchStats.sequenceDone;
    state.notesUpdated = Number(state.notesUpdated || 0) + batchStats.notesUpdated;
    state.unchangedRows = Number(state.unchangedRows || 0) + batchStats.unchangedRows;
    state.problemRows = Number(state.problemRows || 0) + Number(batchStats.problemRows || 0);
    state.errors = errors;
    state.errorCount = errorCount;
    state.elapsedMs = Number(state.elapsedMs || 0) + (Date.now() - startedAt);

    if (deferredTransient) {
      state.transientDeferrals = Number(state.transientDeferrals || 0) + 1;
      state.lastTransientError = deferredTransient;
    } else {
      state.lastTransientError = '';
    }

    var done = cursor >= total;
    if (done) {
      var revResult = state.notesUpdated > 0 ? touchCheckerDataRevision_() : getCheckerDataRevision_();
      state.status = 'DONE';
      state.triggerId = '';
      // Persist terminal state before trigger cleanup. If cleanup itself fails, a stale
      // trigger sees DONE on its next run and clears itself without doing more work.
      novelJobSave_(state);
      novelClearBuildQueueTriggers_();

      return {
        ok: true, jobId: state.jobId, status: 'DONE',
        processedRows: state.processedRows, total: total,
        queuedTasks: state.queuedTasks, notesUpdated: state.notesUpdated,
        unchangedRows: state.unchangedRows, errorCount: state.errorCount,
        elapsedMs: state.elapsedMs,
        cycleProcessedCount: Number(state.cycleProcessedCount || 0),
        cycleRemainingCandidates: Number(state.cycleRemainingCandidates || 0),
        cycleEligibleCount: Number(state.cycleEligibleCount || 0),
        invalidIdentityCount: Number(state.invalidIdentityCount || 0),
        revisionAvailable: revResult.revisionAvailable,
        message: 'สร้างคิวเสร็จสิ้น ' + state.queuedTasks + ' งาน / ' + state.processedRows + ' แถว'
      };
    }

    // Replace the long crash-watchdog with the normal short continuation trigger.
    var triggerId = novelScheduleBuildQueueContinue_();
    state.status = 'SCHEDULED';
    state.triggerId = triggerId;
    novelJobSave_(state);

    return {
      ok: true, jobId: state.jobId, status: 'SCHEDULED',
      cursor: cursor, total: total,
      processedRows: state.processedRows, queuedTasks: state.queuedTasks,
      notesUpdated: state.notesUpdated, errorCount: state.errorCount,
      transientDeferrals: Number(state.transientDeferrals || 0),
      elapsedMs: state.elapsedMs,
      cycleProcessedCount: Number(state.cycleProcessedCount || 0),
      cycleRemainingCandidates: Number(state.cycleRemainingCandidates || 0),
      cycleEligibleCount: Number(state.cycleEligibleCount || 0),
      invalidIdentityCount: Number(state.invalidIdentityCount || 0),
      message: deferredTransient
        ? ('บริการ Google ขัดข้องชั่วคราว จะลอง documentId ' + (deferredTransient.documentId || '?') + ' ใหม่อัตโนมัติจากลำดับเดิม ' + cursor + '/' + total)
        : ('กำลังดำเนินการ... ' + cursor + '/' + total + ' แถว')
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ─── Public entrypoints ──────────────────────────────────────────────────────────────────

/**
 * Start a resumable Build Queue job. If a job is already active, returns its status (AC9).
 * Takes a frozen snapshot of targets at start time (AC15), then runs the first batch synchronously.
 */
function startNovelBuildQueueJob_(settings) {
  settings = settings || {};

  // Fast-path: detect active job before doing snapshot reads (AC9)
  var existing = novelJobLoad_();
  if (existing && (existing.status === 'RUNNING' || existing.status === 'SCHEDULED')) {
    var snap = existing.snapshot || [];
    return {
      ok: true, jobId: existing.jobId, status: existing.status,
      cursor: existing.cursor, total: snap.length,
      processedRows: existing.processedRows, queuedTasks: existing.queuedTasks,
      notesUpdated: existing.notesUpdated, errorCount: existing.errorCount,
      cycleProcessedCount: Number(existing.cycleProcessedCount || 0),
      cycleRemainingCandidates: Number(existing.cycleRemainingCandidates || 0),
      cycleEligibleCount: Number(existing.cycleEligibleCount || 0),
      message: 'มีงานที่กำลังรันอยู่ กรุณากดรีเฟรชสถานะ'
    };
  }

  var buildMode = String(settings.buildMode || 'keyword').trim();
  var nextBatchPlan = buildMode === 'manualRows' ? null : novelNextBatchPrepareKeywordJob_(settings);
  var snapshot = nextBatchPlan ? nextBatchPlan.snapshot : novelBuildQueueSnapshotTargets_(settings);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, error: 'ระบบล็อคอยู่ กรุณาลองใหม่' };
  }
  try {
    // Double-check inside lock (AC9: concurrent Start)
    var existingAgain = novelJobLoad_();
    if (existingAgain && (existingAgain.status === 'RUNNING' || existingAgain.status === 'SCHEDULED')) {
      var snap2 = existingAgain.snapshot || [];
      return {
        ok: true, jobId: existingAgain.jobId, status: existingAgain.status,
        cursor: existingAgain.cursor, total: snap2.length,
        processedRows: existingAgain.processedRows, queuedTasks: existingAgain.queuedTasks,
        notesUpdated: existingAgain.notesUpdated, errorCount: existingAgain.errorCount,
        cycleProcessedCount: Number(existingAgain.cycleProcessedCount || 0),
        cycleRemainingCandidates: Number(existingAgain.cycleRemainingCandidates || 0),
        cycleEligibleCount: Number(existingAgain.cycleEligibleCount || 0),
        message: 'มีงานที่กำลังรันอยู่ กรุณากดรีเฟรชสถานะ'
      };
    }

    // CGS-013: this is a genuinely NEW user-started build (both active-job checks passed).
    // Archive/retire the entire prior queue durably, then compact AI_QUEUE before creating the
    // new job. Continuation workers never call this helper, so they cannot clear their own rows.
    prepareNovelQueueForNewBuild_();

    // A user-invoked zero-target build is still the latest build. Persist a fresh
    // terminal identity under the same lock used by normal starts so default export
    // can never fall back to a stale prior jobId (CGS-007-C02 F1-F4).
    if (!snapshot.length) {
      novelClearBuildQueueTriggers_();
      var emptyJobId = 't' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      var emptyNow = new Date().toISOString();
      var emptyState = {
        jobId: emptyJobId,
        mode: String(settings.buildMode || 'keyword'),
        status: 'DONE',
        startedAt: emptyNow,
        lastRunAt: emptyNow,
        spreadsheetId: SpreadsheetApp.getActive().getId(),
        cursor: 0, processedRows: 0, queuedTasks: 0, notesUpdated: 0,
        unchangedRows: 0, problemRows: 0, errorCount: 0, errors: [],
        elapsedMs: 0, triggerId: '',
        nextBatchEnabled: !!nextBatchPlan,
        nextBatchScopeKey: nextBatchPlan ? nextBatchPlan.scope.scopeKey : '',
        nextBatchSheetId: nextBatchPlan ? nextBatchPlan.scope.sheetId : '',
        nextBatchKeywords: nextBatchPlan ? nextBatchPlan.scope.normalizedKeywords : [],
        cycleProcessedCount: nextBatchPlan ? nextBatchPlan.cycleProcessedCount : 0,
        cycleRemainingAtStart: nextBatchPlan ? nextBatchPlan.remainingCandidates : 0,
        cycleRemainingCandidates: nextBatchPlan ? nextBatchPlan.remainingCandidates : 0,
        cycleEligibleCount: nextBatchPlan ? nextBatchPlan.eligibleCount : 0,
        cycleProcessedInJob: 0,
        invalidIdentityCount: nextBatchPlan ? nextBatchPlan.invalidIdentityCount : 0,
        snapshot: []
      };
      novelJobSave_(emptyState);
      var exhausted = !!nextBatchPlan && nextBatchPlan.remainingCandidates === 0 && nextBatchPlan.cycleProcessedCount > 0;
      return {
        ok: true, jobId: emptyJobId, status: 'DONE', cycleExhausted: exhausted,
        message: exhausted
          ? 'Next Batch cycle นี้ครบแล้ว ไม่มี documentId ที่ยังไม่เคยประมวลผล (กด Reset Next Batch Cycle หากต้องการเริ่มใหม่)'
          : 'ไม่พบแถวที่ต้องประมวลผล',
        processedRows: 0, queuedTasks: 0, total: 0,
        cycleProcessedCount: Number(emptyState.cycleProcessedCount || 0),
        cycleRemainingCandidates: Number(emptyState.cycleRemainingCandidates || 0),
        cycleEligibleCount: Number(emptyState.cycleEligibleCount || 0),
        invalidIdentityCount: Number(emptyState.invalidIdentityCount || 0)
      };
    }

    novelClearBuildQueueTriggers_();

    var jobId = 't' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    var state = {
      jobId: jobId,
      mode: String(settings.buildMode || 'keyword'),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
      spreadsheetId: SpreadsheetApp.getActive().getId(),
      cursor: 0, processedRows: 0, queuedTasks: 0, notesUpdated: 0,
      unchangedRows: 0, problemRows: 0, errorCount: 0, errors: [],
      elapsedMs: 0, triggerId: '',
      nextBatchEnabled: !!nextBatchPlan,
      nextBatchScopeKey: nextBatchPlan ? nextBatchPlan.scope.scopeKey : '',
      nextBatchSheetId: nextBatchPlan ? nextBatchPlan.scope.sheetId : '',
      nextBatchKeywords: nextBatchPlan ? nextBatchPlan.scope.normalizedKeywords : [],
      cycleProcessedCount: nextBatchPlan ? nextBatchPlan.cycleProcessedCount : 0,
      cycleRemainingAtStart: nextBatchPlan ? nextBatchPlan.remainingCandidates : 0,
      cycleRemainingCandidates: nextBatchPlan ? nextBatchPlan.remainingCandidates : 0,
      cycleEligibleCount: nextBatchPlan ? nextBatchPlan.eligibleCount : 0,
      cycleProcessedInJob: 0,
      invalidIdentityCount: nextBatchPlan ? nextBatchPlan.invalidIdentityCount : 0,
      snapshot: snapshot
    };
    novelJobSave_(state);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }

  // Run first batch — worker acquires its own lock
  return novelBuildQueueWorker_();
}

/** Trigger target: continues an in-progress resumable job (AC3/AC8) */
function continueNovelBuildQueueJob() {
  novelBuildQueueWorker_();
}

/** Returns current job state for Sidebar status polling */
function getNovelBuildQueueJobStatus() {
  var state = novelJobLoad_();
  if (!state) return { status: 'IDLE', message: 'ไม่มีงาน' };
  var snap = state.snapshot || [];
  return {
    ok: true,
    jobId: state.jobId,
    status: state.status,
    mode: state.mode,
    cursor: Number(state.cursor || 0),
    total: snap.length,
    processedRows: Number(state.processedRows || 0),
    queuedTasks: Number(state.queuedTasks || 0),
    notesUpdated: Number(state.notesUpdated || 0),
    unchangedRows: Number(state.unchangedRows || 0),
    errorCount: Number(state.errorCount || 0),
    elapsedMs: Number(state.elapsedMs || 0),
    startedAt: state.startedAt,
    lastRunAt: state.lastRunAt,
    cycleProcessedCount: Number(state.cycleProcessedCount || 0),
    cycleRemainingCandidates: Number(state.cycleRemainingCandidates || 0),
    cycleEligibleCount: Number(state.cycleEligibleCount || 0),
    invalidIdentityCount: Number(state.invalidIdentityCount || 0),
    nextBatchEnabled: !!state.nextBatchEnabled,
    errors: (state.errors || []).slice(0, 5)
  };
}

/** Cancel: set CANCELLED, clear triggers, keep already-written queue/log intact (AC10) */
function cancelNovelBuildQueueJob() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'ระบบล็อคอยู่' };
  try {
    novelClearBuildQueueTriggers_();
    var state = novelJobLoad_();
    if (!state) return { ok: true, status: 'IDLE', message: 'ไม่มีงานที่ต้องยกเลิก' };
    if (state.status === 'DONE' || state.status === 'FAILED') return { ok: true, status: state.status, message: 'งานสิ้นสุดแล้ว' };
    state.status = 'CANCELLED';
    state.triggerId = '';
    novelJobSave_(state);
    return { ok: true, status: 'CANCELLED', jobId: state.jobId, message: 'ยกเลิกงานแล้ว' };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Self-contained fallback flattener (raw tab objects, same contract as getAllTabsFlat_)
// used only when Checker_Main.txt's getAllTabsFlat_ isn't loaded in this runtime.
