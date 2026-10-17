/****************************************************
 * IpeNovel Package ZIP Row Exporter for Google Sheets
 * IpeNovelPackageRowExport.gs
 * --------------------------------------------------
 * ใช้ในไฟล์ Google Sheets "รายชื่อนิยาย / รวมนิยาย"
 *
 * ทำอะไร:
 * - เลือกแถวในชีต เช่น แถว 884
 * - อ่านชื่อเรื่องจากคอลัมน์ B
 * - อ่านลิงก์ Google Docs จากคอลัมน์ C ถ้าไม่มีจะลอง D/E
 * - Export Google Docs tabs เป็น package-import.zip
 * - ใน zip มี manifest.csv + contents/001-050.txt
 * - วางลิงก์ ZIP กลับคอลัมน์ O
 *
 * สำคัญ:
 * - ใช้คู่กับระบบ Import Package ZIP ของ ipenovelz
 * - 1 ZIP = 1 นิยาย / 1 แถว
 * - 1 TXT = 1 แพ็ก เช่น 001-050.txt
 ****************************************************/

const IPN_PACKAGE_ROW_EXPORT_CONFIG = {
  MAIN_SHEET_NAME: '',

  HEADER_ROW: 1,
  FIRST_DATA_ROW: 2,

  TITLE_COL: 2,        // B = ชื่อเรื่อง
  DOC_URL_COL: 3,      // C = ลิงก์ Google Docs
  FALLBACK_DOC_URL_COLS: [4, 5], // D/E
  OUTPUT_LINK_COL: 15, // O = วางลิงก์ ZIP (แทรกคอลัมน์ F แล้วขยับ +1)

  PACKAGE_SIZE: 50,

  DEFAULT_PRICE: 100,
  // ใส่กฎราคาแยกแพ็ก เช่น:
  // 001-050=98
  // 051-100=100
  // default=100
  DEFAULT_PRICE_RULES: '',
  AUTO_IS_FREE_BY_PRICE: true,
  DEFAULT_IS_FREE: false,
  DEFAULT_IS_PUBLISHED: true,
  DEFAULT_CONTENT_FORMAT: 'plain_text',
  DEFAULT_SALE_MODE: 'package',

  MERGE_SELECTED_ROWS_TO_ONE_ZIP: false,
  PRESERVE_SELECTED_ROW_AS_PACKAGE: true,
  PRICE_MODE: 'sheetNotePerChapter', // fixed | rangeRules | perChapter | sheetNotePerChapter
  PRICE_PER_CHAPTER: 2,
  PACKAGE_NOTE_COL: 13, // M = หมายเหตุโปรแกรม / จำนวนบท / ฟรี (แทรกคอลัมน์ F แล้วขยับ +1)
  FREE_KEYWORDS: ['ฟรี', 'free'],

  ZIP_SUFFIX: '_package_import.zip',
  MANIFEST_FILE_NAME: 'manifest.csv',
  CONTENT_DIR: 'contents',

  // Multi-Novel ZIP (Import Multi-Novel ZIP: /admin/import-episodes)
  MULTI_NOVEL_ZIP_SUFFIX: '_multi_novel_package_import.zip',
  MULTI_NOVEL_CONTENT_DIR: 'contents',
  MULTI_NOVEL_USE_MATCH_TITLE_AFTER_COLON: true,
  MULTI_NOVEL_STRIP_TRAILING_RANGE_FROM_TITLE: true,

  SORT_BY_EPISODE_NUMBER: true,

  WARN_TXT_BYTES: 7.5 * 1024 * 1024,

  OUTPUT_FOLDER_ID: '1bDT1DV8p6DjUaLpWe30vtNbVy-e2w71L',

  OVERWRITE_OUTPUT_LINK: true,
  SLEEP_BETWEEN_ROWS_MS: 400
};

function addIpeNovelPackageRowExportMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('IpeNovel Package Export')
    .addItem('Open Package Export Sidebar', 'showIpeNovelPackageRowExportSidebar')
    .addSeparator()
    .addItem('Export ZIP จากแถวที่เลือก', 'exportIpeNovelPackageZipFromSelectedRows')
    .addItem('Export ZIP รวมแถวที่เลือกเป็น ZIP เดียว', 'exportIpeNovelPackageMergedZipFromSelectedRows')
    .addItem('Export Multi-Novel ZIP จากแถวที่เลือก', 'exportIpeNovelPackageMultiNovelZipFromSelectedRows')
    .addItem('Export ZIP จากเลขแถว...', 'exportIpeNovelPackageZipByPromptRow')
    .addSeparator()
    .addItem('ติดตั้งเมนู Package Export ตอนนี้', 'installIpeNovelPackageRowExportMenuNow')
    .addToUi();
}

function installIpeNovelPackageRowExportMenuNow() {
  addIpeNovelPackageRowExportMenu_();
  SpreadsheetApp.getUi().alert('เพิ่มเมนู IpeNovel Package Export แล้ว');
}

function showIpeNovelPackageRowExportSidebar() {
  const html = HtmlService
    .createHtmlOutputFromFile('IpeNovelPackageSidebar')
    .setTitle('IpeNovel Package Export');

  SpreadsheetApp.getUi().showSidebar(html);
}

function getIpeNovelPackageExportDefaultSettings() {
  const sheet = ipnPkgRowGetMainSheet_();
  const range = sheet.getActiveRange();
  const activeRow = range ? range.getRow() : IPN_PACKAGE_ROW_EXPORT_CONFIG.FIRST_DATA_ROW;

  return {
    row: activeRow >= IPN_PACKAGE_ROW_EXPORT_CONFIG.FIRST_DATA_ROW
      ? activeRow
      : IPN_PACKAGE_ROW_EXPORT_CONFIG.FIRST_DATA_ROW,

    packageSize: Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_SIZE || 50),
    price: Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE || 0),
    priceRules: String(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE_RULES || ''),
    autoIsFreeByPrice: !!IPN_PACKAGE_ROW_EXPORT_CONFIG.AUTO_IS_FREE_BY_PRICE,
    isFree: !!IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_FREE,
    isPublished: !!IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED,
    sortByEpisodeNumber: !!IPN_PACKAGE_ROW_EXPORT_CONFIG.SORT_BY_EPISODE_NUMBER,
    outputFolderId: String(IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID || ''),
    outputLinkCol: Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_LINK_COL || 15),

    preserveSelectedRowAsPackage: !!IPN_PACKAGE_ROW_EXPORT_CONFIG.PRESERVE_SELECTED_ROW_AS_PACKAGE,
    priceMode: String(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE || 'sheetNotePerChapter'),
    pricePerChapter: Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_PER_CHAPTER || 2),
    packageNoteCol: Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_NOTE_COL || 13)
  };
}

function exportIpeNovelPackageZipFromSidebar(settings) {
  settings = settings || {};

  const sheet = ipnPkgRowGetMainSheet_();
  let rowNo = Number(settings.row || 0);

  if (!rowNo) {
    const range = sheet.getActiveRange();
    rowNo = range ? range.getRow() : 0;
  }

  if (!Number.isFinite(rowNo) || rowNo < IPN_PACKAGE_ROW_EXPORT_CONFIG.FIRST_DATA_ROW) {
    throw new Error('เลขแถวไม่ถูกต้อง กรุณาเลือกแถวข้อมูล หรือใส่เลขแถว เช่น 884');
  }

  return ipnPkgRowRunWithTemporarySettings_(settings, function() {
    return ipnPkgRowExportOneRow_(sheet, rowNo);
  });
}

function exportIpeNovelPackageZipSelectedFromSidebar(settings) {
  settings = settings || {};

  return ipnPkgRowRunWithTemporarySettings_(settings, function() {
    return ipnPkgRowExportSelectedRowsCore_({ silentConfirm: true });
  });
}

function exportIpeNovelPackageMergedZipSelectedFromSidebar(settings) {
  settings = settings || {};
  settings = Object.assign({}, settings, { mergeSelectedRowsToOneZip: true });

  return ipnPkgRowRunWithTemporarySettings_(settings, function() {
    return ipnPkgRowExportMergedSelectedRowsCore_({ silentConfirm: true });
  });
}

function exportIpeNovelPackageMergedZipFromSelectedRows() {
  // ipnPkgRowExportMergedSelectedRowsCore_ already shows its own ui.alert()
  // for every non-success case (no selection, cancel, all rows failed) when
  // silentConfirm is false — only show the extra summary alert on success.
  const ui = SpreadsheetApp.getUi();
  const res = ipnPkgRowExportMergedSelectedRowsCore_({ silentConfirm: false });

  if (!res || !res.ok) return;

  const lines = [
    '✅ Export ZIP รวมสำเร็จ',
    '',
    'จำนวนแถวที่เลือก: ' + (res.rowCount || 0),
    'รวมสำเร็จ: ' + (res.successRowCount || 0),
    'จำนวนบททั้งหมด: ' + (res.chapterCount || 0),
    'จำนวนแพ็ก: ' + (res.packageCount || 0),
    '',
    'ZIP: ' + res.zipUrl
  ];

  if (res.problems && res.problems.length) {
    lines.push('', 'ปัญหา: ' + res.problems.slice(0, 10).join(' | '));
  }

  ui.alert(lines.join('\n'));
}

function exportIpeNovelPackageMultiNovelZipSelectedFromSidebar(settings) {
  settings = settings || {};
  settings = Object.assign({}, settings, { mergeSelectedRowsToOneZip: true });

  return ipnPkgRowRunWithTemporarySettings_(settings, function() {
    return ipnPkgRowExportMultiNovelSelectedRowsCore_({ silentConfirm: true });
  });
}

function exportIpeNovelPackageMultiNovelZipFromSelectedRows() {
  // ipnPkgRowExportMultiNovelSelectedRowsCore_ already shows its own ui.alert()
  // for every non-success case (no selection, cancel, all rows failed) when
  // silentConfirm is false — only show the extra summary alert on success.
  const ui = SpreadsheetApp.getUi();
  const res = ipnPkgRowExportMultiNovelSelectedRowsCore_({ silentConfirm: false });

  if (!res || !res.ok) return;

  const lines = [
    '✅ Export Multi-Novel ZIP สำเร็จ',
    '',
    'จำนวนแถวที่เลือก: ' + (res.rowCount || 0),
    'รวมสำเร็จ: ' + (res.successRowCount || 0),
    'จำนวนเรื่องที่พบ: ' + (res.novelCount || 0),
    'จำนวนแพ็กทั้งหมด: ' + (res.packageCount || 0),
    '',
    'ZIP: ' + res.zipUrl
  ];

  if (res.problems && res.problems.length) {
    lines.push('', 'ปัญหา: ' + res.problems.slice(0, 10).join(' | '));
  }

  ui.alert(lines.join('\n'));
}

