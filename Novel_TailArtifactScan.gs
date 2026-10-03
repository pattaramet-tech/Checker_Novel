/****************************************************
 * Novel Tail Artifact Scanner
 *
 * Sheet: นิยายยังไม่จบ/ยังไม่ยื่น
 * Column C = Google Docs
 *
 * ตรวจเฉพาะช่วงท้ายของแต่ละ Google Docs Tab
 * เพื่อหาเศษ UI / metadata / footer จากเว็บต้นฉบับ เช่น:
 *
 * - ความคิดของผู้สร้าง
 * - ความคิดของผู้เขียน / ผู้แต่ง
 * - Author's Thoughts / Creator's Thoughts
 * - Takamiya_Shin Takamiya_Shin
 * - อ่านตอนเพิ่มเติม: bit.ly/...
 * - สนับสนุนผู้เขียน: paypal.me/...
 * - ความคิดเห็น / ความคิดเห็น 10
 * - Comments / Votes / โหวต
 *
 * ผลลัพธ์:
 * - แจ้งใน Execution log
 * - ไม่แก้ Google Docs
 * - ไม่แก้ Column L
 ****************************************************/

const NOVEL_TAIL_SCAN_CFG = {
  SHEET_NAME: 'นิยายยังไม่จบ/ยังไม่ยื่น',

  TITLE_COL: 2,    // B
  DOC_URL_COL: 3,  // C

  // ===== กำหนดช่วงแถวตรงนี้ =====
  START_ROW: 1660,
  END_ROW: 1700,
  // ===============================

  // ตรวจเฉพาะกี่ย่อหน้าสุดท้ายของแต่ละ Tab
  TAIL_PARAGRAPHS: 8,

  // ป้องกัน Apps Script timeout
  MAX_RUN_MS: 4.5 * 60 * 1000
};


/**
 * ฟังก์ชันหลัก
 *
 * Run ฟังก์ชันนี้
 */
