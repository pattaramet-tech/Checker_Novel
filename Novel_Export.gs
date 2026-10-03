function exportNovelPendingJson() {
  return exportNovelPendingJsonForMode_('latest');
}

function exportNovelAllPendingJson() {
  return exportNovelPendingJsonForMode_('all');
}

function exportNovelPendingJsonForMode_(mode) {
  ensureNovelHelperSheets_();
  const data = getNovelQueueObjects_();
  const allPending = data.filter(r => String(r.claudeStatus || '') === 'PENDING');
  let pending = allPending;
  if (String(mode || 'latest') !== 'all') {
    const state = novelJobLoad_();
    const latestJobId = state && state.jobId ? String(state.jobId).trim() : '';
    pending = latestJobId
      ? allPending.filter(r => String(r.buildJobId || '') === latestJobId)
      : [];
  }

  const payload = pending.map(r => ({
    taskId: r.taskId,
    documentId: r.documentId,
    docUrl: r.docUrl,
    tabId: r.tabId,
    tabNo: Number(r.tabNo),
    tabTitle: r.tabTitle,
    paragraphIndex: Number(r.paragraphIndex),
    paragraphFingerprint: r.paragraphFingerprint,
    sourceRow: Number(r.sourceRow),
    highlightedText: r.highlightedText,
    paragraphText: r.paragraphText
  }));

  return JSON.stringify(payload, null, 2);
}