function exportIpeNovelPackageZipByPromptRow() {
  const ui = SpreadsheetApp.getUi();

  const res = ui.prompt(
    'Export Package ZIP',
    'ใส่เลขแถวที่ต้องการ Export เช่น 884',
    ui.ButtonSet.OK_CANCEL
  );

  if (res.getSelectedButton() !== ui.Button.OK) return;

  const rowNo = Number(String(res.getResponseText() || '').trim());
  if (!Number.isFinite(rowNo) || rowNo < IPN_PACKAGE_ROW_EXPORT_CONFIG.FIRST_DATA_ROW) {
    ui.alert('เลขแถวไม่ถูกต้อง');
    return;
  }

  const sheet = ipnPkgRowGetMainSheet_();
  const result = ipnPkgRowExportOneRow_(sheet, rowNo);

  ui.alert(
    result.ok
      ? 'Export สำเร็จ\n\nแถว: ' + rowNo + '\nZIP:\n' + result.zipUrl
      : 'Export ไม่สำเร็จ\n\nแถว: ' + rowNo + '\n' + result.message
  );
}

function exportIpeNovelPackageZipFromSelectedRows() {
  ipnPkgRowExportSelectedRowsCore_({ silentConfirm: false });
}

function ipnPkgRowExportSelectedRowsCore_(options) {
  options = options || {};

  const ui = SpreadsheetApp.getUi();
  const sheet = ipnPkgRowGetMainSheet_();
  const rows = ipnPkgRowGetSelectedRows_(sheet);

  if (!rows.length) {
    if (!options.silentConfirm) ui.alert('กรุณาเลือกแถวหรือเซลล์ในแถวที่ต้องการ Export');
    return {
      ok: false,
      message: 'ไม่พบแถวที่เลือก',
      success: 0,
      failed: 0,
      results: []
    };
  }

  if (!options.silentConfirm) {
    const confirm = ui.alert(
      'ยืนยัน Export Package ZIP',
      'จะ Export ทั้งหมด ' + rows.length + ' แถว\n\nแถว: ' + rows.join(', ') +
        '\n\nลิงก์ ZIP จะถูกวางในคอลัมน์ O',
      ui.ButtonSet.OK_CANCEL
    );

    if (confirm !== ui.Button.OK) {
      return {
        ok: false,
        message: 'ยกเลิก',
        success: 0,
        failed: 0,
        results: []
      };
    }
  }

  const results = [];
  let success = 0;
  let failed = 0;

  rows.forEach(function(rowNo) {
    try {
      const r = ipnPkgRowExportOneRow_(sheet, rowNo);
      results.push(r);

      if (r.ok) success++;
      else failed++;

      SpreadsheetApp.flush();
      Utilities.sleep(Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.SLEEP_BETWEEN_ROWS_MS || 400));

    } catch (e) {
      failed++;

      const msg = e && e.message ? e.message : String(e);
      const r = {
        ok: false,
        row: rowNo,
        message: msg
      };

      results.push(r);
      ipnPkgRowWriteOutput_(sheet, rowNo, '', '❌ ' + msg);
    }
  });

  const summary = {
    ok: failed === 0,
    message: 'Export เสร็จแล้ว สำเร็จ ' + success + ' / ผิดพลาด ' + failed,
    success: success,
    failed: failed,
    results: results
  };

  if (!options.silentConfirm) {
    const lines = [
      'Export Package ZIP เสร็จแล้ว',
      '',
      'สำเร็จ: ' + success,
      'ผิดพลาด: ' + failed,
      ''
    ];

    results.slice(0, 20).forEach(function(r) {
      lines.push(
        (r.ok ? '✅ ' : '❌ ') +
        'แถว ' + r.row +
        ': ' +
        (r.ok ? r.zipUrl : r.message)
      );
    });

    if (results.length > 20) {
      lines.push('...และอีก ' + (results.length - 20) + ' รายการ');
    }

    ui.alert(lines.join('\n'));
  }

  return summary;
}

function ipnPkgRowExportMergedSelectedRowsCore_(options) {
  options = options || {};

  const ui = SpreadsheetApp.getUi();
  const sheet = ipnPkgRowGetMainSheet_();
  const rows = ipnPkgRowGetSelectedRows_(sheet);

  if (!rows.length) {
    if (!options.silentConfirm) ui.alert('กรุณาเลือกแถวที่ต้องการรวมเป็น ZIP เดียว');
    return {
      ok: false,
      message: 'ไม่พบแถวที่เลือก',
      rowCount: 0,
      successRowCount: 0,
      chapterCount: 0,
      packageCount: 0,
      problems: [],
      results: []
    };
  }

  if (!options.silentConfirm) {
    const confirm = ui.alert(
      'ยืนยัน Export ZIP รวมแถวที่เลือกเป็น ZIP เดียว',
      'จะรวม ' + rows.length + ' แถวเป็น ZIP เดียว\n\nแถว: ' + rows.join(', ') +
        '\n\nลิงก์ ZIP จะถูกวางที่แถวแรก (' + rows[0] + ') คอลัมน์ O',
      ui.ButtonSet.OK_CANCEL
    );

    if (confirm !== ui.Button.OK) {
      return {
        ok: false,
        message: 'ยกเลิก',
        rowCount: 0,
        successRowCount: 0,
        chapterCount: 0,
        packageCount: 0,
        problems: [],
        results: []
      };
    }
  }

  const preserve = !!IPN_PACKAGE_ROW_EXPORT_CONFIG.PRESERVE_SELECTED_ROW_AS_PACKAGE;
  const firstRow = rows[0];
  const rowResults = [];
  const packages = [];
  let baseName = '';

  rows.forEach(function(rowNo) {
    try {
      const storyTitle = String(
        sheet.getRange(rowNo, IPN_PACKAGE_ROW_EXPORT_CONFIG.TITLE_COL).getDisplayValue() || ''
      ).trim();

      if (!baseName && storyTitle) baseName = storyTitle;

      const docUrlInfo = ipnPkgRowGetDocUrlFromRow_(sheet, rowNo);
      if (!docUrlInfo.url) {
        rowResults.push({ row: rowNo, ok: false, message: 'ไม่พบลิงก์ Google Docs ในคอลัมน์ C/D/E' });
        return;
      }

      const docId = ipnPkgRowExtractGoogleDocId_(docUrlInfo.url);
      if (!docId) {
        rowResults.push({
          row: rowNo,
          ok: false,
          message: 'ลิงก์ไม่ใช่ Google Docs หรือดึง Doc ID ไม่ได้: ' + docUrlInfo.url
        });
        return;
      }

      let doc;
      try {
        doc = DocumentApp.openById(docId);
      } catch (e) {
        rowResults.push({
          row: rowNo,
          ok: false,
          message: 'เปิด Google Docs ไม่ได้: ' + (e && e.message ? e.message : e)
        });
        return;
      }

      const docName = doc.getName();
      const exportData = ipnPkgRowBuildExportDataFromDoc_(doc);

      if (!exportData.chapters.length) {
        rowResults.push({ row: rowNo, ok: false, message: 'ไม่พบแท็บที่มี title/content สำหรับ export' });
        return;
      }

      if (preserve) {
        const chapters = exportData.chapters;
        const startNo = chapters[0].episodeNumber;
        const endNo = chapters[chapters.length - 1].episodeNumber;

        const episodeNumber = startNo === endNo
          ? String(startNo)
          : String(startNo) + ' - ' + String(endNo);

        const episodeTitle = startNo === endNo
          ? 'แพ็กบทที่ ' + startNo
          : 'แพ็กบทที่ ' + startNo + ' - ' + endNo;

        const fileBase =
          ipnPkgRowPadNumberForFile_(startNo) + '-' + ipnPkgRowPadNumberForFile_(endNo);

        const contentFile = IPN_PACKAGE_ROW_EXPORT_CONFIG.CONTENT_DIR + '/' + fileBase + '.txt';

        const packageContent = chapters.map(function(ch) {
          return ch.title + '\n\n' + (ch.content || '');
        }).join('\n\n\n');

        const chapterCount = chapters.length;
        const priceInfo = ipnPkgRowResolveMergedPackagePriceForRow_(sheet, rowNo, startNo, endNo, chapterCount);

        const pkg = {
          row: rowNo,
          storyTitle: storyTitle || docName || ('row-' + rowNo),
          startNo: startNo,
          endNo: endNo,
          episodeNumber: episodeNumber,
          episodeTitle: episodeTitle,
          price: ipnPkgRowFormatPrice_(priceInfo.price),
          isFree: String(priceInfo.isFree).toLowerCase(),
          isPublished: String(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED).toLowerCase(),
          saleMode: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_SALE_MODE,
          contentFile: contentFile,
          contentFormat: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_CONTENT_FORMAT,
          sortOrder: String(startNo),
          description: ipnPkgRowBuildMergedPackageDescription_(episodeNumber, chapterCount, priceInfo),
          priceSource: priceInfo.source,
          priceChapterCount: priceInfo.priceChapterCount || chapterCount,
          rawPriceNote: priceInfo.rawNote || '',
          content: packageContent,
          contentBytes: ipnPkgRowUtf8ByteLength_(packageContent),
          chapterCount: chapterCount,
          chapters: chapters
        };

        if (pkg.contentBytes > Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.WARN_TXT_BYTES || 0)) {
          pkg.sizeWarning =
            'แพ็กแถว ' + rowNo + ' (' + episodeNumber + ') มีขนาด ' +
            Math.round(pkg.contentBytes / 1024 / 1024 * 10) / 10 +
            'MB ควรตรวจว่าไม่เกิน limit import/DB';
        }

        if (String(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE || '') === 'sheetNotePerChapter') {
          const noteParsed = ipnPkgRowParseChapterCountAndFreeFromNote_(priceInfo.rawNote || '');
          if (noteParsed.chapterCountFromNote !== null && noteParsed.chapterCountFromNote !== chapterCount) {
            pkg.noteMismatchWarning =
              'แถว ' + rowNo + ': จำนวนบทในคอลัมน์ M = ' + noteParsed.chapterCountFromNote +
              ' แต่จำนวนแท็บจริง = ' + chapterCount;
          }
        }

        packages.push(pkg);
      } else {
        exportData.packages.forEach(function(p) {
          const chapterCount = p.chapterCount || (p.chapters ? p.chapters.length : 0);
          const priceInfo = ipnPkgRowResolveMergedPackagePrice_(p.startNo, p.endNo, chapterCount);

          const fileBase =
            'r' + rowNo + '-' +
            ipnPkgRowPadNumberForFile_(p.startNo) + '-' + ipnPkgRowPadNumberForFile_(p.endNo);

          const contentFile = IPN_PACKAGE_ROW_EXPORT_CONFIG.CONTENT_DIR + '/' + fileBase + '.txt';

          const pkg = {
            row: rowNo,
            storyTitle: storyTitle || docName || ('row-' + rowNo),
            startNo: p.startNo,
            endNo: p.endNo,
            episodeNumber: p.episodeNumber,
            episodeTitle: p.episodeTitle,
            price: ipnPkgRowFormatPrice_(priceInfo.price),
            isFree: String(priceInfo.isFree).toLowerCase(),
            isPublished: p.isPublished,
            saleMode: p.saleMode,
            contentFile: contentFile,
            contentFormat: p.contentFormat,
            sortOrder: p.sortOrder,
            description: 'แพ็กอ่านบนเว็บ บทที่ ' + p.episodeNumber + ' | ราคา: ' + ipnPkgRowFormatPrice_(priceInfo.price) + ' บาท',
            priceSource: priceInfo.source,
            content: p.content,
            contentBytes: p.contentBytes,
            chapterCount: chapterCount,
            chapters: p.chapters || []
          };

          if (pkg.contentBytes > Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.WARN_TXT_BYTES || 0)) {
            pkg.sizeWarning =
              'แพ็กแถว ' + rowNo + ' (' + p.episodeNumber + ') มีขนาด ' +
              Math.round(pkg.contentBytes / 1024 / 1024 * 10) / 10 +
              'MB ควรตรวจว่าไม่เกิน limit import/DB';
          }

          packages.push(pkg);
        });
      }

      rowResults.push({
        row: rowNo,
        ok: true,
        chapterCount: exportData.chapters.length
      });

    } catch (e) {
      rowResults.push({
        row: rowNo,
        ok: false,
        message: e && e.message ? e.message : String(e)
      });
    }
  });

  const okPackages = packages.slice().sort(function(a, b) { return a.startNo - b.startNo; });

  if (!okPackages.length) {
    const msg = 'ไม่พบแถวที่ export ได้สำเร็จเลย';

    rows.forEach(function(rowNo) {
      const rr = rowResults.filter(function(r) { return r.row === rowNo; })[0];
      ipnPkgRowWriteOutput_(sheet, rowNo, '', '❌ ' + (rr && rr.message ? rr.message : msg));
    });

    if (!options.silentConfirm) ui.alert(msg);

    return {
      ok: false,
      message: msg,
      rowCount: rows.length,
      successRowCount: 0,
      chapterCount: 0,
      packageCount: 0,
      problems: [],
      results: rowResults
    };
  }

  const problems = ipnPkgRowCheckMergedRangeProblems_(okPackages);

  okPackages.forEach(function(pkg) {
    if (pkg.sizeWarning) problems.push(pkg.sizeWarning);
    if (pkg.noteMismatchWarning) problems.push(pkg.noteMismatchWarning);
  });

  const zipFile = ipnPkgRowCreatePackageZip_(baseName || 'ipenovel-merged-package', okPackages);

  const totalChapters = okPackages.reduce(function(sum, p) { return sum + p.chapterCount; }, 0);
  const successRows = {};
  okPackages.forEach(function(p) { successRows[p.row] = true; });
  const successRowCount = Object.keys(successRows).length;

  const noteLines = [
    '✅ Export ZIP รวมสำเร็จ',
    'ไฟล์: ' + zipFile.getName(),
    'จำนวนแถวที่รวม: ' + successRowCount + ' / ' + rows.length,
    'จำนวนบททั้งหมด: ' + totalChapters,
    'จำนวนแพ็ก: ' + okPackages.length
  ];

  if (problems.length) {
    noteLines.push('ปัญหา: ' + problems.slice(0, 10).join(' | '));
  }

  ipnPkgRowWriteOutput_(sheet, firstRow, zipFile.getUrl(), noteLines.join('\n'));

  rows.forEach(function(rowNo) {
    if (rowNo === firstRow) return;

    if (successRows[rowNo]) {
      ipnPkgRowWriteMergedRefNote_(sheet, rowNo, 'รวมอยู่ใน ZIP แถว ' + firstRow);
    } else {
      const rr = rowResults.filter(function(r) { return r.row === rowNo; })[0];
      ipnPkgRowWriteOutput_(sheet, rowNo, '', '❌ ' + (rr && rr.message ? rr.message : 'ไม่ทราบสาเหตุ'));
    }
  });

  const packagesSummary = okPackages.map(function(p) {
    return {
      row: p.row,
      episodeNumber: p.episodeNumber,
      chapterCount: p.chapterCount,
      priceChapterCount: p.priceChapterCount || p.chapterCount,
      price: p.price,
      isFree: p.isFree,
      priceSource: p.priceSource || '',
      rawPriceNote: p.rawPriceNote || '',
      contentFile: p.contentFile
    };
  });

  return {
    ok: true,
    message: 'Export ZIP รวมสำเร็จ',
    zipUrl: zipFile.getUrl(),
    fileName: zipFile.getName(),
    firstRow: firstRow,
    rowCount: rows.length,
    successRowCount: successRowCount,
    chapterCount: totalChapters,
    packageCount: okPackages.length,
    packages: packagesSummary,
    problems: problems,
    results: rowResults
  };
}

