function buildNovelQueue(options = {}) {
  const startedAt = Date.now();
  // Raw/internal callers keep the legacy preserve behavior unless they explicitly opt into the
  // CGS-013 active-only lifecycle. User-facing buildNovelQueueDefault() opts in.
  const clearQueue = options.clearQueue === true;
  const activeOnlyReset = options.activeOnlyReset === true;
  const main = getNovelMainSheet_();
  const meta = ensureNovelHelperSheets_();
  const queue = meta.queue;
  const log = meta.log;
  if (activeOnlyReset || clearQueue) {
    // CGS-013-C02: every destructive/new-build reset path must archive durably before queue
    // compaction. Legacy clearQueue callers now share the same no-loss lifecycle.
    prepareNovelQueueForNewBuild_({ meta: meta });
  }

  // Dedupe re-exports (AC12): taskId is content-derived, so an unchanged paragraph
  // re-exported later produces the same taskId and must not create a duplicate row.
  // existingQueueRows (U5-U8, round 5): snapshot of every row already durably in AI_QUEUE before
  // this run — used by processNovelQueueSourceRow_ to reconcile a currently-dirty paragraph back
  // to its existing task identity even after unrelated position drift (see that function).
  // X1/X2 (round 8/C09): AI_QUEUE is intentionally non-destructive history — a terminal APPLIED
  // row stays in the sheet forever. existingTaskIds (the dedupe-skip gate) is seeded ONLY from
  // ACTIVE rows, so a terminal row's taskId can never suppress a later RECURRENCE of the exact
  // same dirty content — that recurrence must mint its own distinct, auditable identity instead
  // (see the generation-bump logic in processNovelQueueSourceRow_).
  // round 11/C12: a SUPERSEDED row (supersededAt set — retired by a prior re-export, see C11) is
  // history too, exactly like a terminal APPLIED row: it must never be a reconciliation candidate
  // nor seed the active dedupe gate, or a dirty recurrence after supersession would be silently
  // swallowed with no active task created. Its taskId is still kept as an OCCUPIED historical
  // identity for fresh-task collision avoidance (supersededHistoryTaskIds in that function).
  const existingQueueRows = getNovelQueueObjects_();
  const existingLogRows = typeof getNovelLogObjects_ === 'function' ? getNovelLogObjects_() : [];
  const existingTaskIds = new Set(
    existingQueueRows.filter(function(r) {
      return String(r.applyStatus || '') !== 'APPLIED' && String(r.supersededAt || '') === '';
    }).map(function(r) { return String(r.taskId); })
  );

  const manualRows = Array.isArray(options.manualRows) && options.manualRows.length
    ? options.manualRows.slice().sort((a, b) => a - b)
    : null;

  const output = [];
  const errors = [];
  const stats = {
    queuedTasks: 0,
    sequenceDone: 0,
    notesUpdated: 0,
    unchangedRows: 0,
    problemRows: 0,
    noteResultRows: new Set()
  };
  const logRows = [];
  // round 10/C11: taskIds of existing NON-TERMINAL rows that this re-export scanned but could not
  // carry forward to any current paragraph (per-tab orphans, see processNovelQueueSourceRow_).
  // They are prior-generation history now; supersededAt is stamped on them below so Apply stops
  // treating a blank applyStatus as proof of currentness.
  const supersededTaskIds = new Set();
  const now = new Date();
  let processedRows = 0;

  if (manualRows) {
    // โหมดระบุแถวเอง: วนเฉพาะแถวที่ผู้ใช้ระบุ ไม่ไล่ทั้งชีต และไม่ใช้ noteKeywords
    // ผู้ใช้ตั้งใจเลือกแถวนี้เองแล้ว จึงไม่ข้าม "รอ N แท็บ" หรือ note ว่างโดยอัตโนมัติ
    const maxRows = Number(options.maxRows || manualRows.length);
    const lastRow = main.getLastRow();

    for (let idx = 0; idx < manualRows.length; idx++) {
      if (processedRows >= maxRows) break;

      const sourceRow = manualRows[idx];

      if (sourceRow < NOVEL_HELPER_CONFIG.FIRST_DATA_ROW || sourceRow > lastRow) {
        errors.push(`แถว ${sourceRow}: อยู่นอกขอบเขตข้อมูลของชีต (แถวข้อมูลเริ่มที่ ${NOVEL_HELPER_CONFIG.FIRST_DATA_ROW}, ล่าสุด ${lastRow})`);
        continue;
      }

      const docUrl = getNovelDocUrlFromRow_(main, sourceRow);
      const note = String(main.getRange(sourceRow, NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL).getValue() || '').trim();

      if (!docUrl) {
        errors.push(`แถว ${sourceRow}: ไม่พบ docUrl (คอลัมน์ ${NOVEL_HELPER_CONFIG.DOC_URL_COL})`);
        continue;
      }

      if (!note) {
        errors.push(`แถว ${sourceRow}: หมายเหตุ (คอลัมน์ L) ว่าง แต่ยังดำเนินการต่อเพราะเลือกแถวนี้เอง`);
      }

      processedRows++;
      processNovelQueueSourceRow_(main, log, sourceRow, docUrl, note, output, now, stats, logRows, existingTaskIds, existingQueueRows, supersededTaskIds, { historyLogRows: existingLogRows });
    }
  } else {
    // โหมดค้นจากคอลัมน์ L (flow เดิม): ไล่ทั้งชีตจาก FIRST_DATA_ROW ตาม maxRows
    // ถ้ามี noteKeywords ให้กรองเฉพาะแถวที่หมายเหตุตรงคีย์เวิร์ดอย่างน้อย 1 คำเพิ่มเติม
    const maxRows = Number(options.maxRows || NOVEL_HELPER_CONFIG.DEFAULT_MAX_ROWS);
    const noteKeywords = Array.isArray(options.noteKeywords)
      ? options.noteKeywords.map(k => String(k || '').trim()).filter(Boolean)
      : [];

    const lastRow = main.getLastRow();
    const lastCol = Math.max(main.getLastColumn(), NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL);
    if (lastRow >= NOVEL_HELPER_CONFIG.FIRST_DATA_ROW) {
      const rows = main
        .getRange(NOVEL_HELPER_CONFIG.FIRST_DATA_ROW, 1, lastRow - NOVEL_HELPER_CONFIG.FIRST_DATA_ROW + 1, lastCol)
        .getValues();
      const docUrls = getNovelDocUrlsBatch_(
        main,
        NOVEL_HELPER_CONFIG.FIRST_DATA_ROW,
        rows.length,
        rows
      );

      for (let i = 0; i < rows.length; i++) {
        if (processedRows >= maxRows) break;

        const sourceRow = NOVEL_HELPER_CONFIG.FIRST_DATA_ROW + i;
        const row = rows[i];
        const reviewed = row[NOVEL_HELPER_CONFIG.REVIEWED_COL - 1];
        const note = String(row[NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL - 1] || '').trim();

        // กรองด้วยข้อมูลที่อ่านมาแล้วก่อน ไม่เรียก Google Docs สำหรับแถวที่ไม่ใช่งาน
        if (!note) continue;
        if (reviewed === true || String(reviewed).toUpperCase() === 'TRUE') continue;
        if (/^(?:รอ\s+\d+\s+แท็บ|รอตรวจ\s+\d+\s+แท็บ(?:\s*:)?)/.test(note)) continue;

        if (noteKeywords.length) {
          const noteLower = note.toLowerCase();
          const matched = noteKeywords.some(kw => noteLower.indexOf(kw.toLowerCase()) !== -1);
          if (!matched) continue;
        }

        const docUrl = docUrls[i];
        if (!docUrl) continue;
        processedRows++;
        processNovelQueueSourceRow_(main, log, sourceRow, docUrl, note, output, now, stats, logRows, existingTaskIds, existingQueueRows, supersededTaskIds, { historyLogRows: existingLogRows });
      }
    }
  }

  if (output.length) {
    const outputRows = output.map(function(obj) { return novelObjectToRow_(meta.queueMap, meta.queueHeaders.length, obj); });
    queue.getRange(queue.getLastRow() + 1, 1, outputRows.length, meta.queueHeaders.length).setValues(outputRows);
  }
  if (logRows.length) {
    const logRowArrays = logRows.map(function(obj) { return novelObjectToRow_(meta.logMap, meta.logHeaders.length, obj); });
    log.getRange(log.getLastRow() + 1, 1, logRowArrays.length, meta.logHeaders.length).setValues(logRowArrays);
  }

  // round 10/C11: stamp supersededAt on every existing NON-TERMINAL row this re-export scanned but
  // could not carry forward. AI_QUEUE stays non-destructive — the row is kept exactly as-is, only
  // this one auditable timestamp cell is added — but Apply now has an explicit current-vs-superseded
  // signal and stops re-attempting (and re-erroring on) prior-generation history forever. Never
  // stamped for a terminal APPLIED row or one already carrying supersededAt.
  if (supersededTaskIds.size) {
    const supersededCol = meta.queueMap.supersededAt || 0;
    if (supersededCol > 0) {
      const rowByTaskId = new Map();
      existingQueueRows.forEach(function(r) { rowByTaskId.set(String(r.taskId), r); });
      supersededTaskIds.forEach(function(taskId) {
        const r = rowByTaskId.get(String(taskId));
        if (r && r._sheetRow &&
            String(r.applyStatus || '') !== 'APPLIED' &&
            String(r.supersededAt || '') === '') {
          queue.getRange(r._sheetRow, supersededCol).setValue(now);
        }
      });
    }
  }

  SpreadsheetApp.flush();
  const revisionResult = stats.notesUpdated > 0
    ? touchCheckerDataRevision_()
    : getCheckerDataRevision_();
  const revisionWarning = stats.notesUpdated > 0 && !revisionResult.revisionAvailable
    ? 'Build Queue และอัปเดตคอลัมน์ L สำเร็จแล้ว แต่ระบบแจ้งหน้า Checker ให้อัปเดตอัตโนมัติไม่สำเร็จ หากยังเห็นข้อมูลเดิมให้กดรีเฟรชหนึ่งครั้ง'
    : '';

  let message;
  if (manualRows) {
    message = `สร้างคิวจากแถวที่ระบุ ${manualRows.length} แถว / ประมวลผล ${processedRows} แถว / queuedTasks ${stats.queuedTasks} งาน`;
  } else if (options.noteKeywords && options.noteKeywords.length) {
    message = `สร้างคิวจากคีย์เวิร์ด ${processedRows} แถว / queuedTasks ${stats.queuedTasks} งาน`;
  } else {
    message = `สร้างคิว ${stats.queuedTasks} งาน / ประมวลผล ${processedRows} แถว / อัปเดตเลขบทเรียงต่อเนื่อง ${stats.sequenceDone} แถว`;
  }
  message += ` / อัปเดตหมายเหตุ ${stats.notesUpdated} แถว / ค่าเดิมอยู่แล้ว ${stats.unchangedRows} แถว`;

  if (errors.length) {
    message += ' | ปัญหา: ' + errors.slice(0, 10).join(' | ');
  }
  const elapsedMs = Date.now() - startedAt;
  message += ` | ใช้เวลา ${(elapsedMs / 1000).toFixed(1)} วินาที`;
  if (revisionWarning) message += '\nคำเตือน: ' + revisionWarning;

  return {
    ok: true,
    processedRows,
    tasks: stats.queuedTasks,
    queuedTasks: stats.queuedTasks,
    sequenceDone: stats.sequenceDone,
    notesUpdated: stats.notesUpdated,
    unchangedRows: stats.unchangedRows,
    problemRows: stats.problemRows,
    errorCount: errors.length,
    elapsedMs,
    errors,
    revisionAvailable: revisionResult.revisionAvailable,
    revision: revisionResult.revision,
    revisionWarning,
    message
  };
}

