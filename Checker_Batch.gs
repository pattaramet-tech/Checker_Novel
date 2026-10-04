/* =========================
 * Checker_Batch.gs
 * Batched tab scanning (25 tabs/call)
 * ========================= */
function isFreeChapterRangeDocumentName_(documentName) {
  var normalizedName = String(documentName || '').trim();
  if (!normalizedName) return false;
  var match = normalizedName.match(/(?:^|[^0-9])(0*1)\s*[-–—]\s*([0-9]+)\s*$/);
  if (!match) return false;
  var start = Number(match[1]);
  var end = Number(match[2]);
  return start === 1 && Number.isInteger(end) && end > start;
}

function isFreeChapterRangeDocument_(doc) {
  try {
    return !!doc && typeof doc.getName === 'function' && isFreeChapterRangeDocumentName_(doc.getName());
  } catch (ignored) {
    return false;
  }
}

function hasCheckerFreeMarker_(note) {
  return String(note || '').split('|').some(function(part) {
    return /(?:^|\s)ฟรี\s*$/.test(part.trim());
  });
}

function stripCheckerFreeMarker_(note) {
  return String(note || '').split('|').map(function(part) {
    var cleanPart = part.trim();
    while (/(?:^|\s)ฟรี\s*$/.test(cleanPart)) {
      cleanPart = cleanPart.replace(/(?:^|\s)ฟรี\s*$/, '').trim();
    }
    return cleanPart;
  }).filter(Boolean).join(' | ');
}

function addCheckerFreeMarker_(note, isFree) {
  var original = String(note || '').trim();
  if (!isFree) return original;

  var cleanNote = stripCheckerFreeMarker_(original);
  var parts = cleanNote ? cleanNote.split('|').map(function(part) { return part.trim(); }).filter(Boolean) : [];
  var primaryIndex = -1;
  for (var i = 0; i < parts.length; i++) {
    if (/^(?:เลขบทเรียงต่อเนื่อง|รอ\s+[0-9]+\s+แท็บ)$/.test(parts[i])) {
      primaryIndex = i;
      break;
    }
  }

  if (primaryIndex >= 0) parts[primaryIndex] += ' ฟรี';
  else parts.push('ฟรี');
  return parts.join(' | ');
}

function sanitizeCheckerScanValue_(value, keepContentDigest) {
  if (Array.isArray(value)) {
    return value.map(function(item) { return sanitizeCheckerScanValue_(item, keepContentDigest); });
  }
  if (!value || typeof value !== 'object') return value;

  var blockedKeys = {
    text: true,
    contentSignature: true,
    signature: true,
    paragraphText: true,
    finalParagraph: true,
    oldText: true,
    newText: true,
    removedTexts: true,
    changes: true,
    from: true,
    to: true,
    before: true,
    after: true,
    documentName: true,
    docName: true,
    normalizedContent: true,
    rawContent: true,
    stack: true
  };
  var safeValue = {};
  Object.keys(value).forEach(function(key) {
    if (blockedKeys[key]) return;
    if (key === 'contentDigest') {
      var digest = String(value[key] || '');
      if (keepContentDigest && /^[a-f0-9]{64}$/.test(digest)) safeValue[key] = digest;
      return;
    }
    if (key === 'contentSimilarityHash') {
      var similarityHash = String(value[key] || '');
      if (keepContentDigest && /^[a-f0-9]{16}$/.test(similarityHash)) safeValue[key] = similarityHash;
      return;
    }
    if (key === 'contentSimilarityLength') {
      var similarityLength = Number(value[key] || 0);
      if (keepContentDigest && isFinite(similarityLength) && similarityLength >= 0 && similarityLength <= 1200) {
        safeValue[key] = Math.floor(similarityLength);
      }
      return;
    }
    if (key === 'message') {
      safeValue[key] = value[key] ? 'ตรวจแท็บไม่สำเร็จ' : '';
      return;
    }
    if (key === 'error') {
      safeValue[key] = value[key] ? 'ดำเนินการไม่สำเร็จ' : '';
      return;
    }
    safeValue[key] = sanitizeCheckerScanValue_(value[key], keepContentDigest);
  });
  return safeValue;
}

function sanitizeCheckerCheckpointValue_(value) {
  return sanitizeCheckerScanValue_(value, true);
}

function sanitizeCheckerPublicValue_(value) {
  return sanitizeCheckerScanValue_(value, false);
}

function sanitizeCheckerCheckpointSummary_(summary) {
  return sanitizeCheckerCheckpointValue_(summary || {});
}

function sanitizeCheckerPublicSummary_(summary) {
  return sanitizeCheckerPublicValue_(summary || {});
}

/* =========================
 * Web app: note merge/dedupe helpers
 * ใช้รวมหมายเหตุจากหลายแหล่ง (คำต่างประเทศ/เลขบท/ต้นฉบับไม่มีบทที่ ฯลฯ)
 * โดยไม่ overwrite ของเดิม และไม่เขียนซ้ำ
 * ========================= */

// เรียงเลขแท็บ ไม่ซ้ำ แล้วต่อด้วยจุลภาค เช่น [3,2,3] -> "2, 3"
function formatTabNumberList_(tabIndexes) {
  var arr = (tabIndexes || [])
    .map(Number)
    .filter(function(n) { return !isNaN(n); })
    .sort(function(a, b) { return a - b; });

  arr = arr.filter(function(v, i) { return i === 0 || v !== arr[i - 1]; });
  return arr.join(', ');
}

// แยกหมายเหตุด้วย " | " แล้วตัดส่วนที่ซ้ำกันทุกตัวอักษรออก คงลำดับที่พบก่อน
function dedupeCheckerNotes_(noteText) {
  var parts = String(noteText || '')
    .split('|')
    .map(function(s) { return s.trim(); })
    .filter(Boolean);

  var seen = {};
  var out = [];
  parts.forEach(function(p) {
    if (seen[p]) return;
    seen[p] = true;
    out.push(p);
  });
  return out.join(' | ');
}

// ต่อท้ายหมายเหตุเดิมด้วย " | " แล้ว dedupe เสมอ ไม่เคย overwrite ของเดิม
function appendCheckerNote_(baseNote, addition) {
  var base = String(baseNote || '').trim();
  var add = String(addition || '').trim();
  if (!add) return dedupeCheckerNotes_(base);
  if (!base) return dedupeCheckerNotes_(add);
  return dedupeCheckerNotes_(base + ' | ' + add);
}

// รวมหมายเหตุหลายชิ้นตามลำดับ argument (ชิ้นแรกขึ้นก่อน) พร้อม dedupe
function mergeCheckerNotes_() {
  var combined = '';
  for (var i = 0; i < arguments.length; i++) {
    combined = appendCheckerNote_(combined, arguments[i]);
  }
  return combined;
}

/**
 * รวมผลลัพธ์เฉพาะฟีเจอร์ Web app (title layout / english source cleanup /
 * source no-chapter note) จาก runAllChecks() ของแท็บหนึ่งเข้า batchTotals
 * ใช้ร่วมกันทุกจุดที่ loop ทีละแท็บ กันโค้ดสะสมผลซ้ำหลายจุด
 */
function accumulateWebAppExtrasIntoBatchTotals_(batchTotals, result, tabName, tabIndex) {
  result = result || {};

  var titleLayout = result.titleLayoutReport || {};
  batchTotals.titleParagraphInsertedTotal = Number(batchTotals.titleParagraphInsertedTotal || 0) + Number(titleLayout.titleParagraphInserted || 0);
  batchTotals.titleParagraphUpdatedTotal = Number(batchTotals.titleParagraphUpdatedTotal || 0) + Number(titleLayout.titleParagraphUpdated || 0);
  batchTotals.titleLayoutSkippedTotal = Number(batchTotals.titleLayoutSkippedTotal || 0) + Number(titleLayout.titleLayoutSkipped || 0);

  var eng = result.englishSourceCleanup || {};
  if (Number(eng.detected || 0) > 0) {
    batchTotals.englishSourceDetectedTotal = Number(batchTotals.englishSourceDetectedTotal || 0) + 1;
    if (Number(eng.removed || 0) > 0) {
      batchTotals.englishSourceRemovedTotal = Number(batchTotals.englishSourceRemovedTotal || 0) + 1;
      batchTotals.englishSourceRemovedParagraphsTotal = Number(batchTotals.englishSourceRemovedParagraphsTotal || 0) + Number(eng.removedParagraphs || 0);
    } else {
      batchTotals.englishSourceUncertainTabs = batchTotals.englishSourceUncertainTabs || [];
      batchTotals.englishSourceUncertainTabs.push({ tab: tabName, tabIndex: tabIndex });
    }
  }

  var srcNote = result.sourceNoChapterNote || {};
  if (Number(srcNote.found || 0) > 0) {
    batchTotals.sourceNoChapterTabs = batchTotals.sourceNoChapterTabs || [];
    batchTotals.sourceNoChapterTabs.push({ tab: tabName, tabIndex: tabIndex });
  }

  var ending = result.endingCleanup || {};
  if (ending.changed) {
    batchTotals.endingCleanupChangedTotal = Number(batchTotals.endingCleanupChangedTotal || 0) + 1;
  }
  batchTotals.endingPromoRemovedTotal = Number(batchTotals.endingPromoRemovedTotal || 0) + Number(ending.removedPromoLines || 0);
  if (ending.insertedEndMarker) {
    batchTotals.endingMarkerInsertedTotal = Number(batchTotals.endingMarkerInsertedTotal || 0) + 1;
  }

  // Fix timeout: สะสมผลตรวจภาษาของแท็บนี้ไว้ (คำนวณตอนสแกนแท็บอยู่แล้วใน scanWholeDocumentChunk)
  // แทนที่ finalize จะต้องเปิด getBody()/getText() ของทุกแท็บซ้ำอีกรอบ
  if (result.untranslatedEnglishInfo) {
    batchTotals.untranslatedEnglishTabs = batchTotals.untranslatedEnglishTabs || [];
    var alreadyListed = batchTotals.untranslatedEnglishTabs.some(function(x) {
      return Number(x.tabNo) === Number(tabIndex);
    });
    if (!alreadyListed) {
      batchTotals.untranslatedEnglishTabs.push({
        tabNo: tabIndex,
        title: tabName,
        latinRatio: result.untranslatedEnglishInfo.latinRatio,
        thaiRatio: result.untranslatedEnglishInfo.thaiRatio
      });
    }
  }

  return batchTotals;
}

function buildWholeDocumentScanNote_(summary) {
  summary = summary || {};
  var parts = [];

  var foreignNames = (summary.foreignTabNames || []).slice(0, 50);
  if (foreignNames.length) {
    parts.push('พบแท็บมีคำต่างประเทศ: ' + foreignNames.join(', '));
  }

  // ประโยคภาษาอังกฤษยาวที่ Gemini แปลไม่หมด (เก็บเฉพาะหมายเลขแท็บ ไม่มีข้อความตัวอย่าง)
  var longEnglishMessage = (typeof checkerBuildLongEnglishMessage_ === 'function')
    ? checkerBuildLongEnglishMessage_(summary.longEnglishTabNumbers || [])
    : '';
  if (longEnglishMessage) {
    parts.push(longEnglishMessage);
  }

  var chapterIssues = summary.chapterSequenceIssues || [];
  var dupNumbers = [];
  var missingNumbers = [];
  var otherNonContinuous = false;

  function pushUnique_(arr, n) { if (!isNaN(n) && arr.indexOf(n) === -1) arr.push(n); }

  chapterIssues.forEach(function(issue) {
    var type = String(issue.type || '');
    var current = Number(issue.current);
    var expected = Number(issue.expected);

    if (type === 'เลขซ้ำ') {
      pushUnique_(dupNumbers, current);
    } else if (type === 'เลขข้าม' || type === 'ไม่ต่อเนื่อง') {
      // บทที่หาย = ช่วง expected .. current-1 (กรณีเลขกระโดดไปข้างหน้า)
      if (!isNaN(expected) && !isNaN(current) && current > expected) {
        for (var n = expected; n <= current - 1; n++) pushUnique_(missingNumbers, n);
      } else {
        otherNonContinuous = true;
      }
    } else if (type === 'เลขย้อนหลัง') {
      otherNonContinuous = true;
    }
    // 'ไม่พบเลขบท' ไม่ flag เพื่อลด noise
  });

  // เนื้อหาซ้ำระหว่างบท
  var contentDup = summary.contentDuplicates || [];
  var contentDupTexts = [];
  contentDup.forEach(function(pair) {
    var a = (pair.chapterA == null) ? (pair.tabA || '') : ('บทที่ ' + pair.chapterA);
    var b = (pair.chapterB == null) ? (pair.tabB || '') : ('บทที่ ' + pair.chapterB);
    if (a && b) contentDupTexts.push(a + ' และ ' + b);
  });

  var hasDuplicate = dupNumbers.length > 0 || !!summary.hasDuplicateChapter;
  var hasMissing = missingNumbers.length > 0;

  if (dupNumbers.length) {
    parts.push('เลขบทซ้ำ ' + dupNumbers.sort(function(a, b) { return a - b; }).join(', '));
  } else if (summary.hasDuplicateChapter) {
    parts.push('เลขบทซ้ำ');
  }

  if (missingNumbers.length) {
    parts.push('บทที่หาย ' + compressNumberRanges_(missingNumbers));
  }

  if (otherNonContinuous) {
    parts.push('เลขบทไม่ต่อเนื่อง');
  }

  if (contentDupTexts.length) {
    parts.push('เนื้อหาซ้ำ ' + contentDupTexts.slice(0, 20).join(' / '));
  }

  if (!hasDuplicate && !hasMissing && !otherNonContinuous && !contentDupTexts.length) {
    parts.push('เลขบทเรียงต่อเนื่อง');
  }

  // ต้นฉบับไม่มีบทที่: ต่อท้ายหมายเหตุเดิมเสมอ ไม่ overwrite
  var sourceNoChapterTabs = summary.sourceNoChapterTabs || [];
  if (sourceNoChapterTabs.length) {
    var sourceNoChapterList = formatTabNumberList_(sourceNoChapterTabs.map(function(t) { return t.tabIndex; }));
    if (sourceNoChapterList) {
      parts.push('ต้นฉบับไม่มีบทที่: แท็บ ' + sourceNoChapterList);
    }
  }

  return dedupeCheckerNotes_(parts.join(' | '));
}

// ย่อเลขเป็นช่วง เช่น [124,125,126,200] -> "124-126, 200"
function compressNumberRanges_(nums) {
  var arr = (nums || []).map(Number).filter(function(n) { return !isNaN(n); })
    .sort(function(a, b) { return a - b; });
  // ลบค่าซ้ำ
  arr = arr.filter(function(v, i) { return i === 0 || v !== arr[i - 1]; });

  var out = [];
  var i = 0;
  while (i < arr.length) {
    var start = arr[i], end = start;
    while (i + 1 < arr.length && arr[i + 1] === end + 1) { end = arr[i + 1]; i++; }
    out.push(start === end ? String(start) : (start + '-' + end));
    i++;
  }
  return out.join(', ');
}

// เทียบ fingerprint ของบทแรกในแต่ละแท็บ เพื่อจับทั้งเนื้อหาซ้ำตรง ๆ และ near-duplicate
// ที่มีการแทรก/ตัด/แก้คำเล็กน้อยช่วงต้นบท โดยไม่เก็บหรือเทียบ raw novel text นอก runtime.
function buildContentDuplicateReport_(items) {
  items = items || [];
  var prior = [];
  var dups = [];

  function validExactDigest_(item) {
    return /^[a-f0-9]{64}$/.test(String(item && item.contentDigest || '').toLowerCase());
  }

  function popcount32_(value) {
    value = value >>> 0;
    value = value - ((value >>> 1) & 0x55555555);
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
  }

  function nearDuplicate_(a, b) {
    var hashA = String(a && a.contentSimilarityHash || '').toLowerCase();
    var hashB = String(b && b.contentSimilarityHash || '').toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(hashA) || !/^[a-f0-9]{16}$/.test(hashB)) return false;

    var lenA = Number(a && a.contentSimilarityLength || 0);
    var lenB = Number(b && b.contentSimilarityLength || 0);
    if (!isFinite(lenA) || !isFinite(lenB) || lenA < 80 || lenB < 80) return false;

    // Avoid comparing a short extract against a substantially different-sized chapter. Genuine
    // copies with a small inserted note/paragraph still remain comfortably above this ratio.
    var lengthRatio = Math.min(lenA, lenB) / Math.max(lenA, lenB);
    if (lengthRatio < 0.75) return false;

    var leftA = parseInt(hashA.slice(0, 8), 16) >>> 0;
    var rightA = parseInt(hashA.slice(8), 16) >>> 0;
    var leftB = parseInt(hashB.slice(0, 8), 16) >>> 0;
    var rightB = parseInt(hashB.slice(8), 16) >>> 0;
    var hammingDistance = popcount32_(leftA ^ leftB) + popcount32_(rightA ^ rightB);

    // 10/64 differing bits is strict enough to keep unrelated chapters far apart, while tolerating
    // the small prefix/wording drift that previously caused SHA-256 equality to miss a duplicate.
    return hammingDistance <= 10;
  }

  items.forEach(function(item) {
    var itemDigest = String(item && item.contentDigest || '').toLowerCase();
    var itemHasExact = validExactDigest_(item);
    var itemHasSimilarity = /^[a-f0-9]{16}$/.test(String(item && item.contentSimilarityHash || '').toLowerCase());
    if (!itemHasExact && !itemHasSimilarity) return;

    var prev = null;
    for (var i = 0; i < prior.length; i++) {
      var candidate = prior[i];
      var exactMatch = itemHasExact && validExactDigest_(candidate) &&
        itemDigest === String(candidate.contentDigest || '').toLowerCase();
      if (exactMatch || nearDuplicate_(candidate, item)) {
        prev = candidate;
        break;
      }
    }

    if (prev) {
      dups.push({
        chapterA: prev.chapterNumber,
        chapterB: item.chapterNumber,
        tabA: prev.tab,
        tabB: item.tab
      });
    }
    prior.push(item);
  });

  return dups;
}

function summarizeBatchTotals_(totals) {
  totals = totals || {};
  return sanitizeCheckerCheckpointValue_({
    tabChecked: Number(totals.tabChecked || 0),
    tabTotal: Number(totals.tabTotal || 0),
    replacedEmDashCount: Number(totals.replacedEmDashCount || 0),
    replacedWawCount: Number(totals.replacedWawCount || 0),
    latinSpecialRemovedTotal: Number(totals.latinSpecialRemovedTotal || 0),
    nonThaiCount: Number(totals.nonThaiCount || 0),
    paragraphCount: Number(totals.paragraphCount || 0),
    spacingCount: Number(totals.spacingCount || 0),
    blankRemoved: Number(totals.blankRemoved || 0),
    removedCount: Number(totals.removedCount || 0),
    breakPairsTotal: Number(totals.breakPairsTotal || 0),
    removedTitleParensTotal: Number(totals.removedTitleParensTotal || 0),
    duplicateChapterHeadingRemovedTotal: Number(totals.duplicateChapterHeadingRemovedTotal || 0),
    duplicateChapterTitleRemovedTotal: Number(totals.duplicateChapterTitleRemovedTotal || 0),
    longEnglishParagraphCount: Number(totals.longEnglishParagraphCount || 0),
    longEnglishTabNumbers: totals.longEnglishTabNumbers || [],
    longEnglishTabCounts: totals.longEnglishTabCounts || [],
    foreignTabNames: totals.foreignTabNames || [],
    foreignTabCounts: totals.foreignTabCounts || [],
    titleEpisodeTabs: totals.titleEpisodeTabs || [],
    titleChapterTabs: totals.titleChapterTabs || [],
    titleChanges: totals.titleChanges || [],
    titleEpisodeCount: Number(totals.titleEpisodeCount || 0),
    titleChapterCount: Number(totals.titleChapterCount || 0),
    chapterSequenceIssues: totals.chapterSequenceIssues || [],
    tabChapterItems: totals.tabChapterItems || [],
    tabErrors: totals.tabErrors || [],
    tabSucceeded: Number(totals.tabSucceeded || 0),
    hasDuplicateChapter: !!totals.hasDuplicateChapter,
    titleParagraphInsertedTotal: Number(totals.titleParagraphInsertedTotal || 0),
    titleParagraphUpdatedTotal: Number(totals.titleParagraphUpdatedTotal || 0),
    titleLayoutSkippedTotal: Number(totals.titleLayoutSkippedTotal || 0),
    englishSourceDetectedTotal: Number(totals.englishSourceDetectedTotal || 0),
    englishSourceRemovedTotal: Number(totals.englishSourceRemovedTotal || 0),
    englishSourceRemovedParagraphsTotal: Number(totals.englishSourceRemovedParagraphsTotal || 0),
    englishSourceUncertainTabs: totals.englishSourceUncertainTabs || [],
    sourceNoChapterTabs: totals.sourceNoChapterTabs || [],
    endingCleanupChangedTotal: Number(totals.endingCleanupChangedTotal || 0),
    endingPromoRemovedTotal: Number(totals.endingPromoRemovedTotal || 0),
    endingMarkerInsertedTotal: Number(totals.endingMarkerInsertedTotal || 0),
    untranslatedEnglishTabs: totals.untranslatedEnglishTabs || [],
    emptyTabNumbers: totals.emptyTabNumbers || [],
    announcementTabNumbers: totals.announcementTabNumbers || [],
    tailJunkTabGroups: totals.tailJunkTabGroups || [],
    endingPendingPromoTabs: totals.endingPendingPromoTabs || [],
    endingMissingMarkerTabs: totals.endingMissingMarkerTabs || [],
    titleColonFixed: Number(totals.titleColonFixed || 0),
    thaiDigitFixed: Number(totals.thaiDigitFixed || 0),
    episodePrefixFixed: Number(totals.episodePrefixFixed || 0),
    untranslatedChecked: Number(totals.untranslatedChecked || 0)
  });
}