function ipnPkgRowRunWithTemporarySettings_(settings, callback) {
  settings = settings || {};

  const old = {
    PACKAGE_SIZE: IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_SIZE,
    DEFAULT_PRICE: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE,
    DEFAULT_PRICE_RULES: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE_RULES,
    AUTO_IS_FREE_BY_PRICE: IPN_PACKAGE_ROW_EXPORT_CONFIG.AUTO_IS_FREE_BY_PRICE,
    DEFAULT_IS_FREE: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_FREE,
    DEFAULT_IS_PUBLISHED: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED,
    SORT_BY_EPISODE_NUMBER: IPN_PACKAGE_ROW_EXPORT_CONFIG.SORT_BY_EPISODE_NUMBER,
    OUTPUT_FOLDER_ID: IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID,
    OUTPUT_LINK_COL: IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_LINK_COL,
    MERGE_SELECTED_ROWS_TO_ONE_ZIP: IPN_PACKAGE_ROW_EXPORT_CONFIG.MERGE_SELECTED_ROWS_TO_ONE_ZIP,
    PRESERVE_SELECTED_ROW_AS_PACKAGE: IPN_PACKAGE_ROW_EXPORT_CONFIG.PRESERVE_SELECTED_ROW_AS_PACKAGE,
    PRICE_MODE: IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE,
    PRICE_PER_CHAPTER: IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_PER_CHAPTER,
    PACKAGE_NOTE_COL: IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_NOTE_COL
  };

  try {
    if (settings.packageSize !== undefined && settings.packageSize !== '') {
      const v = Number(settings.packageSize);
      if (!Number.isFinite(v) || v < 1) throw new Error('PACKAGE_SIZE ต้องมากกว่า 0');
      IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_SIZE = v;
    }

    if (settings.price !== undefined && settings.price !== '') {
      const v = Number(settings.price);
      if (!Number.isFinite(v) || v < 0) throw new Error('ราคาแพ็กต้องเป็นเลข 0 ขึ้นไป');
      IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE = v;
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'priceRules')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE_RULES =
        String(settings.priceRules || '').trim();
      // Validate early so sidebar reports error before creating ZIP.
      ipnPkgRowParsePriceRules_(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE_RULES);
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'autoIsFreeByPrice')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.AUTO_IS_FREE_BY_PRICE =
        settings.autoIsFreeByPrice === true ||
        settings.autoIsFreeByPrice === 'true' ||
        settings.autoIsFreeByPrice === 1 ||
        settings.autoIsFreeByPrice === '1';
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'isFree')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_FREE =
        settings.isFree === true ||
        settings.isFree === 'true' ||
        settings.isFree === 1 ||
        settings.isFree === '1';
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'isPublished')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED =
        settings.isPublished === true ||
        settings.isPublished === 'true' ||
        settings.isPublished === 1 ||
        settings.isPublished === '1';
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'sortByEpisodeNumber')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.SORT_BY_EPISODE_NUMBER =
        settings.sortByEpisodeNumber === true ||
        settings.sortByEpisodeNumber === 'true' ||
        settings.sortByEpisodeNumber === 1 ||
        settings.sortByEpisodeNumber === '1';
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'outputFolderId')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID =
        String(settings.outputFolderId || '').trim();
    }

    if (settings.outputLinkCol !== undefined && settings.outputLinkCol !== '') {
      const v = Number(settings.outputLinkCol);
      if (!Number.isFinite(v) || v < 1) throw new Error('คอลัมน์ output ไม่ถูกต้อง');
      IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_LINK_COL = v;
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'mergeSelectedRowsToOneZip')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.MERGE_SELECTED_ROWS_TO_ONE_ZIP =
        settings.mergeSelectedRowsToOneZip === true ||
        settings.mergeSelectedRowsToOneZip === 'true' ||
        settings.mergeSelectedRowsToOneZip === 1 ||
        settings.mergeSelectedRowsToOneZip === '1';
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'preserveSelectedRowAsPackage')) {
      IPN_PACKAGE_ROW_EXPORT_CONFIG.PRESERVE_SELECTED_ROW_AS_PACKAGE =
        settings.preserveSelectedRowAsPackage === true ||
        settings.preserveSelectedRowAsPackage === 'true' ||
        settings.preserveSelectedRowAsPackage === 1 ||
        settings.preserveSelectedRowAsPackage === '1';
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'priceMode')) {
      const mode = String(settings.priceMode || 'fixed').trim();
      if (['fixed', 'rangeRules', 'perChapter', 'sheetNotePerChapter'].indexOf(mode) === -1) {
        throw new Error('priceMode ต้องเป็น fixed, rangeRules, perChapter หรือ sheetNotePerChapter');
      }
      IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE = mode;
    }

    if (settings.pricePerChapter !== undefined && settings.pricePerChapter !== '') {
      const v = Number(settings.pricePerChapter);
      if (!Number.isFinite(v) || v < 0) throw new Error('ราคาต่อบทต้องเป็นเลข 0 ขึ้นไป');
      IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_PER_CHAPTER = v;
    }

    if (settings.packageNoteCol !== undefined && settings.packageNoteCol !== '') {
      const v = Number(settings.packageNoteCol);
      if (!Number.isFinite(v) || v < 1) throw new Error('คอลัมน์จำนวนบท/ฟรีไม่ถูกต้อง');
      IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_NOTE_COL = v;
    }

    return callback();

  } finally {
    IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_SIZE = old.PACKAGE_SIZE;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE = old.DEFAULT_PRICE;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE_RULES = old.DEFAULT_PRICE_RULES;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.AUTO_IS_FREE_BY_PRICE = old.AUTO_IS_FREE_BY_PRICE;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_FREE = old.DEFAULT_IS_FREE;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED = old.DEFAULT_IS_PUBLISHED;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.SORT_BY_EPISODE_NUMBER = old.SORT_BY_EPISODE_NUMBER;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID = old.OUTPUT_FOLDER_ID;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_LINK_COL = old.OUTPUT_LINK_COL;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.MERGE_SELECTED_ROWS_TO_ONE_ZIP = old.MERGE_SELECTED_ROWS_TO_ONE_ZIP;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.PRESERVE_SELECTED_ROW_AS_PACKAGE = old.PRESERVE_SELECTED_ROW_AS_PACKAGE;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE = old.PRICE_MODE;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_PER_CHAPTER = old.PRICE_PER_CHAPTER;
    IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_NOTE_COL = old.PACKAGE_NOTE_COL;
  }
}

