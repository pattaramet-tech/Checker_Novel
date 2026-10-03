function getNovelMainSheet_() {
  const ss = SpreadsheetApp.getActive();

  if (NOVEL_HELPER_CONFIG.MAIN_SHEET_NAME) {
    const sheet = ss.getSheetByName(NOVEL_HELPER_CONFIG.MAIN_SHEET_NAME);
    if (!sheet) throw new Error(`ไม่พบชีตหลัก: ${NOVEL_HELPER_CONFIG.MAIN_SHEET_NAME}`);
    return sheet;
  }

  // ให้ใช้ชีตเดียวกับ Checker ก่อน เพื่อไม่หลุดไป AI_QUEUE/AI_LOG เวลาเปิด sidebar
  try {
    if (typeof getCheckerSheet_ === 'function') return getCheckerSheet_();
  } catch (e) {}

  const active = ss.getActiveSheet();
  if ([NOVEL_HELPER_CONFIG.QUEUE_SHEET, NOVEL_HELPER_CONFIG.LOG_SHEET].includes(active.getName())) {
    throw new Error('ตอนนี้อยู่ใน AI_QUEUE/AI_LOG กรุณากลับไปชีตงานหลักก่อน');
  }
  return active;
}

function getNovelDocUrlFromRow_(sheet, rowNumber) {
  const col = NOVEL_HELPER_CONFIG.DOC_URL_COL;
  const range = sheet.getRange(rowNumber, col);
  let value = String(range.getDisplayValue() || '').trim();

  // ถ้าเป็น Rich Text Link ให้ดึง URL จริงออกมาก่อน
  try {
    const rt = range.getRichTextValue();
    const direct = rt && rt.getLinkUrl ? rt.getLinkUrl() : '';
    if (direct) return direct;

    // กรณีมีหลาย run ในเซลล์
    const runs = rt && rt.getRuns ? rt.getRuns() : [];
    for (var i = 0; i < runs.length; i++) {
      var u = runs[i].getLinkUrl && runs[i].getLinkUrl();
      if (u) return u;
    }
  } catch (e) {}

  return value;
}

// อ่าน URL หลายแถวด้วย Google Service call ชุดเดียว
function getNovelDocUrlsBatch_(sheet, startRow, rowCount, displayRows) {
  if (!rowCount) return [];
  const col = NOVEL_HELPER_CONFIG.DOC_URL_COL;
  const result = new Array(rowCount).fill('');
  const richValues = sheet.getRange(startRow, col, rowCount, 1).getRichTextValues();

  for (let i = 0; i < rowCount; i++) {
    const displayValue = displayRows && displayRows[i]
      ? displayRows[i][col - 1]
      : '';
    let url = '';
    const rt = richValues[i] && richValues[i][0];

    try { url = rt && rt.getLinkUrl ? (rt.getLinkUrl() || '') : ''; } catch (e) {}
    if (!url && rt) {
      try {
        const runs = rt.getRuns ? rt.getRuns() : [];
        for (let j = 0; j < runs.length; j++) {
          const runUrl = runs[j].getLinkUrl ? runs[j].getLinkUrl() : '';
          if (runUrl) {
            url = runUrl;
            break;
          }
        }
      } catch (e2) {}
    }
    result[i] = String(url || displayValue || '').trim();
  }
  return result;
}

function getNovelDocumentTabs_(doc) {
  if (doc && typeof doc.getTabs === 'function') {
    const rawTabs = (typeof getAllTabsFlat_ === 'function')
      ? getAllTabsFlat_(doc)
      : flattenNovelDocumentTabsRaw_(doc.getTabs());
    if (rawTabs && rawTabs.length) {
      return rawTabs.map(function(tab) {
        return {
          tab: tab,
          title: tab.getTitle ? tab.getTitle() : '',
          tabId: tab.getId ? String(tab.getId()) : ''
        };
      });
    }
  }
  return [{ tab: null, title: 'เอกสารหลัก', tabId: '' }];
}

function getNovelBodyFromTab_(doc, tabInfo) {
  if (tabInfo && tabInfo.tab && typeof tabInfo.tab.asDocumentTab === 'function') {
    return tabInfo.tab.asDocumentTab().getBody();
  }
  return doc.getBody();
}

// Resolve a tab by its stable tabId. Falls back to the (unstable) 1-based tabNo ONLY when
// tabId itself is missing/blank (legacy queue rows exported before this change).
// A nonblank tabId that no longer matches any current tab (deleted/moved) must BLOCK, never
// silently fall back to tabNo — tabNo can point at a completely different tab after reordering.
function resolveNovelTabById_(tabs, tabId, fallbackTabNo) {
  const list = tabs || [];
  if (tabId) {
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].tabId === tabId) return list[i];
    }
    return null;
  }
  return list[Number(fallbackTabNo) - 1] || null;
}

function flattenNovelDocumentTabsRaw_(tabs, result = []) {
  for (const tab of tabs) {
    result.push(tab);
    const children = tab.getChildTabs ? tab.getChildTabs() : [];
    if (children && children.length) flattenNovelDocumentTabsRaw_(children, result);
  }
  return result;
}

function normalizeNovelColor_(color) {
  if (!color) return '';
  return String(color).trim().toLowerCase();
}