function mergeBatchTotals_(base, add) {
  base = summarizeBatchTotals_(base);
  add = summarizeBatchTotals_(add);

  base.tabChecked += add.tabChecked;
  base.tabTotal = Math.max(base.tabTotal, add.tabTotal);
  base.replacedEmDashCount += add.replacedEmDashCount;
  base.replacedWawCount += add.replacedWawCount;
  base.latinSpecialRemovedTotal += add.latinSpecialRemovedTotal;
  base.nonThaiCount += add.nonThaiCount;
  base.paragraphCount += add.paragraphCount;
  base.spacingCount += add.spacingCount;
  base.blankRemoved += add.blankRemoved;
  base.removedCount += add.removedCount;
  base.breakPairsTotal += add.breakPairsTotal;
  base.removedTitleParensTotal += add.removedTitleParensTotal;
  base.duplicateChapterHeadingRemovedTotal += add.duplicateChapterHeadingRemovedTotal;
  base.duplicateChapterTitleRemovedTotal += add.duplicateChapterTitleRemovedTotal;
  base.longEnglishParagraphCount += add.longEnglishParagraphCount;
  base.titleEpisodeCount += add.titleEpisodeCount;
  base.titleChapterCount += add.titleChapterCount;
  base.tabSucceeded += add.tabSucceeded;
  base.hasDuplicateChapter = base.hasDuplicateChapter || add.hasDuplicateChapter;
  base.titleParagraphInsertedTotal += add.titleParagraphInsertedTotal;
  base.titleParagraphUpdatedTotal += add.titleParagraphUpdatedTotal;
  base.titleLayoutSkippedTotal += add.titleLayoutSkippedTotal;
  base.englishSourceDetectedTotal += add.englishSourceDetectedTotal;
  base.englishSourceRemovedTotal += add.englishSourceRemovedTotal;
  base.englishSourceRemovedParagraphsTotal += add.englishSourceRemovedParagraphsTotal;
  base.endingCleanupChangedTotal += add.endingCleanupChangedTotal;
  base.endingPromoRemovedTotal += add.endingPromoRemovedTotal;
  base.endingMarkerInsertedTotal += add.endingMarkerInsertedTotal;

  (add.englishSourceUncertainTabs || []).forEach(function(item) {
    var exists = base.englishSourceUncertainTabs.some(function(x) {
      return Number(x.tabIndex || 0) === Number(item.tabIndex || 0);
    });
    if (!exists) base.englishSourceUncertainTabs.push(item);
  });
  (add.sourceNoChapterTabs || []).forEach(function(item) {
    var exists = base.sourceNoChapterTabs.some(function(x) {
      return Number(x.tabIndex || 0) === Number(item.tabIndex || 0);
    });
    if (!exists) base.sourceNoChapterTabs.push(item);
  });
  (add.untranslatedEnglishTabs || []).forEach(function(item) {
    var exists = base.untranslatedEnglishTabs.some(function(x) {
      return Number(x.tabNo || 0) === Number(item.tabNo || 0);
    });
    if (!exists) base.untranslatedEnglishTabs.push(item);
  });

  (add.longEnglishTabNumbers || []).forEach(function(tabNo) {
    if (base.longEnglishTabNumbers.indexOf(tabNo) === -1) base.longEnglishTabNumbers.push(tabNo);
  });
  base.longEnglishTabNumbers.sort(function(a, b) { return Number(a) - Number(b); });
  (add.longEnglishTabCounts || []).forEach(function(item) { base.longEnglishTabCounts.push(item); });

  (add.foreignTabNames || []).forEach(function(name) {
    if (base.foreignTabNames.indexOf(name) === -1) base.foreignTabNames.push(name);
  });
  (add.foreignTabCounts || []).forEach(function(item) { base.foreignTabCounts.push(item); });
  (add.titleEpisodeTabs || []).forEach(function(name) {
    if (base.titleEpisodeTabs.indexOf(name) === -1) base.titleEpisodeTabs.push(name);
  });
  (add.titleChapterTabs || []).forEach(function(name) {
    if (base.titleChapterTabs.indexOf(name) === -1) base.titleChapterTabs.push(name);
  });
  (add.titleChanges || []).forEach(function(item) { base.titleChanges.push(item); });
  (add.chapterSequenceIssues || []).forEach(function(item) { base.chapterSequenceIssues.push(item); });
  (add.tabErrors || []).forEach(function(item) {
    var exists = base.tabErrors.some(function(x) {
      return Number(x.tabIndex || 0) === Number(item.tabIndex || 0);
    });
    if (!exists) base.tabErrors.push(item);
  });
  (add.tabChapterItems || []).forEach(function(item) {
    var exists = (base.tabChapterItems || []).some(function(x) {
      return Number(x.tabIndex || 0) === Number(item.tabIndex || 0) && String(x.tab || '') === String(item.tab || '');
    });
    if (!exists) base.tabChapterItems.push(item);
  });

  ['emptyTabNumbers', 'announcementTabNumbers', 'endingPendingPromoTabs', 'endingMissingMarkerTabs'].forEach(function(key) {
    base[key] = base[key] || [];
    (add[key] || []).forEach(function(n) {
      var v = Number(n);
      if (!isNaN(v) && base[key].indexOf(v) === -1) base[key].push(v);
    });
    base[key].sort(function(a, b) { return a - b; });
  });

  base.tailJunkTabGroups = base.tailJunkTabGroups || [];
  (add.tailJunkTabGroups || []).forEach(function(item) {
    var exists = base.tailJunkTabGroups.some(function(x) {
      return Number(x.tabIndex || 0) === Number(item.tabIndex || 0) && String(x.group || '') === String(item.group || '');
    });
    if (!exists) base.tailJunkTabGroups.push(item);
  });

  base.titleColonFixed = Number(base.titleColonFixed || 0) + Number(add.titleColonFixed || 0);
  base.thaiDigitFixed = Number(base.thaiDigitFixed || 0) + Number(add.thaiDigitFixed || 0);
  base.episodePrefixFixed = Number(base.episodePrefixFixed || 0) + Number(add.episodePrefixFixed || 0);
  base.untranslatedChecked = Number(base.untranslatedChecked || 0) + Number(add.untranslatedChecked || 0);

  return base;
}

function legacyBatchGetFirstChapterItemFromRunResult_(result, tabName, tabIndex) {
  result = result || {};
  var seq = result.chapterSequence || {};
  var chapters = seq.chapters || [];
  var first = chapters.length ? chapters[0] : null;

  return {
    tab: tabName,
    tabIndex: Number(tabIndex || 0),
    chapterNumber: first ? Number(first.chapterNumber) : null,
    paragraphIndex: first ? Number(first.paragraphIndex || 0) : null,
    contentDigest: first ? String(first.contentDigest || '') : '',
    contentSimilarityHash: first ? String(first.contentSimilarityHash || '') : '',
    contentSimilarityLength: first ? Number(first.contentSimilarityLength || 0) : 0
  };
}

function extractNumberFromTabTitle_(title) {
  return extractChapterNumberFromText_(title);
}

function legacyBatchBuildChapterSequenceIssuesFromTabItems_(items) {
  items = (items || []).slice().sort(function(a, b) {
    return Number(a.tabIndex || 0) - Number(b.tabIndex || 0);
  });

  var issues = [];
  var hasDuplicateChapter = false;
  var seen = {};
  var numbered = [];

  items.forEach(function(item) {
    var num = item.chapterNumber == null || item.chapterNumber === '' ? null : Number(item.chapterNumber);

    if (num == null || isNaN(num)) {
      issues.push({
        tab: item.tab,
        tabIndex: item.tabIndex,
        type: 'ไม่พบเลขบท',
        expected: null,
        previous: null,
        current: null,
        paragraphIndex: item.paragraphIndex || null,
        text: item.text || ''
      });
      return;
    }

    if (seen[String(num)]) {
      hasDuplicateChapter = true;
      issues.push({
        tab: item.tab,
        tabIndex: item.tabIndex,
        type: 'เลขซ้ำ',
        expected: seen[String(num)].chapterNumber + 1,
        previous: seen[String(num)].chapterNumber,
        current: num,
        previousTab: seen[String(num)].tab,
        paragraphIndex: item.paragraphIndex || null,
        text: item.text || ''
      });
    } else {
      seen[String(num)] = item;
    }

    numbered.push({
      tab: item.tab,
      tabIndex: item.tabIndex,
      chapterNumber: num,
      paragraphIndex: item.paragraphIndex || null,
      text: item.text || ''
    });
  });

  for (var i = 1; i < numbered.length; i++) {
    var prev = numbered[i - 1];
    var curr = numbered[i];
    var expected = Number(prev.chapterNumber) + 1;

    if (Number(curr.chapterNumber) !== expected) {
      var type = 'ไม่ต่อเนื่อง';
      if (Number(curr.chapterNumber) === Number(prev.chapterNumber)) {
        type = 'เลขซ้ำ';
        hasDuplicateChapter = true;
      } else if (Number(curr.chapterNumber) < Number(prev.chapterNumber)) {
        type = 'เลขย้อนหลัง';
      } else if (Number(curr.chapterNumber) > expected) {
        type = 'เลขข้าม';
      }

      var alreadyDuplicate = issues.some(function(x) {
        return x.type === 'เลขซ้ำ' && Number(x.current) === Number(curr.chapterNumber) && Number(x.tabIndex) === Number(curr.tabIndex);
      });

      if (!(type === 'เลขซ้ำ' && alreadyDuplicate)) {
        issues.push({
          tab: curr.tab,
          tabIndex: curr.tabIndex,
          type: type,
          expected: expected,
          previous: prev.chapterNumber,
          current: curr.chapterNumber,
          previousTab: prev.tab,
          paragraphIndex: curr.paragraphIndex || null,
          text: curr.text || ''
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues: issues,
    hasDuplicateChapter: hasDuplicateChapter,
    totalFound: numbered.length,
    items: items
  };
}


/* ===== Missing functions restored ===== */
function legacyBatchRunAllChecks_() {
  const rep = replaceEmDashWithEllipsis();
  const replacedEmDashCount = Number(rep?.emDashCount || 0), replacedWawCount = Number(rep?.wawCount || 0);
  const latinSpecialRemoved = removeLatinBasedSpecialCharacters();
  const nonThaiCount = highlightForeignCharacters();

  // V11.7: ลบ [เลขบท] : ตั้งแต่ต้นรอบตรวจก่อนจัดหัวบท
  // แล้วลบซ้ำอีกครั้งหลังจัดหัวบท เผื่อมีบรรทัดถูกย้าย/แยกในระหว่างตรวจ
  const removedLeadingBracketTagsBefore = removeLeadingBracketTagsNearChapter_();
  const titleReport = titleConvertAndReport_();
  const removedLeadingBracketTagsAfterTitle = removeLeadingBracketTagsNearChapter_();

  const removedTitleParens = removeParenthesesInChapterTitle();
  // V11.12: หัวบทต้องอยู่ paragraph เดียวกับชื่อบท จึงรวมกลับแทนการแยกบรรทัด
  const mergedTitleLine = mergeChapterTitleBackInActiveTab_();
  const duplicateChapterHeadingRemoved = removeDuplicateChapterHeadingLines_();
  const duplicateChapterTitleRemoved = removeDuplicateChapterTitleLines_();
  const duplicateBracketChapterRemoved = removeDuplicateBracketChapterLine_();
  const removedLeadingBracketTagsAfterSplit = removeLeadingBracketTagsNearChapter_();
  const removedLeadingBracketTags = typeof mergeLeadingBracketRemovalReports_ === 'function'
    ? mergeLeadingBracketRemovalReports_(removedLeadingBracketTagsBefore, removedLeadingBracketTagsAfterTitle, removedLeadingBracketTagsAfterSplit)
    : (removedLeadingBracketTagsBefore || removedLeadingBracketTagsAfterTitle || removedLeadingBracketTagsAfterSplit);

  const breakPairs = breakAdjacentQuoteAndBracketPairs();
  const bracketStatusSplit = splitBracketedStatusBlocks_();
  const paragraphCount = formatParagraphIndent();
  const spacingCount = setParagraphSpacing(10);
  const blankRemoved = removeAllBlankLines();
  setFontToSarabun16();
  const removedCount = removeEnglishInParentheses(false);
  removeThaiNoteParentheses();
  if (nonThaiCount === 0) underlineFirstLine();

  const chapterSequence = checkChapterSequenceInBody_();

  return {
    replacedEmDashCount,
    replacedWawCount,
    latinSpecialRemoved,
    nonThaiCount,
    paragraphCount,
    spacingCount,
    blankRemoved,
    removedCount,
    breakPairs,
    titleReport,
    removedLeadingBracketTags,
    bracketStatusSplit,
    removedTitleParens,
    splitTitleLine: { changed: 0, from: "", to: "" },
    mergedTitleLine,
    duplicateChapterHeadingRemoved,
    duplicateChapterTitleRemoved,
    duplicateBracketChapterRemoved,
    chapterSequence
  };
}

function legacyBatchRunAllChecksWithAlert_() {
  if (typeof resetForeignWordAllowListCache_ === 'function') resetForeignWordAllowListCache_();
  const result = runAllChecksAllTabs();
  const epTabs = result.titleEpisodeTabs || [], chTabs = result.titleChapterTabs || [];
  const changedWords = (result.titleEpisodeCount || 0) + (result.titleChapterCount || 0);
  const lines = [
    `🧾 ตรวจแล้ว: ${result.tabChecked}/${result.tabTotal} แท็บ`,
    `🔁 แทนที่ "—" เป็น "..." แล้ว ${result.replacedEmDashCount} ตำแหน่ง`,
    `🔁 แก้ "و" เป็น "ล" แล้ว ${result.replacedWawCount} ตำแหน่ง`,
    `🗑️ ลบอักษรละตินพิเศษแล้ว ${result.latinSpecialRemovedTotal} ตัว`,
    `🔍 พบตัวอักษรต่างประเทศรวม ${result.nonThaiCount} ตัว`,
    `↩️ แยกบรรทัดรวม ${result.breakPairsTotal} จุด`,
    `📑 จัดรูปแบบย่อหน้ารวม ${result.paragraphCount} ย่อหน้า`,
    `📏 เว้นระยะห่างรวม ${result.spacingCount} ย่อหน้า`,
    `🧹 ลบบรรทัดว่างรวม ${result.blankRemoved} บรรทัด`,
    `🗑️ ลบคำในวงเล็บรวม ${result.removedCount} ตำแหน่ง`,
    `🏷️ ลบวงเล็บท้ายชื่อตอนรวม ${result.removedTitleParensTotal} จุด`,
    `🧹 ลบบรรทัดหัวบทซ้ำรวม ${result.duplicateChapterHeadingRemovedTotal || 0} บรรทัด`,
    `🧹 ลบชื่อบทซ้ำรวม ${result.duplicateChapterTitleRemovedTotal || 0} บรรทัด`,
    "",
    result.foreignTabNames && result.foreignTabNames.length > 0
      ? `📌 แท็บที่พบตัวอักษรต่างประเทศ:\n- ${result.foreignTabNames.join("\n- ")}`
      : "💯 ไม่พบตัวอักษรต่างประเทศในทุกแท็บ",
    "",
    `🪄 เปลี่ยนเป็นบทที่ ${changedWords} คำ`,
  ];

  if (changedWords) {
    if (epTabs.length) lines.push(`- ตอนที่→บทที่: ${epTabs.length} แท็บ\n  • ${epTabs.join("\n  • ")}`);
    if (chTabs.length) lines.push(`- Chapter→บทที่: ${chTabs.length} แท็บ\n  • ${chTabs.join("\n  • ")}`);
  }

  const chapterIssues = result.chapterSequenceIssues || [];
  const hasDuplicate = !!result.hasDuplicateChapter || chapterIssues.some(function(x) { return x.type === 'เลขซ้ำ'; });
  const hasNonContinuous = chapterIssues.some(function(x) { return x.type !== 'เลขซ้ำ'; });
  lines.push("");
  if (hasNonContinuous) lines.push("⚠️ เลขบทไม่ต่อเนื่อง");
  if (hasDuplicate) lines.push("⚠️ เลขบทซ้ำ");
  if (!hasNonContinuous && !hasDuplicate) lines.push("✅ เลขบทต่อเนื่อง");

  lines.push("", "🎉 ดำเนินการเรียบร้อยแล้ว!");
  DocumentApp.getUi().alert(lines.join("\n"));
  return result;
}

function legacyBatchUnderlineFirstLine_() {
  const paras = getActiveBody_().getParagraphs(), p = paras[0];
  if (!p) return false;
  const t = p.editAsText();
  t.setUnderline(true); t.setBold(true);
  return true;
}

function legacyBatchCollectChapterNumbersFromBody_(body) {
  const paras = body.getParagraphs();
  const out = [];

  for (let i = 0; i < paras.length; i++) {
    const text = cleanText_(paras[i].getText());
    if (!text || text === NOTE_TEXT_) continue;

    const line = normalizeChapterLine_(text);
    if (!isChapterLineText_(line)) continue;

    const num = extractChapterNumberFromText_(line);
    if (num != null) {
      const digestDocumentId = getCheckerContentDigestDocumentId_();
      const similarity = out.length === 0
        ? buildChapterContentSimilarityFingerprint_(paras, i, digestDocumentId)
        : { hash: '', length: 0 };
      out.push({
        paragraphIndex: i + 1,
        text: text,
        chapterNumber: num,
        contentDigest: buildChapterContentDigest_(paras, i, digestDocumentId),
        contentSimilarityHash: similarity.hash,
        contentSimilarityLength: similarity.length
      });
    }
  }

  return out;
}

// ดึงเนื้อเรื่องช่วงต้นบท (ข้ามหัวบท/ชื่อบท/แผงสถานะ) มาทำลายเซ็นเทียบซ้ำ
function legacyBatchBuildChapterContentSignature_(paras, headingIndex) {
  var collected = '';
  var limit = Math.min(paras.length, headingIndex + 30);

  for (var j = headingIndex + 1; j < limit; j++) {
    var p = paras[j];
    var raw = cleanText_(p.getText());
    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;
    if (isChapterLineText_(normalizeChapterLine_(raw))) break;

    // ข้ามบรรทัดชื่อบท (ตัวหนา+ขีดเส้นใต้) เฉพาะตอนยังไม่เก็บเนื้อหา
    try {
      if (collected.length === 0 &&
          typeof isBoldUnderlineParagraph_ === 'function' &&
          isBoldUnderlineParagraph_(p)) continue;
    } catch (e) {}

    collected += raw + ' ';
    if (collected.length >= 160) break;
  }

  return normalizeContentSignature_(collected);
}

function legacyBatchNormalizeContentSignature_(s) {
  return String(s || '')
    .replace(INVIS_RE_, '')
    .replace(/[\s\u00A0]+/g, '')
    .replace(/[“”"'‘’.,!?…\-–—()（）\[\]【】]/g, '')
    .slice(0, 120);
}

function legacyBatchCheckChapterSequenceInBody_() {
  const body = getActiveBody_();
  const chapters = collectChapterNumbersFromBody_(body);
  const issues = [];

  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1];
    const curr = chapters[i];
    const expected = prev.chapterNumber + 1;

    if (curr.chapterNumber !== expected) {
      let type = 'ไม่ต่อเนื่อง';
      if (curr.chapterNumber === prev.chapterNumber) type = 'เลขซ้ำ';
      else if (curr.chapterNumber < prev.chapterNumber) type = 'เลขย้อนหลัง';
      else if (curr.chapterNumber > expected) type = 'เลขข้าม';

      issues.push({
        type: type,
        expected: expected,
        previous: prev.chapterNumber,
        current: curr.chapterNumber,
        paragraphIndex: curr.paragraphIndex,
        text: curr.text
      });
    }
  }

  return {
    ok: issues.length === 0,
    totalFound: chapters.length,
    chapters: chapters,
    issues: issues
  };
}

function buildChapterSequenceNote_(result) {
  if (!result || !result.totalFound) {
    return 'ไม่พบเลขบท';
  }

  if (result.hasDuplicate) {
    return 'พบเลขบทซ้ำ';
  }

  return result.ok ? 'เลขบทต่อเนื่อง' : 'พบเลขบทไม่ต่อเนื่อง';
}

function checkTabTitleSequence_(doc) {
  const tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  const items = [];
  const issues = [];

  if (!tabs.length) {
    return {
      ok: true,
      totalFound: 0,
      items: [],
      issues: []
    };
  }

  tabs.forEach(function(tab, idx) {
    const title = getTabNameSafe_(tab, idx);
    const number = extractNumberFromTabTitle_(title);

    items.push({
      index: idx + 1,
      title: title,
      number: number
    });
  });

  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const curr = items[i];

    if (prev.number == null || curr.number == null) continue;

    const expected = prev.number + 1;

    if (curr.number !== expected) {
      let type = 'ไม่ต่อเนื่อง';
      if (curr.number === prev.number) type = 'เลขซ้ำ';
      else if (curr.number < prev.number) type = 'เลขย้อนหลัง';
      else if (curr.number > expected) type = 'เลขข้าม';

      issues.push({
        type: type,
        expected: expected,
        previous: prev.number,
        current: curr.number,
        tabTitle: curr.title,
        tabIndex: curr.index
      });
    }
  }

  return {
    ok: issues.length === 0,
    totalFound: items.filter(function(x) { return x.number != null; }).length,
    items: items,
    issues: issues
  };
}

function buildTabTitleSequenceNote_(result) {
  if (!result || !result.items || !result.items.length) {
    return 'ไม่พบชื่อแท็บ';
  }

  if (result.ok) {
    return 'ชื่อแท็บต่อเนื่อง';
  }

  const first = (result.issues || []).find(function(x) {
    return String(x.tabTitle || '').trim();
  });

  if (!first) {
    return 'ชื่อแท็บไม่ต่อเนื่อง';
  }

  return 'ชื่อแท็บไม่ต่อเนื่อง: ' + String(first.tabTitle || '').trim();
}
function legacyBatchExtractChapterNumberFromText_(text) {
  const s = thaiDigitsToArabic_(String(text || ''))
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return null;

  let m = s.match(/^(?:บทที่|ตอนที่)\s*([0-9]+)/i);
  if (m) return Number(m[1]);

  m = s.match(/^chapter\s*([0-9]+)/i);
  if (m) return Number(m[1]);

  m = s.match(/\b(?:บทที่|ตอนที่|chapter)\s*([0-9]+)\b/i);
  if (m) return Number(m[1]);

  return null;
}

function legacyBatchOpenDocByIdSafe_(docId) {
  var id = String(docId || '').trim();
  if (!id) throw new Error('docId ว่าง');

  var lastErr = null;

  for (var i = 0; i < 3; i++) {
    try {
      return DocumentApp.openById(id);
    } catch (e) {
      lastErr = e;
      Utilities.sleep(500 * (i + 1));
    }
  }

  throw new Error('เปิดเอกสารไม่ได้: ' + id + ' | ' + (lastErr && lastErr.message ? lastErr.message : lastErr));
}

function extractBracketOnlyChapterNumber_(text) {
  const s = thaiDigitsToArabic_(String(text || ''))
    .replace(INVIS_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const m = s.match(/^\[\s*([0-9]+)\s*\]$/);
  return m ? Number(m[1]) : null;
}

/** 🧹 ลบหัวบทซ้ำ ทั้งแบบซ้ำในบรรทัดเดียวและซ้ำติดกัน เช่น
 * บทที่ 10บทที่ 10  -> บทที่ 10
 * บทที่ 393\nบทที่ 393 -> บทที่ 393
 * รองรับ: บทที่ / ตอนที่ / Chapter และเลขไทย
 */
function legacyBatchRemoveDuplicateChapterHeadingLines_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let removed = 0;
  const removedTexts = [];

  function normalizeChapterOnlyKey_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return null;

    let m = s.match(/^(บทที่|ตอนที่)\s*([0-9]+)$/i);
    if (m) return "บทที่ " + Number(m[2]);

    m = s.match(/^chapter\s*([0-9]+)$/i);
    if (m) return "บทที่ " + Number(m[1]);

    return null;
  }

  function fixInlineDuplicateHeading_(p) {
    const raw = cleanText_(p.getText());
    if (!raw || raw === NOTE_TEXT_) return 0;

    const s = thaiDigitsToArabic_(raw)
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    let m = s.match(/^(บทที่|ตอนที่)\s*([0-9]+)\s*(?:(?:บทที่|ตอนที่)\s*\2\s*)+$/i);
    if (m) {
      const newText = "บทที่ " + Number(m[2]);
      if (raw !== newText) {
        removedTexts.push(raw);
        p.setText(newText);
        if (typeof setHeadingLineStyle_ === "function") setHeadingLineStyle_(p);
        return 1;
      }
      return 0;
    }

    m = s.match(/^chapter\s*([0-9]+)\s*(?:chapter\s*\1\s*)+$/i);
    if (m) {
      const newText = "บทที่ " + Number(m[1]);
      if (raw !== newText) {
        removedTexts.push(raw);
        p.setText(newText);
        if (typeof setHeadingLineStyle_ === "function") setHeadingLineStyle_(p);
        return 1;
      }
    }

    return 0;
  }

  // 1) แก้หัวบทที่เบิ้ลอยู่ในบรรทัดเดียว เช่น บทที่ 10บทที่ 10
  for (let i = 0; i < paras.length; i++) {
    removed += fixInlineDuplicateHeading_(paras[i]);
  }

  // 2) ลบบรรทัดหัวบทซ้ำที่ติดกัน
  for (let i = paras.length - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];

    const currKey = normalizeChapterOnlyKey_(curr.getText());
    const prevKey = normalizeChapterOnlyKey_(prev.getText());

    if (!currKey || !prevKey) continue;

    if (currKey === prevKey) {
      removedTexts.push(cleanText_(curr.getText()));
      removeParaSafely_(curr);
      removed++;
    }
  }

  return {
    removed: removed,
    removedTexts: removedTexts
  };
}



/** 🧹 ลบชื่อบทซ้ำติดกันหลังหัวบท เช่น
 * บทที่ 236
 * ความกังวลขององค์ไทเฮาเจียงหนานเฟิ่ง!
 * ความกังวลขององค์ไทเฮาเจียงหนานเฟิ่ง!
 * ให้เหลือชื่อบทแค่ 1 บรรทัด
 */
function legacyBatchRemoveDuplicateChapterTitleLines_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let removed = 0;
  const removedTexts = [];

  function isChapterOnlyHeadingText_(text) {
    const s = thaiDigitsToArabic_(cleanText_(text))
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return false;

    return /^(บทที่|ตอนที่)\s*[0-9]+$/i.test(s) || /^chapter\s*[0-9]+$/i.test(s);
  }

  function normalizeTitleKey_(text) {
    const s = cleanText_(text)
      .replace(INVIS_RE_, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!s || s === NOTE_TEXT_) return null;
    if (isStatusPanelLine_(s)) return null;
    if (isChapterOnlyHeadingText_(s)) return null;
    if (isChapterLineText_(normalizeChapterLine_(s))) return null;

    return s;
  }

  function findPrevMeaningfulIndex_(startIndex) {
    for (let i = startIndex; i >= 0; i--) {
      const t = cleanText_(paras[i].getText());
      if (!t || t === NOTE_TEXT_) continue;
      return i;
    }
    return -1;
  }

  // วนจากล่างขึ้นบน ป้องกัน index เพี้ยนตอนลบ paragraph
  for (let i = paras.length - 1; i > 0; i--) {
    const curr = paras[i];
    const prev = paras[i - 1];

    const currKey = normalizeTitleKey_(curr.getText());
    const prevKey = normalizeTitleKey_(prev.getText());

    if (!currKey || !prevKey) continue;
    if (currKey !== prevKey) continue;

    // เช็กว่าบรรทัดก่อนหน้าคู่ซ้ำคือหัวบท เช่น บทที่ 236
    const beforeIdx = findPrevMeaningfulIndex_(i - 2);
    if (beforeIdx < 0) continue;

    const beforeText = paras[beforeIdx].getText();
    if (!isChapterOnlyHeadingText_(beforeText)) continue;

    removedTexts.push(cleanText_(curr.getText()));
    removeParaSafely_(curr);
    removed++;
  }

  return {
    removed: removed,
    removedTexts: removedTexts
  };
}

