function applyNovelReadyEdits() {
  const ss = SpreadsheetApp.getActive();
  const meta = ensureNovelHelperSheets_();
  const data = getNovelQueueObjects_();
  // round 10/C11: a READY row is a candidate only when it is BOTH not terminal (applyStatus !==
  // APPLIED) AND not superseded history — a re-export that could not carry this row forward stamps
  // supersededAt, and such a row must never be selected for an Apply attempt again (Z1/Z6). A blank
  // applyStatus on its own is NOT proof the row is still the current generation.
  const ready = data.filter(r =>
    String(r.claudeStatus || '') === 'READY' &&
    String(r.applyStatus || '') !== 'APPLIED' &&
    String(r.supersededAt || '') === ''
  );

  if (!ready.length) {
    const noReadyRevision = getCheckerDataRevision_();
    return {
      ok: true,
      applied: 0,
      errors: 0,
      notesUpdated: 0,
      blockedRows: 0,
      unchangedRows: 0,
      updatedSourceRows: [],
      blockedSourceRows: [],
      revisionAvailable: noReadyRevision.revisionAvailable,
      revision: noReadyRevision.revision,
      revisionWarning: '',
      message: 'ไม่มีงาน READY ให้ apply'
    };
  }

  const now = new Date();
  let applied = 0;
  let errors = 0;
  let notesUpdated = 0;
  let blockedRows = 0;
  let unchangedRows = 0;
  const updatedSourceRows = [];
  const blockedSourceRows = [];

  // Group by document identity (documentId, fallback docUrl for legacy rows) instead of
  // sourceSheetName+sourceRow: the sheet may have been sorted between export and apply (AC1).
  const groups = new Map();
  ready.forEach(function(task) {
    const gid = task.documentId || task.docUrl;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(task);
  });

  const sheetRowIndexCache = new Map();
  function getRowIndexForSheet_(sheetName) {
    if (sheetRowIndexCache.has(sheetName)) return sheetRowIndexCache.get(sheetName);
    const sheet = ss.getSheetByName(sheetName);
    const byDocumentId = new Map();
    const byDocUrl = new Map();
    if (sheet) {
      const lastRow = sheet.getLastRow();
      const startRow = NOVEL_HELPER_CONFIG.FIRST_DATA_ROW;
      if (lastRow >= startRow) {
        const rowCount = lastRow - startRow + 1;
        const urls = getNovelDocUrlsBatch_(sheet, startRow, rowCount, null);
        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          if (!url) continue;
          const rowNo = startRow + i;
          if (!byDocUrl.has(url)) byDocUrl.set(url, rowNo);
          const docId = extractGoogleFileId_(url);
          if (docId && !byDocumentId.has(docId)) byDocumentId.set(docId, rowNo);
        }
      }
    }
    const idxInfo = { sheet: sheet, byDocumentId: byDocumentId, byDocUrl: byDocUrl };
    sheetRowIndexCache.set(sheetName, idxInfo);
    return idxInfo;
  }

  // Resolve the CURRENT source row fresh by document identity (never trust task.sourceRow — AC1).
  function resolveCurrentRow_(sheetName, documentId, docUrl) {
    const idxInfo = getRowIndexForSheet_(sheetName);
    if (!idxInfo.sheet) return null;
    if (documentId && idxInfo.byDocumentId.has(documentId)) return idxInfo.byDocumentId.get(documentId);
    const fallbackDocId = !documentId && docUrl ? extractGoogleFileId_(docUrl) : null;
    if (fallbackDocId && idxInfo.byDocumentId.has(fallbackDocId)) return idxInfo.byDocumentId.get(fallbackDocId);
    if (docUrl && idxInfo.byDocUrl.has(docUrl)) return idxInfo.byDocUrl.get(docUrl);
    return null;
  }

  const rowApplySummary = new Map(); // gid -> { sheetName, resolvedRow, sourceRowFallback, originalNote, doc }

  groups.forEach(function(tasks, gid) {
    const firstTask = tasks[0];
    const sheetName = firstTask.sourceSheetName;
    let doc = null;
    let documentId = firstTask.documentId || '';
    let openError = null;

    try {
      doc = documentId ? DocumentApp.openById(documentId) : DocumentApp.openByUrl(firstTask.docUrl);
      if (!documentId && doc && typeof doc.getId === 'function') {
        try { documentId = doc.getId(); } catch (eid) {}
      }
    } catch (err) {
      openError = err;
    }

    if (openError) {
      // เปิดเอกสารไม่สำเร็จ: ไม่แตะเอกสาร ไม่แตะคอลัมน์ L ของแถวไหนเลย (no mutation attempted)
      const msg = 'เปิดเอกสารไม่สำเร็จ: ' + openError.message;
      tasks.forEach(function(task) {
        errors++;
        updateNovelQueueTask_(task.taskId, { applyStatus: 'ERROR', message: msg });
        appendNovelLog_(meta, {
          time: now, sourceSheetName: task.sourceSheetName, sourceRowAtExport: task.sourceRow, sourceRowAtApply: '',
          docUrl: task.docUrl, documentId: task.documentId || '', tabId: task.tabId || '', tabNoAtExport: task.tabNo,
          tabNoAtApply: '', tabTitle: task.tabTitle, paragraphIndex: task.paragraphIndex, taskId: task.taskId,
          paragraphFingerprint: task.paragraphFingerprint || '', oldText: '', newText: '', actor: 'Apps Script',
          status: 'ERROR', message: msg
        });
      });
      blockedRows++;
      blockedSourceRows.push({
        sourceSheetName: sheetName,
        sourceRow: Number(firstTask.sourceRow),
        reason: msg
      });
      return;
    }

    const tabs = getNovelDocumentTabs_(doc);
    const currentRow = resolveCurrentRow_(sheetName, documentId, firstTask.docUrl);

    rowApplySummary.set(gid, {
      sheetName: sheetName,
      resolvedRow: currentRow,
      sourceRowFallback: Number(firstTask.sourceRow),
      originalNote: firstTask.originalNote || '',
      reviewTabs: tasks.map(function(task) { return task.tabNo; }),
      buildJobIds: Array.from(new Set(tasks.map(function(task) { return String(task.buildJobId || '').trim(); }).filter(Boolean))),
      doc: doc,
      tabs: tabs
    });

    // Apply selection has two shapes here (Y1-Y3 round 9/C10, tightened round 10/C11):
    //
    //  - A FRESH READY task (applyStatus blank, never yet attempted) that reached this point has
    //    already been proven current: superseded history was filtered out of `ready` above. It is
    //    always attempted regardless of whether its anchor still resolves — that first attempt is
    //    exactly what surfaces the legitimate, informative ERROR (e.g. "ไม่พบแท็บ" on a deleted tab,
    //    or a real stale-conflict) that a human needs to see (Z2).
    //
    //  - A RETRY (a READY row still carrying a leftover applyStatus === 'ERROR') is re-attempted
    //    ONLY when its recorded anchor still resolves to a paragraph that is CURRENTLY DIRTY by the
    //    same export-time semantics (novelQueueRowStillLive_ / novelParagraphIsDirty_). If the anchor
    //    no longer identifies any paragraph (Y1/C10), OR it still resolves but the paragraph is no
    //    longer dirty — its highlight/marker was cleared, or it was otherwise fixed, with the text
    //    unchanged (round 10/C11) — the retry is orphaned history: it must not be re-attempted, must
    //    not increment errors again, must not overwrite the document, and must not emit a fresh Apply
    //    log entry (Z3/Z4). "Unknown" (a legacy row with no anchor data at all) stays conservative
    //    and is still attempted, exactly as before. Unchanged real foreign / long-English work still
    //    counts as dirty, so a genuine retry against untouched content remains retryable (Z3).
    const liveTasks = tasks.filter(function(task) {
      if (String(task.applyStatus || '') !== 'ERROR') return true; // fresh current READY — always gets its first attempt
      return novelQueueRowStillLive_(task, doc, tabs);
    });

    liveTasks.forEach(function(task) {
      try {
        if (currentRow === null) {
          throw new Error('ไม่พบแถวต้นทางปัจจุบันที่ลิงก์ไปยังเอกสารนี้ (documentId เปลี่ยนหรือถูกลบ)');
        }

        const tabInfo = resolveNovelTabById_(tabs, task.tabId, task.tabNo);
        if (!tabInfo) throw new Error('ไม่พบแท็บ (tabId เปลี่ยนหรือถูกลบ)');

        const body = getNovelBodyFromTab_(doc, tabInfo);
        const paragraphs = body.getParagraphs();

        let target;
        if (task.paragraphFingerprint) {
          target = novelResolveTargetParagraph_(paragraphs, documentId, tabInfo.tabId, task.paragraphIndex, task.paragraphFingerprint, task.occurrenceCount, task.tabFingerprintSequenceAtExport);
          if (!target) throw new Error('paragraph changed: ข้อความใน Docs เปลี่ยนไปหลังสร้างคิว (stale conflict) จึงไม่แก้อัตโนมัติ');
        } else {
          // Legacy queue row (exported before this change): no fingerprint recorded, fall back to exact-text compare.
          const pIndex = Number(task.paragraphIndex) - 1;
          const candidate = paragraphs[pIndex];
          if (!candidate) throw new Error(`ไม่พบย่อหน้า ${task.paragraphIndex}`);
          if (candidate.getText() !== task.paragraphText) {
            throw new Error('paragraph changed: ข้อความใน Docs ไม่ตรงกับตอนสร้างคิว จึงไม่แก้อัตโนมัติ');
          }
          target = candidate;
        }

        if (!task.finalParagraph || !String(task.finalParagraph).trim()) {
          throw new Error('finalParagraph ว่าง');
        }

        const oldText = target.getText();
        setNovelParagraphTextSarabun18_(target, task.finalParagraph);
        applied++;

        let tabNoAtApply = task.tabNo;
        for (let i = 0; i < tabs.length; i++) {
          if (tabs[i] === tabInfo) { tabNoAtApply = i + 1; break; }
        }

        updateNovelQueueTask_(task.taskId, {
          applyStatus: 'APPLIED',
          appliedAt: now,
          message: 'applied | Sarabun 18 | highlight #d62828'
        });

        appendNovelLog_(meta, {
          time: now, sourceSheetName: task.sourceSheetName, sourceRowAtExport: task.sourceRow, sourceRowAtApply: currentRow,
          docUrl: task.docUrl, documentId: documentId, tabId: tabInfo.tabId || '', tabNoAtExport: task.tabNo,
          tabNoAtApply: tabNoAtApply, tabTitle: tabInfo.title, paragraphIndex: task.paragraphIndex, taskId: task.taskId,
          paragraphFingerprint: task.paragraphFingerprint || '', oldText: oldText, newText: task.finalParagraph,
          actor: 'Apps Script', status: 'APPLIED', message: task.taskId
        });

      } catch (err) {
        errors++;

        updateNovelQueueTask_(task.taskId, {
          applyStatus: 'ERROR',
          message: err.message
        });

        appendNovelLog_(meta, {
          time: now, sourceSheetName: task.sourceSheetName, sourceRowAtExport: task.sourceRow,
          sourceRowAtApply: currentRow === null ? '' : currentRow,
          docUrl: task.docUrl, documentId: documentId, tabId: task.tabId || '', tabNoAtExport: task.tabNo, tabNoAtApply: '',
          tabTitle: task.tabTitle, paragraphIndex: task.paragraphIndex, taskId: task.taskId,
          paragraphFingerprint: task.paragraphFingerprint || '', oldText: '', newText: '', actor: 'Apps Script',
          status: 'ERROR', message: err.message
        });
      }
    });
  });

  // อัปเดต column L เฉพาะเอกสารที่ apply ครบ ไม่มี error/needs_review ค้าง แล้วสแกนทั้งเอกสารซ้ำก่อนสรุปผล (AC4)
  const refreshed = getNovelQueueObjects_();
  rowApplySummary.forEach(function(info, gid) {
    const related = refreshed.filter(function(r) { return (r.documentId || r.docUrl) === gid; });
    // X3/X4/X7 (round 8/C09): AI_QUEUE is intentionally non-destructive history — every row ever
    // created for this document stays forever, including terminal APPLIED rows and rows that later
    // became stale/orphaned (their recorded paragraph no longer safely resolves, or was separately
    // fixed). Blocking completion on EVERY historical row would let an old, long-resolved ERROR or
    // an orphaned PENDING/READY/NEEDS_REVIEW row block "เสร็จ" forever even after all CURRENT work
    // is done. Filter to only rows that still safely resolve to a CURRENTLY DIRTY paragraph (same
    // conservative proof Apply itself uses) before evaluating the (unchanged) business rule.
    const liveRelated = related.filter(function(r) {
      // round 10/C11: superseded rows are prior-generation history — like terminal APPLIED rows they
      // can never be a live blocker (Z6/Z8). They are dropped here BEFORE getNovelApplyRowBlockReason_
      // sees them, so a stale READY/ERROR row a re-export retired can never hold "เสร็จ" hostage.
      if (String(r.supersededAt || '') !== '') return false;
      return !novelQueueRowIsBlockingShape_(r) || novelQueueRowStillLive_(r, info.doc, info.tabs);
    });
    const blockReason = getNovelApplyRowBlockReason_(liveRelated);
    const sheet = ss.getSheetByName(info.sheetName);

    if (blockReason || info.resolvedRow === null || !sheet) {
      blockedRows++;
      blockedSourceRows.push({
        sourceSheetName: info.sheetName,
        sourceRow: info.resolvedRow || info.sourceRowFallback,
        reason: blockReason || (info.resolvedRow === null
          ? 'ไม่พบแถวต้นทางปัจจุบันที่ลิงก์ไปยังเอกสารนี้ (documentId เปลี่ยนหรือถูกลบ)'
          : 'ไม่พบ source sheet')
      });
      return;
    }

    const rescan = novelRescanDocumentForCompletion_(info.doc);
    const noteRange = sheet.getRange(info.resolvedRow, NOVEL_HELPER_CONFIG.PROGRAM_NOTE_COL);
    // F6: read the CURRENT Column L value fresh, not the stale export-time originalNote — a
    // เลขบทซ้ำ/เนื้อหาซ้ำ/ฟรี/บทที่หาย marker added or removed after export must still be honored,
    // so a blocker can never be bypassed by an outdated originalNote.
    const currentNote = String(noteRange.getValue() || '');
    const reviewTabValues = (info.reviewTabs || []).slice();
    const buildIdSet = new Set((info.buildJobIds || []).map(function(v) {
      return String(v || '').trim();
    }).filter(Boolean));
    if (buildIdSet.size) {
      related.forEach(function(row) {
        if (String(row.supersededAt || '') !== '') return;
        if (buildIdSet.has(String(row.buildJobId || '').trim())) reviewTabValues.push(row.tabNo);
      });
    }

    // Runtime uses the canonical target-tab parser. Extracted legacy test harnesses do not load it,
    // so use a conservative fallback only in that isolated environment.
    if (typeof parseNovelTargetTabs_ === 'function') {
      try {
        parseNovelTargetTabs_(info.originalNote || '', rescan.tabCount).forEach(function(tabNo) {
          reviewTabValues.push(tabNo);
        });
      } catch (e) {}
    } else {
      const fallbackText = String(info.originalNote || '').replace(/[๐-๙]/g, function(ch) {
        return String('๐๑๒๓๔๕๖๗๘๙'.indexOf(ch));
      });
      const fallbackRe = /(?:แท็บ(?:ที่)?|tabs?|tab)\s*[:：]?\s*(\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*)/gi;
      let fallbackMatch;
      while ((fallbackMatch = fallbackRe.exec(fallbackText)) !== null) {
        fallbackMatch[1].split(',').forEach(function(token) {
          const range = token.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
          if (range) {
            const a = Number(range[1]);
            const b = Number(range[2]);
            for (let tabNo = Math.min(a, b); tabNo <= Math.max(a, b); tabNo++) reviewTabValues.push(tabNo);
          } else {
            reviewTabValues.push(Number(token.trim()));
          }
        });
      }
    }
    (rescan.foreignTabs || []).forEach(function(tabNo) { reviewTabValues.push(tabNo); });
    const reviewTabs = Array.from(new Set(reviewTabValues.map(Number).filter(function(tabNo) {
      return Number.isInteger(tabNo) && tabNo > 0;
    }))).sort(function(a, b) { return a - b; });
    const note = composeNovelCompletionNote_(rescan.tabCount, currentNote, rescan.stillHasForeign, reviewTabs);
    if (currentNote === note) {
      unchangedRows++;
      return;
    }

    noteRange.setValue(note);
    notesUpdated++;
    updatedSourceRows.push({
      sourceSheetName: info.sheetName,
      sourceRow: info.resolvedRow,
      note: note
    });
  });

  SpreadsheetApp.flush();
  const revisionResult = notesUpdated > 0
    ? touchCheckerDataRevision_()
    : getCheckerDataRevision_();
  const revisionWarning = notesUpdated > 0 && !revisionResult.revisionAvailable
    ? 'Apply และอัปเดตคอลัมน์ L สำเร็จแล้ว\nแต่ระบบแจ้งหน้า Checker ให้อัปเดตอัตโนมัติไม่สำเร็จ\nหากหน้า Checker ยังแสดงข้อมูลเดิม ให้กดรีเฟรชหนึ่งครั้ง'
    : '';
  const message = buildNovelApplyResultMessage_(applied, errors, notesUpdated, blockedRows, unchangedRows);
  const userMessage = revisionWarning
    ? message + '\nคำเตือน: ' + revisionWarning
    : message;

  return {
    ok: errors === 0,
    applied,
    errors,
    notesUpdated,
    blockedRows,
    unchangedRows,
    updatedSourceRows,
    blockedSourceRows,
    revisionAvailable: revisionResult.revisionAvailable,
    revision: revisionResult.revision,
    revisionWarning,
    message: userMessage
  };
}