function ipnPkgRowExportOneRow_(sheet, rowNo) {
  const row = Number(rowNo);

  if (!Number.isFinite(row) || row < IPN_PACKAGE_ROW_EXPORT_CONFIG.FIRST_DATA_ROW) {
    throw new Error('เลขแถวไม่ถูกต้อง: ' + rowNo);
  }

  const storyTitle = String(
    sheet.getRange(row, IPN_PACKAGE_ROW_EXPORT_CONFIG.TITLE_COL).getDisplayValue() || ''
  ).trim();

  const docUrlInfo = ipnPkgRowGetDocUrlFromRow_(sheet, row);

  if (!docUrlInfo.url) {
    const msg = 'ไม่พบลิงก์ Google Docs ในคอลัมน์ C/D/E';
    ipnPkgRowWriteOutput_(sheet, row, '', '❌ ' + msg);
    return { ok: false, row: row, message: msg };
  }

  const docId = ipnPkgRowExtractGoogleDocId_(docUrlInfo.url);

  if (!docId) {
    const msg = 'ลิงก์ไม่ใช่ Google Docs หรือดึง Doc ID ไม่ได้: ' + docUrlInfo.url;
    ipnPkgRowWriteOutput_(sheet, row, '', '❌ ' + msg);
    return { ok: false, row: row, message: msg };
  }

  let doc;
  try {
    doc = DocumentApp.openById(docId);
  } catch (e) {
    const msg = 'เปิด Google Docs ไม่ได้: ' + (e && e.message ? e.message : e);
    ipnPkgRowWriteOutput_(sheet, row, '', '❌ ' + msg);
    return { ok: false, row: row, message: msg };
  }

  const docName = doc.getName();
  const exportData = ipnPkgRowBuildExportDataFromDoc_(doc);

  if (!exportData.chapters.length) {
    const msg = 'ไม่พบแท็บที่มี title/content สำหรับ export';
    ipnPkgRowWriteOutput_(sheet, row, '', '❌ ' + msg);
    return { ok: false, row: row, message: msg };
  }

  let packagesForZip = exportData.packages;
  const useSheetNotePerChapter =
    String(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE || '') === 'sheetNotePerChapter';

  if (useSheetNotePerChapter) {
    const singlePkg = ipnPkgRowBuildSinglePackageFromChaptersForRow_(
      sheet, row, exportData.chapters, storyTitle || docName || ('row-' + row)
    );

    const noteParsed = ipnPkgRowParseChapterCountAndFreeFromNote_(singlePkg.rawPriceNote || '');
    if (noteParsed.chapterCountFromNote !== null && noteParsed.chapterCountFromNote !== exportData.chapters.length) {
      exportData.problems.push(
        'แถว ' + row + ': จำนวนบทในคอลัมน์ M = ' + noteParsed.chapterCountFromNote +
        ' แต่จำนวนแท็บจริง = ' + exportData.chapters.length
      );
    }

    packagesForZip = [singlePkg];
  }

  const zipFile = ipnPkgRowCreatePackageZip_(
    storyTitle || docName || ('row-' + row),
    packagesForZip
  );

  const noteLines = [
    '✅ Export Package ZIP สำเร็จ',
    'ไฟล์: ' + zipFile.getName(),
    'จำนวนแท็บทั้งหมด: ' + exportData.totalTabs,
    'จำนวนบทที่ export: ' + exportData.chapters.length,
    'จำนวนแพ็ก: ' + packagesForZip.length
  ];

  if (useSheetNotePerChapter) {
    const pkg0 = packagesForZip[0];
    noteLines.push('ราคาอิงคอลัมน์ M');
    noteLines.push('คอลัมน์ M: ' + (pkg0.rawPriceNote || '(ว่าง)'));
    noteLines.push('จำนวนบทที่ใช้คิดราคา: ' + pkg0.priceChapterCount);
    noteLines.push('ราคา: ' + pkg0.price + ' บาท' + (pkg0.isFree === 'true' ? ' (ฟรี)' : ''));
  } else {
    noteLines.push('แพ็กละ: ' + IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_SIZE + ' บท');
  }

  if (exportData.problems.length) {
    noteLines.push('ปัญหา: ' + exportData.problems.slice(0, 10).join(' | '));
  }

  ipnPkgRowWriteOutput_(sheet, row, zipFile.getUrl(), noteLines.join('\n'));

  return {
    ok: true,
    row: row,
    zipUrl: zipFile.getUrl(),
    fileName: zipFile.getName(),
    totalTabs: exportData.totalTabs,
    chapterCount: exportData.chapters.length,
    packageCount: packagesForZip.length,
    problems: exportData.problems
  };
}

function ipnPkgRowBuildExportDataFromDoc_(doc) {
  const tabs = ipnPkgRowGetAllTabs_(doc);
  const chapters = [];
  const problems = [];

  tabs.forEach(function(tabInfo, index) {
    const tabName = tabInfo.title || ('แท็บ ' + (index + 1));
    const body = tabInfo.body;

    const rawText = ipnPkgRowNormalizeText_(body ? body.getText() : '');

    if (!rawText.trim()) {
      problems.push('แท็บ "' + tabName + '" ว่าง');
      return;
    }

    const lines = rawText.split('\n');
    const titleIndex = lines.findIndex(function(line) {
      return ipnPkgRowCleanLine_(line) !== '';
    });

    if (titleIndex === -1) {
      problems.push('แท็บ "' + tabName + '" ไม่มี title');
      return;
    }

    const title = ipnPkgRowCleanLine_(lines[titleIndex]);

    let contentLines = lines.slice(titleIndex + 1);
    contentLines = ipnPkgRowTrimEmptyLines_(contentLines);

    const content = contentLines.join('\n').trim();

    if (!content) {
      problems.push('แท็บ "' + tabName + '" ไม่มี content');
    }

    const epNo = ipnPkgRowParseEpisodeNumber_(title, tabName, index);

    chapters.push({
      index: index,
      tabName: tabName,
      episodeNumber: epNo,
      title: title,
      content: content
    });
  });

  const sortedChapters = IPN_PACKAGE_ROW_EXPORT_CONFIG.SORT_BY_EPISODE_NUMBER
    ? chapters.slice().sort(function(a, b) {
        if (a.episodeNumber !== b.episodeNumber) return a.episodeNumber - b.episodeNumber;
        return a.index - b.index;
      })
    : chapters.slice();

  const packages = ipnPkgRowBuildPackages_(sortedChapters, IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_SIZE);

  packages.forEach(function(pkg) {
    if (pkg.contentBytes > Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.WARN_TXT_BYTES || 0)) {
      problems.push(
        'แพ็ก ' + pkg.episodeNumber +
        ' มีขนาด ' + Math.round(pkg.contentBytes / 1024 / 1024 * 10) / 10 +
        'MB ควรตรวจว่าไม่เกิน limit import/DB'
      );
    }
  });

  return {
    totalTabs: tabs.length,
    chapters: sortedChapters,
    packages: packages,
    problems: problems
  };
}

function ipnPkgRowBuildPackages_(chapters, packageSize) {
  const out = [];
  const size = Math.max(1, Number(packageSize || 50));

  for (let i = 0; i < chapters.length; i += size) {
    const chunk = chapters.slice(i, i + size);
    if (!chunk.length) continue;

    const startNo = chunk[0].episodeNumber;
    const endNo = chunk[chunk.length - 1].episodeNumber;

    const episodeNumber = startNo === endNo
      ? String(startNo)
      : String(startNo) + ' - ' + String(endNo);

    const episodeTitle = startNo === endNo
      ? 'แพ็กบทที่ ' + startNo
      : 'แพ็กบทที่ ' + startNo + ' - ' + endNo;

    const fileBase =
      ipnPkgRowPadNumberForFile_(startNo) +
      '-' +
      ipnPkgRowPadNumberForFile_(endNo);

    const contentFile =
      IPN_PACKAGE_ROW_EXPORT_CONFIG.CONTENT_DIR +
      '/' +
      fileBase +
      '.txt';

    const packageContent = chunk.map(function(ch) {
      return ch.title + '\n\n' + (ch.content || '');
    }).join('\n\n\n');

    const priceInfo = ipnPkgRowResolvePackagePrice_(startNo, endNo);

    out.push({
      startNo: startNo,
      endNo: endNo,
      episodeNumber: episodeNumber,
      episodeTitle: episodeTitle,
      price: ipnPkgRowFormatPrice_(priceInfo.price),
      isFree: String(priceInfo.isFree).toLowerCase(),
      isPublished: String(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED).toLowerCase(),
      saleMode: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_SALE_MODE,
      contentFile: contentFile,
      contentFormat: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_CONTENT_FORMAT,
      sortOrder: String(startNo),
      description: 'แพ็กอ่านบนเว็บ บทที่ ' + episodeNumber + ' | ราคา: ' + ipnPkgRowFormatPrice_(priceInfo.price) + ' บาท',
      priceSource: priceInfo.source,
      content: packageContent,
      contentBytes: ipnPkgRowUtf8ByteLength_(packageContent),
      chapterCount: chunk.length,
      chapters: chunk
    });
  }

  return out;
}