function legacyBatchRemoveDuplicateBracketChapterLine_() {
  const body = getActiveBody_();
  const paras = body.getParagraphs();

  let headingIdx = -1;
  let headingNumber = null;

  for (let i = 0; i < Math.min(paras.length, 20); i++) {
    const text = cleanText_(paras[i].getText());
    if (!text || text === NOTE_TEXT_) continue;

    const num = extractChapterNumberFromText_(text);
    if (num != null && isChapterLineText_(normalizeChapterLine_(text))) {
      headingIdx = i;
      headingNumber = num;
      break;
    }
  }

  if (headingIdx === -1 || headingNumber == null) {
    return { removed: 0, chapterNumber: null };
  }

  let removed = 0;
  let removedTexts = [];

  const bracketOnlyRe = /^\[\s*([0-9]+)\s*\]$/;
  const bracketAtEndRe = /\s*\[\s*([0-9]+)\s*\]\s*$/;

  for (let j = headingIdx + 1; j < Math.min(paras.length, headingIdx + 6); j++) {
    const p = paras[j];
    const text = cleanText_(p.getText());
    if (!text) continue;

    if (text === NOTE_TEXT_) continue;
    if (isChapterLineText_(normalizeChapterLine_(text))) break;
    if (isStatusPanelLine_(text)) break;

    const onlyMatch = text.match(bracketOnlyRe);
    if (onlyMatch) {
      const num = Number(onlyMatch[1]);
      if (num === headingNumber) {
        removedTexts.push(text);
        removeParaSafely_(p);
        removed++;
      }
      continue;
    }

    const endMatch = text.match(bracketAtEndRe);
    if (endMatch) {
      const num = Number(endMatch[1]);
      if (num === headingNumber) {
        const newText = text.replace(bracketAtEndRe, '').replace(/\s+$/g, '');
        if (newText && newText !== text) {
          p.setText(newText);
          removedTexts.push(text);
          removed++;
        }
      }
    }
  }

  return {
    removed: removed,
    chapterNumber: headingNumber,
    removedTexts: removedTexts
  };
}

function addTabRunResultToBatchTotals_(batchTotals, result, tabName, tabIndex) {
  batchTotals.tabChecked++;
  batchTotals.tabSucceeded++;
  batchTotals.replacedEmDashCount += Number(result.replacedEmDashCount || 0);
  batchTotals.replacedWawCount += Number(result.replacedWawCount || 0);
  batchTotals.latinSpecialRemovedTotal += Number(result.latinSpecialRemoved && result.latinSpecialRemoved.total || 0);
  batchTotals.nonThaiCount += Number(result.nonThaiCount || 0);
  batchTotals.paragraphCount += Number(result.paragraphCount || 0);
  batchTotals.spacingCount += Number(result.spacingCount || 0);
  batchTotals.blankRemoved += Number(result.blankRemoved || 0);
  batchTotals.removedCount += Number(result.removedCount || 0);
  batchTotals.breakPairsTotal += Number(result.breakPairs && result.breakPairs.total || 0);
  batchTotals.removedTitleParensTotal += Number(result.removedTitleParens || 0);
  batchTotals.duplicateChapterHeadingRemovedTotal += Number(result.duplicateChapterHeadingRemoved && result.duplicateChapterHeadingRemoved.removed || 0);
  batchTotals.duplicateChapterTitleRemovedTotal += Number(result.duplicateChapterTitleRemoved && result.duplicateChapterTitleRemoved.removed || 0);

  if ((result.nonThaiCount || 0) > 0) {
    if (batchTotals.foreignTabNames.indexOf(tabName) === -1) batchTotals.foreignTabNames.push(tabName);
    batchTotals.foreignTabCounts.push({ name: tabName, count: Number(result.nonThaiCount || 0) });
  }

  if (result.titleReport && result.titleReport.changed) {
    if (result.titleReport.episodeChanged) {
      if (batchTotals.titleEpisodeTabs.indexOf(tabName) === -1) batchTotals.titleEpisodeTabs.push(tabName);
      batchTotals.titleEpisodeCount++;
      batchTotals.titleChanges.push({
        tab: tabName, type: 'ตอนที่→บทที่',
        from: result.titleReport.from, to: result.titleReport.to
      });
    } else if (result.titleReport.chapterChanged) {
      if (batchTotals.titleChapterTabs.indexOf(tabName) === -1) batchTotals.titleChapterTabs.push(tabName);
      batchTotals.titleChapterCount++;
      batchTotals.titleChanges.push({
        tab: tabName, type: 'Chapter→บทที่',
        from: result.titleReport.from, to: result.titleReport.to
      });
    }
  }

  // ประโยคภาษาอังกฤษยาว: เก็บเฉพาะจำนวนย่อหน้าและหมายเลขแท็บ
  var longEnglishInTab = Number(result.longEnglishParagraphCount || 0);
  if (longEnglishInTab > 0) {
    batchTotals.longEnglishParagraphCount += longEnglishInTab;
    if (batchTotals.longEnglishTabNumbers.indexOf(Number(tabIndex)) === -1) {
      batchTotals.longEnglishTabNumbers.push(Number(tabIndex));
    }
    batchTotals.longEnglishTabCounts.push({ tabNo: Number(tabIndex), count: longEnglishInTab });
  }

  batchTotals.tabChapterItems.push(getFirstChapterItemFromRunResult_(result, tabName, tabIndex));
  var seq = result.chapterSequence || {};
  (seq.issues || []).forEach(function(issue) {
    batchTotals.chapterSequenceIssues.push({
      tab: tabName,
      type: issue.type,
      expected: issue.expected,
      previous: issue.previous,
      current: issue.current,
      paragraphIndex: issue.paragraphIndex,
      text: issue.text
    });
    if (issue.type === 'เลขซ้ำ') batchTotals.hasDuplicateChapter = true;
  });

  accumulateWebAppExtrasIntoBatchTotals_(batchTotals, result, tabName, tabIndex);
}