// X3/X4/X7 (round 8/C09): a queue row is "blocking-shaped" if its status would, taken alone,
// satisfy either branch of getNovelApplyRowBlockReason_ below — i.e. it's a candidate that needs
// its LIVENESS verified before it's allowed to actually block. A terminal APPLIED row is never
// blocking-shaped regardless of anything else.
function novelQueueRowIsBlockingShape_(row) {
  const applyStatus = String(row.applyStatus || '');
  if (applyStatus === 'APPLIED') return false;
  if (applyStatus === 'ERROR') return true;
  return ['PENDING', 'READY', 'NEEDS_REVIEW'].includes(String(row.claudeStatus || ''));
}

// Shared core (round 8/C09, refactored round 9/C10): resolves a queue row's recorded position/
// fingerprint anchor against the live document, using the exact same conservative proof Apply
// itself uses (novelResolveTargetParagraph_) — never a looser check. Returns the resolved
// paragraph object, `false` (definitively cannot be proven to exist anymore — the tab is gone or
// the position/content anchor no longer matches), or `null` (genuinely CANNOT verify: missing
// anchor data, or a read failure) — callers decide how to treat "unknown", but it must never be
// silently treated as equivalent to "confirmed gone".
function novelResolveQueueRowLiveTarget_(row, doc, tabs) {
  if (!row.tabId || !row.paragraphFingerprint) return null; // no stable anchor recorded — can't verify either way
  const tabInfo = resolveNovelTabById_(tabs || [], row.tabId, row.tabNo);
  if (!tabInfo) return false; // the tab itself is gone — nothing there can still exist
  let paragraphs;
  try {
    paragraphs = getNovelBodyFromTab_(doc, tabInfo).getParagraphs();
  } catch (e) {
    return null; // can't read the tab right now — genuinely unknown
  }
  const target = novelResolveTargetParagraph_(
    paragraphs, row.documentId, tabInfo.tabId, row.paragraphIndex, row.paragraphFingerprint,
    row.occurrenceCount, row.tabFingerprintSequenceAtExport
  );
  return target || false; // no target: can no longer be safely proven to exist — moved on or resolved
}