function ipnPkgRowResolvePackagePrice_(startNo, endNo) {
  const rules = ipnPkgRowParsePriceRules_(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE_RULES || '');
  const rangeKey = ipnPkgRowNormalizeRangeKey_(String(startNo) + '-' + String(endNo));
  const singleKey = ipnPkgRowNormalizeRangeKey_(String(startNo));
  const defaultPrice = Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE || 0);

  let price = defaultPrice;
  let source = 'default';

  if (Object.prototype.hasOwnProperty.call(rules.byRange, rangeKey)) {
    price = rules.byRange[rangeKey];
    source = 'rule:' + rangeKey;
  } else if (Object.prototype.hasOwnProperty.call(rules.byRange, singleKey)) {
    price = rules.byRange[singleKey];
    source = 'rule:' + singleKey;
  } else if (rules.defaultPrice !== null) {
    price = rules.defaultPrice;
    source = 'rule:default';
  }

  if (!Number.isFinite(price) || price < 0) price = 0;

  const isFree = IPN_PACKAGE_ROW_EXPORT_CONFIG.AUTO_IS_FREE_BY_PRICE
    ? price <= 0
    : !!IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_FREE;

  return {
    price: price,
    isFree: isFree,
    source: source
  };
}

function ipnPkgRowResolveMergedPackagePrice_(startNo, endNo, chapterCount) {
  const mode = String(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE || 'fixed').trim();

  if (mode === 'rangeRules') {
    return ipnPkgRowResolvePackagePrice_(startNo, endNo);
  }

  let price;
  let source;

  if (mode === 'perChapter') {
    const perChapter = Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_PER_CHAPTER || 0);
    price = Number(chapterCount || 0) * (Number.isFinite(perChapter) ? perChapter : 0);
    source = 'perChapter';
  } else {
    price = Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_PRICE || 0);
    source = 'fixed';
  }

  if (!Number.isFinite(price) || price < 0) price = 0;

  const isFree = IPN_PACKAGE_ROW_EXPORT_CONFIG.AUTO_IS_FREE_BY_PRICE
    ? price <= 0
    : !!IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_FREE;

  return {
    price: price,
    isFree: isFree,
    source: source
  };
}

function ipnPkgRowResolveMergedPackagePriceForRow_(sheet, rowNo, startNo, endNo, chapterCount) {
  const mode = String(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE || 'fixed').trim();

  if (mode === 'sheetNotePerChapter') {
    return ipnPkgRowResolveMergedPackagePriceFromSheetNote_(sheet, rowNo, chapterCount);
  }

  return ipnPkgRowResolveMergedPackagePrice_(startNo, endNo, chapterCount);
}

function ipnPkgRowGetPackageNoteFromRow_(sheet, rowNo) {
  const col = Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.PACKAGE_NOTE_COL || 13);
  if (!col) return '';

  return String(sheet.getRange(rowNo, col).getDisplayValue() || '').trim();
}

function ipnPkgRowParseChapterCountAndFreeFromNote_(noteText) {
  const raw = String(noteText || '');
  const normalized = ipnPkgRowThaiDigitsToArabic_(raw);
  const lower = normalized.toLowerCase();

  const freeKeywords = IPN_PACKAGE_ROW_EXPORT_CONFIG.FREE_KEYWORDS || ['ฟรี', 'free'];
  const isFreeByNote = freeKeywords.some(function(kw) {
    const k = String(kw || '').toLowerCase().trim();
    return k && lower.indexOf(k) !== -1;
  });

  let chapterCountFromNote = null;

  const afterDoneMatch = normalized.match(/เสร็จ\s*([0-9]+)/);
  if (afterDoneMatch && afterDoneMatch[1] !== undefined) {
    const n = Number(afterDoneMatch[1]);
    if (Number.isFinite(n) && n >= 0) chapterCountFromNote = n;
  }

  if (chapterCountFromNote === null) {
    const anyNumberMatch = normalized.match(/([0-9]+)/);
    if (anyNumberMatch && anyNumberMatch[1] !== undefined) {
      const n2 = Number(anyNumberMatch[1]);
      if (Number.isFinite(n2) && n2 >= 0) chapterCountFromNote = n2;
    }
  }

  return {
    rawNote: raw,
    isFreeByNote: isFreeByNote,
    chapterCountFromNote: chapterCountFromNote
  };
}

function ipnPkgRowResolveMergedPackagePriceFromSheetNote_(sheet, rowNo, fallbackChapterCount) {
  const note = ipnPkgRowGetPackageNoteFromRow_(sheet, rowNo);
  const parsed = ipnPkgRowParseChapterCountAndFreeFromNote_(note);

  if (parsed.isFreeByNote) {
    return {
      price: 0,
      isFree: true,
      source: 'sheetNote:free',
      priceChapterCount: parsed.chapterCountFromNote || fallbackChapterCount,
      rawNote: note
    };
  }

  const count = parsed.chapterCountFromNote || fallbackChapterCount;
  const perChapter = Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_PER_CHAPTER || 0);
  let price = Number(count || 0) * (Number.isFinite(perChapter) ? perChapter : 0);

  if (!Number.isFinite(price) || price < 0) price = 0;

  const isFree = IPN_PACKAGE_ROW_EXPORT_CONFIG.AUTO_IS_FREE_BY_PRICE
    ? price <= 0
    : !!IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_FREE;

  return {
    price: price,
    isFree: isFree,
    source: parsed.chapterCountFromNote ? 'sheetNote:chapterCount' : 'fallback:tabCount',
    priceChapterCount: count,
    rawNote: note
  };
}

function ipnPkgRowBuildMergedPackageDescription_(episodeNumber, chapterCount, priceInfo) {
  const priceChapterCount = priceInfo.priceChapterCount || chapterCount;
  const priceText = ipnPkgRowFormatPrice_(priceInfo.price);

  let desc =
    'แพ็กอ่านบนเว็บ บทที่ ' + episodeNumber +
    ' | จำนวนบทคิดราคา: ' + priceChapterCount +
    ' | ราคา: ' + priceText + ' บาท';

  if (priceInfo.isFree) {
    desc += ' | ฟรี';
    if (priceInfo.rawNote) desc += ' (' + priceInfo.rawNote + ')';
  }

  return desc;
}

function ipnPkgRowBuildSinglePackageFromChaptersForRow_(sheet, rowNo, chapters, storyTitle) {
  const startNo = chapters[0].episodeNumber;
  const endNo = chapters[chapters.length - 1].episodeNumber;

  const episodeNumber = startNo === endNo
    ? String(startNo)
    : String(startNo) + ' - ' + String(endNo);

  const episodeTitle = startNo === endNo
    ? 'แพ็กบทที่ ' + startNo
    : 'แพ็กบทที่ ' + startNo + ' - ' + endNo;

  const fileBase =
    ipnPkgRowPadNumberForFile_(startNo) + '-' + ipnPkgRowPadNumberForFile_(endNo);

  const contentFile = IPN_PACKAGE_ROW_EXPORT_CONFIG.CONTENT_DIR + '/' + fileBase + '.txt';

  const packageContent = chapters.map(function(ch) {
    return ch.title + '\n\n' + (ch.content || '');
  }).join('\n\n\n');

  const chapterCount = chapters.length;
  const priceInfo = ipnPkgRowResolveMergedPackagePriceForRow_(sheet, rowNo, startNo, endNo, chapterCount);

  return {
    startNo: startNo,
    endNo: endNo,
    episodeNumber: episodeNumber,
    episodeTitle: episodeTitle,
    price: ipnPkgRowFormatPrice_(priceInfo.price),
    isFree: String(priceInfo.isFree).toLowerCase(),
    isPublished: String(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED).toLowerCase(),
    saleMode: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_SALE_MODE,
    contentFile: contentFile,
    contentFormat: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_CONTENT_FORMAT,
    sortOrder: String(startNo),
    description: ipnPkgRowBuildMergedPackageDescription_(episodeNumber, chapterCount, priceInfo),
    priceSource: priceInfo.source,
    priceChapterCount: priceInfo.priceChapterCount || chapterCount,
    rawPriceNote: priceInfo.rawNote || '',
    content: packageContent,
    contentBytes: ipnPkgRowUtf8ByteLength_(packageContent),
    chapterCount: chapterCount,
    chapters: chapters
  };
}

function ipnPkgRowCheckMergedRangeProblems_(packages) {
  const problems = [];

  const seen = {};
  packages.forEach(function(pkg) {
    (pkg.chapters || []).forEach(function(ch) {
      const key = String(ch.episodeNumber);
      if (!seen[key]) seen[key] = [];
      seen[key].push(pkg.row);
    });
  });

  Object.keys(seen).forEach(function(key) {
    if (seen[key].length > 1) {
      problems.push('บทซ้ำ: บทที่ ' + key + ' พบในแถว ' + seen[key].join(', '));
    }
  });

  const sorted = packages.slice().sort(function(a, b) { return a.startNo - b.startNo; });

  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].endNo;
    const curStart = sorted[i].startNo;

    if (curStart > prevEnd + 1) {
      problems.push(
        'ช่วงบทขาดหาย: ระหว่างบทที่ ' + prevEnd + ' ถึง ' + curStart +
        ' (แถว ' + sorted[i - 1].row + ' → แถว ' + sorted[i].row + ')'
      );
    } else if (curStart <= prevEnd) {
      problems.push(
        'ช่วงบททับซ้อน: แถว ' + sorted[i - 1].row + ' (ถึงบทที่ ' + prevEnd + ') กับแถว ' +
        sorted[i].row + ' (เริ่มบทที่ ' + curStart + ')'
      );
    }
  }

  return problems;
}

function ipnPkgRowWriteMergedRefNote_(sheet, rowNo, note) {
  const col = IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_LINK_COL;
  const cell = sheet.getRange(rowNo, col);

  cell.setValue(note || '');
  cell.setBackground('#DBEAFE').setFontColor('#1E3A8A');

  try {
    cell.setNote(String(note || ''));
  } catch (e) {}

  cell
    .setFontFamily('Arial')
    .setFontSize(10)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP)
    .setVerticalAlignment('middle');
}