// ย่อหน้านี้มีประโยคภาษาอังกฤษยาวที่ Gemini แปลไม่หมดหรือไม่
// ใช้ detector ตัวเดียวกับ Checker (checkerHasLongEnglishSentence_) เพื่อให้เกณฑ์ตรงกัน
// ถ้าไฟล์ Checker ไม่ได้อยู่ในโปรเจกต์เดียวกัน จะถือว่าไม่พบ แทนการทำให้ Build Queue ล้ม
function processNovelQueueSourceRow_(main, log, sourceRow, docUrl, note, output, now, stats, logRows, existingTaskIds, existingQueueRows, supersededTaskIds, workerOptions) {
  logRows = logRows || [];
  existingTaskIds = existingTaskIds || new Set();
  existingQueueRows = existingQueueRows || [];
  workerOptions = workerOptions || {};
  // round 10/C11: caller-owned Set collecting the taskIds of existing NON-TERMINAL rows this
  // re-export scanned but could not carry forward to any current paragraph (per-tab orphans, see
  // below). buildNovelQueue stamps supersededAt on them after this function returns.
  supersededTaskIds = supersededTaskIds || new Set();
  // Defensive: every ACTIVE existing row's taskId must count as "already in the queue" for the
  // final dedupe gate, regardless of whether the caller remembered to seed existingTaskIds from
  // it. X1/X2 (round 8/C09): a TERMINAL (APPLIED) row's taskId is deliberately excluded here — it
  // must never suppress a later recurrence of the exact same dirty content. round 11/C12: a
  // SUPERSEDED row is excluded for the same reason.
  existingQueueRows.forEach(function(r) {
    if (String(r.applyStatus || '') !== 'APPLIED' && String(r.supersededAt || '') === '') {
      existingTaskIds.add(String(r.taskId));
    }
  });
  // CGS-012: historical identity can now come from durable AI_LOG. Keep the queue-based history
  // compatibility fallback until the later active-only queue phase removes terminal/superseded rows.
  // Sets are assigned after opening the document so the history lookup is scoped to this document.
  let terminalTaskIds = new Set();
  let supersededHistoryTaskIds = new Set();
  let documentId = '';
  try {
    const doc = DocumentApp.openByUrl(docUrl);
    documentId = doc.getId();
    const historyIndex = typeof novelBuildHistoryIndex_ === 'function'
      ? novelBuildHistoryIndex_(workerOptions.historyLogRows || [], existingQueueRows, documentId)
      : {
          terminalTaskIds: new Set(existingQueueRows.filter(function(r) {
            return String(r.applyStatus || '') === 'APPLIED';
          }).map(function(r) { return String(r.taskId); })),
          supersededTaskIds: new Set(existingQueueRows.filter(function(r) {
            return String(r.supersededAt || '') !== '';
          }).map(function(r) { return String(r.taskId); }))
        };
    terminalTaskIds = historyIndex.terminalTaskIds;
    supersededHistoryTaskIds = historyIndex.supersededTaskIds;
    const tabs = getNovelDocumentTabs_(doc);
    const tabCount = tabs.length;

    // Root-cause fix (F3/R1/R2, T1/T2 round 4): tabNo AND the note's wording are both metadata
    // only, never authoritative — this includes legacy "รอ N แท็บ" waiting notes and continuous-
    // chapter-number notes. A row that reaches this function was explicitly selected for (re-)
    // export (manualRows, or any row the default scan chose to process), so the live Doc must
    // always be scanned FIRST, before any note-wording shortcut is even considered. Only when the
    // live scan finds nothing currently dirty is the note-based shortcut (continuous-note /
    // waiting-note passthrough) safe to take; if the live scan finds real current problems, this
    // row must be queued normally regardless of what the note happens to say.
    const liveTabs = novelLiveScanDirtyTabs_(doc, tabs);

    const isContinuousNote = noteIsOnlyContinuous_(note);
    const isWaitingNote = /^(?:รอ\s+\d+\s+แท็บ|รอตรวจ\s+\d+\s+แท็บ(?:\s*:)?)/.test(note);
    if ((isContinuousNote || isWaitingNote) && !liveTabs.length) {
      const doneText = composeWaitingTabsNote_(tabCount, note);
      setNovelProgramNoteIfChanged_(main, sourceRow, doneText, stats);
      logRows.push({
        time: now, sourceSheetName: main.getName(), sourceRowAtExport: sourceRow, sourceRowAtApply: '',
        docUrl: docUrl, documentId: documentId, tabId: '', tabNoAtExport: '', tabNoAtApply: '', tabTitle: '',
        paragraphIndex: '', taskId: '', paragraphFingerprint: '', oldText: note, newText: doneText,
        actor: 'Apps Script', status: 'DONE', message: 'เลขบทเรียงต่อเนื่อง'
      });
      if (isContinuousNote) stats.sequenceDone++;
      return;
    }

    const tabParse = parseNovelTargetTabsDetailed_(note, tabCount);
    let targetTabs = tabParse.tabs;

    if (liveTabs.length) {
      targetTabs = Array.from(new Set(targetTabs.concat(liveTabs))).sort(function(a, b) { return a - b; });
    }

    if (!targetTabs.length) {
      let msg;
      if (tabParse.outOfRange.length) {
        msg = 'ต้องตรวจเอง: เลขแท็บ ' + tabParse.outOfRange.join(', ') +
          ' เกินจำนวนแท็บในเอกสาร (เอกสารมี ' + tabCount + ' แท็บ)';
      } else {
        msg = 'ต้องตรวจเอง: หมายเหตุไม่ได้ระบุเลขแท็บ ' +
          '(กรุณาใช้รูปแบบ “แท็บ 2”, “แท็บ 2-4” หรือ “พบแท็บมีคำต่างประเทศ: 2, 3”)';
      }
      const keepMarkers = extractCheckerProblemMarkers_(note);
      if (keepMarkers.length) msg += ' | ' + keepMarkers.join(' | ');
      msg = addCheckerFreeMarker_(msg, hasCheckerFreeMarker_(note));
      setNovelProgramNoteIfChanged_(main, sourceRow, msg, stats);
      logRows.push({
        time: now, sourceSheetName: main.getName(), sourceRowAtExport: sourceRow, sourceRowAtApply: '',
        docUrl: docUrl, documentId: documentId, tabId: '', tabNoAtExport: '', tabNoAtApply: '', tabTitle: '',
        paragraphIndex: '', taskId: '', paragraphFingerprint: '', oldText: note, newText: msg,
        actor: 'Apps Script', status: 'NEEDS_REVIEW',
        message: tabParse.outOfRange.length ? 'tab numbers out of range' : 'no tab numbers in note'
      });
      stats.problemRows++;
      return;
    }

    let rowTaskCount = 0;
    // T5 (round 4): a marker-only paragraph (literal review marker, but no highlight/foreign/
    // long-English content of its own) is real, still-pending work — Admin hasn't resolved it
    // yet — but there's nothing an AI task can translate there, so it never becomes a queue entry.
    // Track whether we saw one so a zero-task row can be told apart from a genuinely empty one.
    let sawMarkerOnlyParagraph = false;
    for (const tabNo of targetTabs) {
      const tabInfo = tabs[tabNo - 1];
      if (!tabInfo) continue;

      const body = getNovelBodyFromTab_(doc, tabInfo);
      const paragraphs = body.getParagraphs();
      // Rank of this paragraph among identical-text dirty paragraphs seen so far in THIS tab,
      // counted fresh in document order on every scan. Reset per tab. Kept as informational
      // queue metadata only (occurrenceIndex) — NOT used for taskId identity (see T3/T4 above).
      const occurrenceCounts = new Map();
      // S1/S3 (fix round 3): total number of dirty paragraphs sharing that exact fingerprint in
      // this tab. Apply uses this to know whether a task's content was ever ambiguous (had
      // siblings) — if so, Apply must resolve ONLY via the exact recorded paragraph position,
      // never by guessing among current fingerprint matches. Filled in after this tab's loop
      // finishes, once the final per-fingerprint counts are known.
      const tabOutputEntries = [];

      // W1-W8 (round 7/C08): the full in-order fingerprint sequence of every paragraph currently
      // in this tab — the structural anchor stored per task and later checked by
      // novelDuplicateTabStructureStable_ at re-export/Apply time.
      const tabFingerprintSequence = paragraphs.map(function(para) {
        return novelComputeParagraphFingerprint_(documentId, tabInfo.tabId, para.getText());
      }).join('|');

      // U5-U8 (round 5): reconcile this tab's EXISTING queue rows against the CURRENT paragraphs
      // BEFORE minting any taskId, so an unchanged physical paragraph keeps its existing task
      // identity even when an unrelated paragraph is inserted/removed elsewhere in the tab (which
      // used to shift its raw physical index and mint a brand-new, silently-duplicate task — the
      // exact round-5 finding). Mirrors novelResolveTargetParagraph_'s Apply-time logic: position
      // anchor first, content-only fallback only for paragraphs proven unique at their own export
      // time, and never silently claim an ambiguous match — an unclaimed existing row just stays
      // an orphaned (already-applied, or now-unresolvable) row in the sheet; the still-dirty
      // paragraph it can't be safely matched to instead mints its own new task below (a conflict-
      // path duplicate is safe; a silent wrong-identity merge is not). X1/X2 (round 8/C09): a
      // TERMINAL (APPLIED) row is never a reconciliation candidate — reconciling back to a closed
      // identity would just get silently skipped by the dedupe gate below, hiding a genuine
      // recurrence of the same dirty content behind an already-resolved taskId. round 11/C12: a
      // SUPERSEDED row (supersededAt set) is likewise never a reconciliation candidate — it is
      // retired history, and reconciling a current dirty paragraph back onto it would resurrect a
      // row Apply and the final blocker deliberately ignore (C11), leaving the current problem with
      // no active task.
      const tabExistingRows = existingQueueRows.filter(function(r) {
        return String(r.documentId) === String(documentId) && String(r.tabId) === String(tabInfo.tabId) &&
          String(r.applyStatus || '') !== 'APPLIED' && String(r.supersededAt || '') === '';
      });
      function isParagraphDirtyNow_(paragraph, text) {
        return !!(getNovelHighlightedText_(paragraph) || novelDetectForeignWords_(text) || novelParagraphHasLongEnglish_(text));
      }
      const reconciledTaskIdByIndex = new Map();
      tabExistingRows.forEach(function(existingRow) {
        const existingIdx = Number(existingRow.paragraphIndex) - 1;
        // V6 (round 6/C07): a missing/invalid occurrenceCount is UNKNOWN, never coerced to 1
        // (assumed unique) — see novelResolveTargetParagraph_'s matching hasKnownCount/knownUnique/
        // knownMultiple trio, kept identical here on purpose so export reconciliation and Apply
        // agree on what "provably unique" vs "confirmed duplicate" vs "unknown legacy" means.
        const rawCount = Number(existingRow.occurrenceCount);
        const hasKnownCount = Number.isFinite(rawCount) && rawCount >= 1;
        const knownMultiple = hasKnownCount && rawCount > 1;
        const knownUnique = hasKnownCount && rawCount === 1;

        if (paragraphs[existingIdx] && !reconciledTaskIdByIndex.has(existingIdx)) {
          const idxText = paragraphs[existingIdx].getText();
          const fpAtIdx = novelComputeParagraphFingerprint_(documentId, tabInfo.tabId, idxText);
          if (fpAtIdx === existingRow.paragraphFingerprint) {
            if (knownMultiple) {
              // W1-W8 (round 7/C08): a CONFIRMED duplicate's raw position anchor is only
              // trustworthy when the FULL recorded fingerprint sequence proves every position
              // OUTSIDE this task's own duplicate group still holds the exact content it did at
              // export time (novelDuplicateTabStructureStable_) — a same-count REORDER elsewhere
              // in the tab (e.g. a non-duplicate paragraph moved from after the group to before
              // it) is not caught by a raw paragraph-count check alone. An in-place edit to a
              // GROUP member (e.g. a sibling being fixed) is deliberately exempt from this check.
              // Structural drift for a confirmed duplicate must leave it unclaimed (block), never
              // guess.
              if (novelDuplicateTabStructureStable_(documentId, tabInfo.tabId, existingRow.paragraphFingerprint, paragraphs, existingRow.tabFingerprintSequenceAtExport)) {
                reconciledTaskIdByIndex.set(existingIdx, existingRow.taskId);
              }
              return;
            }
            // unique-at-export-time (or unknown-count) path: verify no OTHER currently-dirty
            // paragraph now coincidentally shares this fingerprint before trusting the position
            // match — an unknown legacy count gets the SAME scrutiny as a proven-unique one here
            // (never the relaxed knownMultiple shortcut above).
            let extraMatchFound = false;
            for (let q = 0; q < paragraphs.length; q++) {
              if (q === existingIdx) continue;
              const qText = paragraphs[q].getText();
              if (!qText || !qText.trim() || !isParagraphDirtyNow_(paragraphs[q], qText)) continue;
              if (novelComputeParagraphFingerprint_(documentId, tabInfo.tabId, qText) === existingRow.paragraphFingerprint) {
                extraMatchFound = true;
                break;
              }
            }
            if (!extraMatchFound) reconciledTaskIdByIndex.set(existingIdx, existingRow.taskId);
            return; // position slot existed but content differs, or a new ambiguity appeared — never fall back to content search here
          }
        }

        // V6: only a CONFIRMED-unique row (occurrenceCount === 1, not missing/unknown) may fall
        // back to a content-only search — a confirmed duplicate OR an unknown legacy count can
        // never safely disambiguate via content alone.
        if (!knownUnique) return;

        let match = -1;
        let matchCount = 0;
        for (let q = 0; q < paragraphs.length; q++) {
          if (reconciledTaskIdByIndex.has(q)) continue;
          const qText = paragraphs[q].getText();
          if (!qText || !qText.trim() || !isParagraphDirtyNow_(paragraphs[q], qText)) continue;
          if (novelComputeParagraphFingerprint_(documentId, tabInfo.tabId, qText) === existingRow.paragraphFingerprint) {
            matchCount++;
            match = q;
          }
        }
        if (matchCount === 1) reconciledTaskIdByIndex.set(match, existingRow.taskId);
      });

      // Y4/Y5 (round 9/C10): taskIds of this tab's NON-TERMINAL existing rows that reconciliation
      // just tried but could NOT safely claim (left unclaimed — ambiguous, moved, or otherwise
      // unresolvable, per U8/round 5). These are genuinely orphaned: still occupying an identity
      // slot in existingTaskIds, but not representing any specific current paragraph anymore. A
      // freshly-minted identity must never coincidentally collide with one of these — that would
      // silently swallow a real current dirty paragraph via the dedupe gate below, with nothing
      // ever created to represent it (the round-9 finding). This is deliberately NARROWER than all
      // of existingTaskIds: an existing row's own taskId recomputing identically for its own
      // still-unchanged position is the routine, correct dedupe case and must never be treated as
      // a collision requiring a new generation.
      const claimedTaskIdSet = new Set(Array.from(reconciledTaskIdByIndex.values()));
      const orphanTaskIds = new Set(
        tabExistingRows.filter(function(r) { return !claimedTaskIdSet.has(r.taskId); })
          .map(function(r) { return String(r.taskId); })
      );

      // round 10/C11: an orphan is, by construction, a NON-TERMINAL existing row this re-export
      // scanned this tab for and could NOT safely reconcile to any current paragraph — Apply's own
      // novelResolveTargetParagraph_ would independently fail (or block) on the exact same anchor.
      // It is prior-generation history now: any still-live dirty paragraph it might have represented
      // mints its own fresh task below. Record it so buildNovelQueue stamps supersededAt, which is
      // what finally lets Apply stop re-attempting (and re-erroring / re-logging) it every run.
      orphanTaskIds.forEach(function(taskId) { supersededTaskIds.add(String(taskId)); });

      for (let p = 0; p < paragraphs.length; p++) {
        const para = paragraphs[p];
        const text = para.getText();
        if (!text || !text.trim()) continue;

        const highlightedText = getNovelHighlightedText_(para);
        const hasForeign = novelDetectForeignWords_(text);
        // V11.12: ประโยคภาษาอังกฤษยาวที่ Gemini แปลไม่หมด ก็ต้องเข้าคิวเช่นกัน
        const hasLongEnglish = novelParagraphHasLongEnglish_(text);
        if (!highlightedText && !hasForeign && !hasLongEnglish) {
          if (novelParagraphHasMarkerText_(text)) sawMarkerOnlyParagraph = true;
          continue;
        }

        rowTaskCount++;

        const occurrenceIndex = occurrenceCounts.get(text) || 0;
        occurrenceCounts.set(text, occurrenceIndex + 1);

        const paragraphFingerprint = novelComputeParagraphFingerprint_(documentId, tabInfo.tabId, text);
        // T3/T4 (round 4) + U5-U8 (round 5): prefer a reconciled EXISTING identity (stable across
        // unrelated position drift); only mint a brand-new position-derived taskId when no
        // existing row could be safely matched to this specific physical paragraph.
        // Y4/Y5 (round 9/C10): when reconciliation deliberately leaves a paragraph unclaimed
        // because of a new ambiguity (U8, round 5), this CURRENT dirty paragraph still needs its
        // OWN task — the freshly-minted identity must never collide with ANY occupied taskId,
        // terminal OR non-terminal-orphan, or it gets silently swallowed by the dedupe gate below
        // and the real current problem never gets queued at all (the round-9 finding: checking
        // only terminalTaskIds missed collisions with an unclaimed but still-occupied orphan).
        const reconciledTaskId = reconciledTaskIdByIndex.get(p);
        let taskId;
        if (reconciledTaskId) {
          taskId = reconciledTaskId;
        } else {
          // X1/X2 (round 8/C09) + Y4/Y5 (round 9/C10) + round 11/C12: bump a generation suffix
          // until the candidate collides with NONE of the occupied historical identities — a
          // closed terminal identity (a genuine recurrence, round 8), a currently-occupied
          // non-terminal orphan identity (round 9), or a superseded retired identity (C12) — a
          // still-deterministic identity distinct from every occupied generation that came before.
          if (typeof novelNextAvailableTaskIdFromHistory_ === 'function') {
            taskId = novelNextAvailableTaskIdFromHistory_(
              documentId, tabInfo.tabId, paragraphFingerprint, p,
              terminalTaskIds, orphanTaskIds, supersededHistoryTaskIds
            );
          } else {
            let generation = 0;
            taskId = novelComputeTaskId_(documentId, tabInfo.tabId, paragraphFingerprint, p);
            while (terminalTaskIds.has(taskId) || orphanTaskIds.has(taskId) || supersededHistoryTaskIds.has(taskId)) {
              generation++;
              taskId = novelComputeTaskId_(documentId, tabInfo.tabId, paragraphFingerprint, p + ':gen' + generation);
            }
          }
        }
        // AC12/R4: unchanged paragraph -> same taskId already in queue -> skip duplicate
        if (existingTaskIds.has(taskId)) continue;
        existingTaskIds.add(taskId);

        const entry = {
          taskId: taskId, createdAt: now, sourceSheetName: main.getName(), sourceRow: sourceRow,
          documentId: documentId, docUrl: docUrl, originalNote: note, targetTabCount: targetTabs.length,
          tabId: tabInfo.tabId, tabNo: tabNo, tabTitle: tabInfo.title, paragraphIndex: p + 1,
          paragraphFingerprint: paragraphFingerprint, occurrenceIndex: occurrenceIndex, occurrenceCount: 0,
          // Legacy/informational (round 6/C07) — superseded by tabFingerprintSequenceAtExport
          // (round 7/C08) as the actual structural anchor, kept only so older rows already
          // carrying this field remain harmlessly readable; its .length is implied by the sequence.
          tabParagraphCountAtExport: paragraphs.length,
          // W1-W8 (round 7/C08): the real structural anchor — see novelDuplicateTabStructureStable_.
          tabFingerprintSequenceAtExport: tabFingerprintSequence,
          highlightedText: highlightedText, paragraphText: text,
          claudeStatus: 'PENDING', finalParagraph: '', applyStatus: '', appliedAt: '', message: ''
        };
        output.push(entry);
        tabOutputEntries.push(entry);
        stats.queuedTasks++;
      }

      // Backfill occurrenceCount now that this tab's final per-text counts are known.
      tabOutputEntries.forEach(function(entry) {
        entry.occurrenceCount = occurrenceCounts.get(entry.paragraphText) || 1;
      });
    }

    if (rowTaskCount === 0 && sawMarkerOnlyParagraph) {
      // T5/U1-U4 (round 4/5): real pending work exists (the review marker), just nothing an AI
      // task can act on yet. This is the SAME "still needs Admin review" state a completed row
      // with leftover foreign content would be in, so it must use the exact same status text —
      // "เสร็จ N แท็บ รอแอดแพรวตรวจ" — via composeNovelCompletionNote_, which also preserves ฟรี /
      // บทที่หาย and still lets เลขบทซ้ำ/เนื้อหาซ้ำ block completion entirely. The audit log status
      // must NOT be DONE — Admin's review is explicitly still pending.
      const pendingText = composeNovelCompletionNote_(tabCount, note, true);
      setNovelProgramNoteIfChanged_(main, sourceRow, pendingText, stats);
      logRows.push({
        time: now, sourceSheetName: main.getName(), sourceRowAtExport: sourceRow, sourceRowAtApply: '',
        docUrl: docUrl, documentId: documentId, tabId: '', tabNoAtExport: targetTabs.join(','), tabNoAtApply: '',
        tabTitle: '', paragraphIndex: '', taskId: '', paragraphFingerprint: '', oldText: note, newText: pendingText,
        actor: 'Apps Script', status: 'PENDING_REVIEW', message: 'marker-only, no queueable AI paragraph'
      });
      return;
    }

    if (rowTaskCount === 0) {
      let msg = 'ต้องตรวจเอง: ไม่พบไฮไลต์ คำต่างประเทศ หรือประโยคภาษาอังกฤษยาวในแท็บที่ระบุ';
      const keepMarkers = extractCheckerProblemMarkers_(note);
      if (keepMarkers.length) msg += ' | ' + keepMarkers.join(' | ');
      msg = addCheckerFreeMarker_(msg, hasCheckerFreeMarker_(note));
      setNovelProgramNoteIfChanged_(main, sourceRow, msg, stats);
      logRows.push({
        time: now, sourceSheetName: main.getName(), sourceRowAtExport: sourceRow, sourceRowAtApply: '',
        docUrl: docUrl, documentId: documentId, tabId: '', tabNoAtExport: targetTabs.join(','), tabNoAtApply: '',
        tabTitle: '', paragraphIndex: '', taskId: '', paragraphFingerprint: '', oldText: note, newText: msg,
        actor: 'Apps Script', status: 'NEEDS_REVIEW', message: 'no suspicious paragraph found'
      });
      stats.problemRows++;
    }
  } catch (err) {
    if (workerOptions.rethrowTransient === true && novelBuildQueueIsTransientError_(err)) throw err;
    let msg = `ต้องตรวจเอง: ${err.message}`;
    const keepMarkers = extractCheckerProblemMarkers_(note);
    if (keepMarkers.length) msg += ' | ' + keepMarkers.join(' | ');
    msg = addCheckerFreeMarker_(msg, hasCheckerFreeMarker_(note));
    setNovelProgramNoteIfChanged_(main, sourceRow, msg, stats);
    logRows.push({
      time: now, sourceSheetName: main.getName(), sourceRowAtExport: sourceRow, sourceRowAtApply: '',
      docUrl: docUrl, documentId: documentId, tabId: '', tabNoAtExport: '', tabNoAtApply: '', tabTitle: '',
      paragraphIndex: '', taskId: '', paragraphFingerprint: '', oldText: note, newText: msg,
      actor: 'Apps Script', status: 'ERROR', message: err.stack || err.message
    });
    stats.problemRows++;
  }
}