// X3/X4/X7 (round 8/C09): does this row's recorded anchor still resolve to a paragraph that is
// CURRENTLY DIRTY, right now? Used for FINAL BLOCKER evaluation, where "is there still real
// unfinished work" is the actual question — a paragraph that resolves but is no longer dirty
// (already fixed some other way, e.g. a highlight manually cleared with the text unchanged) is
// legitimately no longer a live blocker. Returns true/false/null exactly like the shared resolver.
function novelQueueRowResolvesToLiveDirtyParagraph_(row, doc, tabs) {
  const target = novelResolveQueueRowLiveTarget_(row, doc, tabs);
  if (target === null) return null;
  if (target === false) return false;
  return novelParagraphIsDirty_(target, target.getText());
}

// X3/X4/X7 (round 8/C09): used for FINAL BLOCKER evaluation — "unknown" (can't verify) stays
// conservative and still counts as a live blocker, so missing information never silently unblocks
// completion.
function novelQueueRowStillLive_(row, doc, tabs) {
  return novelQueueRowResolvesToLiveDirtyParagraph_(row, doc, tabs) !== false;
}

// round 10/C11: APPLY SELECTION for a retry now uses novelQueueRowStillLive_ (identity proof AND
// still-dirty), the same predicate final-blocker evaluation uses. The round-9 identity-only variant
// (novelQueueRowTargetStillResolves_) was removed: a retry whose target resolves but is no longer
// dirty (highlight/marker cleared, text unchanged) must be preserved as history, not re-mutated.