function scanNovelTailArtifacts() {
  const startedAt = Date.now();

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const sheet = ss.getSheetByName(
    NOVEL_TAIL_SCAN_CFG.SHEET_NAME
  );

  if (!sheet) {
    throw new Error(
      'ไม่พบแท็บ "' +
      NOVEL_TAIL_SCAN_CFG.SHEET_NAME +
      '"'
    );
  }

  const lastRow = sheet.getLastRow();

  const startRow = Math.max(
    2,
    NOVEL_TAIL_SCAN_CFG.START_ROW
  );

  const endRow = Math.min(
    NOVEL_TAIL_SCAN_CFG.END_ROW,
    lastRow
  );

  console.log('======================================');
  console.log('NOVEL TAIL ARTIFACT SCAN');
  console.log(
    'ช่วงแถว: ' + startRow + ' - ' + endRow
  );
  console.log('======================================');

  let docsChecked = 0;
  let tabsChecked = 0;
  let rowsWithProblems = 0;
  let totalMatches = 0;

  const findings = [];


  for (let row = startRow; row <= endRow; row++) {

    /*
     * ถ้าใกล้หมดเวลา ให้หยุดแบบปลอดภัย
     */
    if (
      Date.now() - startedAt >
      NOVEL_TAIL_SCAN_CFG.MAX_RUN_MS
    ) {
      console.log('');
      console.log(
        '⏸ ใกล้หมดเวลา หยุดที่ก่อนแถว ' + row
      );
      console.log(
        'ให้รันต่อโดยแก้ START_ROW = ' + row
      );
      break;
    }


    try {
      const title = String(
        sheet
          .getRange(
            row,
            NOVEL_TAIL_SCAN_CFG.TITLE_COL
          )
          .getDisplayValue() || ''
      ).trim();


      const linkCell = sheet.getRange(
        row,
        NOVEL_TAIL_SCAN_CFG.DOC_URL_COL
      );


      /*
       * รองรับ Rich Text URL
       */
      let url = '';

      if (
        typeof getRichTextUrlSafe_ === 'function'
      ) {
        url =
          getRichTextUrlSafe_(linkCell) || '';
      }

      if (!url) {
        url = String(
          linkCell.getDisplayValue() || ''
        ).trim();
      }


      /*
       * Column C ว่าง
       */
      if (!url) {
        continue;
      }


      /*
       * ใช้ parser เดิมถ้ามี
       */
      let parsed;

      if (
        typeof parseGoogleDocUrl_ === 'function'
      ) {
        parsed = parseGoogleDocUrl_(url);

      } else {
        parsed =
          novelTailParseGoogleDocUrl_(url);
      }


      const docId =
        parsed && parsed.docId
          ? String(parsed.docId)
          : '';


      if (!docId) {
        console.log(
          '⚠️ แถว ' +
          row +
          ': ไม่พบ Google Docs ID'
        );

        continue;
      }


      /*
       * เปิด Google Docs
       */
      const doc =
        typeof openDocByIdSafe_ === 'function'
          ? openDocByIdSafe_(docId)
          : DocumentApp.openById(docId);


      /*
       * อ่าน Google Docs Tabs จริง
       */
      let tabs = [];

      if (
        typeof getAllTabsFlat_ === 'function'
      ) {
        tabs =
          getAllTabsFlat_(doc) || [];
      }


      /*
       * fallback เอกสารไม่มี Docs Tabs
       */
      if (!tabs.length) {
        tabs = [null];
      }


      docsChecked++;

      let rowMatches = [];


      for (
        let t = 0;
        t < tabs.length;
        t++
      ) {
        const tab = tabs[t];

        tabsChecked++;


        let body = null;

        if (
          tab &&
          typeof getBodyFromTabSafe_ ===
            'function'
        ) {
          body =
            getBodyFromTabSafe_(tab, doc);

        } else if (tab) {
          try {
            body =
              tab.asDocumentTab().getBody();
          } catch (e) {
            body = null;
          }

        } else {
          body = doc.getBody();
        }


        if (!body) {
          continue;
        }


        let tabTitle =
          'แท็บ ' + (t + 1);

        if (
          tab &&
          typeof getTabNameSafe_ ===
            'function'
        ) {
          tabTitle =
            getTabNameSafe_(tab, t);
        }


        /*
         * อ่านเฉพาะย่อหน้าท้าย
         */
        const paragraphs =
          body.getParagraphs();

        const startIndex = Math.max(
          0,
          paragraphs.length -
            NOVEL_TAIL_SCAN_CFG
              .TAIL_PARAGRAPHS
        );


        const tailLines = [];

        for (
          let p = startIndex;
          p < paragraphs.length;
          p++
        ) {
          const text = String(
            paragraphs[p].getText() || ''
          ).trim();

          if (text) {
            tailLines.push(text);
          }
        }


        /*
         * ตรวจ artifact
         */
        const matches =
          detectNovelTailArtifacts_(
            tailLines
          );


        if (matches.length) {
          matches.forEach(function(match) {

            rowMatches.push({
              tabNo: t + 1,
              tabTitle: tabTitle,
              type: match.type,
              text: match.text
            });

            totalMatches++;
          });
        }
      }


      if (rowMatches.length) {
        rowsWithProblems++;

        findings.push({
          row: row,
          title: title,
          matches: rowMatches
        });


        console.log('');
        console.log(
          '🚨 แถว ' +
          row +
          ' | ' +
          title
        );


        rowMatches.forEach(function(x) {
          console.log(
            '  ↳ แท็บ ' +
            x.tabNo +
            ' [' +
            x.tabTitle +
            '] ' +
            x.type +
            ' → ' +
            x.text
          );
        });
      }


    } catch (error) {
      console.log(
        '❌ แถว ' +
        row +
        ': ' +
        (
          error &&
          error.message
            ? error.message
            : error
        )
      );
    }
  }


  /*
   * Summary
   */
  console.log('');
  console.log('======================================');
  console.log('SUMMARY');
  console.log(
    'Docs ตรวจแล้ว: ' + docsChecked
  );
  console.log(
    'Tabs ตรวจแล้ว: ' + tabsChecked
  );
  console.log(
    'แถวที่พบปัญหา: ' +
    rowsWithProblems
  );
  console.log(
    'ข้อความที่พบทั้งหมด: ' +
    totalMatches
  );
  console.log('======================================');


  /*
   * สรุปเลขแถวอีกครั้ง
   */
  if (findings.length) {
    console.log('');
    console.log('แถวที่ควรตรวจ:');

    findings.forEach(function(item) {

      const tabs =
        item.matches
          .map(function(x) {
            return x.tabNo;
          })
          .filter(function(v, i, a) {
            return a.indexOf(v) === i;
          });

      console.log(
        'แถว ' +
        item.row +
        ' | แท็บ ' +
        compressNovelTailNumbers_(tabs)
      );
    });

  } else {
    console.log(
      '✅ ไม่พบข้อความต้องสงสัย'
    );
  }


  return findings;
}


/**
 * ตรวจข้อความท้าย Tab
 */