// แปลงข้อความเลขแถวที่ผู้ใช้พิมพ์เอง เช่น "1296,1300-1302" -> [1296,1300,1301,1302]
// - ตัดเลขซ้ำ, sort จากน้อยไปมาก
// - ข้ามเลขที่น้อยกว่า FIRST_DATA_ROW แบบเงียบ ๆ (ไม่ throw)
// - ถ้า format ผิด (ไม่ใช่เลขเดี่ยวหรือช่วง เช่น "abc" หรือ "1-2-3") จะ throw error ชัดเจน
function parseNovelHelperManualRows_(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('กรุณาระบุเลขแถว เช่น 1296 หรือ 1296,1300-1304');
  }

  const tokens = raw.split(/[,\n]+/).map(t => t.trim()).filter(Boolean);
  if (!tokens.length) {
    throw new Error('กรุณาระบุเลขแถว เช่น 1296 หรือ 1296,1300-1304');
  }

  const rowsSet = new Set();

  tokens.forEach(token => {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
        throw new Error(`รูปแบบเลขแถวไม่ถูกต้อง: "${token}"`);
      }
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      for (let n = start; n <= end; n++) rowsSet.add(n);
      return;
    }

    const singleMatch = token.match(/^(\d+)$/);
    if (singleMatch) {
      const n = Number(singleMatch[1]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`รูปแบบเลขแถวไม่ถูกต้อง: "${token}"`);
      }
      rowsSet.add(n);
      return;
    }

    throw new Error(`รูปแบบเลขแถวไม่ถูกต้อง: "${token}" ใช้เช่น 1296 หรือ 1296-1309`);
  });

  const rows = Array.from(rowsSet)
    .filter(n => n >= NOVEL_HELPER_CONFIG.FIRST_DATA_ROW)
    .sort((a, b) => a - b);

  if (!rows.length) {
    throw new Error(`ไม่มีเลขแถวที่ใช้ได้ (ต้อง >= ${NOVEL_HELPER_CONFIG.FIRST_DATA_ROW})`);
  }

  return rows;
}

// จุดเข้าจาก Sidebar: CGS-005 resumable job path