function scanWholeDocumentChunk(payload) {
  payload = payload || {};
  if (!payload.finalize && typeof resetForeignWordAllowListCache_ === 'function') resetForeignWordAllowListCache_();

  var sheetRow = Number(payload.sheetRow);
  var cursor = Math.max(0, Number(payload.cursor || 0));
  var defaultChunkSize = (typeof WEBAPP_SCAN_CONFIG_ !== 'undefined' && WEBAPP_SCAN_CONFIG_)
    ? Number(WEBAPP_SCAN_CONFIG_.DEFAULT_CHUNK_SIZE || 3)
    : 3;
  var chunkSize = Math.max(1, Number(payload.chunkSize || defaultChunkSize));
  var finalize = !!payload.finalize;
  // lightScan: โหมด "ตรวจแถวที่เลือก" แบบรวมทุกการตรวจ - ไม่จัดฟอร์แมต (ไม่แตะฟอนต์/ย่อหน้า/ระยะห่าง/สี)
  // แก้เนื้อหาเบาเฉพาะ 3 อย่างที่อนุมัติ: — -> ..., ลบ : หลังเลขบท, เลขไทย -> อารบิก
  // สรุปผลแยก 3 หมวด: L = ภาษา, M = เลขบท/เนื้อหาซ้ำ, N = อื่น ๆ (แท็บว่าง/ขยะท้ายบท/โปรโมตท้ายบท)
  var lightScan = !!payload.lightScan;
  var execStartedAt = Date.now();
  if (lightScan) lightScanPerfInit_(payload.runId);
  var logChunkPerf_ = (typeof logCheckerScanChunkPerf_ === 'function')
    ? logCheckerScanChunkPerf_
    : function() {};
  var accumulated = summarizeBatchTotals_(payload.accumulated || {});

  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = resolveMappedRowByIdentity_(sheetRow, payload.docId);
  sheetRow = row.sheetRow;
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var doc = openDocByIdSafe_(row.docId);
  lightScanPerfCount_('docOpens');
  var tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  lightScanPerfCount_('tabsListed', tabs.length);
  var tabTotal = tabs.length || 1;

  accumulated.tabTotal = Math.max(Number(accumulated.tabTotal || 0), tabTotal);

  if (finalize) {
    var finalizeStartedAt = Date.now();

    // ===== Phase A: FINALIZE_SUMMARY - รวม sequence + หมายเหตุ + เขียนผลลง Google Sheets ก่อนเสมอ =====
    var finalSummary = summarizeBatchTotals_(accumulated);
    var crossTabSeq = finalSummary.tabErrors.length
      ? { ok: false, issues: [], hasDuplicateChapter: false, incomplete: true }
      : buildChapterSequenceIssuesFromTabItems_(finalSummary.tabChapterItems || []);

    (crossTabSeq.issues || []).forEach(function(issue) {
      finalSummary.chapterSequenceIssues.push(issue);
    });
    finalSummary.hasDuplicateChapter = finalSummary.hasDuplicateChapter || !!crossTabSeq.hasDuplicateChapter;
    finalSummary.contentDuplicates = buildContentDuplicateReport_(finalSummary.tabChapterItems || []);

    // ===== Phase B: FINALIZE_LANGUAGE - ใช้ผลตรวจภาษาที่สะสมมาจากแต่ละแท็บระหว่าง chunk loop
    // (accumulateWebAppExtrasIntoBatchTotals_ คำนวณตอนสแกนแท็บอยู่แล้ว นับเป็น context เดียวกัน)
    // ห้ามเปิด getBody()/getText() ของทุกแท็บซ้ำอีกรอบตรงนี้ - ถ้าไม่มีข้อมูลสะสม (เช่น finalize
    // ถูกเรียกตรงจาก retry เก่าที่ไม่ผ่าน chunk loop) ค่อย fallback ไปสแกนแบบเดิมเป็นทางเลือกสำรอง
    var untranslatedTabs = finalSummary.untranslatedEnglishTabs || [];
    // coverage: แยก "ตรวจครบแล้วไม่พบ" ออกจาก "ตรวจไม่ครบ" — ตรวจครบแล้วต้องไม่อ่านทุกแท็บซ้ำ
    // (โหมดเต็ม untranslatedChecked เป็น 0 เสมอ จึง fallback แบบเดิมทุกครั้ง)
    var untranslatedCoverage = {
      checked: Number(finalSummary.untranslatedChecked || 0),
      total: Number(finalSummary.tabTotal || 0),
      complete: Number(finalSummary.untranslatedChecked || 0) >= Number(finalSummary.tabTotal || 0) &&
                finalSummary.tabErrors.length === 0
    };
    var untranslatedFallbackRan = false;
    if (!untranslatedTabs.length && !untranslatedCoverage.complete && typeof checkerFindUntranslatedEnglishTabsInDoc_ === 'function') {
      try {
        untranslatedTabs = checkerFindUntranslatedEnglishTabsInDoc_(doc) || [];
        untranslatedFallbackRan = true;
        lightScanPerfCount_('fallbackUntranslatedScans');
      } catch (eLang) {
        untranslatedTabs = [];
      }
    }
    finalSummary.untranslatedCoverage = untranslatedCoverage;
    finalSummary.untranslatedFallbackRan = untranslatedFallbackRan;

    var untranslatedEnglishTabNos = untranslatedTabs.map(function(t) { return t.tabNo; });
    var untranslatedEnglishMessage = (typeof checkerBuildUntranslatedEnglishMessage_ === 'function')
      ? checkerBuildUntranslatedEnglishMessage_(untranslatedTabs)
      : (untranslatedEnglishTabNos.length ? ('แท็บ ' + untranslatedEnglishTabNos.join(', ') + ' ยังไม่แปลเป็นไทย') : '');

    finalSummary.untranslatedEnglishTabs = untranslatedTabs;
    finalSummary.untranslatedEnglishMessage = untranslatedEnglishMessage;

    // ===== lightScan: สรุปผลแยก 3 หมวดลง L/M/N แทนโน้ตรวมเดิมใน L =====
    if (lightScan && typeof buildLightScanColumnNotes_ === 'function') {
      var colNotes = buildLightScanColumnNotes_(finalSummary, doc);
      var lightFailedNos = finalSummary.tabErrors.map(function(item) { return item.tabIndex; });
      if (lightFailedNos.length) {
        colNotes.noteLanguage = mergeCheckerNotes_(
          'ตรวจแท็บไม่สำเร็จ: ' + lightFailedNos.join(', '),
          colNotes.noteLanguage
        );
      }

      updateCheckerFields({
        sheetRow: sheetRow,
        checked: true,
        note: colNotes.noteLanguage
      });
      lightScanPerfCount_('sheetWrites');
      var skippedWrites = [];
      if (!writeLightScanColumnValue_(sheetRow, LIGHT_SCAN_COLUMNS_.SEQUENCE, colNotes.noteSequence)) skippedWrites.push('M');
      if (!writeLightScanColumnValue_(sheetRow, LIGHT_SCAN_COLUMNS_.OTHER, colNotes.noteOther)) skippedWrites.push('N');

      var lightPerf = lightScanPerfSnapshot_();
      if (lightPerf) {
        lightPerf.executionMs = Date.now() - execStartedAt;
        lightPerf.skippedWrites = skippedWrites;
        try { console.log('[LightScanPerf] ' + JSON.stringify(lightPerf)); } catch (eLog) {}
      }

      logChunkPerf_('FINALIZE_SUMMARY_DONE', {
        sheetRow: sheetRow,
        elapsedMs: Date.now() - finalizeStartedAt,
        lightScan: true
      });

      return {
        ok: true,
        docId: row.docId,
        sheetRow: sheetRow,
        finalized: true,
        done: true,
        lightScan: true,
        version: LIGHT_SCAN_VERSION_,
        perf: lightPerf,
        skippedWrites: skippedWrites,
        note: colNotes.noteLanguage,
        noteLanguage: colNotes.noteLanguage,
        noteSequence: colNotes.noteSequence,
        noteOther: colNotes.noteOther,
        row: getMappedRow_(sheetRow),
        summary: sanitizeCheckerPublicSummary_(finalSummary),
        retryState: finalSummary.tabErrors.length
          ? sanitizeCheckerCheckpointSummary_(finalSummary)
          : null,
        crossTabSequence: sanitizeCheckerPublicValue_(crossTabSeq || {}),
        tabRename: { enabled: false, ok: true, result: null, error: '' }
      };
    }

    var note = buildWholeDocumentScanNote_(finalSummary);
    // priority สูงกว่าหมายเหตุปกติ: ขึ้นก่อนเสมอ ต่อท้าย note เดิมด้วย " | " (ไม่ overwrite ของเดิม)
    note = mergeCheckerNotes_(untranslatedEnglishMessage, note);
    if (finalSummary.tabErrors.length) {
      var failedNos = finalSummary.tabErrors.map(function(item) { return item.tabIndex; });
      var failedMessage = 'ตรวจแท็บไม่สำเร็จ: ' + failedNos.join(', ');
      note = mergeCheckerNotes_(failedMessage, note);
    }
    note = addCheckerFreeMarker_(note, isFreeChapterRangeDocument_(doc));

    // V11.5: บันทึกผลตรวจลงชีตก่อนเสมอ แล้วค่อยเรียงชื่อแท็บ
    // เพราะการเรียงชื่อแท็บต้องใช้ Google Docs API และอาจช้า/ติดสิทธิ์/หมดเวลา
    // ถ้าวางไว้ก่อน updateCheckerFields จะทำให้ผู้ใช้เห็นว่า "ตรวจแล้วแต่ไม่บันทึกผล"
    updateCheckerFields({
      sheetRow: sheetRow,
      checked: true,
      note: note
    });

    logChunkPerf_('FINALIZE_SUMMARY_DONE', {
      sheetRow: sheetRow,
      elapsedMs: Date.now() - finalizeStartedAt
    });

    // ===== Phase C: FINALIZE_RENAME - เรียงชื่อแท็บเป็นคำสั่งแยก (ผลตรวจ/หมายเหตุถูกบันทึกไปแล้วข้างบนเสมอ)
    // ปิดเป็นค่าเริ่มต้น (CHECKER_CFG.RENAME_TABS_AFTER_SCAN = false) เพื่อลดเวลา finalize
    // ผู้ใช้เรียงชื่อแท็บผ่านเมนู/ปุ่มแยกได้ (resetTabNamesRow / resetTabNamesSequentialWithAlert)
    // ถ้าเปิดใช้แล้ว Docs API ล้ม/หมดเวลา ต้องไม่ทำให้ผลตรวจหลักที่บันทึกไปแล้วเสียหาย
    var tabRename = { enabled: false, ok: true, result: null, error: '' };
    if (typeof resetTabNamesAfterScanSafe_ === 'function') {
      tabRename = resetTabNamesAfterScanSafe_(doc);
    } else if (!(CHECKER_CFG && CHECKER_CFG.RENAME_TABS_AFTER_SCAN === false) && typeof resetTabNamesInDoc_ === 'function') {
      tabRename.enabled = true;
      try {
        tabRename.result = resetTabNamesInDoc_(doc);
        tabRename.ok = true;
      } catch (e) {
        tabRename.ok = false;
        tabRename.error = String(e && e.message ? e.message : e);
      }
    }

    finalSummary.tabRename = tabRename;
    var clientSummary = sanitizeCheckerPublicSummary_(finalSummary);
    var retryState = finalSummary.tabErrors.length
      ? sanitizeCheckerCheckpointSummary_(finalSummary)
      : null;
    var clientTabRename = sanitizeCheckerPublicValue_(tabRename);
    var clientCrossTabSequence = sanitizeCheckerPublicValue_(crossTabSeq || {});

    return {
      ok: true,
      docId: row.docId,
      sheetRow: sheetRow,
      finalized: true,
      done: true,
      note: note,
      row: getMappedRow_(sheetRow),
      summary: clientSummary,
      retryState: retryState,
      crossTabSequence: clientCrossTabSequence,
      tabRename: clientTabRename
    };
  }

  var batchTotals = summarizeBatchTotals_({
    tabChecked: 0,
    tabTotal: tabTotal,
    replacedEmDashCount: 0,
    replacedWawCount: 0,
    latinSpecialRemovedTotal: 0,
    nonThaiCount: 0,
    paragraphCount: 0,
    spacingCount: 0,
    blankRemoved: 0,
    removedCount: 0,
    breakPairsTotal: 0,
    removedTitleParensTotal: 0,
    duplicateChapterHeadingRemovedTotal: 0,
    duplicateChapterTitleRemovedTotal: 0,
    foreignTabNames: [],
    foreignTabCounts: [],
    titleEpisodeTabs: [],
    titleChapterTabs: [],
    titleChanges: [],
    titleEpisodeCount: 0,
    titleChapterCount: 0,
    chapterSequenceIssues: [],
    tabChapterItems: [],
    tabErrors: [],
    tabSucceeded: 0,
    hasDuplicateChapter: false
  });

  if (!tabs.length) {
    if (cursor === 0) {
      var singleResult = withOpenDocTabContext_(doc, row.tabId, function() {
        var isLight = lightScan && typeof runAllChecksLightScan_ === 'function';
        var checkResult = isLight
          ? runAllChecksLightScan_()
          : runAllChecks();
        if (!isLight) {
          // lightScan คำนวณ untranslated จาก snapshot แล้ว ไม่อ่านซ้ำ
          checkResult.untranslatedEnglishInfo = (typeof computeUntranslatedEnglishInfoForActiveTab_ === 'function')
            ? computeUntranslatedEnglishInfoForActiveTab_()
            : null;
        }
        return checkResult;
      });

      var singleName = row.tabId ? ('แท็บ ' + row.tabId) : 'เอกสารหลัก';

      batchTotals.tabChecked = 1;
      batchTotals.tabSucceeded = 1;
      batchTotals.replacedEmDashCount += Number(singleResult.replacedEmDashCount || 0);
      batchTotals.replacedWawCount += Number(singleResult.replacedWawCount || 0);
      batchTotals.latinSpecialRemovedTotal += Number(singleResult.latinSpecialRemoved && singleResult.latinSpecialRemoved.total || 0);
      batchTotals.nonThaiCount += Number(singleResult.nonThaiCount || 0);
      batchTotals.paragraphCount += Number(singleResult.paragraphCount || 0);
      batchTotals.spacingCount += Number(singleResult.spacingCount || 0);
      batchTotals.blankRemoved += Number(singleResult.blankRemoved || 0);
      batchTotals.removedCount += Number(singleResult.removedCount || 0);
      batchTotals.breakPairsTotal += Number(singleResult.breakPairs && singleResult.breakPairs.total || 0);
      batchTotals.removedTitleParensTotal += Number(singleResult.removedTitleParens || 0);
      batchTotals.duplicateChapterHeadingRemovedTotal += Number(singleResult.duplicateChapterHeadingRemoved && singleResult.duplicateChapterHeadingRemoved.removed || 0);
      batchTotals.duplicateChapterTitleRemovedTotal += Number(singleResult.duplicateChapterTitleRemoved && singleResult.duplicateChapterTitleRemoved.removed || 0);

      if ((singleResult.nonThaiCount || 0) > 0) {
        batchTotals.foreignTabNames.push(singleName);
        batchTotals.foreignTabCounts.push({
          name: singleName,
          count: Number(singleResult.nonThaiCount || 0)
        });
      }

      if (singleResult.titleReport && singleResult.titleReport.changed) {
        if (singleResult.titleReport.episodeChanged) {
          batchTotals.titleEpisodeCount++;
          batchTotals.titleEpisodeTabs.push(singleName);
          batchTotals.titleChanges.push({
            tab: singleName,
            type: 'ตอนที่→บทที่',
            from: singleResult.titleReport.from,
            to: singleResult.titleReport.to
          });
        } else if (singleResult.titleReport.chapterChanged) {
          batchTotals.titleChapterCount++;
          batchTotals.titleChapterTabs.push(singleName);
          batchTotals.titleChanges.push({
            tab: singleName,
            type: 'Chapter→บทที่',
            from: singleResult.titleReport.from,
            to: singleResult.titleReport.to
          });
        }
      }

      // ประโยคภาษาอังกฤษยาวของเอกสารที่ไม่มีแท็บ = แท็บ 1
      var singleLongEnglish = Number(singleResult.longEnglishParagraphCount || 0);
      if (singleLongEnglish > 0) {
        batchTotals.longEnglishParagraphCount += singleLongEnglish;
        batchTotals.longEnglishTabNumbers.push(1);
        batchTotals.longEnglishTabCounts.push({ tabNo: 1, count: singleLongEnglish });
      }

      batchTotals.tabChapterItems.push(getFirstChapterItemFromRunResult_(singleResult, singleName, 1));

      var singleSeq = singleResult.chapterSequence || {};
      (singleSeq.issues || []).forEach(function(issue) {
        batchTotals.chapterSequenceIssues.push({
          tab: singleName,
          type: issue.type,
          expected: issue.expected,
          previous: issue.previous,
          current: issue.current,
          paragraphIndex: issue.paragraphIndex,
          text: issue.text
        });

        if (issue.type === 'เลขซ้ำ') batchTotals.hasDuplicateChapter = true;
      });

      accumulateWebAppExtrasIntoBatchTotals_(batchTotals, singleResult, singleName, 1);
      if (lightScan) {
        accumulateLightScanTabExtras_(batchTotals, singleResult, 1);
        batchTotals.untranslatedChecked = (batchTotals.untranslatedChecked || 0) + 1;
      }
    }

    var singleMerged = mergeBatchTotals_(accumulated, batchTotals);

    return {
      ok: true,
      done: true,
      cursor: cursor,
      docId: row.docId,
      sheetRow: sheetRow,
      nextCursor: 1,
      summary: sanitizeCheckerPublicSummary_(singleMerged),
      checkpoint: sanitizeCheckerCheckpointSummary_(singleMerged),
      perf: lightScan ? lightScanPerfSnapshot_() : null
    };
  }

  var slice = tabs.slice(cursor, cursor + chunkSize);

  // Fix timeout: for loop แทน forEach เพื่อให้ break ก่อน hard timeout ได้อย่างปลอดภัย
  // อย่างน้อยตรวจให้จบ 1 แท็บต่อคำสั่งเสมอ (ตรวจ time budget ก่อนเริ่มแท็บถัดไปเท่านั้น ไม่ตัดกลางแท็บที่กำลังทำ)
  var chunkStartedAt = Date.now();
  var configuredTimeBudgetMs = (typeof WEBAPP_SCAN_CONFIG_ !== 'undefined' && WEBAPP_SCAN_CONFIG_)
    ? Number(WEBAPP_SCAN_CONFIG_.SERVER_TIME_BUDGET_MS || 240000)
    : 240000;
  var timeBudgetMs = Math.max(1000, Number(payload.timeBudgetMs || configuredTimeBudgetMs));
  var processedInThisCall = 0;
  var timeBudgetReached = false;

  for (var idxInChunk = 0; idxInChunk < slice.length; idxInChunk++) {
    if (processedInThisCall > 0 && (Date.now() - chunkStartedAt) >= timeBudgetMs) {
      timeBudgetReached = true;
      logChunkPerf_('TIME_BUDGET', {
        sheetRow: sheetRow,
        nextTabIndex: cursor + processedInThisCall + 1
      });
      break;
    }

    var tab = slice[idxInChunk];
    var tabId = tab.getId ? tab.getId() : '';
    var tabIndex = cursor + idxInChunk + 1;
    var tabName = getTabNameSafe_(tab, cursor + idxInChunk);
    var tabStartedAt = Date.now();

    logChunkPerf_('START', { sheetRow: sheetRow, tabIndex: tabIndex, tabName: tabName });

    try {
      var result = withOpenDocTabContext_(doc, tab, function() {
        var isLight = lightScan && typeof runAllChecksLightScan_ === 'function';
        var checkResult = isLight
          ? runAllChecksLightScan_()
          : runAllChecks();
        if (!isLight) {
          // lightScan คำนวณ untranslated จาก snapshot ใน runAllChecksLightScan_ แล้ว ไม่อ่านซ้ำ
          checkResult.untranslatedEnglishInfo = (typeof computeUntranslatedEnglishInfoForActiveTab_ === 'function')
            ? computeUntranslatedEnglishInfoForActiveTab_()
            : null;
        }
        return checkResult;
      });

      batchTotals.tabChecked++;
      batchTotals.replacedEmDashCount += Number(result.replacedEmDashCount || 0);
      batchTotals.replacedWawCount += Number(result.replacedWawCount || 0);
      batchTotals.latinSpecialRemovedTotal += Number(result.latinSpecialRemoved && result.latinSpecialRemoved.total || 0);
      batchTotals.nonThaiCount += Number(result.nonThaiCount || 0);
      batchTotals.paragraphCount += Number(result.paragraphCount || 0);
      batchTotals.spacingCount += Number(result.spacingCount || 0);
      batchTotals.blankRemoved += Number(result.blankRemoved || 0);
      batchTotals.removedCount += Number(result.removedCount || 0);
      batchTotals.breakPairsTotal += Number(result.breakPairs && result.breakPairs.total || 0);
      batchTotals.removedTitleParensTotal += Number(result.removedTitleParens || 0);
      batchTotals.duplicateChapterHeadingRemovedTotal += Number(result.duplicateChapterHeadingRemoved && result.duplicateChapterHeadingRemoved.removed || 0);
      batchTotals.duplicateChapterTitleRemovedTotal += Number(result.duplicateChapterTitleRemoved && result.duplicateChapterTitleRemoved.removed || 0);

      if ((result.nonThaiCount || 0) > 0) {
        if (batchTotals.foreignTabNames.indexOf(tabName) === -1) {
          batchTotals.foreignTabNames.push(tabName);
        }
        batchTotals.foreignTabCounts.push({
          name: tabName,
          count: Number(result.nonThaiCount || 0)
        });
      }

      // ประโยคภาษาอังกฤษยาว: เก็บเฉพาะจำนวนย่อหน้าและหมายเลขแท็บ ห้ามเก็บข้อความดิบ
      var chunkLongEnglish = Number(result.longEnglishParagraphCount || 0);
      if (chunkLongEnglish > 0) {
        var chunkTabNo = tabIndex;
        batchTotals.longEnglishParagraphCount += chunkLongEnglish;
        if (batchTotals.longEnglishTabNumbers.indexOf(chunkTabNo) === -1) {
          batchTotals.longEnglishTabNumbers.push(chunkTabNo);
        }
        batchTotals.longEnglishTabCounts.push({ tabNo: chunkTabNo, count: chunkLongEnglish });
      }

      if (result.titleReport && result.titleReport.changed) {
        if (result.titleReport.episodeChanged) {
          if (batchTotals.titleEpisodeTabs.indexOf(tabName) === -1) {
            batchTotals.titleEpisodeTabs.push(tabName);
          }
          batchTotals.titleEpisodeCount++;
          batchTotals.titleChanges.push({
            tab: tabName,
            type: 'ตอนที่→บทที่',
            from: result.titleReport.from,
            to: result.titleReport.to
          });
        } else if (result.titleReport.chapterChanged) {
          if (batchTotals.titleChapterTabs.indexOf(tabName) === -1) {
            batchTotals.titleChapterTabs.push(tabName);
          }
          batchTotals.titleChapterCount++;
          batchTotals.titleChanges.push({
            tab: tabName,
            type: 'Chapter→บทที่',
            from: result.titleReport.from,
            to: result.titleReport.to
          });
        }
      }

      batchTotals.tabChapterItems.push(getFirstChapterItemFromRunResult_(result, tabName, tabIndex));

      var seq = result.chapterSequence || {};
      (seq.issues || []).forEach(function(issue) {
        batchTotals.chapterSequenceIssues.push({
          tab: tabName,
          type: issue.type,
          expected: issue.expected,
          previous: issue.previous,
          current: issue.current,
          paragraphIndex: issue.paragraphIndex,
          text: issue.text
        });

        if (issue.type === 'เลขซ้ำ') batchTotals.hasDuplicateChapter = true;
      });

      accumulateWebAppExtrasIntoBatchTotals_(batchTotals, result, tabName, tabIndex);
      if (lightScan) {
        accumulateLightScanTabExtras_(batchTotals, result, tabIndex);
        batchTotals.untranslatedChecked = (batchTotals.untranslatedChecked || 0) + 1;
      }
      batchTotals.tabSucceeded++;

      logChunkPerf_('DONE', {
        sheetRow: sheetRow,
        tabIndex: tabIndex,
        tabName: tabName,
        elapsedMs: Date.now() - tabStartedAt,
        performanceTimings: result.performanceTimings
      });
    } catch (tabError) {
      // แท็บเดียวหนักมาก/error ไม่ทำให้ทั้ง chunk ล้ม - บันทึก tabErrors แล้วไปแท็บถัดไป
      batchTotals.tabErrors.push({
        tab: tabName,
        tabId: tabId,
        tabIndex: tabIndex,
        message: String(tabError && tabError.message ? tabError.message : tabError)
      });

      logChunkPerf_('ERROR', {
        sheetRow: sheetRow,
        tabIndex: tabIndex,
        tabName: tabName,
        elapsedMs: Date.now() - tabStartedAt
      });
    }

    processedInThisCall++;
  }

  var merged = mergeBatchTotals_(accumulated, batchTotals);
  var nextCursor = cursor + processedInThisCall;
  var done = !timeBudgetReached && nextCursor >= tabs.length;

  return {
    ok: true,
    done: done,
    cursor: cursor,
    docId: row.docId,
    sheetRow: sheetRow,
    nextCursor: nextCursor,
    summary: sanitizeCheckerPublicSummary_(merged),
    checkpoint: sanitizeCheckerCheckpointSummary_(merged),
    timeBudgetReached: timeBudgetReached,
    perf: lightScan ? lightScanPerfSnapshot_() : null
  };
}