function detectNovelTailArtifacts_(lines) {
  const results = [];

  (lines || []).forEach(function(rawLine) {

    const original =
      String(rawLine || '').trim();

    if (!original) {
      return;
    }


    const normalized =
      normalizeNovelTailText_(original);


    /*
     * 1. Author / Creator thoughts
     */
    if (
      /^(?:ความคิด|ความคิดเห็น|หมายเหตุ|บันทึก)\s*(?:ของ)?\s*(?:ผู้สร้าง|ผู้เขียน|ผู้แต่ง|ผู้ประพันธ์)\s*:?\s*$/i
        .test(normalized) ||

      /^(?:author'?s?|creator'?s?)\s+(?:thoughts?|notes?)\s*:?\s*$/i
        .test(normalized)
    ) {
      results.push({
        type: 'AUTHOR_THOUGHTS',
        text: original
      });

      return;
    }


    /*
     * 2. Takamiya_Shin / ชื่อ username ซ้ำ
     *
     * เช่น:
     * Takamiya_Shin Takamiya_Shin
     */
    if (
      /takamiya[_\s-]*shin/i
        .test(normalized) ||

      /^([a-z][a-z0-9_.-]{2,})\s+\1$/i
        .test(normalized)
    ) {
      results.push({
        type: 'USERNAME / AUTHOR',
        text: original
      });

      return;
    }


    /*
     * 3. อ่านเพิ่ม / Read more
     */
    if (
      /(?:อ่าน|ติดตาม).{0,12}(?:ตอน|บท|เนื้อหา)?.{0,10}(?:เพิ่มเติม|เพิ่ม|ต่อไป)/i
        .test(normalized) ||

      /\b(?:read\s+more|more\s+chapters?|next\s+chapters?)\b/i
        .test(normalized) ||

      /\bbit\.ly\//i
        .test(normalized)
    ) {
      results.push({
        type: 'READ_MORE',
        text: original
      });

      return;
    }


    /*
     * 4. Donate / Support author
     */
    if (
      /(?:สนับสนุน|บริจาค|โดเนท).{0,20}(?:ผู้เขียน|ผู้แต่ง|ผู้สร้าง|ผู้ประพันธ์)?/i
        .test(normalized) ||

      /\bpaypal\.me\//i
        .test(normalized) ||

      /\bko-fi\.com\//i
        .test(normalized) ||

      /\bbuymeacoffee\.com\//i
        .test(normalized) ||

      /\b(?:support|donate|donation|tip)\b.{0,20}\b(?:author|writer|creator)?\b/i
        .test(normalized)
    ) {
      results.push({
        type: 'SUPPORT / DONATE',
        text: original
      });

      return;
    }


    /*
     * 5. Comments
     *
     * จำกัดให้เป็นบรรทัด UI สั้น ๆ เท่านั้น
     * เพื่อลด false positive จากเนื้อเรื่อง
     */
    if (
      /^(?:ความคิดเห็น|คอมเมนต์|ความเห็น)\s*[:：]?\s*\d*\s*$/i
        .test(normalized) ||

      /^(?:comments?|reviews?)\s*[:：]?\s*\d*\s*$/i
        .test(normalized)
    ) {
      results.push({
        type: 'COMMENTS',
        text: original
      });

      return;
    }


    /*
     * 6. Vote
     */
    if (
      /^(?:โหวต|คะแนนโหวต|จำนวนโหวต)\s*[:：]?\s*\d*\s*$/i
        .test(normalized) ||

      /^(?:votes?|voting)\s*[:：]?\s*\d*\s*$/i
        .test(normalized)
    ) {
      results.push({
        type: 'VOTE',
        text: original
      });

      return;
    }


    /*
     * 7. Power Stone / WebNovel footer ใกล้เคียง
     */
    if (
      /^(?:power\s*stones?|powerstone)\s*[:：]?\s*\d*\s*$/i
        .test(normalized) ||

      /^(?:พาวเวอร์\s*สโตน|หินพลัง)\s*[:：]?\s*\d*\s*$/i
        .test(normalized)
    ) {
      results.push({
        type: 'POWER_STONE',
        text: original
      });

      return;
    }
  });


  return results;
}


/**
 * normalize สำหรับจับคำใกล้เคียง
 */
function normalizeNovelTailText_(text) {
  return String(text || '')
    .replace(
      /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0\u2060]/g,
      ' '
    )
    .replace(/[“”"'`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * fallback parser
 */
function novelTailParseGoogleDocUrl_(url) {
  const match =
    String(url || '').match(
      /\/document\/d\/([a-zA-Z0-9_-]+)/
    );

  return {
    docId:
      match && match[1]
        ? match[1]
        : ''
  };
}


/**
 * 22,23,24,27 -> 22-24, 27
 */
function compressNovelTailNumbers_(numbers) {
  let arr =
    (numbers || [])
      .map(Number)
      .filter(function(n) {
        return !isNaN(n);
      })
      .sort(function(a, b) {
        return a - b;
      });


  arr = arr.filter(
    function(v, i) {
      return (
        i === 0 ||
        v !== arr[i - 1]
      );
    }
  );


  const out = [];

  let i = 0;

  while (i < arr.length) {
    let start = arr[i];
    let end = start;

    while (
      i + 1 < arr.length &&
      arr[i + 1] === end + 1
    ) {
      i++;
      end = arr[i];
    }

    out.push(
      start === end
        ? String(start)
        : start + '-' + end
    );

    i++;
  }


  return out.join(', ');
}