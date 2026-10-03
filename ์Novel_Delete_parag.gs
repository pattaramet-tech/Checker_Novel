/**
 * ลบช่องว่างก่อน "จบตอน" ทุก Google Docs Tab
 *
 * ทำเฉพาะ:
 * 1. ลบ paragraph ว่างที่ติดก่อน "จบตอน"
 * 2. ลบ paragraph ว่างที่มี Page Break
 * 3. Reset spacing before/after ของ "จบตอน"
 *
 * ไม่แตะเนื้อเรื่องส่วนอื่น
 */
function removeBlankBeforeEndMarkerAllTabs() {
  const DOC_ID = '1LHUr1NK9tlABmAOjBwVVdOAW4IfHh0r8HS_lwUWxoOQ';

  const doc = DocumentApp.openById(DOC_ID);

  const tabs = getAllDocumentTabsFlat_(doc);

  let tabsChecked = 0;
  let tabsChanged = 0;
  let removedParagraphs = 0;
  let endMarkersFound = 0;

  tabs.forEach(function(tab, tabIndex) {
    const body = getBodyFromDocumentTab_(tab, doc);

    if (!body) return;

    tabsChecked++;

    const result = cleanupBeforeEndMarkerInBody_(body);

    endMarkersFound += result.markersFound;
    removedParagraphs += result.removed;

    if (result.changed) {
      tabsChanged++;

      console.log(
        '✅ แท็บ ' +
        (tabIndex + 1) +
        ': ลบช่องว่าง ' +
        result.removed +
        ' paragraph'
      );
    }
  });

  console.log('===== SUMMARY =====');
  console.log('ตรวจทั้งหมด: ' + tabsChecked + ' แท็บ');
  console.log('พบ "จบตอน": ' + endMarkersFound + ' จุด');
  console.log('แก้ไข: ' + tabsChanged + ' แท็บ');
  console.log('ลบ paragraph ว่าง: ' + removedParagraphs);
}


/**
 * จัดการ Body ของ 1 Tab
 */
function cleanupBeforeEndMarkerInBody_(body) {
  let markersFound = 0;
  let removed = 0;
  let changed = false;

  /*
   * ต้องวนจากท้ายขึ้นบน
   * เพราะเราจะ removeChild()
   * index จะได้ไม่เลื่อนจนผิดตำแหน่ง
   */
  for (let i = body.getNumChildren() - 1; i >= 0; i--) {
    let element = body.getChild(i);

    if (
      element.getType() !==
      DocumentApp.ElementType.PARAGRAPH
    ) {
      continue;
    }

    const paragraph = element.asParagraph();

    const text = normalizeEndMarkerText_(
      paragraph.getText()
    );

    /*
     * ต้องเป็นคำว่า "จบตอน" เท่านั้น
     */
    if (text !== 'จบตอน') {
      continue;
    }

    markersFound++;


    /*
     * Reset spacing ของ paragraph จบตอน
     */
    try {
      paragraph.setSpacingBefore(0);
      paragraph.setSpacingAfter(0);
      changed = true;
    } catch (e) {}


    /*
     * ลบ paragraph ว่างก่อนหน้า
     */
    let previousIndex = i - 1;

    while (previousIndex >= 0) {
      const previous =
        body.getChild(previousIndex);

      if (
        previous.getType() !==
        DocumentApp.ElementType.PARAGRAPH
      ) {
        break;
      }

      const previousParagraph =
        previous.asParagraph();

      /*
       * ถ้า paragraph ไม่มีข้อความจริง
       * ให้ลบทิ้ง
       *
       * รวมถึง paragraph ที่มี Page Break
       * เพราะ getText() มักว่าง
       */
      if (
        isEffectivelyBlankParagraph_(
          previousParagraph
        )
      ) {
        body.removeChild(previous);

        removed++;
        changed = true;

        /*
         * หลัง remove:
         * "จบตอน" จะเลื่อนขึ้นมา 1 index
         */
        i--;
        previousIndex--;

        continue;
      }

      /*
       * เจอเนื้อเรื่องจริงแล้ว หยุด
       */
      break;
    }
  }

  return {
    markersFound: markersFound,
    removed: removed,
    changed: changed
  };
}


/**
 * Paragraph นี้เป็นช่องว่างจริงหรือไม่
 */
function isEffectivelyBlankParagraph_(paragraph) {
  if (!paragraph) return true;

  let text = '';

  try {
    text = String(
      paragraph.getText() || ''
    );
  } catch (e) {
    return false;
  }

  /*
   * กำจัด invisible characters
   */
  text = text
    .replace(
      /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g,
      ''
    )
    .trim();

  if (text !== '') {
    return false;
  }

  /*
   * Paragraph ว่าง
   * ถึงจะมี PageBreak อยู่ก็ถือว่าลบได้
   * เพราะอยู่ติดก่อน "จบตอน"
   */
  return true;
}


/**
 * normalize "จบตอน"
 */
function normalizeEndMarkerText_(text) {
  return String(text || '')
    .replace(
      /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * ดึง Google Docs Tabs ทั้งหมด
 * รวม Child Tabs
 */
function getAllDocumentTabsFlat_(doc) {
  const result = [];

  function walk(tabs) {
    (tabs || []).forEach(function(tab) {
      result.push(tab);

      try {
        const children =
          tab.getChildTabs
            ? tab.getChildTabs()
            : [];

        if (children && children.length) {
          walk(children);
        }
      } catch (e) {}
    });
  }

  if (
    doc &&
    typeof doc.getTabs === 'function'
  ) {
    walk(doc.getTabs());
  }

  /*
   * Google Docs แบบเก่า / ไม่มี Tabs
   */
  if (!result.length) {
    result.push(null);
  }

  return result;
}


/**
 * อ่าน Body ของ Google Docs Tab
 */
function getBodyFromDocumentTab_(tab, doc) {
  if (!tab) {
    return doc.getBody();
  }

  try {
    if (
      typeof tab.asDocumentTab ===
      'function'
    ) {
      return tab
        .asDocumentTab()
        .getBody();
    }
  } catch (e) {}

  try {
    if (
      typeof tab.getBody ===
      'function'
    ) {
      return tab.getBody();
    }
  } catch (e) {}

  return null;
}