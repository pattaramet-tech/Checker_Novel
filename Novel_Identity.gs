// ===== stable identity: paragraph fingerprint + content-derived taskId =====
// Same paragraph content -> same taskId always (prevents duplicate tasks on re-export).
// Changed paragraph content -> new taskId always (detects an edited paragraph).
const NOVEL_FINGERPRINT_CONTEXT_ = 'novel-paragraph-fingerprint-v1';

function novelComputeParagraphFingerprint_(documentId, tabId, paragraphText) {
  var input = NOVEL_FINGERPRINT_CONTEXT_ + '\n' + String(documentId || '') + '\n' + String(tabId || '') + '\n' + String(paragraphText || '');
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return bytes.map(function(v) { var u = v < 0 ? v + 256 : v; return (u < 16 ? '0' : '') + u.toString(16); }).join('');
}

// discriminator (T3/T4, round 4 — replaces round-2's occurrence-RANK discriminator):
// documentId+tabId+text alone cannot distinguish two BYTE-IDENTICAL dirty paragraphs in the same
// tab — both would hash to the same fingerprint and collapse into one taskId, silently dropping
// one of them from the queue. The discriminator used to be the 0-based RANK of this paragraph
// among identical-text dirty paragraphs, recomputed fresh on every scan — but that rank shifts
// when a SIBLING duplicate's dirty state changes (e.g. it gets applied and its text no longer
// matches), so the REMAINING untouched duplicate could recompute to rank 0 on re-export and
// collide with the taskId of the sibling that was already applied under that rank, silently
// merging into an already-completed task instead of getting queued. The paragraph's own physical
// position (p, 0-based) does not shift just because some OTHER paragraph's dirty state changed —
// only insertion/removal of paragraphs BEFORE it would, which is the same drift the position-
// anchor Apply resolution (novelResolveTargetParagraph_) already treats as a stale-conflict case.
// For the overwhelmingly common case of a paragraph with unique text in its tab, this has no
// effect on identity/dedupe stability; it only disambiguates true duplicates, and now does so
// safely across sibling state changes.
// discriminator accepts a plain 0-based position number (the common case, unchanged hash from
// before) OR a "position:salt" string (round 5, U8) — used only when a freshly minted identity
// would otherwise collide with an existing queue taskId that reconciliation deliberately left
// unclaimed as ambiguous; salting guarantees a genuinely fresh, still-deterministic identity.
function novelComputeTaskId_(documentId, tabId, paragraphFingerprint, discriminator) {
  var idx = (discriminator === undefined || discriminator === null || discriminator === '') ? '0' : String(discriminator);
  var digest = novelComputeParagraphFingerprint_('task:' + documentId + ':' + idx, tabId, paragraphFingerprint);
  return 't' + digest.slice(0, 20);
}

// W1-W8 (round 7/C08): raw paragraph COUNT alone (tabParagraphCountAtExport, round 6/C07) is not
// sufficient structural proof for a confirmed duplicate — a same-count REORDER (e.g. a non-
// duplicate paragraph moved from after a duplicate group to before it) preserves total count while
// silently realigning indices. tabFingerprintSequenceAtExport is the stronger anchor: the full,
// in-order list of every paragraph's fingerprint in the tab at the moment this task was queued,
// '|'-joined into one cell value. To verify a confirmed duplicate's position is still trustworthy:
//  1) lengths must match (same paragraph count — subsumes the old count-only check), and
//  2) every position that was NOT part of THIS task's own duplicate group at export time (i.e.
//     its recorded fingerprint differs from expectedFingerprint) must still hold that EXACT SAME
//     fingerprint right now.
// Positions that WERE part of the group are deliberately excluded from that comparison — a sibling
// legitimately being fixed changes exactly those positions, and must never count as "structural
// drift" (S2/S5, round 3) — only genuine movement of paragraphs OUTSIDE the group counts. Whether
// THIS task's own specific slot still holds matching content is verified separately (the existing
// position-anchor check), so the S1/inverse-stale "own paragraph changed" case is still caught.
function novelDuplicateTabStructureStable_(documentId, tabId, expectedFingerprint, paragraphs, recordedSequenceStr) {
  var recorded = String(recordedSequenceStr || '').split('|').filter(function(s) { return s !== ''; });
  if (!recorded.length || recorded.length !== paragraphs.length) return false; // no anchor recorded, or count itself changed
  for (var i = 0; i < recorded.length; i++) {
    if (recorded[i] === expectedFingerprint) continue; // was part of the duplicate group — exempt
    var currentFp = novelComputeParagraphFingerprint_(documentId, tabId, paragraphs[i].getText());
    if (currentFp !== recorded[i]) return false; // a non-group position's content changed/moved
  }
  return true;
}

