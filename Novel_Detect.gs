// Foreign-word detector: prefer the shared, more complete regex from Checker_Main.txt when present,
// else fall back to NOVEL_HELPER_CONFIG.FOREIGN_RE (same character ranges, local copy).
function novelDetectForeignWords_(text) {
  const s = String(text || '');
  if (typeof FOREIGN_WORD_RE_V9_ !== 'undefined') {
    const re = new RegExp(FOREIGN_WORD_RE_V9_.source, FOREIGN_WORD_RE_V9_.flags.replace('g', ''));
    return re.test(s);
  }
  return NOVEL_HELPER_CONFIG.FOREIGN_RE.test(s);
}

// Checker_Main.txt inserts a literal in-document marker paragraph whose text is exactly
// this string (NOTE_TEXT_) to flag a chapter for review. A paragraph carrying only that
// marker (no foreign characters of its own) must still count as "dirty" during Novel Helper's
// live scans/rescans — reuse the shared constant when Checker_Main.txt is loaded.
const NOVEL_FOREIGN_MARKER_TEXT_ = (typeof NOTE_TEXT_ !== 'undefined') ? NOTE_TEXT_ : 'พบคำต่างประเทศ';

function novelParagraphHasMarkerText_(text) {
  return String(text || '').indexOf(NOVEL_FOREIGN_MARKER_TEXT_) !== -1;
}

// Paragraph "dirty" test for EXPORT scanning / apply-time duplicate disambiguation: highlighted
// background (manual or legacy marking), a supported foreign character, long-English leakage, or
// the literal review marker. Highlight is a legitimate export-time signal a human can paint to
// flag a paragraph for AI translation. Self-contained (no calls to other novelParagraphIsDirty*
// variants) so it stays independently extractable/testable.
function novelParagraphIsDirty_(paragraph, text) {
  return !!(getNovelHighlightedText_(paragraph) || novelDetectForeignWords_(text) || novelParagraphHasLongEnglish_(text) || novelParagraphHasMarkerText_(text));
}

// T6 (round 4): paragraph "dirty" test for the FINAL COMPLETION rescan only. AI Apply itself
// paints a highlight (NOVEL_APPLY_HIGHLIGHT_COLOR, see setNovelParagraphTextSarabun18_) on every
// paragraph it touches so a human reviewer can see what changed. That highlight must never, by
// itself, count as "still needs work" — otherwise a fully-translated, clean-Thai paragraph could
// never let the row reach เสร็จ N แท็บ. Completion depends only on the literal review marker or
// content that is provably still foreign/leaking English, never on generic non-white highlight.
// Self-contained (no dependency on novelParagraphIsDirty_) for the same extractability reason.
function novelParagraphIsDirtyForCompletion_(paragraph, text) {
  return !!(novelParagraphHasMarkerText_(text) || novelDetectForeignWords_(text) || novelParagraphHasLongEnglish_(text));
}

// Live-scan every current tab of the document (not just tabs a stale note mentions) and return
// the 1-based tab numbers that currently contain at least one dirty paragraph (per isDirtyFn).
// tabNo from Column L notes is metadata only and can drift after tabs are reordered/added/removed,
// so export and the final completion rescan must always trust a fresh scan over stale note numbers.
// isDirtyFn defaults to the export-time test; the completion rescan passes its own stricter test.
function novelLiveScanDirtyTabs_(doc, tabs, isDirtyFn) {
  const isDirty = typeof isDirtyFn === 'function' ? isDirtyFn : novelParagraphIsDirty_;
  const dirty = [];
  for (let t = 0; t < tabs.length; t++) {
    const body = getNovelBodyFromTab_(doc, tabs[t]);
    const paragraphs = body.getParagraphs();
    for (let p = 0; p < paragraphs.length; p++) {
      const text = paragraphs[p].getText();
      if (!text || !text.trim()) continue;
      if (isDirty(paragraphs[p], text)) {
        dirty.push(t + 1);
        break;
      }
    }
  }
  return dirty;
}

function novelParagraphHasLongEnglish_(text) {
  if (typeof checkerHasLongEnglishSentence_ !== 'function') return false;
  try {
    return !!checkerHasLongEnglishSentence_(text);
  } catch (e) {
    return false;
  }
}

// ประมวลผล 1 แถวต้นทาง: เปิด Docs, เช็คเลขบทเรียงต่อเนื่อง, parse เลขแท็บ, สร้าง task เข้าคิว
// แยกออกมาจาก buildNovelQueue เดิมเพื่อใช้ร่วมกันทั้งโหมด manualRows และโหมด keyword/default
// existingQueueRows (round 5, U5-U8): full existing AI_QUEUE row objects (documentId/tabId/
// paragraphFingerprint/paragraphIndex/occurrenceCount/taskId), a snapshot taken BEFORE this build
// run started. Used only to RECONCILE a currently-dirty paragraph back to an already-existing
// task identity — see the reconciliation pass inside the tab loop below — never mutated by this
// function. existingTaskIds remains the live, run-growing set used for the final "already
// represented in the queue, don't push a duplicate output row" gate.
function getNovelHighlightedText_(paragraph) {
  const text = paragraph.editAsText();
  const raw = text.getText();
  if (!raw) return '';

  const chunks = [];
  let current = '';
  const attributeStarts = text.getTextAttributeIndices();
  const starts = attributeStarts && attributeStarts.length ? attributeStarts : [0];

  // getTextAttributeIndices() คืนตำแหน่งที่ style เปลี่ยน
  // จึงอ่าน background ต่อ style run แทนการเรียก getBackgroundColor() ทุกตัวอักษร
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const endExclusive = i + 1 < starts.length ? starts[i + 1] : raw.length;
    if (start >= raw.length || endExclusive <= start) continue;

    const bg = normalizeNovelColor_(text.getBackgroundColor(start));
    const isHighlighted = bg && !NOVEL_HELPER_CONFIG.WHITE_COLORS.has(bg);
    if (isHighlighted) {
      current += raw.slice(start, endExclusive);
    } else if (current) {
      chunks.push(current);
      current = '';
    }
  }

  if (current) chunks.push(current);
  return chunks.join(' | ').trim();
}