function ipnPkgRowParsePriceRules_(text) {
  const result = {
    byRange: {},
    defaultPrice: null
  };

  const raw = String(text || '').trim();
  if (!raw) return result;

  const lines = raw.split(/\r?\n/);

  lines.forEach(function(line, idx) {
    let s = String(line || '').trim();

    if (!s || s.charAt(0) === '#') return;

    // allow inline comments: 051-100=98 # promo price
    s = s.replace(/\s+#.*$/, '').trim();
    if (!s) return;

    const defaultMatch = s.match(/^default\s*(?:=|:|\t|,)\s*([0-9]+(?:\.[0-9]+)?)$/i);
    if (defaultMatch) {
      result.defaultPrice = Number(defaultMatch[1]);
      return;
    }

    const m = s.match(/^(.+?)\s*(?:=|:|\t|,)\s*([0-9]+(?:\.[0-9]+)?)$/);
    if (!m) {
      throw new Error(
        'รูปแบบกฎราคาไม่ถูกต้อง บรรทัด ' + (idx + 1) +
        ': "' + line + '" ใช้เช่น 051-100=98 หรือ default=100'
      );
    }

    const key = ipnPkgRowNormalizeRangeKey_(m[1]);
    const price = Number(m[2]);

    if (!key) {
      throw new Error('กฎราคาบรรทัด ' + (idx + 1) + ' อ่านช่วงแพ็กไม่ได้: ' + line);
    }

    if (!Number.isFinite(price) || price < 0) {
      throw new Error('กฎราคาบรรทัด ' + (idx + 1) + ' ราคาต้องเป็นเลข 0 ขึ้นไป: ' + line);
    }

    result.byRange[key] = price;
  });

  return result;
}

function ipnPkgRowNormalizeRangeKey_(input) {
  const text = ipnPkgRowThaiDigitsToArabic_(String(input || '').trim());
  if (!text) return '';

  const nums = text.match(/[0-9]+(?:\.[0-9]+)?/g);
  if (!nums || !nums.length) return '';

  const start = ipnPkgRowNormalizeNumberKey_(nums[0]);
  const end = nums.length >= 2 ? ipnPkgRowNormalizeNumberKey_(nums[1]) : start;

  if (!start) return '';

  return start === end ? start : start + '-' + end;
}

function ipnPkgRowNormalizeNumberKey_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';

  if (Math.floor(n) === n) return String(Math.floor(n));
  return String(n).replace(/\.0+$/, '');
}

function ipnPkgRowFormatPrice_(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';

  if (Math.floor(n) === n) return String(Math.floor(n));
  return String(Math.round(n * 100) / 100);
}


function ipnPkgRowCreatePackageZip_(baseName, packages) {
  const blobs = [];

  const manifestCsv = ipnPkgRowBuildManifestCsv_(packages);

  blobs.push(
    Utilities.newBlob(
      '\uFEFF' + manifestCsv,
      'text/csv;charset=utf-8',
      IPN_PACKAGE_ROW_EXPORT_CONFIG.MANIFEST_FILE_NAME
    )
  );

  packages.forEach(function(pkg) {
    blobs.push(
      Utilities.newBlob(
        pkg.content,
        'text/plain;charset=utf-8',
        pkg.contentFile
      )
    );
  });

  const zipName =
    ipnPkgRowSanitizeFileName_(baseName || 'ipenovel-package-import') +
    IPN_PACKAGE_ROW_EXPORT_CONFIG.ZIP_SUFFIX;

  const zipBlob = Utilities.zip(blobs, zipName);

  if (IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID) {
    return DriveApp
      .getFolderById(IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID)
      .createFile(zipBlob);
  }

  return DriveApp.createFile(zipBlob);
}

function ipnPkgRowBuildManifestCsv_(packages) {
  const headers = [
    'episodeNumber',
    'episodeTitle',
    'price',
    'isFree',
    'isPublished',
    'saleMode',
    'contentFile',
    'contentFormat',
    'sortOrder',
    'description'
  ];

  const rows = [headers];

  packages.forEach(function(pkg) {
    rows.push([
      pkg.episodeNumber,
      pkg.episodeTitle,
      pkg.price,
      pkg.isFree,
      pkg.isPublished,
      pkg.saleMode,
      pkg.contentFile,
      pkg.contentFormat,
      pkg.sortOrder,
      pkg.description
    ]);
  });

  return rows.map(function(row) {
    return row.map(ipnPkgRowCsvCell_).join(',');
  }).join('\r\n');
}

function ipnPkgRowGetMainSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ไม่พบ Spreadsheet');

  if (IPN_PACKAGE_ROW_EXPORT_CONFIG.MAIN_SHEET_NAME) {
    const sh = ss.getSheetByName(IPN_PACKAGE_ROW_EXPORT_CONFIG.MAIN_SHEET_NAME);
    if (!sh) throw new Error('ไม่พบชีต: ' + IPN_PACKAGE_ROW_EXPORT_CONFIG.MAIN_SHEET_NAME);
    return sh;
  }

  try {
    if (typeof getCheckerSheet_ === 'function') return getCheckerSheet_();
  } catch (e) {}

  const active = ss.getActiveSheet();
  if (!active) throw new Error('ไม่พบชีตที่เปิดอยู่');
  return active;
}

function ipnPkgRowGetSelectedRows_(sheet) {
  const range = sheet.getActiveRange();
  if (!range) return [];

  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const out = [];

  for (let i = 0; i < numRows; i++) {
    const r = startRow + i;
    if (r >= IPN_PACKAGE_ROW_EXPORT_CONFIG.FIRST_DATA_ROW) out.push(r);
  }

  return out;
}

function ipnPkgRowGetDocUrlFromRow_(sheet, rowNo) {
  const cols = [IPN_PACKAGE_ROW_EXPORT_CONFIG.DOC_URL_COL]
    .concat(IPN_PACKAGE_ROW_EXPORT_CONFIG.FALLBACK_DOC_URL_COLS || []);

  for (let i = 0; i < cols.length; i++) {
    const col = Number(cols[i]);
    if (!col) continue;

    const range = sheet.getRange(rowNo, col);
    const richUrl = ipnPkgRowGetRichTextUrlSafe_(range);
    const display = String(range.getDisplayValue() || '').trim();
    const raw = String(range.getValue() || '').trim();

    const candidates = [richUrl, display, raw].filter(Boolean);

    for (let j = 0; j < candidates.length; j++) {
      const url = candidates[j];
      if (ipnPkgRowExtractGoogleDocId_(url)) {
        return { url: url, col: col };
      }
    }
  }

  return { url: '', col: 0 };
}

function ipnPkgRowGetRichTextUrlSafe_(range) {
  try {
    const rt = range.getRichTextValue();
    if (!rt) return '';

    const direct = rt.getLinkUrl && rt.getLinkUrl();
    if (direct) return direct;

    const runs = rt.getRuns ? rt.getRuns() : [];
    for (let i = 0; i < runs.length; i++) {
      const u = runs[i].getLinkUrl && runs[i].getLinkUrl();
      if (u) return u;
    }
  } catch (e) {}

  return '';
}

function ipnPkgRowExtractGoogleDocId_(input) {
  const text = String(input || '').trim();
  if (!text) return '';

  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]+)/,
    /docs\.google\.com\/document\/u\/\d+\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (m && m[1]) return m[1];
  }

  if (/^[a-zA-Z0-9_-]{25,}$/.test(text)) return text;

  return '';
}

function ipnPkgRowWriteOutput_(sheet, rowNo, url, note) {
  const col = IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_LINK_COL;
  const cell = sheet.getRange(rowNo, col);

  if (url) {
    cell.setValue(url);

    try {
      const rich = SpreadsheetApp.newRichTextValue()
        .setText(url)
        .setLinkUrl(url)
        .build();

      cell.setRichTextValue(rich);
    } catch (e) {}

    cell.setBackground('#DCFCE7').setFontColor('#166534');
  } else {
    cell.setValue(note || '');
    cell.setBackground('#FEE2E2').setFontColor('#991B1B');
  }

  try {
    cell.setNote(String(note || ''));
  } catch (e2) {}

  cell
    .setFontFamily('Arial')
    .setFontSize(10)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP)
    .setVerticalAlignment('middle');
}

function ipnPkgRowGetAllTabs_(doc) {
  const result = [];

  function walkTabs(tabs) {
    (tabs || []).forEach(function(tab) {
      const title = ipnPkgRowGetTabTitleSafe_(tab, result.length);
      const body = ipnPkgRowGetBodyFromTabSafe_(doc, tab);

      result.push({
        tab: tab,
        title: title,
        body: body
      });

      const children = tab.getChildTabs ? tab.getChildTabs() : [];
      if (children && children.length > 0) {
        walkTabs(children);
      }
    });
  }

  if (doc && typeof doc.getTabs === 'function') {
    walkTabs(doc.getTabs());
  }

  if (!result.length) {
    result.push({
      tab: null,
      title: doc.getName ? doc.getName() : 'เอกสารหลัก',
      body: doc.getBody()
    });
  }

  return result;
}

function ipnPkgRowGetTabTitleSafe_(tab, index) {
  try {
    if (tab && typeof tab.getTitle === 'function') return tab.getTitle();
    if (tab && typeof tab.getName === 'function') return tab.getName();
  } catch (e) {}

  return 'แท็บ ' + (Number(index || 0) + 1);
}

function ipnPkgRowGetBodyFromTabSafe_(doc, tab) {
  if (!tab) return doc.getBody();

  try {
    if (typeof tab.asDocumentTab === 'function') {
      return tab.asDocumentTab().getBody();
    }
  } catch (e) {}

  try {
    if (typeof tab.getBody === 'function') return tab.getBody();
  } catch (e2) {}

  return doc.getBody();
}

function ipnPkgRowParseEpisodeNumber_(title, tabName, zeroBasedIndex) {
  const text = ipnPkgRowThaiDigitsToArabic_(
    String(title || '') + ' ' + String(tabName || '')
  );

  const patterns = [
    /#\s*([0-9]+(?:\.[0-9]+)?)/i,
    /(?:บทที่|ตอนที่|บท|ตอน)\s*([0-9]+(?:\.[0-9]+)?)/i,
    /(?:chapter|chapters|ch\.?|episode|ep\.?)\s*([0-9]+(?:\.[0-9]+)?)/i,
    /^\s*([0-9]+(?:\.[0-9]+)?)\b/
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = text.match(patterns[i]);
    if (m && m[1] !== undefined) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }

  return Number(zeroBasedIndex) + 1;
}