function novelResolveTargetParagraph_(paragraphs, documentId, tabId, exportParagraphIndex, expectedFingerprint, expectedOccurrenceCount, expectedTabFingerprintSequence) {
  const idx = Number(exportParagraphIndex) - 1;
  const rawCount = Number(expectedOccurrenceCount);
  const hasKnownCount = Number.isFinite(rawCount) && rawCount >= 1;
  const knownMultiple = hasKnownCount && rawCount > 1;
  const knownUnique = hasKnownCount && rawCount === 1;
  const allowContentFallback = knownUnique; // only a CONFIRMED-unique paragraph may fall back to content search
  const tabStructureUnchanged = novelDuplicateTabStructureStable_(documentId, tabId, expectedFingerprint, paragraphs, expectedTabFingerprintSequence);
  // Only a CONFIRMED duplicate whose tab structure is provably unchanged (outside its own group)
  // may skip the extra-duplicate check below; a legacy row with no recorded
  // tabFingerprintSequenceAtExport (tabStructureUnchanged false by construction) falls through to
  // the same scrutiny as an unknown-count row — conservative by default, never assumed safe.
  const skipExtraDuplicateCheck = knownMultiple && tabStructureUnchanged;
  // A confirmed duplicate whose tab structure HAS changed must block outright, not fall through to
  // the extra-duplicate check (which is itself unreliable once positions may have shifted) and
  // never to the content-only fallback (content alone can never disambiguate true duplicates).
  const blockOnStructuralDrift = knownMultiple && !tabStructureUnchanged;

  function isDirtyNow_(paragraph) {
    const text = paragraph.getText();
    return !!(getNovelHighlightedText_(paragraph) || novelDetectForeignWords_(text) || novelParagraphHasLongEnglish_(text));
  }

  if (blockOnStructuralDrift) return null;

  if (paragraphs[idx]) {
    const fpAtIdx = novelComputeParagraphFingerprint_(documentId, tabId, paragraphs[idx].getText());
    if (fpAtIdx === expectedFingerprint) {
      if (skipExtraDuplicateCheck) return paragraphs[idx];

      let extraMatchFound = false;
      for (let q = 0; q < paragraphs.length; q++) {
        if (q === idx) continue;
        if (!isDirtyNow_(paragraphs[q])) continue;
        if (novelComputeParagraphFingerprint_(documentId, tabId, paragraphs[q].getText()) === expectedFingerprint) {
          extraMatchFound = true;
          break;
        }
      }
      if (!extraMatchFound) return paragraphs[idx];
      return null; // a new coincidental duplicate appeared — no longer provably unique, block
    }
  }

  if (!allowContentFallback) return null; // had siblings, or unknown legacy count — content alone can never prove identity; block

  let match = null;
  for (let p = 0; p < paragraphs.length; p++) {
    if (!isDirtyNow_(paragraphs[p])) continue; // keep the same "dirty paragraphs only" universe export used
    const fp2 = novelComputeParagraphFingerprint_(documentId, tabId, paragraphs[p].getText());
    if (fp2 === expectedFingerprint) {
      if (match) return null; // no longer unique — ambiguous, block rather than guess
      match = paragraphs[p];
    }
  }
  return match;
}

// สแกนทุกแท็บที่มีอยู่จริงในเอกสาร (ไม่ใช่แค่แท็บที่ apply รอบนี้แตะ) ก่อนสรุปว่า "เสร็จ"
// กันแท็บสกปรกที่ไม่เคยเข้าคิวหลุดรอดไปเป็นแถวที่ทำเสร็จแล้ว (AC4)