function getNovelApplyRowBlockReason_(related) {
  related = related || [];
  if (related.some(r => String(r.applyStatus || '') === 'ERROR')) {
    return 'มี task สถานะ ERROR';
  }
  if (related.some(r =>
    ['PENDING', 'READY', 'NEEDS_REVIEW'].includes(String(r.claudeStatus || '')) &&
    String(r.applyStatus || '') !== 'APPLIED'
  )) {
    return 'ยังมี task ที่ Apply ไม่ครบ';
  }
  return '';
}

function buildNovelApplyResultMessage_(applied, errors, notesUpdated, blockedRows, unchangedRows) {
  const message = `Apply สำเร็จ ${applied} งาน / error ${errors} งาน / อัปเดตคอลัมน์ L ${notesUpdated} แถว / ยังติดเงื่อนไข ${blockedRows} แถว / ค่าเดิมอยู่แล้ว ${unchangedRows} แถว`;
  if (applied > 0 && notesUpdated === 0) {
    if (blockedRows > 0) {
      return message + ' | คอลัมน์ L ยังไม่เปลี่ยนเพราะ source row ยังมี task ค้าง, error หรือหา source sheet ไม่พบ';
    }
    if (unchangedRows > 0) {
      return message + ' | คอลัมน์ L ไม่เปลี่ยนเพราะค่าใหม่ตรงกับค่าปัจจุบันแล้ว';
    }
    return message + ' | คอลัมน์ L ยังไม่เปลี่ยนเพราะไม่พบ source row ที่อัปเดตได้';
  }
  return message;
}