function ipnPkgRowThaiDigitsToArabic_(text) {
  const map = {
    '๐': '0',
    '๑': '1',
    '๒': '2',
    '๓': '3',
    '๔': '4',
    '๕': '5',
    '๖': '6',
    '๗': '7',
    '๘': '8',
    '๙': '9'
  };

  return String(text || '').replace(/[๐-๙]/g, function(d) {
    return map[d] || d;
  });
}

function ipnPkgRowPadNumberForFile_(num) {
  const s = String(num);

  if (s.indexOf('.') !== -1) {
    return s.replace(/\./g, '_').padStart(3, '0');
  }

  const n = Number(num);
  if (!Number.isFinite(n)) return '000';

  return String(Math.floor(n)).padStart(3, '0');
}

function ipnPkgRowNormalizeText_(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\u200C/g, '')
    .replace(/\u200D/g, '')
    .replace(/\uFEFF/g, '');
}

function ipnPkgRowCleanLine_(line) {
  return String(line ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\u200C/g, '')
    .replace(/\u200D/g, '')
    .trim();
}

function ipnPkgRowTrimEmptyLines_(lines) {
  const result = [].concat(lines);

  while (result.length > 0 && ipnPkgRowCleanLine_(result[0]) === '') {
    result.shift();
  }

  while (result.length > 0 && ipnPkgRowCleanLine_(result[result.length - 1]) === '') {
    result.pop();
  }

  return result;
}