function retryFailedDocumentTabs(payload) {
  payload = payload || {};
  var sheetRow = Number(payload.sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');
  // retry ต้องคงโหมดเดิม: lightScan ห้ามหลุดไป full scan
  var lightScan = !!payload.lightScan;
  var execStartedAt = Date.now();
  if (lightScan) lightScanPerfInit_(payload.runId);

  var accumulated = summarizeBatchTotals_(payload.accumulated || {});
  var requested = Array.isArray(payload.tabIndexes) ? payload.tabIndexes : [];
  if (!requested.length) {
    requested = (accumulated.tabErrors || []).map(function(item) { return item.tabIndex; });
  }

  var retryIndexes = [];
  requested.forEach(function(value) {
    var n = Number(value);
    if (n > 0 && retryIndexes.indexOf(n) === -1) retryIndexes.push(n);
  });
  retryIndexes.sort(function(a, b) { return a - b; });

  var row = resolveMappedRowByIdentity_(sheetRow, payload.docId);
  sheetRow = row.sheetRow;
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');
  var doc = openDocByIdSafe_(row.docId);
  lightScanPerfCount_('docOpens');
  var tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  lightScanPerfCount_('tabsListed', tabs.length);

  // เอา error เก่าของแท็บที่กำลัง retry ออก แล้วใส่กลับเฉพาะแท็บที่ยังล้ม
  accumulated.tabErrors = (accumulated.tabErrors || []).filter(function(item) {
    return retryIndexes.indexOf(Number(item.tabIndex || 0)) === -1;
  });

  var retryTotals = summarizeBatchTotals_({ tabTotal: tabs.length || 1 });
  retryIndexes.forEach(function(tabIndex) {
    var tab = tabs[tabIndex - 1];
    if (!tab) {
      retryTotals.tabErrors.push({
        tab: 'แท็บ ' + tabIndex,
        tabId: '',
        tabIndex: tabIndex,
        message: 'ไม่พบแท็บลำดับนี้ในเอกสาร'
      });
      return;
    }

    var tabId = tab.getId ? tab.getId() : '';
    var tabName = getTabNameSafe_(tab, tabIndex - 1);
    try {
      // ใช้ tab object ที่มีอยู่แล้ว — ไม่เปิดเอกสารซ้ำต่อแท็บ ไม่ fallback ไปแท็บแรก
      var result = withOpenDocTabContext_(doc, tab, function() {
        var isLight = lightScan && typeof runAllChecksLightScan_ === 'function';
        var checkResult = isLight
          ? runAllChecksLightScan_()
          : runAllChecks();
        if (!isLight) {
          checkResult.untranslatedEnglishInfo = (typeof computeUntranslatedEnglishInfoForActiveTab_ === 'function')
            ? computeUntranslatedEnglishInfoForActiveTab_()
            : null;
        }
        return checkResult;
      });
      addTabRunResultToBatchTotals_(retryTotals, result, tabName, tabIndex);
      if (lightScan) {
        accumulateLightScanTabExtras_(retryTotals, result, tabIndex);
        retryTotals.untranslatedChecked = (retryTotals.untranslatedChecked || 0) + 1;
      }
    } catch (error) {
      retryTotals.tabErrors.push({
        tab: tabName,
        tabId: tabId,
        tabIndex: tabIndex,
        message: String(error && error.message ? error.message : error)
      });
    }
  });

  var merged = mergeBatchTotals_(accumulated, retryTotals);
  var retryPerf = lightScan ? lightScanPerfSnapshot_() : null;
  if (retryPerf) retryPerf.executionMs = Date.now() - execStartedAt;
  return {
    ok: true,
    docId: row.docId,
    sheetRow: sheetRow,
    retried: retryIndexes.length,
    succeeded: retryIndexes.length - retryTotals.tabErrors.length,
    failed: retryTotals.tabErrors.length,
    lightScan: lightScan,
    perf: retryPerf,
    tabErrors: sanitizeCheckerPublicValue_(retryTotals.tabErrors),
    summary: sanitizeCheckerPublicSummary_(merged),
    retryState: sanitizeCheckerCheckpointSummary_(merged)
  };
}

function scanRowDocumentFull(sheetRow) {
  sheetRow = Number(sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var res = scanWholeDocumentChunk({
    sheetRow: sheetRow,
    cursor: 0,
    chunkSize: CHECKER_CFG.TAB_SCAN_CHUNK_SIZE || 10,
    accumulated: null,
    finalize: false
  });

  while (!res.done) {
    res = scanWholeDocumentChunk({
      sheetRow: sheetRow,
      cursor: res.nextCursor,
      chunkSize: CHECKER_CFG.TAB_SCAN_CHUNK_SIZE || 10,
      accumulated: res.checkpoint || res.summary,
      finalize: false
    });
  }

  return scanWholeDocumentChunk({
    sheetRow: sheetRow,
    cursor: res.nextCursor || 0,
    chunkSize: CHECKER_CFG.TAB_SCAN_CHUNK_SIZE || 10,
    accumulated: res.checkpoint || res.summary,
    finalize: true
  });
}


/* =========================
 * Checker Extra Wrappers
 * ใช้รองรับปุ่มใน Index.html ที่เรียกฟังก์ชันเหล่านี้
 * ========================= */

function scanSingleTabRow(payload) {
  payload = payload || {};
  var sheetRow = typeof payload === 'object' ? Number(payload.sheetRow) : Number(payload);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = resolveMappedRowByIdentity_(sheetRow, payload.docId);
  sheetRow = row.sheetRow;
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var tabId = (typeof payload === 'object' && payload.tabId) ? payload.tabId : (row.tabId || '');
  var doc = openDocByIdSafe_(row.docId);
  var result = withOpenDocTabContext_(doc, tabId, function() {
    return runAllChecks();
  });

  var tabName = getCurrentTabTitle_();
  var singleSummary = summarizeBatchTotals_({ tabTotal: 1 });
  addTabRunResultToBatchTotals_(singleSummary, result, tabName || 'เอกสารหลัก', 1);
  var singleCrossTabSequence = buildChapterSequenceIssuesFromTabItems_(singleSummary.tabChapterItems || []);
  (singleCrossTabSequence.issues || []).forEach(function(issue) {
    singleSummary.chapterSequenceIssues.push(issue);
  });
  singleSummary.hasDuplicateChapter = singleSummary.hasDuplicateChapter || !!singleCrossTabSequence.hasDuplicateChapter;
  singleSummary.contentDuplicates = buildContentDuplicateReport_(singleSummary.tabChapterItems || []);

  var note = buildWholeDocumentScanNote_(singleSummary);
  note = addCheckerFreeMarker_(note, isFreeChapterRangeDocument_(doc));

  updateCheckerFields({
    sheetRow: sheetRow,
    checked: true,
    note: note
  });

  return {
    ok: true,
    sheetRow: sheetRow,
    docId: row.docId,
    tabId: tabId,
    note: note,
    result: sanitizeCheckerPublicValue_(result),
    summary: sanitizeCheckerPublicSummary_(singleSummary),
    row: getMappedRow_(sheetRow)
  };
}

function formatSingleActiveTab_() {
  var paragraphCount = formatParagraphIndent();
  var spacingCount = setParagraphSpacing(10);
  var blankRemoved = removeAllBlankLines();
  setFontToSarabun16();
  try { underlineFirstLine(); } catch (e) {}

  return {
    paragraphCount: paragraphCount,
    spacingCount: spacingCount,
    blankRemoved: blankRemoved
  };
}

function formatRowDocumentFull(sheetRow) {
  sheetRow = Number(sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = getMappedRow_(sheetRow);
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var doc = openDocByIdSafe_(row.docId);
  var tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  var report = {
    tabChecked: 0,
    tabTotal: tabs.length || 1,
    paragraphCount: 0,
    spacingCount: 0,
    blankRemoved: 0
  };

  if (!tabs.length) {
    var r0 = withDocTabContext_(row.docId, row.tabId, function() {
      return formatSingleActiveTab_();
    });
    report.tabChecked = 1;
    report.paragraphCount += Number(r0.paragraphCount || 0);
    report.spacingCount += Number(r0.spacingCount || 0);
    report.blankRemoved += Number(r0.blankRemoved || 0);
  } else {
    tabs.forEach(function(tab) {
      var tabId = tab.getId ? tab.getId() : '';
      var r = withDocTabContext_(row.docId, tabId, function() {
        return formatSingleActiveTab_();
      });
      report.tabChecked++;
      report.paragraphCount += Number(r.paragraphCount || 0);
      report.spacingCount += Number(r.spacingCount || 0);
      report.blankRemoved += Number(r.blankRemoved || 0);
    });
  }

  return {
    ok: true,
    sheetRow: sheetRow,
    docId: row.docId,
    result: { report: report }
  };
}

function clearHighlightsRow(sheetRow) {
  sheetRow = Number(sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = getMappedRow_(sheetRow);
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var result = withDocTabContext_(row.docId, row.tabId, function() {
    return clearHighlightsAllTabs();
  });

  return {
    ok: true,
    sheetRow: sheetRow,
    docId: row.docId,
    result: result
  };
}

function convertRowToPdf(sheetRow) {
  sheetRow = Number(sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = getMappedRow_(sheetRow);
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var exportUrl = 'https://www.googleapis.com/drive/v3/files/' +
    encodeURIComponent(row.docId) +
    '/export?mimeType=application/pdf';

  var response = UrlFetchApp.fetch(exportUrl, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Export PDF ไม่สำเร็จ HTTP ' + code + ': ' + response.getContentText());
  }

  var safeName = sanitizeFileName_(row.title || ('row_' + sheetRow));
  var blob = response.getBlob().setName(safeName + '.pdf');
  var folder = DriveApp.getFolderById(CHECKER_CFG.PDF_FOLDER_ID);
  var file = folder.createFile(blob);
  var pdfUrl = file.getUrl();

  updateCheckerFields({
    sheetRow: sheetRow,
    pdfUrl: pdfUrl
  });

  return {
    ok: true,
    sheetRow: sheetRow,
    fileId: file.getId(),
    fileName: file.getName(),
    pdfUrl: pdfUrl
  };
}

function sanitizeFileName_(name) {
  return String(name || 'document')
    .replace(/[\\/:*?"<>|#%{}~&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'document';
}

/* =========================
 * Empty-tab scan (lightweight check)
 * ปุ่ม "ตรวจแท็บว่างที่เลือก" ในหน้า Dashboard: ตรวจเฉพาะจำนวนข้อความในแท็บ
 * หาแท็บ 2 หมวด:
 * - ไม่มีเนื้อหา: ทุกบรรทัดเป็นบรรทัดว่าง/หัวบท/ประกาศ/จบตอนล้วน ๆ
 * - เข้าข่ายประกาศ: มีย่อหน้าเนื้อหาจริงน้อยกว่า ANNOUNCEMENT_MIN_PARAGRAPHS
 *   (เช่น แท็บโปรโมตแฟนฟิค: หัวบท + แนะนำเรื่อง + จบตอน)
 * แท็บที่เป็นแค่หัวบท "หมายเหตุจากต้นฉบับ" ไม่นับทั้งสองหมวด (แท็บหมายเหตุต้นฉบับตั้งใจไว้)
 * ไม่หาคำต่างประเทศ ไม่จัดฟอร์แมต
 * มีการแก้ไขเอกสาร 3 จุด:
 * - ลบ ":" หลังเลขบทในบรรทัดหัวบท เช่น "บทที่ 130: เป็นเทพของเธอ?" -> "บทที่ 130 เป็นเทพของเธอ?"
 * - แทนที่ "—" เป็น "..." ทุกตำแหน่งในแท็บ (แนวเดียวกับ replaceEmDashWithEllipsis)
 * - แปลงเลขไทย ๑-๙ เป็น 1-9 ทุกตำแหน่งในแท็บ เช่น "บทที่ ๑๓๘" -> "บทที่ 138"
 * ข้อความขยะท้ายบท (Patreon/อ่านล่วงหน้า/ความคิดผู้เขียน/ความคิดเห็น/โหวต ฯลฯ)
 * แยกเป็นปุ่ม "ตรวจขยะท้ายบทที่เลือก" (checkRowTailJunk) สรุปสั้น ๆ ลงคอลัมน์ M
 * (เขียนทับทุกรอบ ไม่พบ = ล้างค่า) — ปุ่มตรวจแท็บว่างไม่ยุ่งคอลัมน์ M
 * สรุปผลลงคอลัมน์ L เช่น
 *   "ตรวจ 50 แท็บ พบ 2 แท็บไม่มีเนื้อหา | แท็บ 3, 7 | เข้าข่ายประกาศ (<8 ย่อหน้า) 3 แท็บ: 12, 15, 20"
 * ========================= */

const EMPTY_TAB_SCAN_CONFIG_ = {
  // บรรทัดที่จัดเป็น "ประกาศ/สถานะ" ไม่นับเป็นเนื้อหา — แท็บจะถูกนับว่าไม่มีเนื้อหา
  // ก็ต่อเมื่อทุกบรรทัดในแท็บเป็นบรรทัดว่าง/หัวบท/ประกาศเท่านั้น
  ANNOUNCEMENT_RE_: [
    /^จบ(?:ตอน|บท)?(?:ที่\s*[0-9]+)?$/,            // จบ / จบตอน / จบบทที่ 12
    /จากต้นฉบับ/,                                   // บทที่ 78 มาจากต้นฉบับ / แปลจากต้นฉบับ
    /^ประกาศ/,                                      // ประกาศจากต้นฉบับ / ประกาศ: ...
    /โปรดติดตาม|ฝากติดตาม|ติดตามตอนต่อไป/          // บรรทัดโปรโมตท้ายบท
  ],

  // แท็บที่มีย่อหน้าเนื้อหาจริง "น้อยกว่า" ค่านี้ = เข้าข่ายประกาศ
  // นับเฉพาะย่อหน้าเนื้อหาจริง ไม่นับบรรทัดว่าง/หัวบท/บรรทัดประกาศ/จบตอน
  ANNOUNCEMENT_MIN_PARAGRAPHS: 8,

  // แท็บที่มีแค่หัวบท "หมายเหตุจากต้นฉบับ" (ตรงกับทุก pattern ในหัวบททุกบรรทัด)
  // ไม่นับเป็นแท็บว่าง — ไม่บันทึกหมายเหตุคอลัมน์ L แยก
  SOURCE_NOTE_TAB_RE_: [/หมายเหตุ/, /ต้นฉบับ/]
};

/** บรรทัดนี้เป็นบรรทัดประกาศ/โปรโมต (ไม่ใช่เนื้อเรื่อง) หรือไม่ */
function checkerIsEmptyTabAnnouncementLine_(text) {
  var s = thaiDigitsToArabic_(cleanText_(text));
  if (!s) return true;
  for (var i = 0; i < EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_RE_.length; i++) {
    if (EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_RE_[i].test(s)) return true;
  }
  return false;
}

/**
 * จำแนกเนื้อความของแท็บ (pure function แยกจาก body เพื่อให้เทสได้)
 * - hasNoContent: true เมื่อทุกบรรทัดเป็นบรรทัดว่าง/หมายเหตุระบบ/แผงสถานะ/ประกาศ/หัวบทล้วน ๆ
 * - meaningfulParagraphCount: จำนวนย่อหน้าเนื้อหาจริง (ไม่นับบรรทัดว่าง/หัวบท/ประกาศ)
 * - isSourceNoteTab: true เมื่อเป็นแท็บหัวบทล้วน "หมายเหตุจากต้นฉบับ" — ไม่นับเป็นแท็บว่าง
 */
function checkerClassifyTabContent_(text) {
  var result = { hasNoContent: true, meaningfulParagraphCount: 0, isSourceNoteTab: false };
  var lines = String(text || '').split('\n');
  var headingLines = [];

  for (var i = 0; i < lines.length; i++) {
    var t = cleanText_(lines[i]);
    if (!t || t === NOTE_TEXT_) continue;
    if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(t)) continue;
    // เช็คหัวบทก่อนบรรทัดประกาศ เพื่อไม่ให้ /จากต้นฉบับ/ กินหัวบท "หมายเหตุจากต้นฉบับ"
    if (isChapterLineText_(normalizeChapterLine_(t))) {
      headingLines.push(normalizeChapterLine_(t));
      continue;
    }
    if (checkerIsEmptyTabAnnouncementLine_(t)) continue;
    result.hasNoContent = false;
    result.meaningfulParagraphCount++;
  }

  if (result.hasNoContent && headingLines.length) {
    var allSourceNote = headingLines.every(function(h) {
      var patterns = EMPTY_TAB_SCAN_CONFIG_.SOURCE_NOTE_TAB_RE_ || [];
      for (var k = 0; k < patterns.length; k++) {
        if (!patterns[k].test(h)) return false;
      }
      return patterns.length > 0;
    });
    if (allSourceNote) result.isSourceNoteTab = true;
  }

  return result;
}

/** แท็บนี้ควรถูก flag ว่า "ไม่มีเนื้อหา" หรือไม่ (แท็บหมายเหตุจากต้นฉบับยกเว้น) */
function checkerShouldFlagEmptyTab_(info) {
  info = info || {};
  return !!info.hasNoContent && !info.isSourceNoteTab;
}

function checkerTextHasNoContent_(text) {
  return checkerClassifyTabContent_(text).hasNoContent;
}

/** แท็บนี้ "เข้าข่ายประกาศ" หรือไม่ — มีเนื้อหาบ้างแต่ย่อหน้าเนื้อหาจริงน้อยกว่าเกณฑ์ */
function checkerTabIsAnnouncementLike_(text) {
  var info = checkerClassifyTabContent_(text);
  if (info.hasNoContent) return false;
  return info.meaningfulParagraphCount < Number(EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_MIN_PARAGRAPHS);
}

function checkerTabHasNoContent_(body) {
  if (!body || typeof body.getText !== 'function') return true;
  return checkerClassifyTabContent_(body.getText()).hasNoContent;
}

/**
 * หาตำแหน่ง ":" ที่ตามหลังเลขบทในบรรทัดหัวบท (pure function เทสได้)
 * เช่น "บทที่ 130: เป็นเทพของเธอ?" -> { start: 8, end: 10, insertSpace: true }
 * คืน null ถ้าไม่ใช่หัวบทที่มี colon หลังเลขบท
 * จับเฉพาะ colon แรกหลังเลขบท colon อื่นในชื่อบทไม่แตะ
 */
function findChapterTitleColonFix_(raw) {
  var text = String(raw || '');
  var m = text.match(
    /^(?:บทที่|ตอนที่|บท|chapter)\s*\[?\s*[0-9๐-๙]+\s*\]?[ \t\u00A0]*[:：﹕꞉∶։][ \t\u00A0]*/i
  );
  if (!m) return null;

  var colonOffsetInMatch = m[0].search(/[:：﹕꞉∶։]/);
  var start = m.index + colonOffsetInMatch;
  var end = m.index + m[0].length;

  // ยุบช่องว่างหน้า colon ด้วย ("บทที่ 130 : ชื่อ") ไม่ยุบข้ามขึ้นบรรทัดใหม่
  while (start > m.index && /[ \t\u00A0]/.test(text.charAt(start - 1))) start--;

  return {
    start: start,
    end: end,
    insertSpace: text.slice(end).trim() !== ''
  };
}

/**
 * ลบ ":" หลังเลขบทในทุกหัวบทของ body คืนจำนวนบรรทัดที่แก้
 * ใช้ deleteText/insertText เฉพาะช่วง colon+ช่องว่าง เพื่อคงรูปแบบตัวอักษร
 * (bold/underline หัวบท) ของข้อความส่วนที่เหลือไว้
 */
function fixChapterTitleColonsInBody_(body) {
  if (!body || typeof body.getParagraphs !== 'function') return 0;

  var paras = getParagraphsDeep_(body);
  var fixed = 0;

  paras.forEach(function(p) {
    var editor;
    try { editor = p.editAsText(); } catch (e) { return; }
    if (!editor || typeof editor.getText !== 'function') return;

    var raw = '';
    try { raw = editor.getText(); } catch (e2) { return; }

    var fix = findChapterTitleColonFix_(raw);
    if (!fix) return;

    try {
      editor.deleteText(fix.start, fix.end - 1);
      if (fix.insertSpace) editor.insertText(fix.start, ' ');
      fixed++;
    } catch (e3) {}
  });

  return fixed;
}

/**
 * แทนที่ "—" เป็น "..." (pure function เทสได้) คืนข้อความใหม่ + จำนวนตำแหน่งที่แทน
 */
function replaceEmDashesInText_(text) {
  var s = String(text || '');
  var count = (s.match(/—/g) || []).length;
  if (!count) return { text: s, count: 0 };
  return { text: s.replace(/—/g, '...'), count: count };
}

/**
 * แทนที่ "—" เป็น "..." ทุก text node ใน body คืนจำนวนตำแหน่งที่แทน
 * แตะเฉพาะ node ที่มี "—" จริง เพื่อลดการเขียนทับฟอร์แมตส่วนอื่น
 */
function replaceEmDashInBody_(body) {
  if (!body || typeof getTextNodesInElement_ !== 'function') return 0;

  var nodes = getTextNodesInElement_(body);
  var total = 0;

  nodes.forEach(function(t) {
    var s = '';
    try { s = t.getText(); } catch (e) { return; }
    if (!s || s.indexOf('—') === -1) return;

    var res = replaceEmDashesInText_(s);
    try {
      t.setText(res.text);
      total += res.count;
    } catch (e2) {}
  });

  return total;
}

/* =========================
 * Tail junk scan (ข้อความขยะท้ายบท)
 * ตรวจเฉพาะย่อหน้าท้ายของแต่ละแท็บ หาเศษ UI/metadata จากเว็บต้นฉบับ
 * เช่น อ่านล่วงหน้าบน Patreon, ความคิดของผู้เขียน, ความคิดเห็น 19, โหวต
 * อ่านอย่างเดียว ไม่แก้เอกสาร แล้วสรุปสั้น ๆ ลงคอลัมน์ M
 * ========================= */

const TAIL_JUNK_SCAN_CFG_ = {
  COLUMN: 14,            // N: สรุปข้อความขยะท้ายบท (เขียนทับทุกรอบ) - หมวด "อื่น ๆ" ของการตรวจรวม
  TAIL_PARAGRAPHS: 10    // อ่านกี่ย่อหน้าท้ายแท็บ
};

// กลุ่มแสดงผลแบบย่อ
const TAIL_JUNK_GROUPS_ = {
  PROMO: 'โปรโมต/ลิงก์',
  UI: 'คอมเมนต์/โหวต',
  AUTHOR: 'ความคิดผู้เขียน'
};

function normalizeTailJunkText_(text) {
  return String(text || '')
    .replace(INVIS_RE_, ' ')
    .replace(/[“”"'`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * จำแนกบรรทัดว่าเป็นขยะท้ายบทหรือไม่ (pure function เทสได้)
 * คืนกลุ่ม PROMO / UI / AUTHOR หรือ null ถ้าเป็นเนื้อเรื่องปกติ
 */
function classifyTailJunkLine_(text) {
  var s = thaiDigitsToArabic_(normalizeTailJunkText_(text));
  if (!s) return null;

  // ความคิดของผู้เขียน/ผู้สร้าง, Author's Thoughts
  if (/^(?:ความคิด|ความคิดเห็น|หมายเหตุ|บันทึก)\s*(?:ของ)?\s*(?:ผู้สร้าง|ผู้เขียน|ผู้แต่ง|ผู้ประพันธ์)\s*:?\s*$/i.test(s) ||
      /^(?:author'?s?|creator'?s?)\s+(?:thoughts?|notes?)\s*:?\s*$/i.test(s)) {
    return 'AUTHOR';
  }

  // ชื่อผู้ใช้ซ้ำจากเว็บต้นฉบับ เช่น Takamiya_Shin Takamiya_Shin
  if (/takamiya[_\s-]*shin/i.test(s) || /^([a-z][a-z0-9_.-]{2,})\s+\1$/i.test(s)) {
    return 'PROMO';
  }

  // โปรโมต/ลิงก์: Patreon, อ่านล่วงหน้า, read more, bit.ly
  if (/patreon/i.test(s) ||
      /อ่านล่วงหน้า/.test(s) ||
      /(?:อ่าน|ติดตาม).{0,12}(?:ตอน|บท|เนื้อหา)?\s*(?:เพิ่มเติม|เพิ่ม|ต่อไป)/.test(s) ||
      /\b(?:read\s+more|more\s+chapters?|next\s+chapters?|early\s+chapters?)\b/i.test(s) ||
      /\bbit\.ly\//i.test(s)) {
    return 'PROMO';
  }

  // บริจาค/สนับสนุน (ต้องชี้เป้าถึงผู้เขียน/ลิงก์ กัน false positive จากเนื้อเรื่อง)
  if (/paypal\.me\/|ko-fi\.com\/|buymeacoffee\.com\//i.test(s) ||
      /(?:สนับสนุน|บริจาค|โดเนท|อุดหนุน)\s*(?:ผู้เขียน|ผู้แต่ง|ผู้สร้าง|ผู้ประพันธ์|นิยาย|เรื่อง)/.test(s)) {
    return 'PROMO';
  }

  // UI: ความคิดเห็น (ตัวเลขได้ เช่น ความคิดเห็น 19)
  if (/^(?:ความคิดเห็น|คอมเมนต์|ความเห็น)\s*[:：]?\s*[0-9]*\s*$/.test(s) ||
      /^(?:comments?|reviews?)\s*[:：]?\s*[0-9]*\s*$/i.test(s)) {
    return 'UI';
  }

  // UI: โหวต
  if (/^(?:โหวต|คะแนนโหวต|จำนวนโหวต)\s*[:：]?\s*[0-9]*\s*$/.test(s) ||
      /^(?:votes?|voting)\s*[:：]?\s*[0-9]*\s*$/i.test(s)) {
    return 'UI';
  }

  // UI: Power Stone / พาวเวอร์สโตน
  if (/^(?:power\s*stones?|powerstone)\s*[:：]?\s*[0-9]*\s*$/i.test(s) ||
      /^(?:พาวเวอร์\s*สโตน|หินพลัง)\s*[:：]?\s*[0-9]*\s*$/.test(s)) {
    return 'UI';
  }

  return null;
}

/**
 * อ่านย่อหน้าท้ายของแท็บแล้วคืนกลุ่มขยะที่พบ (ไม่ซ้ำ) — อ่านอย่างเดียว
 */
function scanTabTailJunkGroups_(body) {
  if (!body || typeof body.getParagraphs !== 'function') return [];

  var paras = body.getParagraphs();
  var limit = Number(TAIL_JUNK_SCAN_CFG_.TAIL_PARAGRAPHS || 10);
  var startIndex = Math.max(0, paras.length - limit);
  var groups = [];

  for (var i = startIndex; i < paras.length; i++) {
    var text = '';
    try { text = paras[i].getText(); } catch (e) { continue; }
    if (!String(text || '').trim()) continue;

    var group = classifyTailJunkLine_(text);
    if (group && groups.indexOf(group) === -1) groups.push(group);
  }

  return groups;
}

/**
 * สรุปขยะท้ายบทแบบสั้นสำหรับคอลัมน์ M (pure function เทสได้)
 * tabGroups: [{ tabNo: 4, groups: ['PROMO','UI'] }, ...]
 * คืน '' เมื่อไม่พบ หรือ เช่น "ขยะท้ายบท 2 แท็บ: โปรโมต/ลิงก์ 4, 12 | คอมเมนต์/โหวต 4"
 */
function buildTailJunkSummary_(tabGroups) {
  var byGroup = {};
  var groupOrder = [];
  var junkTabs = [];

  (tabGroups || []).forEach(function(item) {
    (item.groups || []).forEach(function(g) {
      if (!byGroup[g]) {
        byGroup[g] = [];
        groupOrder.push(g);
      }
      if (byGroup[g].indexOf(item.tabNo) === -1) byGroup[g].push(item.tabNo);
      if (junkTabs.indexOf(item.tabNo) === -1) junkTabs.push(item.tabNo);
    });
  });

  if (!junkTabs.length) return '';

  junkTabs.sort(function(a, b) { return a - b; });

  var parts = groupOrder.map(function(g) {
    return TAIL_JUNK_GROUPS_[g] + ' ' + formatTabNumberList_(byGroup[g]);
  });

  return 'ขยะท้ายบท ' + junkTabs.length + ' แท็บ: ' + parts.join(' | ');
}

/**
 * แปลงเลขไทย ๑-๙ เป็น 1-9 (pure function เทสได้) คืนข้อความใหม่ + จำนวนตัวอักษรที่แปลง
 */
function thaiToArabicDigitsInText_(text) {
  var s = String(text || '');
  var count = (s.match(/[๐-๙]/g) || []).length;
  if (!count) return { text: s, count: 0 };
  return { text: thaiDigitsToArabic_(s), count: count };
}

/**
 * แปลงเลขไทยเป็นเลขอารบิกทุก text node ใน body คืนจำนวนตัวอักษรที่แปลง
 * แตะเฉพาะ node ที่มีเลขไทย ๐-๙ จริง เพื่อลดการเขียนทับฟอร์แมตส่วนอื่น
 */
function convertThaiDigitsInBody_(body) {
  if (!body || typeof getTextNodesInElement_ !== 'function') return 0;

  var nodes = getTextNodesInElement_(body);
  var total = 0;

  nodes.forEach(function(t) {
    var s = '';
    try { s = t.getText(); } catch (e) { return; }
    if (!s || !/[๐-๙]/.test(s)) return;

    var res = thaiToArabicDigitsInText_(s);
    try {
      t.setText(res.text);
      total += res.count;
    } catch (e2) {}
  });

  return total;
}

// ตัดผลตรวจรอบเก่า ("ตรวจ N แท็บ..." / "แท็บ x, y" / "เข้าข่ายประกาศ...") ออก แต่คงหมายเหตุอื่นไว้ครบ
function stripEmptyTabsNoteParts_(noteText) {
  return String(noteText || '')
    .split('|')
    .map(function(s) { return s.trim(); })
    .filter(function(part) {
      if (!part) return false;
      if (/^ตรวจ\s*[0-9]+\s*แท็บ/.test(part)) return false;
      if (/^แท็บ\s*[0-9]+(?:\s*,\s*[0-9]+)*$/.test(part)) return false;
      if (/^เข้าข่ายประกาศ/.test(part)) return false;
      return true;
    })
    .join(' | ');
}

// สร้างหมายเหตุผลตรวจแท็บว่างโดยต่อท้ายหมายเหตุเดิมเสมอ ไม่ overwrite ของเดิม
function buildEmptyTabsNote_(existingNote, totalTabs, emptyTabNumbers, announcementTabNumbers) {
  var base = stripEmptyTabsNoteParts_(existingNote);
  var summary = 'ตรวจ ' + Number(totalTabs || 0) + ' แท็บ';
  var parts = [base];

  if (emptyTabNumbers && emptyTabNumbers.length) {
    parts.push(summary + ' พบ ' + emptyTabNumbers.length + ' แท็บไม่มีเนื้อหา');
    parts.push('แท็บ ' + formatTabNumberList_(emptyTabNumbers));
  } else if (announcementTabNumbers && announcementTabNumbers.length) {
    parts.push(summary + ' พบ 0 แท็บไม่มีเนื้อหา');
  } else {
    parts.push(summary + ' ทุกแท็บมีเนื้อหา');
  }

  if (announcementTabNumbers && announcementTabNumbers.length) {
    parts.push(
      'เข้าข่ายประกาศ (<' + Number(EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_MIN_PARAGRAPHS) + ' ย่อหน้า) ' +
      announcementTabNumbers.length + ' แท็บ: ' + formatTabNumberList_(announcementTabNumbers)
    );
  }

  return mergeCheckerNotes_.apply(null, parts);
}

/**
 * Web app: ตรวจแท็บไม่มีเนื้อหา/เข้าข่ายประกาศของแถวเดียว (ปุ่ม "ตรวจแท็บว่างที่เลือก")
 * payload: { sheetRow, docId } — docId เป็น identity กันแถวเลื่อนระหว่างทำงาน
 * พ่วงลบ ":" หลังเลขบทในหัวบททุกแท็บ (titleColonFixed = จำนวนบรรทัดที่แก้)
 * และแทนที่ "—" เป็น "..." (emDashFixed = จำนวนตำแหน่งที่แทน)
 * และแปลงเลขไทยเป็นอารบิก (thaiDigitFixed = จำนวนตัวอักษรที่แปลง)
 * คืนสรุปพร้อม row ที่อัปเดตแล้วสำหรับ patchDashboardRow_
 */
function checkRowEmptyTabs(payload) {
  payload = payload || {};
  var sheetRow = Number(payload.sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = resolveMappedRowByIdentity_(sheetRow, payload.docId);
  sheetRow = row.sheetRow;
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var doc = openDocByIdSafe_(row.docId);
  var tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  var totalTabs = tabs.length || 1;
  var emptyTabNumbers = [];
  var announcementTabNumbers = [];
  var titleColonFixed = 0;
  var emDashFixed = 0;
  var thaiDigitFixed = 0;

  if (!tabs.length) {
    var body = doc.getBody();
    var text = (body && typeof body.getText === 'function') ? body.getText() : '';
    var info = checkerClassifyTabContent_(text);
    if (checkerShouldFlagEmptyTab_(info)) emptyTabNumbers.push(1);
    else if (!info.isSourceNoteTab && info.meaningfulParagraphCount < Number(EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_MIN_PARAGRAPHS)) announcementTabNumbers.push(1);
    titleColonFixed += fixChapterTitleColonsInBody_(body);
    emDashFixed += replaceEmDashInBody_(body);
    thaiDigitFixed += convertThaiDigitsInBody_(body);
  } else {
    tabs.forEach(function(tab, idx) {
      var body = getBodyFromTabSafe_(tab, doc);
      var text = (body && typeof body.getText === 'function') ? body.getText() : '';
      var info = checkerClassifyTabContent_(text);
      if (checkerShouldFlagEmptyTab_(info)) emptyTabNumbers.push(idx + 1);
      else if (!info.isSourceNoteTab && info.meaningfulParagraphCount < Number(EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_MIN_PARAGRAPHS)) announcementTabNumbers.push(idx + 1);
      titleColonFixed += fixChapterTitleColonsInBody_(body);
      emDashFixed += replaceEmDashInBody_(body);
      thaiDigitFixed += convertThaiDigitsInBody_(body);
    });
  }

  var note = buildEmptyTabsNote_(row.note, totalTabs, emptyTabNumbers, announcementTabNumbers);
  var updated = updateCheckerFields({
    sheetRow: sheetRow,
    note: note
  });

  return {
    ok: true,
    sheetRow: sheetRow,
    docId: row.docId,
    totalTabs: totalTabs,
    emptyTabCount: emptyTabNumbers.length,
    emptyTabNumbers: emptyTabNumbers,
    announcementTabCount: announcementTabNumbers.length,
    announcementTabNumbers: announcementTabNumbers,
    titleColonFixed: titleColonFixed,
    emDashFixed: emDashFixed,
    thaiDigitFixed: thaiDigitFixed,
    note: note,
    row: updated.row
  };
}

/**
 * Web app: ตรวจข้อความขยะท้ายบทของแถวเดียว (ปุ่ม "ตรวจขยะท้ายบทที่เลือก")
 * แยกจากปุ่มตรวจแท็บว่าง — ทำแค่สแกนขยะท้ายแท็บแล้วสรุปลงคอลัมน์ M
 * (เขียนทับทุกรอบ ไม่พบ = ล้างค่า) ไม่แก้ Google Docs และไม่แตะคอลัมน์ L
 * payload: { sheetRow, docId } — docId เป็น identity กันแถวเลื่อนระหว่างทำงาน
 */
function checkRowTailJunk(payload) {
  payload = payload || {};
  var sheetRow = Number(payload.sheetRow);
  if (!sheetRow) throw new Error('sheetRow ไม่ถูกต้อง');

  var row = resolveMappedRowByIdentity_(sheetRow, payload.docId);
  sheetRow = row.sheetRow;
  if (!row || !row.docId) throw new Error('ไม่พบ docId ของแถวนี้');

  var doc = openDocByIdSafe_(row.docId);
  var tabs = doc.getTabs ? getAllTabsFlat_(doc) : [];
  var totalTabs = tabs.length || 1;
  var tailJunkTabGroups = [];

  if (!tabs.length) {
    var junkGroups0 = scanTabTailJunkGroups_(doc.getBody());
    if (junkGroups0.length) tailJunkTabGroups.push({ tabNo: 1, groups: junkGroups0 });
  } else {
    tabs.forEach(function(tab, idx) {
      var body = getBodyFromTabSafe_(tab, doc);
      var junkGroups = scanTabTailJunkGroups_(body);
      if (junkGroups.length) tailJunkTabGroups.push({ tabNo: idx + 1, groups: junkGroups });
    });
  }

  var tailJunkSummary = buildTailJunkSummary_(tailJunkTabGroups);

  try {
    getCheckerSheet_()
      .getRange(sheetRow, Number(TAIL_JUNK_SCAN_CFG_.COLUMN))
      .setValue(tailJunkSummary);
  } catch (eM) {}

  return {
    ok: true,
    sheetRow: sheetRow,
    docId: row.docId,
    totalTabs: totalTabs,
    tailJunkTabCount: tailJunkTabGroups.length,
    tailJunkTabNumbers: tailJunkTabGroups.map(function(x) { return x.tabNo; }),
    tailJunkSummary: tailJunkSummary
  };
}
/* =========================
 * Light scan (ตรวจแถวที่เลือก - รวมทุกการตรวจ ไม่จัดฟอร์แมต)
 * payload.lightScan = true ใน scanWholeDocumentChunk จะสลับไปใช้ runAllChecksLightScan_()
 * - ตรวจครบ: คำต่างประเทศ (นับอย่างเดียว), เลขบท, เนื้อหาซ้ำ, ประโยคอังกฤษยาว,
 *   แท็บยังไม่แปล, แท็บว่าง/เข้าข่ายประกาศ, ขยะท้ายบท, โปรโมตท้ายบท/จบตอน, ต้นฉบับอังกฤษ
 * - แก้เนื้อหาเบา 3 อย่าง: — -> ..., ลบ : หลังเลขบท, เลขไทย -> อารบิก
 * - ห้ามจัดฟอร์แมต: ไม่แตะฟอนต์/ขนาด/ย่อหน้า/ระยะห่าง/เส้นใต้/ตัวหนา/สีไฮไลต์
 * - สรุปผลแยก 3 หมวด: L = ภาษา, M = เลขบทซ้ำ/หาย + เนื้อหาซ้ำ, N = อื่น ๆ
 * ========================= */

const LIGHT_SCAN_COLUMNS_ = {
  LANGUAGE: 12,  // L: คำต่างประเทศ/ภาษา
  SEQUENCE: 13,  // M: เลขบทซ้ำ/หาย + เนื้อหาซ้ำ + ต้นฉบับไม่มีบทที่
  OTHER: 14      // N: อื่น ๆ (แท็บว่าง/เข้าข่ายประกาศ, ขยะท้ายบท, โปรโมตท้ายบท, สถิติแก้เนื้อหาเบา)
};

/**
 * นับตัวอักษรต่างประเทศแบบ report-only (เกณฑ์เดียวกับ highlightForeignCharacters)
 * ไม่ล้างสีเก่า ไม่ไฮไลต์ใหม่ ไม่แทรกหมายเหตุในเอกสาร
 */
function countForeignCharactersReportOnly_() {
  var body = getActiveBody_();
  var texts = getTextNodesInElement_(body);
  var count = 0;
  var KOREAN_RE_SRC = '[\\u1100-\\u11FF\\u3130-\\u318F\\uAC00-\\uD7AF]+';

  texts.forEach(function(textElement) {
    var text = '';
    try { text = textElement.getText(); } catch (e) { return; }
    if (!text) return;

    // 1) นับภาษาเกาหลีก่อน (เกณฑ์เดียวกับเวอร์ชันไฮไลต์)
    var koreanRe = new RegExp(KOREAN_RE_SRC, 'g');
    var km;
    while ((km = koreanRe.exec(text)) !== null) {
      count += km[0].length;
    }

    // 2) นับภาษาต่างประเทศอื่น
    var re = new RegExp(FOREIGN_WORD_RE_V9_.source, 'g');
    var kaomojiSkipMap = buildKaomojiSkipMapV9_(text);

    var match;
    while ((match = re.exec(text)) !== null) {
      var word = match[0];
      var start = match.index;
      var end = start + word.length - 1;

      if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(word)) continue;
      if (kaomojiSkipMap[start] || shouldSkipForeignWordV9_(word, text, start, end)) continue;

      var allAllowed = true;
      for (var i = 0; i < word.length; i++) {
        if (!EXTRA_ALLOWED_CHARS_V9_.has(word[i])) {
          allAllowed = false;
          break;
        }
      }
      if (allAllowed) continue;

      count += word.length;
    }
  });

  return count;
}

/**
 * ตรวจท้ายบทแบบ report-only (เกณฑ์เดียวกับ cleanupEndingPromoAndEnsureEndMarker_)
 * นับบรรทัดโปรโมตที่รอลบ (pendingPromoLines) และว่ามี "จบตอน" หรือไม่ (hadEndMarker)
 * ไม่ลบ ไม่แทรกอะไรในเอกสาร
 */
function detectEndingPromoReportOnly_() {
  var cfg = (typeof ENDING_CLEANUP_CONFIG_ !== 'undefined') ? ENDING_CLEANUP_CONFIG_ : null;
  var empty = {
    changed: false,
    removedPromoLines: 0,
    removedPromoExamples: [],
    pendingPromoLines: 0,
    hadEndMarker: true,
    insertedEndMarker: false,
    dedupedEndMarker: 0,
    scannedTailParagraphs: 0
  };
  if (!cfg || cfg.ENABLED === false) return empty;

  var body;
  try { body = getActiveBody_(); } catch (e) { return empty; }
  var paras = body.getParagraphs();
  var total = paras.length;
  var scanLimit = Math.max(1, Number(cfg.TAIL_PARAGRAPH_SCAN_LIMIT || 15));
  var startIdx = Math.max(0, total - scanLimit);

  var pendingPromoLines = 0;
  var hadEndMarker = false;

  for (var i = startIdx; i < total; i++) {
    var text = '';
    try { text = cleanText_(paras[i].getText()); } catch (e2) { continue; }
    if (!text || text === NOTE_TEXT_) continue;
    if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(text)) continue;

    if (typeof isEndMarkerLine_ === 'function' && isEndMarkerLine_(text, cfg)) {
      hadEndMarker = true;
    } else if (typeof isRemovableEndingPromoLine_ === 'function' && isRemovableEndingPromoLine_(text)) {
      pendingPromoLines++;
    }
  }

  return {
    changed: false,
    removedPromoLines: 0,
    removedPromoExamples: [],
    pendingPromoLines: pendingPromoLines,
    hadEndMarker: hadEndMarker,
    insertedEndMarker: false,
    dedupedEndMarker: 0,
    scannedTailParagraphs: total - startIdx
  };
}

/**
 * ตรวจต้นฉบับภาษาอังกฤษที่ติดมาก่อนหัวบทไทยแบบ report-only
 * (ใช้ตัวตรวจเดิม detectEnglishSourceBlock_ แต่ไม่ลบออกจากเอกสาร)
 */
function detectEnglishSourceReportOnly_() {
  const cfg = (typeof ENGLISH_SOURCE_CLEANUP_CONFIG_ !== 'undefined') ? ENGLISH_SOURCE_CLEANUP_CONFIG_ : null;
  const emptyReport = {
    detected: 0,
    removed: 0,
    removedParagraphs: 0,
    englishHeading: '',
    thaiHeading: '',
    startParagraphIndex: null,
    endParagraphIndex: null,
    confidence: null,
    examples: []
  };
  if (!cfg || cfg.ENABLED === false) return emptyReport;
  if (typeof detectEnglishSourceBlock_ !== 'function') return emptyReport;

  var body;
  try { body = getActiveBody_(); } catch (e) { return emptyReport; }
  var paras = body.getParagraphs();
  var texts = paras.map(function(p) { return p.getText(); });

  var blockInfo = detectEnglishSourceBlock_(texts, cfg);
  if (!blockInfo.detected) return emptyReport;

  return {
    detected: 1,
    removed: 0,
    removedParagraphs: 0,
    englishHeading: blockInfo.englishHeadingText,
    thaiHeading: blockInfo.thaiHeadingText,
    startParagraphIndex: blockInfo.startIndex + 1,
    endParagraphIndex: blockInfo.endIndex + 1,
    confidence: blockInfo.confidence,
    examples: blockInfo.confidence === 'HIGH' ? [] : blockInfo.examples
  };
}

/**
 * โหมดตรวจเบาต่อแท็บ (perf-1: single-pass snapshot)
 * อ่านข้อความย่อหน้าครั้งเดียว แล้ว cleanup + ตัวตรวจทุกกลุ่มใช้ข้อความชุดเดียวกัน
 * - cleanup: — → ..., و → ล, เลขไทย → อารบิก, ลบ : หลังเลขบท (รักษาฟอร์แมต)
 * - หลังแก้ จะ re-read เฉพาะย่อหน้า dirty เพื่อให้ตัวตรวจเห็นข้อความล่าสุด
 * - ขั้นตอนที่ข้าม: ลบอักษรละตินพิเศษ, ไฮไลต์คำต่างประเทศ, จัดหัวบท/แปลงหัวบท,
 *   ลบวงเล็บ/ชื่อซ้ำ/หัวบทซ้ำ, แยกบรรทัด, ย่อหน้า/ระยะห่าง, ลบบรรทัดว่าง, ฟอนต์ Sarabun
 */
function runAllChecksLightScan_() {
  var body = getActiveBody_();
  var paras = lightScanPerfTimed_('getParas', function() { return body.getParagraphs(); });
  lightScanPerfCount_('paragraphGets');
  var paraTexts = paras.map(function(p) {
    lightScanPerfCount_('paraTextReads');
    return p.getText();
  });

  if (typeof resetForeignWordAllowListCache_ === 'function') resetForeignWordAllowListCache_();

  // ===== cleanup เนื้อหาเบา (แก้เฉพาะย่อหน้าที่มีจุดแก้ รักษาฟอร์แมตส่วนอื่น) =====
  var cleanup = applyLightScanCleanups_(paras, paraTexts);
  cleanup.dirtyIndexes.forEach(function(i) {
    lightScanPerfCount_('dirtyParaTextReads');
    paraTexts[i] = paras[i].getText();
  });

  var joinedText = paraTexts.join('\n');

  // ===== ตรวจทั้งหมดจากข้อความชุดเดียวกัน (ไม่อ่านเอกสารซ้ำ) =====
  var nonThaiCount = lightScanPerfTimed_('checkForeign', function() {
    return countForeignCharactersFromTexts_(paraTexts);
  });

  var sourceNoChapterNote = lightScanPerfTimed_('checkSourceNoChapter', function() {
    var found = detectSourceNoChapterNoteInLines_(paraTexts, SOURCE_NO_CHAPTER_NOTE_CONFIG_);
    return found.found
      ? { found: 1, note: 'ต้นฉบับไม่มีบทที่', paragraphIndex: found.paragraphIndex + 1, matchedText: found.matchedText }
      : { found: 0, note: '', paragraphIndex: null, matchedText: '' };
  });

  var englishSourceCleanup = lightScanPerfTimed_('checkEnglishSource', function() {
    return detectEnglishSourceFromTexts_(paraTexts);
  });

  var endingCleanup = lightScanPerfTimed_('checkEnding', function() {
    return detectEndingPromoFromTexts_(paraTexts);
  });

  var chapterSequence = lightScanPerfTimed_('checkSequence', function() {
    var scan = collectChapterScanFromTexts_(paras, paraTexts);
    return checkChapterSequenceFromChapters_(scan.chapters);
  });

  var longEnglish = lightScanPerfTimed_('checkLongEnglish', function() {
    return checkerScanLongEnglishFromTexts_(paraTexts);
  });

  var untranslatedEnglishInfo = lightScanPerfTimed_('checkUntranslated', function() {
    return computeUntranslatedEnglishFromTexts_(joinedText);
  });

  var tabClass = lightScanPerfTimed_('checkEmptyClassify', function() {
    return checkerClassifyTabContent_(joinedText);
  });

  var junkGroups = lightScanPerfTimed_('checkJunk', function() {
    return scanTabTailJunkFromTexts_(paraTexts);
  });

  return {
    replacedEmDashCount: cleanup.counts.emDash,
    replacedWawCount: cleanup.counts.waw,
    nonThaiCount: nonThaiCount,
    titleColonFixed: cleanup.counts.colon,
    thaiDigitFixed: cleanup.counts.thaiDigit,
    episodePrefixFixed: cleanup.counts.tonToBod,
    sourceNoChapterNote: sourceNoChapterNote,
    englishSourceCleanup: englishSourceCleanup,
    endingCleanup: endingCleanup,
    chapterSequence: chapterSequence,
    longEnglishParagraphCount: Number(longEnglish && longEnglish.paragraphCount || 0),
    untranslatedEnglishInfo: untranslatedEnglishInfo,
    __lightClass: tabClass,
    __lightJunkGroups: junkGroups
  };
}

/** สะสมผลเฉพาะโหมด lightScan ของแท็บหนึ่งเข้า batchTotals */
function accumulateLightScanTabExtras_(batchTotals, result, tabIndex) {
  result = result || {};
  tabIndex = Number(tabIndex);

  var info = result.__lightClass || { hasNoContent: false, meaningfulParagraphCount: 0, isSourceNoteTab: false };

  if (checkerShouldFlagEmptyTab_(info)) {
    batchTotals.emptyTabNumbers = batchTotals.emptyTabNumbers || [];
    if (batchTotals.emptyTabNumbers.indexOf(tabIndex) === -1) batchTotals.emptyTabNumbers.push(tabIndex);
  } else if (!info.isSourceNoteTab && info.meaningfulParagraphCount < Number(EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_MIN_PARAGRAPHS)) {
    batchTotals.announcementTabNumbers = batchTotals.announcementTabNumbers || [];
    if (batchTotals.announcementTabNumbers.indexOf(tabIndex) === -1) batchTotals.announcementTabNumbers.push(tabIndex);
  }

  batchTotals.tailJunkTabGroups = batchTotals.tailJunkTabGroups || [];
  (result.__lightJunkGroups || []).forEach(function(group) {
    batchTotals.tailJunkTabGroups.push({ tabIndex: tabIndex, group: group });
  });

  var endingInfo = result.endingCleanup || {};
  if (Number(endingInfo.pendingPromoLines || 0) > 0) {
    batchTotals.endingPendingPromoTabs = batchTotals.endingPendingPromoTabs || [];
    if (batchTotals.endingPendingPromoTabs.indexOf(tabIndex) === -1) batchTotals.endingPendingPromoTabs.push(tabIndex);
  }
  if (!endingInfo.hadEndMarker) {
    batchTotals.endingMissingMarkerTabs = batchTotals.endingMissingMarkerTabs || [];
    if (batchTotals.endingMissingMarkerTabs.indexOf(tabIndex) === -1) batchTotals.endingMissingMarkerTabs.push(tabIndex);
  }

  batchTotals.titleColonFixed = Number(batchTotals.titleColonFixed || 0) + Number(result.titleColonFixed || 0);
  batchTotals.thaiDigitFixed = Number(batchTotals.thaiDigitFixed || 0) + Number(result.thaiDigitFixed || 0);
  batchTotals.episodePrefixFixed = Number(batchTotals.episodePrefixFixed || 0) + Number(result.episodePrefixFixed || 0);
}

function writeLightScanColumnValue_(sheetRow, column, value) {
  try {
    var range = getCheckerSheet_().getRange(Number(sheetRow), Number(column));
    var existing = String(range.getDisplayValue() || '').trim();
    // กันทับข้อมูลคนละประเภท: เซลล์เดิมเป็นลิงก์ (PDF/ZIP) แต่ข้อความใหม่ไม่ใช่ลิงก์ = ข้าม
    // (ผลลัพธ์จะถูกรายงานกลับใน skippedWrites ของ response และ log)
    if (/^https?:\/\//i.test(existing) && !/^https?:\/\//i.test(String(value || ''))) {
      lightScanPerfCount_('skippedUrlWrites');
      return false;
    }
    range.setValue(value || '');
    lightScanPerfCount_('sheetWrites');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * สรุปผล lightScan เป็น 3 โน้ตแยกหมวด
 * L = ภาษา (คำต่างประเทศ/ประโยคอังกฤษยาว/ยังไม่แปล)
 * M = เลขบทซ้ำ/หาย/ไม่ต่อเนื่อง + เนื้อหาซ้ำ + ต้นฉบับไม่มีบทที่
 * N = อื่น ๆ (แท็บว่าง/เข้าข่ายประกาศ, ขยะท้ายบท, โปรโมตท้ายบท/จบตอน, ต้นฉบับอังกฤษ, สถิติแก้เนื้อหาเบา)
 */
function buildLightScanColumnNotes_(summary, doc) {
  summary = summary || {};

  // ===== L: ภาษา =====
  var lang = [];
  var coverage = summary.untranslatedCoverage || null;
  var coverageIncomplete = !!coverage && coverage.complete === false;
  var nonThai = Number(summary.nonThaiCount || 0);
  if (nonThai > 0) {
    lang.push('พบตัวอักษรต่างประเทศ ' + nonThai + ' ตัว');
    var foreignNames = (summary.foreignTabNames || []).slice(0, 50);
    if (foreignNames.length) lang.push('พบแท็บมีคำต่างประเทศ: ' + foreignNames.join(', '));
  } else if (coverageIncomplete) {
    // findings ว่างเพราะตรวจไม่ครบ — ห้ามรายงานว่าผ่าน
    lang.push('ยังตรวจไม่ครบ (' + coverage.checked + '/' + coverage.total + ' แท็บ) — ยังสรุปไม่ได้ว่าไม่พบตัวอักษรต่างประเทศ');
  } else {
    lang.push('ไม่พบตัวอักษรต่างประเทศ');
  }
  var longEnglishMessage = (typeof checkerBuildLongEnglishMessage_ === 'function')
    ? checkerBuildLongEnglishMessage_(summary.longEnglishTabNumbers || [])
    : '';
  if (longEnglishMessage) lang.push(longEnglishMessage);
  var untranslatedMessage = (typeof checkerBuildUntranslatedEnglishMessage_ === 'function')
    ? checkerBuildUntranslatedEnglishMessage_(summary.untranslatedEnglishTabs || [])
    : '';
  if (untranslatedMessage) lang.push(untranslatedMessage);

  // ===== M: เลขบท/เนื้อหาซ้ำ =====
  var seq = [];
  var dupNumbers = [];
  var missingNumbers = [];
  var otherNonContinuous = false;

  (summary.chapterSequenceIssues || []).forEach(function(issue) {
    var type = String(issue.type || '');
    var current = Number(issue.current);
    var expected = Number(issue.expected);

    if (type === 'เลขซ้ำ') {
      if (!isNaN(current) && dupNumbers.indexOf(current) === -1) dupNumbers.push(current);
    } else if (type === 'เลขข้าม' || type === 'ไม่ต่อเนื่อง') {
      if (!isNaN(expected) && !isNaN(current) && current > expected) {
        for (var n = expected; n <= current - 1; n++) {
          if (missingNumbers.indexOf(n) === -1) missingNumbers.push(n);
        }
      } else {
        otherNonContinuous = true;
      }
    } else if (type === 'เลขย้อนหลัง') {
      otherNonContinuous = true;
    }
  });

  dupNumbers.sort(function(a, b) { return a - b; });
  missingNumbers.sort(function(a, b) { return a - b; });

  var contentDupTexts = [];
  (summary.contentDuplicates || []).forEach(function(pair) {
    var a = (pair.chapterA == null) ? (pair.tabA || '') : ('บทที่ ' + pair.chapterA);
    var b = (pair.chapterB == null) ? (pair.tabB || '') : ('บทที่ ' + pair.chapterB);
    if (a && b) contentDupTexts.push(a + ' และ ' + b);
  });

  if (dupNumbers.length) seq.push('เลขบทซ้ำ ' + dupNumbers.join(', '));
  if (missingNumbers.length) seq.push('บทที่หาย ' + compressNumberRanges_(missingNumbers));
  if (otherNonContinuous) seq.push('เลขบทไม่ต่อเนื่อง');
  if (contentDupTexts.length) seq.push('เนื้อหาซ้ำ ' + contentDupTexts.slice(0, 20).join(' / '));
  if (!seq.length) seq.push('เลขบทเรียงต่อเนื่อง');

  var sourceNoChapterTabs = summary.sourceNoChapterTabs || [];
  if (sourceNoChapterTabs.length) {
    var sourceList = formatTabNumberList_(sourceNoChapterTabs.map(function(t) { return t.tabIndex; }));
    if (sourceList) seq.push('ต้นฉบับไม่มีบทที่: แท็บ ' + sourceList);
  }

  // ===== N: อื่น ๆ =====
  var other = [];
  var emptyTabs = summary.emptyTabNumbers || [];
  var announcementTabs = summary.announcementTabNumbers || [];

  if (emptyTabs.length) {
    other.push('พบ ' + emptyTabs.length + ' แท็บไม่มีเนื้อหา | แท็บ ' + formatTabNumberList_(emptyTabs));
  }
  if (announcementTabs.length) {
    other.push(
      'เข้าข่ายประกาศ (<' + Number(EMPTY_TAB_SCAN_CONFIG_.ANNOUNCEMENT_MIN_PARAGRAPHS) + ' ย่อหน้า) ' +
      announcementTabs.length + ' แท็บ: ' + formatTabNumberList_(announcementTabs)
    );
  }
  if (!emptyTabs.length && !announcementTabs.length) {
    other.push('ตรวจ ' + Number(summary.tabTotal || 0) + ' แท็บ ทุกแท็บมีเนื้อหา');
  }

  var junkByGroup = {};
  var junkOrder = [];
  (summary.tailJunkTabGroups || []).forEach(function(item) {
    var groupName = (typeof TAIL_JUNK_GROUPS_ !== 'undefined' && TAIL_JUNK_GROUPS_[item.group])
      ? TAIL_JUNK_GROUPS_[item.group]
      : String(item.group || '');
    if (!junkByGroup[groupName]) {
      junkByGroup[groupName] = [];
      junkOrder.push(groupName);
    }
    if (junkByGroup[groupName].indexOf(item.tabIndex) === -1) junkByGroup[groupName].push(item.tabIndex);
  });
  junkOrder.forEach(function(groupName) {
    other.push('ขยะท้ายบท ' + groupName + ': แท็บ ' + formatTabNumberList_(junkByGroup[groupName]));
  });

  var pendingPromoTabs = summary.endingPendingPromoTabs || [];
  if (pendingPromoTabs.length) {
    other.push('พบบรรทัดโปรโมตท้ายบท: แท็บ ' + formatTabNumberList_(pendingPromoTabs));
  }
  var missingMarkerTabs = summary.endingMissingMarkerTabs || [];
  if (missingMarkerTabs.length) {
    other.push('ไม่พบ "จบตอน" ท้ายแท็บ: แท็บ ' + formatTabNumberList_(missingMarkerTabs));
  }

  var engSourceTabs = (summary.englishSourceUncertainTabs || [])
    .map(function(x) { return Number(x.tabIndex || 0); })
    .filter(Boolean);
  if (engSourceTabs.length) {
    other.push('พบต้นฉบับอังกฤษติดหัวแท็บ: แท็บ ' + formatTabNumberList_(engSourceTabs));
  }

  var fixStats = [];
  if (Number(summary.replacedEmDashCount || 0) > 0) {
    fixStats.push('แทน — เป็น ... ' + Number(summary.replacedEmDashCount) + ' จุด');
  }
  if (Number(summary.titleColonFixed || 0) > 0) {
    fixStats.push('ลบ : ในชื่อบท ' + Number(summary.titleColonFixed) + ' จุด');
  }
  if (Number(summary.episodePrefixFixed || 0) > 0) {
    fixStats.push('แก้ ตอนที่ เป็น บทที่ ' + Number(summary.episodePrefixFixed) + ' จุด');
  }
  if (Number(summary.thaiDigitFixed || 0) > 0) {
    fixStats.push('แปลงเลขไทยเป็นอารบิก ' + Number(summary.thaiDigitFixed) + ' ตัว');
  }
  if (fixStats.length) other.push('แก้แล้ว: ' + fixStats.join(' | '));

  if (summary.untranslatedFallbackRan) {
    other.push('ตรวจไม่ครบ — สแกน untranslated ซ้ำทั้งเอกสารอัตโนมัติ');
  }

  var noteLanguage = dedupeCheckerNotes_(lang.join(' | '));
  var noteSequence = dedupeCheckerNotes_(seq.join(' | '));
  var noteOther = dedupeCheckerNotes_(other.join(' | '));

  // marker ฟรี ต้องอยู่คอลัมน์ L เสมอ (ระบบ export อ่าน ฟรี/จำนวนบท จาก L)
  if (doc && typeof isFreeChapterRangeDocument_ === 'function') {
    noteLanguage = addCheckerFreeMarker_(noteLanguage, isFreeChapterRangeDocument_(doc));
  }

  return {
    noteLanguage: noteLanguage,
    noteSequence: noteSequence,
    noteOther: noteOther
  };
}

/* =========================================================
 * LightScan PERF (perf-1): instrumentation + single-pass snapshot
 * - เพิ่มขึ้นจากงานเพิ่มความเร็ว "ตรวจแถวที่เลือก" บน branch perf/lightscan-fast
 * - วัดผ่าน run ID ต่องาน: นับจำนวนเปิดเอกสาร/อ่านย่อหน้า/hash + เวลาแต่ละขั้น
 *   ไม่บันทึกเนื้อหานิยายหรือข้อมูลลับลง log (มีแต่ตัวเลขและชื่อ stage)
 * - โหมด lightScan อ่านย่อหน้าครั้งเดียวต่อแท็บ (snapshot) แล้วให้ cleanup + ตัวตรวจ
 *   ทุกกลุ่มใช้ข้อความชุดเดียวกัน แทนการไล่อ่านเอกสารซ้ำหลายรอบ
 * - คงเกณฑ์การตรวจและการแก้เนื้อหาเบาเดิมทุกข้อ: — → ..., و → ล, เลขไทย → อารบิก,
 *   ลบ : หลังเลขบท, ไม่จัดฟอร์แมต, ไม่ลบขยะท้ายบท/เติมจบตอน
 * - การแก้ข้อความรักษาฟอร์แมต: ใช้ deleteText/insertText เฉพาะช่วง colon
 *   และ Text.replaceText สำหรับ — / و / เลขไทย (ข้อความใหม่รับฟอร์แมตของข้อความเดิม)
 * ========================================================= */

const LIGHT_SCAN_VERSION_ = 'perf-2';

var __LIGHT_SCAN_PERF__ = null;

function lightScanPerfInit_(runId) {
  __LIGHT_SCAN_PERF__ = {
    runId: String(runId || ''),
    version: LIGHT_SCAN_VERSION_,
    counts: {},
    stages: {}
  };
  return __LIGHT_SCAN_PERF__;
}

function lightScanPerfCount_(key, n) {
  if (!__LIGHT_SCAN_PERF__) return;
  __LIGHT_SCAN_PERF__.counts[key] = (__LIGHT_SCAN_PERF__.counts[key] || 0) + Number(n || 1);
}

function lightScanPerfMs_(key, ms) {
  if (!__LIGHT_SCAN_PERF__) return;
  __LIGHT_SCAN_PERF__.stages[key] = (__LIGHT_SCAN_PERF__.stages[key] || 0) + Math.max(0, Number(ms || 0));
}

function lightScanPerfTimed_(key, fn) {
  var startedAt = Date.now();
  try {
    return fn();
  } finally {
    lightScanPerfMs_(key, Date.now() - startedAt);
  }
}

function lightScanPerfSnapshot_() {
  return __LIGHT_SCAN_PERF__ ? JSON.parse(JSON.stringify(__LIGHT_SCAN_PERF__)) : null;
}

/**
 * คำนวณการแก้เนื้อหาเบาทั้ง 5 กฎจากข้อความย่อหน้า "ก่อนแก้" (pure function เทสได้)
 * เกณฑ์ตรงตัวกับโค้ดเดิม: /—/ → '...' (replaceEmDashWithEllipsis), /و/ → 'ล',
 * /[๐-๙]/ → อารบิก (convertThaiDigitsInBody_), colon หลังเลขบทเฉพาะหัวบท
 * (findChapterTitleColonFix_), และ "ตอนที่" → "บทที่" เฉพาะหัวบทหลักแรกของแท็บ
 * (ตามแบบ titleConvertAndReport_ เดิม; ไม่แตะ marker ต้นฉบับกลางแท็บ)
 * — ช่วงที่จับไม่ซ้อนกันเอง จึงคำนวณรวมบนข้อความชุดเดียวได้
 */
function computeLightScanParaEdits_(text, isHeadingPara, isPrimaryHeading) {
  var s = String(text || '');
  var edits = [];
  var emDash = 0;
  var waw = 0;
  var thaiDigit = 0;
  var tonToBod = 0;
  var m;

  var re = /—/g;
  while ((m = re.exec(s)) !== null) {
    edits.push({ start: m.index, end: m.index + 1, replacement: '...' });
    emDash++;
  }

  re = /و/g;
  while ((m = re.exec(s)) !== null) {
    edits.push({ start: m.index, end: m.index + 1, replacement: 'ล' });
    waw++;
  }

  re = /[๐-๙]/g;
  while ((m = re.exec(s)) !== null) {
    edits.push({ start: m.index, end: m.index + 1, replacement: thaiDigitsToArabic_(m[0]) });
    thaiDigit++;
  }

  var colonFix = null;
  if (isHeadingPara) {
    colonFix = findChapterTitleColonFix_(s);
    if (colonFix) {
      edits.push({ start: colonFix.start, end: colonFix.end, replacement: colonFix.insertSpace ? ' ' : '' });
    }
  }

  var tonToBodEdit = null;
  if (isPrimaryHeading && /^ตอนที่(?=\s*[0-9๐-๙])/.test(s)) {
    tonToBodEdit = { start: 0, end: 6, replacement: 'บทที่' };
    edits.push(tonToBodEdit);
    tonToBod = 1;
  }

  edits.sort(function(a, b) { return b.start - a.start; });

  return {
    edits: edits,
    counts: { emDash: emDash, waw: waw, thaiDigit: thaiDigit, colon: colonFix ? 1 : 0, tonToBod: tonToBod },
    colonFix: colonFix,
    tonToBodEdit: tonToBodEdit
  };
}

/**
 * แก้ย่อหน้าแบบรักษาฟอร์แมต:
 * - colon ใช้ deleteText/insertText เฉพาะช่วงตำแหน่งที่คำนวณไว้ (ตำแหน่งจากข้อความก่อนแก้)
 * - — / و / เลขไทย ใช้ Text.replaceText ซึ่งข้อความใหม่รับฟอร์แมตของข้อความเดิมที่ถูกแทน
 * เรียง: colon ก่อน (positional) แล้ว pattern-based ที่เหลือ — ช่วงไม่ซ้อนกันจึงไม่ขัดกัน
 */
function applyLightScanParaEdits_(p, computed) {
  var editor = p.editAsText();

  // positional edits จากข้อความก่อนแก้: ทำตำแหน่งท้ายก่อนหน้า (colon) แล้วค่อยต้นย่อหน้า (ตอนที่→บทที่)
  if (computed.colonFix) {
    editor.deleteText(computed.colonFix.start, computed.colonFix.end - 1);
    if (computed.colonFix.insertSpace) editor.insertText(computed.colonFix.start, ' ');
  }
  if (computed.tonToBodEdit) {
    editor.deleteText(computed.tonToBodEdit.start, computed.tonToBodEdit.end - 1);
    editor.insertText(computed.tonToBodEdit.start, computed.tonToBodEdit.replacement);
  }
  if (computed.counts.emDash > 0) editor.replaceText('—', '...');
  if (computed.counts.waw > 0) editor.replaceText('و', 'ล');
  if (computed.counts.thaiDigit > 0) {
    var pairs = [
      ['๐', '0'], ['๑', '1'], ['๒', '2'], ['๓', '3'], ['๔', '4'],
      ['๕', '5'], ['๖', '6'], ['๗', '7'], ['๘', '8'], ['๙', '9']
    ];
    pairs.forEach(function(pair) {
      editor.replaceText(pair[0], pair[1]);
    });
  }
}

/**
 * cleanup รวมต่อแท็บ: คำนวณจาก paraTexts ที่อ่านไว้แล้ว แล้วแก้เฉพาะย่อหน้าที่มีจุดแก้
 * คืน counts + รายชื่อย่อหน้า dirty (ผู้เรียก re-read เฉพาะแถว dirty เพื่อให้
 * การตรวจขั้นถัดไปเห็นข้อความล่าสุด — ไม่ใช้ cache เก่าข้ามการแก้ข้อความ)
 */
function applyLightScanCleanups_(paras, paraTexts) {
  var totals = { emDash: 0, waw: 0, thaiDigit: 0, colon: 0, tonToBod: 0 };
  var dirtyIndexes = [];
  var firstHeadingSeen = false;
  var startedAt = Date.now();

  for (var i = 0; i < paraTexts.length; i++) {
    var isHeading = isChapterLineText_(normalizeChapterLine_(paraTexts[i]));
    // "ตอนที่" → "บทที่" เฉพาะหัวบทแรกของแท็บ กันไปแตะหัวตอนต้นฉบับ (source episode marker) กลางแท็บ
    var isPrimaryHeading = isHeading && !firstHeadingSeen;
    if (isHeading) firstHeadingSeen = true;

    var computed = computeLightScanParaEdits_(paraTexts[i], isHeading, isPrimaryHeading);
    if (!computed.edits.length) continue;

    try {
      applyLightScanParaEdits_(paras[i], computed);
    } catch (e) {
      continue;
    }

    totals.emDash += computed.counts.emDash;
    totals.waw += computed.counts.waw;
    totals.thaiDigit += computed.counts.thaiDigit;
    totals.colon += computed.counts.colon;
    totals.tonToBod += computed.counts.tonToBod;
    dirtyIndexes.push(i);
  }

  lightScanPerfMs_('cleanup', Date.now() - startedAt);
  lightScanPerfCount_('cleanupParas', dirtyIndexes.length);
  return { counts: totals, dirtyIndexes: dirtyIndexes };
}

/** นับตัวอักษรต่างประเทศจากข้อความย่อหน้า (เกณฑ์เดียวกับเวอร์ชัน report-only เดิม) */
function countForeignCharactersFromTexts_(texts) {
  var count = 0;
  var KOREAN_RE_SRC = '[\\u1100-\\u11FF\\u3130-\\u318F\\uAC00-\\uD7AF]+';

  (texts || []).forEach(function(text) {
    if (!text) return;

    var koreanRe = new RegExp(KOREAN_RE_SRC, 'g');
    var km;
    while ((km = koreanRe.exec(text)) !== null) {
      count += km[0].length;
    }

    var re = new RegExp(FOREIGN_WORD_RE_V9_.source, 'g');
    var kaomojiSkipMap = buildKaomojiSkipMapV9_(text);

    var match;
    while ((match = re.exec(text)) !== null) {
      var word = match[0];
      var start = match.index;
      var end = start + word.length - 1;

      if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(word)) continue;
      if (kaomojiSkipMap[start] || shouldSkipForeignWordV9_(word, text, start, end)) continue;

      var allAllowed = true;
      for (var i = 0; i < word.length; i++) {
        if (!EXTRA_ALLOWED_CHARS_V9_.has(word[i])) {
          allAllowed = false;
          break;
        }
      }
      if (allAllowed) continue;

      count += word.length;
    }
  });

  return count;
}

/** ตัวอย่างข้อความบทจาก texts (port ตรงจาก buildChapterNormalizedComparisonInput_) */
function buildChapterNormalizedComparisonInputFromTexts_(paras, texts, headingIndex) {
  var collected = '';
  var limit = Math.min(texts.length, headingIndex + 30);

  for (var j = headingIndex + 1; j < limit; j++) {
    var raw = cleanText_(texts[j]);
    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;
    if (parseSourceEpisodeMarker_(raw, j + 1, null)) break;
    if (isChapterLineText_(normalizeChapterLine_(raw))) break;

    try {
      if (collected.length === 0 &&
          typeof isBoldUnderlineParagraph_ === 'function' &&
          isBoldUnderlineParagraph_(paras[j])) continue;
    } catch (e) {}

    collected += raw + ' ';
    if (collected.length >= 160) break;
  }

  return normalizeContentSignature_(collected);
}

/** ตัวอย่างยาว near-duplicate จาก texts (port ตรงจาก buildChapterNormalizedSimilarityInput_) */
function buildChapterNormalizedSimilarityInputFromTexts_(paras, texts, headingIndex) {
  var collected = '';
  var limit = Math.min(texts.length, headingIndex + 50);

  for (var j = headingIndex + 1; j < limit; j++) {
    var raw = cleanText_(texts[j]);
    if (!raw || raw === NOTE_TEXT_) continue;
    if (isStatusPanelLine_(raw)) continue;
    if (parseSourceEpisodeMarker_(raw, j + 1, null)) break;
    if (isChapterLineText_(normalizeChapterLine_(raw))) break;

    try {
      if (collected.length === 0 &&
          typeof isBoldUnderlineParagraph_ === 'function' &&
          isBoldUnderlineParagraph_(paras[j])) continue;
    } catch (e) {}

    collected += raw + ' ';
    if (collected.length >= 1600) break;
  }

  // normalize เดิมของ similarity input: lowercase + slice 1200 (ต่างจาก normalizeContentSignature_)
  return String(collected || '')
    .replace(INVIS_RE_, '')
    .replace(/[\s\u00A0]+/g, '')
    .replace(/[“”\"'‘’.,!?…\-–—()（）\[\]【】]/g, '')
    .toLowerCase()
    .slice(0, 1200);
}

/** ลายเซ็นเนื้อหาซ้ำ + near-duplicate จาก texts (port ตรงจาก collectChapterScanFromBody_) */
function collectChapterScanFromTexts_(paras, texts) {
  var chapters = [];
  var sourceEpisodeMarkers = [];
  var digestDocumentId = getCheckerContentDigestDocumentId_();
  var currentChapterNumber = null;

  for (var i = 0; i < texts.length; i++) {
    var text = cleanText_(texts[i]);
    if (!text || text === NOTE_TEXT_) continue;

    var line = normalizeChapterLine_(text);
    var sourceMarker = parseSourceEpisodeMarker_(line, i + 1, currentChapterNumber);
    if (sourceMarker) {
      sourceEpisodeMarkers.push(sourceMarker);
      if (SOURCE_EPISODE_CONFIG_.IGNORE_FOR_SEQUENCE_CHECK !== false) continue;
    }

    if (!isChapterLineText_(line)) continue;

    var num = extractChapterNumberFromText_(line);
    if (num != null && !isNaN(num)) {
      var similarity = chapters.length === 0
        ? lightScanPerfTimed_('hashSimilarity', function() {
            return computeCheckerContentSimilarityFingerprint_(
              digestDocumentId,
              buildChapterNormalizedSimilarityInputFromTexts_(paras, texts, i)
            );
          })
        : { hash: '', length: 0 };
      if (chapters.length === 0) lightScanPerfCount_('hashCount');

      var digest = lightScanPerfTimed_('hashDigest', function() {
        return computeCheckerContentDigest_(
          digestDocumentId,
          buildChapterNormalizedComparisonInputFromTexts_(paras, texts, i)
        );
      });
      lightScanPerfCount_('hashCount');

      chapters.push({
        paragraphIndex: i + 1,
        text: text,
        chapterNumber: num,
        contentDigest: digest,
        contentSimilarityHash: similarity.hash,
        contentSimilarityLength: similarity.length
      });
      currentChapterNumber = num;
    }
  }

  return {
    chapters: chapters,
    sourceEpisodeMarkers: sourceEpisodeMarkers
  };
}

/** ลำดับบทภายในแท็บจาก chapters (loop เดียวกับ checkChapterSequenceInBody_) */
function checkChapterSequenceFromChapters_(chapters) {
  var issues = [];

  for (var i = 1; i < chapters.length; i++) {
    var prev = chapters[i - 1];
    var curr = chapters[i];
    var expected = prev.chapterNumber + 1;

    if (curr.chapterNumber !== expected) {
      var type = 'ไม่ต่อเนื่อง';
      if (curr.chapterNumber === prev.chapterNumber) type = 'เลขซ้ำ';
      else if (curr.chapterNumber < prev.chapterNumber) type = 'เลขย้อนหลัง';
      else if (curr.chapterNumber > expected) type = 'เลขข้าม';

      issues.push({
        type: type,
        expected: expected,
        previous: prev.chapterNumber,
        current: curr.chapterNumber,
        paragraphIndex: curr.paragraphIndex,
        text: curr.text
      });
    }
  }

  return {
    ok: issues.length === 0,
    totalFound: chapters.length,
    chapters: chapters,
    issues: issues
  };
}

/** ประโยคอังกฤษยาวจากข้อความย่อหน้า (port ตรงจาก checkerScanLongEnglishParagraphsInActiveBody_) */
function checkerScanLongEnglishFromTexts_(texts) {
  var cfg = CHECKER_CFG || {};
  if (cfg.LONG_ENGLISH_CHECK_ENABLED === false) return { paragraphCount: 0 };

  var paragraphCount = 0;
  (texts || []).forEach(function(text) {
    var t = cleanText_(text);
    if (!t || t === NOTE_TEXT_) return;
    if (checkerHasLongEnglishSentence_(t)) paragraphCount++;
  });

  return { paragraphCount: paragraphCount };
}

/** ตรวจท้ายบท report-only จากข้อความย่อหน้า (port ตรงจาก detectEndingPromoReportOnly_) */
function detectEndingPromoFromTexts_(texts) {
  var cfg = (typeof ENDING_CLEANUP_CONFIG_ !== 'undefined') ? ENDING_CLEANUP_CONFIG_ : null;
  var empty = {
    changed: false,
    removedPromoLines: 0,
    removedPromoExamples: [],
    pendingPromoLines: 0,
    hadEndMarker: true,
    insertedEndMarker: false,
    dedupedEndMarker: 0,
    scannedTailParagraphs: 0
  };
  if (!cfg || cfg.ENABLED === false) return empty;

  var total = (texts || []).length;
  var scanLimit = Math.max(1, Number(cfg.TAIL_PARAGRAPH_SCAN_LIMIT || 15));
  var startIdx = Math.max(0, total - scanLimit);
  var pendingPromoLines = 0;
  var hadEndMarker = false;

  for (var i = startIdx; i < total; i++) {
    var text = cleanText_(texts[i]);
    if (!text || text === NOTE_TEXT_) continue;
    if (typeof isStatusPanelLine_ === 'function' && isStatusPanelLine_(text)) continue;

    if (typeof isEndMarkerLine_ === 'function' && isEndMarkerLine_(text, cfg)) {
      hadEndMarker = true;
    } else if (typeof isRemovableEndingPromoLine_ === 'function' && isRemovableEndingPromoLine_(text)) {
      pendingPromoLines++;
    }
  }

  return {
    changed: false,
    removedPromoLines: 0,
    removedPromoExamples: [],
    pendingPromoLines: pendingPromoLines,
    hadEndMarker: hadEndMarker,
    insertedEndMarker: false,
    dedupedEndMarker: 0,
    scannedTailParagraphs: total - startIdx
  };
}

/** ขยะท้ายบทจากข้อความย่อหน้า (port ตรงจาก scanTabTailJunkGroups_) */
function scanTabTailJunkFromTexts_(texts) {
  var groups = [];
  var limit = Number(TAIL_JUNK_SCAN_CFG_.TAIL_PARAGRAPHS || 10);
  var startIdx = Math.max(0, (texts || []).length - limit);

  for (var i = startIdx; i < (texts || []).length; i++) {
    if (!String(texts[i] || '').trim()) continue;
    var group = classifyTailJunkLine_(texts[i]);
    if (group && groups.indexOf(group) === -1) groups.push(group);
  }

  return groups;
}

/** ต้นฉบับอังกฤษ report-only จากข้อความย่อหน้า (ตัวตรวจเดิม detectEnglishSourceBlock_ รับ texts อยู่แล้ว) */
function detectEnglishSourceFromTexts_(texts) {
  var cfg = (typeof ENGLISH_SOURCE_CLEANUP_CONFIG_ !== 'undefined') ? ENGLISH_SOURCE_CLEANUP_CONFIG_ : null;
  var emptyReport = {
    detected: 0,
    removed: 0,
    removedParagraphs: 0,
    englishHeading: '',
    thaiHeading: '',
    startParagraphIndex: null,
    endParagraphIndex: null,
    confidence: null,
    examples: []
  };
  if (!cfg || cfg.ENABLED === false) return emptyReport;
  if (typeof detectEnglishSourceBlock_ !== 'function') return emptyReport;

  var blockInfo = detectEnglishSourceBlock_(texts || [], cfg);
  if (!blockInfo.detected) return emptyReport;

  return {
    detected: 1,
    removed: 0,
    removedParagraphs: 0,
    englishHeading: blockInfo.englishHeadingText,
    thaiHeading: blockInfo.thaiHeadingText,
    startParagraphIndex: blockInfo.startIndex + 1,
    endParagraphIndex: blockInfo.endIndex + 1,
    confidence: blockInfo.confidence,
    examples: blockInfo.confidence === 'HIGH' ? [] : blockInfo.examples
  };
}

/** แท็บยังไม่แปลจากข้อความรวมของแท็บ (เกณฑ์เดียวกับ computeUntranslatedEnglishInfoForActiveTab_) */
function computeUntranslatedEnglishFromTexts_(joinedText) {
  if (!CHECKER_CFG || CHECKER_CFG.ENGLISH_UNTRANSLATED_CHECK_ENABLED === false) return null;
  if (!checkerIsLikelyUntranslatedEnglishText_(joinedText)) return null;
  var analysis = checkerAnalyzeThaiEnglishRatio_(joinedText);
  return { latinRatio: analysis.latinRatio, thaiRatio: analysis.thaiRatio };
}