function ipnPkgRowCsvCell_(value) {
  const text = String(value ?? '');
  return '"' + text.replace(/"/g, '""') + '"';
}

function ipnPkgRowUtf8ByteLength_(text) {
  return Utilities.newBlob(String(text ?? ''), 'text/plain;charset=utf-8').getBytes().length;
}

function ipnPkgRowSanitizeFileName_(name) {
  return String(name || 'ipenovel-package-import')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/****************************************************
 * Multi-Novel ZIP export
 * ใช้กับ /admin/import-episodes แท็บ "Import Multi-Novel ZIP"
 * 1 ZIP รองรับหลายเรื่องหลายแพ็ก: 1 แถวที่เลือก = 1 แพ็กเสมอ
 * ไม่ตัดตาม PACKAGE_SIZE, ไม่ sort รวมด้วย startNo ข้ามเรื่อง
 ****************************************************/

function ipnPkgRowThaiDigitsToArabicSafe_(text) {
  if (typeof ipnPkgRowThaiDigitsToArabic_ === 'function') {
    return ipnPkgRowThaiDigitsToArabic_(text);
  }

  const map = {
    '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4',
    '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9'
  };

  return String(text || '').replace(/[๐-๙]/g, function(d) {
    return map[d] || d;
  });
}

function ipnPkgRowStripTrailingEpisodeRangeFromTitle_(title) {
  const original = String(title || '');
  const trimmedOriginal = original.trim();
  if (!trimmedOriginal) return '';

  const normalized = ipnPkgRowThaiDigitsToArabicSafe_(original);

  // ลำดับสำคัญ: ลองแพทเทิร์นที่จำเพาะเจาะจงกว่าก่อน
  const patterns = [
    // บทที่ 001 - 080 / ตอนที่ 001-080 / EP 1-100 (มีคำนำหน้า, ช่วงเลขไม่บังคับ, อาจมีจบ/ฟรีต่อท้าย)
    /\s*(?:บทที่|ตอนที่|EP\.?)\s*[0-9]+(?:\.[0-9]+)?\s*(?:[-–—]\s*[0-9]+(?:\.[0-9]+)?)?\s*(?:จบ|ฟรี|free)?\s*$/i,
    // 001 - 080 / 456 - 530 จบ / 1 - 100 ฟรี / 001-080 (ช่วงเลขล้วน ๆ อาจมีจบ/ฟรีต่อท้าย)
    /\s*[0-9]+(?:\.[0-9]+)?\s*[-–—]\s*[0-9]+(?:\.[0-9]+)?\s*(?:จบ|ฟรี|free)?\s*$/i,
    // 001 จบ / 100 ฟรี (เลขเดี่ยวที่มีคำว่าจบ/ฟรีต่อท้ายเท่านั้น)
    /\s*[0-9]+(?:\.[0-9]+)?\s*(?:จบ|ฟรี|free)\s*$/i
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = normalized.match(patterns[i]);
    if (m && m.index !== undefined && /[0-9]/.test(m[0])) {
      const stripped = original.slice(0, m.index);
      return stripped.replace(/[\s:：\-–—]+$/, '').trim();
    }
  }

  return trimmedOriginal;
}

function ipnPkgRowBuildNovelMatchTitleFromSheetTitle_(sheetTitle) {
  const rawTitle = String(sheetTitle || '').trim();

  const novelTitle = IPN_PACKAGE_ROW_EXPORT_CONFIG.MULTI_NOVEL_STRIP_TRAILING_RANGE_FROM_TITLE
    ? ipnPkgRowStripTrailingEpisodeRangeFromTitle_(rawTitle)
    : rawTitle;

  const cleanNovelTitle = novelTitle.replace(/\s+/g, ' ').trim();

  let novelMatchTitle = cleanNovelTitle;

  if (IPN_PACKAGE_ROW_EXPORT_CONFIG.MULTI_NOVEL_USE_MATCH_TITLE_AFTER_COLON) {
    const colonMatch = cleanNovelTitle.match(/^[^:：]+[:：]\s*(.+)$/);
    if (colonMatch && colonMatch[1]) {
      novelMatchTitle = colonMatch[1].replace(/\s+/g, ' ').trim();
    }
  }

  return {
    rawTitle: rawTitle,
    novelTitle: cleanNovelTitle,
    novelMatchTitle: novelMatchTitle || cleanNovelTitle
  };
}

function ipnPkgRowSafeContentFolderName_(title, rowNo) {
  let s = String(title || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (s.length > 60) s = s.slice(0, 60).trim();
  if (!s) s = 'row-' + rowNo;

  return 'r' + rowNo + '-' + s;
}

function ipnPkgRowExportMultiNovelSelectedRowsCore_(options) {
  options = options || {};

  const ui = SpreadsheetApp.getUi();
  const sheet = ipnPkgRowGetMainSheet_();
  const rows = ipnPkgRowGetSelectedRows_(sheet);

  if (!rows.length) {
    if (!options.silentConfirm) ui.alert('กรุณาเลือกแถวที่ต้องการรวมเป็น Multi-Novel ZIP');
    return {
      ok: false,
      message: 'ไม่พบแถวที่เลือก',
      rowCount: 0,
      successRowCount: 0,
      novelCount: 0,
      chapterCount: 0,
      packageCount: 0,
      problems: [],
      results: []
    };
  }

  if (!options.silentConfirm) {
    const confirm = ui.alert(
      'ยืนยัน Export Multi-Novel ZIP',
      'จะรวม ' + rows.length + ' แถว (หลายเรื่องได้) เป็น Multi-Novel ZIP เดียว\n\nแถว: ' + rows.join(', ') +
        '\n\nลิงก์ ZIP จะถูกวางที่แถวแรก (' + rows[0] + ') คอลัมน์ O',
      ui.ButtonSet.OK_CANCEL
    );

    if (confirm !== ui.Button.OK) {
      return {
        ok: false,
        message: 'ยกเลิก',
        rowCount: 0,
        successRowCount: 0,
        novelCount: 0,
        chapterCount: 0,
        packageCount: 0,
        problems: [],
        results: []
      };
    }
  }

  const firstRow = rows[0];
  const rowResults = [];
  const packages = [];
  let baseName = '';

  rows.forEach(function(rowNo) {
    try {
      const rawTitle = String(
        sheet.getRange(rowNo, IPN_PACKAGE_ROW_EXPORT_CONFIG.TITLE_COL).getDisplayValue() || ''
      ).trim();

      if (!baseName && rawTitle) baseName = rawTitle;

      const titleInfo = ipnPkgRowBuildNovelMatchTitleFromSheetTitle_(rawTitle);

      const docUrlInfo = ipnPkgRowGetDocUrlFromRow_(sheet, rowNo);
      if (!docUrlInfo.url) {
        rowResults.push({ row: rowNo, ok: false, message: 'ไม่พบลิงก์ Google Docs ในคอลัมน์ C/D/E' });
        return;
      }

      const docId = ipnPkgRowExtractGoogleDocId_(docUrlInfo.url);
      if (!docId) {
        rowResults.push({
          row: rowNo,
          ok: false,
          message: 'ลิงก์ไม่ใช่ Google Docs หรือดึง Doc ID ไม่ได้: ' + docUrlInfo.url
        });
        return;
      }

      let doc;
      try {
        doc = DocumentApp.openById(docId);
      } catch (e) {
        rowResults.push({
          row: rowNo,
          ok: false,
          message: 'เปิด Google Docs ไม่ได้: ' + (e && e.message ? e.message : e)
        });
        return;
      }

      const docName = doc.getName();
      const exportData = ipnPkgRowBuildExportDataFromDoc_(doc);

      if (!exportData.chapters.length) {
        rowResults.push({ row: rowNo, ok: false, message: 'ไม่พบแท็บที่มี title/content สำหรับ export' });
        return;
      }

      const chapters = exportData.chapters;
      const startNo = chapters[0].episodeNumber;
      const endNo = chapters[chapters.length - 1].episodeNumber;

      const episodeNumber = startNo === endNo
        ? String(startNo)
        : String(startNo) + ' - ' + String(endNo);

      const episodeTitle = startNo === endNo
        ? 'แพ็กบทที่ ' + startNo
        : 'แพ็กบทที่ ' + startNo + ' - ' + endNo;

      const folderTitle = titleInfo.novelMatchTitle || titleInfo.novelTitle;
      const folderName = ipnPkgRowSafeContentFolderName_(folderTitle, rowNo);
      const fileBase = ipnPkgRowPadNumberForFile_(startNo) + '-' + ipnPkgRowPadNumberForFile_(endNo);

      const contentFile =
        IPN_PACKAGE_ROW_EXPORT_CONFIG.MULTI_NOVEL_CONTENT_DIR + '/' +
        folderName + '/' +
        fileBase + '.txt';

      const packageContent = chapters.map(function(ch) {
        return ch.title + '\n\n' + (ch.content || '');
      }).join('\n\n\n');

      const chapterCount = chapters.length;
      const priceInfo = ipnPkgRowResolveMergedPackagePriceForRow_(sheet, rowNo, startNo, endNo, chapterCount);

      const pkg = {
        row: rowNo,
        rawNovelTitle: titleInfo.rawTitle,
        novelTitle: titleInfo.novelTitle,
        novelMatchTitle: titleInfo.novelMatchTitle,
        storyTitle: titleInfo.rawTitle || docName || ('row-' + rowNo),
        startNo: startNo,
        endNo: endNo,
        episodeNumber: episodeNumber,
        episodeTitle: episodeTitle,
        price: ipnPkgRowFormatPrice_(priceInfo.price),
        isFree: String(priceInfo.isFree).toLowerCase(),
        isPublished: String(IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_IS_PUBLISHED).toLowerCase(),
        saleMode: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_SALE_MODE,
        contentFile: contentFile,
        contentFormat: IPN_PACKAGE_ROW_EXPORT_CONFIG.DEFAULT_CONTENT_FORMAT,
        sortOrder: String(startNo),
        description: ipnPkgRowBuildMergedPackageDescription_(episodeNumber, chapterCount, priceInfo),
        priceSource: priceInfo.source,
        priceChapterCount: priceInfo.priceChapterCount || chapterCount,
        rawPriceNote: priceInfo.rawNote || '',
        content: packageContent,
        contentBytes: ipnPkgRowUtf8ByteLength_(packageContent),
        chapterCount: chapterCount,
        chapters: chapters
      };

      if (pkg.contentBytes > Number(IPN_PACKAGE_ROW_EXPORT_CONFIG.WARN_TXT_BYTES || 0)) {
        pkg.sizeWarning =
          'แพ็กแถว ' + rowNo + ' (' + episodeNumber + ') มีขนาด ' +
          Math.round(pkg.contentBytes / 1024 / 1024 * 10) / 10 +
          'MB ควรตรวจว่าไม่เกิน limit import/DB';
      }

      if (String(IPN_PACKAGE_ROW_EXPORT_CONFIG.PRICE_MODE || '') === 'sheetNotePerChapter') {
        const noteParsed = ipnPkgRowParseChapterCountAndFreeFromNote_(priceInfo.rawNote || '');
        if (noteParsed.chapterCountFromNote !== null && noteParsed.chapterCountFromNote !== chapterCount) {
          pkg.noteMismatchWarning =
            'แถว ' + rowNo + ': จำนวนบทในคอลัมน์ M = ' + noteParsed.chapterCountFromNote +
            ' แต่จำนวนแท็บจริง = ' + chapterCount;
        }
      }

      packages.push(pkg);

      rowResults.push({
        row: rowNo,
        ok: true,
        chapterCount: chapterCount,
        novelMatchTitle: titleInfo.novelMatchTitle
      });

    } catch (e) {
      rowResults.push({
        row: rowNo,
        ok: false,
        message: e && e.message ? e.message : String(e)
      });
    }
  });

  // ห้าม sort ทั้ง ZIP ด้วย startNo อย่างเดียว เพราะหลายเรื่องอาจมีเลขบทซ้ำกัน
  // เรียงตามลำดับแถวที่เลือกไว้เดิม
  const okPackages = packages.slice();

  if (!okPackages.length) {
    const msg = 'ไม่พบแถวที่ export ได้สำเร็จเลย';

    rows.forEach(function(rowNo) {
      const rr = rowResults.filter(function(r) { return r.row === rowNo; })[0];
      ipnPkgRowWriteOutput_(sheet, rowNo, '', '❌ ' + (rr && rr.message ? rr.message : msg));
    });

    if (!options.silentConfirm) ui.alert(msg);

    return {
      ok: false,
      message: msg,
      rowCount: rows.length,
      successRowCount: 0,
      novelCount: 0,
      chapterCount: 0,
      packageCount: 0,
      problems: [],
      results: rowResults
    };
  }

  const problems = ipnPkgRowCheckMultiNovelRangeProblems_(okPackages);

  okPackages.forEach(function(pkg) {
    if (pkg.sizeWarning) problems.push(pkg.sizeWarning);
    if (pkg.noteMismatchWarning) problems.push(pkg.noteMismatchWarning);
  });

  const zipFile = ipnPkgRowCreateMultiNovelPackageZip_(baseName || 'ipenovel-multi-novel-package', okPackages);

  const totalChapters = okPackages.reduce(function(sum, p) { return sum + p.chapterCount; }, 0);
  const successRows = {};
  okPackages.forEach(function(p) { successRows[p.row] = true; });
  const successRowCount = Object.keys(successRows).length;

  const novelKeys = {};
  okPackages.forEach(function(p) {
    novelKeys[String(p.novelMatchTitle || p.novelTitle || '')] = true;
  });
  const novelCount = Object.keys(novelKeys).length;

  const noteLines = [
    '✅ Export Multi-Novel ZIP สำเร็จ',
    'ไฟล์: ' + zipFile.getName(),
    'จำนวนแถวที่รวม: ' + successRowCount + ' / ' + rows.length,
    'จำนวนเรื่อง: ' + novelCount,
    'จำนวนแพ็ก: ' + okPackages.length
  ];

  if (problems.length) {
    noteLines.push('ปัญหา: ' + problems.slice(0, 10).join(' | '));
  }

  ipnPkgRowWriteOutput_(sheet, firstRow, zipFile.getUrl(), noteLines.join('\n'));

  rows.forEach(function(rowNo) {
    if (rowNo === firstRow) return;

    if (successRows[rowNo]) {
      ipnPkgRowWriteMergedRefNote_(sheet, rowNo, 'รวมอยู่ใน Multi-Novel ZIP แถว ' + firstRow);
    } else {
      const rr = rowResults.filter(function(r) { return r.row === rowNo; })[0];
      ipnPkgRowWriteOutput_(sheet, rowNo, '', '❌ ' + (rr && rr.message ? rr.message : 'ไม่ทราบสาเหตุ'));
    }
  });

  const packagesSummary = okPackages.map(function(p) {
    return {
      row: p.row,
      novelTitle: p.novelTitle,
      novelMatchTitle: p.novelMatchTitle,
      episodeNumber: p.episodeNumber,
      chapterCount: p.chapterCount,
      priceChapterCount: p.priceChapterCount || p.chapterCount,
      price: p.price,
      isFree: p.isFree,
      priceSource: p.priceSource || '',
      rawPriceNote: p.rawPriceNote || '',
      contentFile: p.contentFile
    };
  });

  return {
    ok: true,
    message: 'Export Multi-Novel ZIP สำเร็จ',
    zipUrl: zipFile.getUrl(),
    fileName: zipFile.getName(),
    firstRow: firstRow,
    rowCount: rows.length,
    successRowCount: successRowCount,
    novelCount: novelCount,
    chapterCount: totalChapters,
    packageCount: okPackages.length,
    packages: packagesSummary,
    problems: problems,
    results: rowResults
  };
}

function ipnPkgRowCheckMultiNovelRangeProblems_(packages) {
  const problems = [];
  const seenByNovel = {};

  packages.forEach(function(pkg) {
    const novelKey = String(pkg.novelMatchTitle || pkg.novelTitle || '').trim() || ('row-' + pkg.row);
    if (!seenByNovel[novelKey]) seenByNovel[novelKey] = {};

    (pkg.chapters || []).forEach(function(ch) {
      const epKey = String(ch.episodeNumber);
      if (!seenByNovel[novelKey][epKey]) seenByNovel[novelKey][epKey] = [];
      seenByNovel[novelKey][epKey].push(pkg.row);
    });
  });

  Object.keys(seenByNovel).forEach(function(novelKey) {
    const epMap = seenByNovel[novelKey];
    Object.keys(epMap).forEach(function(epKey) {
      if (epMap[epKey].length > 1) {
        problems.push(
          'บทซ้ำในเรื่องเดียวกัน "' + novelKey + '": บทที่ ' + epKey +
          ' พบในแถว ' + epMap[epKey].join(', ')
        );
      }
    });
  });

  return problems;
}

function ipnPkgRowCreateMultiNovelPackageZip_(baseName, packages) {
  const blobs = [];

  const manifestCsv = ipnPkgRowBuildMultiNovelManifestCsv_(packages);
  const BOM_ = String.fromCharCode(0xFEFF);

  blobs.push(
    Utilities.newBlob(
      BOM_ + manifestCsv,
      'text/csv;charset=utf-8',
      IPN_PACKAGE_ROW_EXPORT_CONFIG.MANIFEST_FILE_NAME
    )
  );

  packages.forEach(function(pkg) {
    blobs.push(
      Utilities.newBlob(
        pkg.content,
        'text/plain;charset=utf-8',
        pkg.contentFile
      )
    );
  });

  const zipName =
    ipnPkgRowSanitizeFileName_(baseName || 'ipenovel-multi-novel-package') +
    IPN_PACKAGE_ROW_EXPORT_CONFIG.MULTI_NOVEL_ZIP_SUFFIX;

  const zipBlob = Utilities.zip(blobs, zipName);

  if (IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID) {
    return DriveApp
      .getFolderById(IPN_PACKAGE_ROW_EXPORT_CONFIG.OUTPUT_FOLDER_ID)
      .createFile(zipBlob);
  }

  return DriveApp.createFile(zipBlob);
}

function ipnPkgRowBuildMultiNovelManifestCsv_(packages) {
  const headers = [
    'novelTitle',
    'novelMatchTitle',
    'episodeNumber',
    'episodeTitle',
    'price',
    'isFree',
    'isPublished',
    'saleMode',
    'contentFile',
    'contentFormat',
    'sortOrder',
    'description'
  ];

  const rows = [headers];

  packages.forEach(function(pkg) {
    rows.push([
      pkg.novelTitle,
      pkg.novelMatchTitle,
      pkg.episodeNumber,
      pkg.episodeTitle,
      pkg.price,
      pkg.isFree,
      pkg.isPublished,
      pkg.saleMode,
      pkg.contentFile,
      pkg.contentFormat,
      pkg.sortOrder,
      pkg.description
    ]);
  });

  return rows.map(function(row) {
    return row.map(ipnPkgRowCsvCell_).join(',');
  }).join('\r\n');
}