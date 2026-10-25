/* =========================
 * Checker_Trigger
 *
 * สั่งตรวจเอกสารจากชีตโดยตรง: แอดมินกรอกชื่อเรื่อง (คอลัมน์ B) และลิงก์ Google Docs
 * (คอลัมน์ C) แล้วติ๊ก checkbox คอลัมน์ L เพื่อเข้าคิวตรวจ โดยไม่ต้องเปิด Sidebar
 *
 * หลักการออกแบบ
 * - onEdit handler ต้องเบา: ตรวจความถูกต้องของแถว เข้าคิว แล้วจบ
 *   ห้ามสแกนเอกสารแบบ synchronous เพราะ edit trigger มีเพดานเวลาต่ำ
 * - ทุกการแก้ไข state (enqueue / claim / progress / retry) ต้องอยู่ใน critical
 *   section เดียวกันที่คุมด้วย ScriptLock เพื่อไม่ให้เกิด lost update
 * - งานหนักถูกส่งต่อให้ worker แบบ time-based trigger ที่ resume ได้ข้าม execution
 *   โดยเก็บ cursor + checkpoint ที่ sanitize แล้ว
 * - งานจะถูกลบออกจาก state ก็ต่อเมื่อ finalize เขียนผลลงคอลัมน์ผล (M/N/O) สำเร็จแล้วเท่านั้น
 *   ทำให้การถูก kill กลางคันไม่ทำให้งานหาย
 * - lease หมายถึง "กำลังสแกนอยู่จริง" ไม่ใช่ "execution นี้เคยถืองาน"
 *   worker ที่ยอมยกยอดต้องคืน lease ก่อนจบ เพื่อให้ execution ถัดไปทำต่อได้ทันที
 *   ส่วน worker ที่ถูก kill กลางคันจะคืนไม่ได้ lease จึงค้างไว้จนหมดอายุแล้วถูกยึดต่อ
 * - คิวเก็บเฉพาะ metadata ห้ามเก็บข้อความนิยาย ชื่อเรื่อง หรือ URL
 * ========================= */

const CHECKER_TRIGGER_CFG = {
  // L: checkbox สั่งตรวจ (แทรกคอลัมน์ F กำหนดอ่านแล้วขยับจาก K เป็น L; M=13 หมายเหตุโปรแกรม)
  COMMAND_COL: 12,
  COMMAND_HEADER: 'สั่งตรวจ',

  // true = ตรวจแบบเร็ว (lightScan): ไม่จัดฟอร์แมต เขียนผลแยก M/N/O ~76 วิ/แถว
  // false = ตรวจเต็มแบบเดิม: จัดฟอร์แมตครบ (Sarabun/ย่อหน้า/ลบบรรทัดว่าง ฯลฯ) เขียนโน้ตรวมที่ M
  LIGHT_SCAN: true,

  EDIT_HANDLER_FUNCTION: 'onCheckerCommandEdit',
  WORKER_FUNCTION: 'runCheckerCommandQueue',

  QUEUE_PROPERTY_PREFIX: 'CHECKER_COMMAND_QUEUE:',

  LOCK_WAIT_MS: 15000,
  SCHEDULE_DELAY_MS: 60 * 1000,
  RETRY_DELAY_MS: 2 * 60 * 1000,

  // งบเวลาต่อ execution ของ worker
  //
  // scanWholeDocumentChunk มี time budget ภายในของตัวเอง
  // (WEBAPP_SCAN_CONFIG_.SERVER_TIME_BUDGET_MS = 240000) และจะหยุดตัวเองพร้อมคืน
  // nextCursor/checkpoint ที่ใช้ resume ได้ ดังนั้นถ้าเริ่ม chunk ใหม่ตอน elapsed
  // ไม่เกิน 60 วินาที กรณีแย่สุดคือ ~60s + ~240s = ~5 นาที ซึ่งยังต่ำกว่าเพดาน
  // script runtime 6 นาทีของ Apps Script
  MAX_RUN_MS: 60 * 1000,

  // อายุ lease ของ worker ที่ถืองานอยู่
  //
  // ต้องยาวกว่าเวลาที่ chunk เดียวใช้ได้มากที่สุด (MAX_RUN_MS + SERVER_TIME_BUDGET_MS
  // ~= 60s + 240s = 300s) เพื่อไม่ให้ worker ที่ยังทำงานปกติถูกแย่งงานไป
  // และสั้นพอที่งานซึ่งถูก kill กลางคันจะถูกกู้คืนได้ในเวลาที่ยอมรับได้
  IN_FLIGHT_LEASE_MS: 8 * 60 * 1000,

  MAX_ATTEMPTS: 3,
  MAX_QUEUE_SIZE: 500,

  // ข้อความสถานะใน Column L
  NOTE_QUEUED: 'อยู่ในคิวตรวจ',
  NOTE_RUNNING: 'กำลังตรวจ',
  NOTE_NO_TITLE: 'สั่งตรวจไม่สำเร็จ: ยังไม่ได้กรอกชื่อเรื่อง (คอลัมน์ B)',
  NOTE_NO_URL: 'สั่งตรวจไม่สำเร็จ: ยังไม่ได้กรอกลิงก์ Google Docs (คอลัมน์ C)',
  NOTE_BAD_URL: 'สั่งตรวจไม่สำเร็จ: ลิงก์คอลัมน์ C ไม่ใช่ลิงก์ Google Docs ที่ถูกต้อง',
  NOTE_QUEUE_FULL: 'สั่งตรวจไม่สำเร็จ: คิวเต็ม กรุณารอรอบปัจจุบันให้เสร็จก่อน',
  NOTE_BUSY: 'ระบบกำลังตรวจงานอื่นอยู่ กรุณาลองใหม่อีกครั้ง',
  NOTE_FAILED_PREFIX: 'ตรวจไม่สำเร็จ ติ๊กคอลัมน์ K อีกครั้งเพื่อลองใหม่'
};

/* =========================
 * Pure helpers (ไม่แตะ SpreadsheetApp/PropertiesService/LockService)
 * แยกออกมาเพื่อให้ทดสอบ interleaving ได้จริงด้วย Node
 * ========================= */

/** true เมื่อค่าใน cell ถือเป็น "ติ๊กแล้ว" */
function checkerTriggerIsCommandOn_(value) {
  if (value === true) return true;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'true' || s === '✓' || s === '✔' || s === '✅';
}

/**
 * แปลง edit event ให้เป็นรูปแบบเดียวกัน รองรับทั้งแก้ทีละ cell และวางหลายแถว
 * คืน null เมื่อ event ไม่เกี่ยวข้อง เพื่อให้ handler ออกเร็วที่สุด
 */
function checkerTriggerNormalizeEvent_(e, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  if (!e || !e.range) return null;

  const range = e.range;
  const startCol = Number(range.columnStart || (range.getColumn && range.getColumn()));
  const numCols = Number(range.numColumns || (range.getNumColumns && range.getNumColumns()) || 1);
  const startRow = Number(range.rowStart || (range.getRow && range.getRow()));
  const numRows = Number(range.numRows || (range.getNumRows && range.getNumRows()) || 1);

  if (!startCol || !startRow) return null;

  const endCol = startCol + numCols - 1;
  if (cfg.COMMAND_COL < startCol || cfg.COMMAND_COL > endCol) return null;

  return {
    startRow: startRow,
    numRows: numRows,
    startCol: startCol,
    numCols: numCols,
    commandOffset: cfg.COMMAND_COL - startCol
  };
}

/** หาแถวที่ checkbox ถูกติ๊กเป็น TRUE ในรอบแก้ไขนี้ */
function checkerTriggerCollectCommandRows_(normalized, values, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  const rows = [];
  if (!normalized || !values) return rows;

  for (let i = 0; i < normalized.numRows; i++) {
    const rowValues = values[i] || [];
    if (!checkerTriggerIsCommandOn_(rowValues[normalized.commandOffset])) continue;
    rows.push(normalized.startRow + i);
  }
  return rows;
}

/**
 * ตรวจความพร้อมของแถว: ต้องมีชื่อเรื่อง (B) และลิงก์ Google Docs ที่ parse ได้ (C)
 * คืน docId เพื่อใช้เป็น identity ของงาน
 */
function checkerTriggerValidateRow_(title, url, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;

  const cleanTitle = String(title == null ? '' : title).trim();
  if (!cleanTitle) return { ok: false, reason: 'NO_TITLE', note: cfg.NOTE_NO_TITLE, docId: '' };

  const cleanUrl = String(url == null ? '' : url).trim();
  if (!cleanUrl) return { ok: false, reason: 'NO_URL', note: cfg.NOTE_NO_URL, docId: '' };

  const parsed = (typeof parseGoogleDocUrl_ === 'function')
    ? parseGoogleDocUrl_(cleanUrl)
    : { docId: '' };

  if (!parsed || !parsed.docId) {
    return { ok: false, reason: 'BAD_URL', note: cfg.NOTE_BAD_URL, docId: '' };
  }

  return { ok: true, reason: '', note: '', docId: parsed.docId, tabId: parsed.tabId || '' };
}

/**
 * ลบ field ที่อาจมีเนื้อหาเอกสารออกจาก checkpoint ก่อนเก็บลง durable state
 *
 * scanWholeDocumentChunk คืน checkpoint ที่ผ่าน sanitizeCheckerCheckpointSummary_
 * มาแล้ว แต่ป้องกันอีกชั้นที่นี่ เพื่อไม่ให้ state ของ trigger พึ่งพา
 * sanitizer ฝั่งอื่นเพียงอย่างเดียว
 */
function checkerTriggerSanitizeCheckpoint_(value) {
  const BLOCKED = {
    text: true, note: true, title: true, docName: true, documentName: true,
    paragraphText: true, finalParagraph: true, oldText: true, newText: true,
    removedTexts: true, changes: true, from: true, to: true, before: true,
    after: true, rawContent: true, normalizedContent: true, message: true,
    stack: true, error: true, url: true, docUrl: true, openUrl: true,
    episodeUrl: true, sourceUrl: true, sourceUrl2: true
  };

  function visit(item, depth) {
    if (depth > 12) return null;
    if (Array.isArray(item)) {
      return item.map(function(child) { return visit(child, depth + 1); });
    }
    if (!item || typeof item !== 'object') return item;

    const out = {};
    Object.keys(item).forEach(function(key) {
      if (BLOCKED[key]) return;
      out[key] = visit(item[key], depth + 1);
    });
    return out;
  }

  if (value == null) return null;
  return visit(value, 0);
}

/** เก็บเฉพาะ field ที่จำเป็นของงานในคิว */
function checkerTriggerSanitizeQueueItem_(item) {
  if (!item || typeof item !== 'object') return null;

  const docId = String(item.docId || '').trim();
  const sheetRow = Number(item.sheetRow || 0);
  if (!docId || !sheetRow) return null;

  return {
    sheetRow: sheetRow,
    docId: docId,
    tabId: String(item.tabId || ''),
    enqueuedAt: Number(item.enqueuedAt || 0),
    attempts: Number(item.attempts || 0)
  };
}

/** เก็บเฉพาะ field ที่จำเป็นของงานที่กำลังทำอยู่ พร้อม progress ที่ resume ได้ */
function checkerTriggerSanitizeInFlight_(item) {
  const base = checkerTriggerSanitizeQueueItem_(item);
  if (!base) return null;

  base.cursor = Math.max(0, Number(item.cursor || 0));
  base.checkpoint = checkerTriggerSanitizeCheckpoint_(item.checkpoint || null);
  base.phase = item.phase === 'FINALIZE' ? 'FINALIZE' : 'SCAN';
  base.startedAt = Number(item.startedAt || 0);
  base.lastProgressAt = Number(item.lastProgressAt || 0);
  // owner เป็น token ของ worker execution ที่ถืองานอยู่ (metadata ล้วน)
  base.owner = String(item.owner || '');
  base.leaseUntil = Number(item.leaseUntil || 0);
  return base;
}

/** อ่าน state จาก property string อย่างปลอดภัย */
function checkerTriggerParseQueueState_(raw) {
  const empty = { items: [], inFlight: null, updatedAt: 0 };
  if (!raw) return empty;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    items: items
      .map(function(item) { return checkerTriggerSanitizeQueueItem_(item); })
      .filter(Boolean),
    inFlight: checkerTriggerSanitizeInFlight_(parsed.inFlight),
    updatedAt: Number(parsed.updatedAt || 0)
  };
}

function checkerTriggerSerializeQueueState_(state) {
  const items = ((state && state.items) || [])
    .map(function(item) { return checkerTriggerSanitizeQueueItem_(item); })
    .filter(Boolean);

  return JSON.stringify({
    items: items,
    inFlight: checkerTriggerSanitizeInFlight_(state && state.inFlight),
    updatedAt: Number((state && state.updatedAt) || 0)
  });
}

/**
 * รวมงานใหม่เข้าคิวโดยกันซ้ำ
 * - ซ้ำกับงานในคิว หรือกับงานที่กำลังตรวจอยู่ (inFlight) จะไม่ถูกเพิ่มอีก
 * - อัปเดต sheetRow ล่าสุดให้งานเดิม เผื่อแถวถูกแทรก/ย้าย
 * - เกิน MAX_QUEUE_SIZE จะถูกปฏิเสธและรายงานกลับ
 *
 * mutate state โดยตรง เพื่อให้ caller เรียกภายใน critical section เดียวได้
 */
function checkerTriggerEnqueue_(state, incomingItems, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;

  state.items = (state.items || [])
    .map(function(item) { return checkerTriggerSanitizeQueueItem_(item); })
    .filter(Boolean);

  const byDocId = {};
  state.items.forEach(function(item, index) { byDocId[item.docId] = index; });

  const inFlight = state.inFlight ? checkerTriggerSanitizeInFlight_(state.inFlight) : null;

  const accepted = [];
  const duplicates = [];
  const rejected = [];

  (incomingItems || []).forEach(function(raw) {
    const item = checkerTriggerSanitizeQueueItem_(raw);
    if (!item) return;

    // กำลังตรวจอยู่: อัปเดตตำแหน่งแถวได้ แต่ห้ามสร้างงานใหม่
    if (inFlight && inFlight.docId === item.docId) {
      state.inFlight.sheetRow = item.sheetRow;
      duplicates.push(item);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(byDocId, item.docId)) {
      state.items[byDocId[item.docId]].sheetRow = item.sheetRow;
      duplicates.push(item);
      return;
    }

    if (state.items.length >= Number(cfg.MAX_QUEUE_SIZE || 500)) {
      rejected.push(item);
      return;
    }

    byDocId[item.docId] = state.items.length;
    state.items.push(item);
    accepted.push(item);
  });

  return { accepted: accepted, duplicates: duplicates, rejected: rejected };
}

/**
 * lease ของงานที่กำลังทำอยู่หมดอายุหรือยัง
 *
 * ใช้ตัดสินว่า worker ตัวอื่นเข้ามาแย่งงานต่อได้หรือไม่
 * งานที่ไม่มี owner ถือว่าไม่มีใครถืออยู่ จึงหยิบต่อได้ทันที
 */
function checkerTriggerIsLeaseExpired_(inFlight, nowMs, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  if (!inFlight) return true;
  if (!inFlight.owner) return true;

  const now = Number(nowMs || 0);
  const leaseUntil = Number(inFlight.leaseUntil || 0);
  if (leaseUntil) return now >= leaseUntil;

  // state เก่าที่ยังไม่มี leaseUntil: อนุมานจากความคืบหน้าล่าสุด
  const last = Number(inFlight.lastProgressAt || inFlight.startedAt || 0);
  if (!last) return true;
  return (now - last) >= Number(cfg.IN_FLIGHT_LEASE_MS || 0);
}

/** worker ตัวนี้ยังเป็นเจ้าของงานอยู่หรือไม่ */
function checkerTriggerOwnsInFlight_(inFlight, ownerToken) {
  if (!inFlight) return false;
  const token = String(ownerToken || '');
  if (!token) return false;
  return String(inFlight.owner || '') === token;
}

/**
 * เลือกงานถัดไปมาทำ พร้อมจอง lease โดย mutate state ภายใน critical section
 *
 * กติกาความเป็นเจ้าของ (กัน worker สองตัวสแกนงานเดียวกันพร้อมกัน):
 * - inFlight เป็นของ worker นี้เอง -> resume และต่ออายุ lease
 * - inFlight เป็นของ worker อื่นและ lease ยังไม่หมด -> ไม่แตะ state เลย
 *   คืน OWNED_BY_OTHER ให้ผู้เรียกไปตั้งเวลามาใหม่
 * - inFlight ที่ lease หมดอายุ (worker เดิมถูก kill) -> ยึดงานมาทำต่อได้
 * - ไม่มี inFlight -> ย้ายงานหัวคิวมาเป็น inFlight พร้อมจอง lease
 *
 * งานจะยังอยู่ใน durable state เสมอจนกว่าจะ finalize สำเร็จ
 */
function checkerTriggerClaimJob_(state, nowMs, cfg, ownerToken) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  const now = Number(nowMs || 0);
  const token = String(ownerToken || '');
  const leaseUntil = now + Number(cfg.IN_FLIGHT_LEASE_MS || 0);

  if (!token) return { job: null, resumed: false, reason: 'NO_OWNER_TOKEN' };

  if (state.inFlight) {
    const current = checkerTriggerSanitizeInFlight_(state.inFlight);
    const mine = checkerTriggerOwnsInFlight_(current, token);
    const yielded = !String(current.owner || '');
    const expired = checkerTriggerIsLeaseExpired_(current, now, cfg);

    // worker อื่นยังสแกนงานนี้อยู่จริง ๆ: ห้ามแตะ state และห้ามสแกนซ้อน
    if (!mine && !yielded && !expired) {
      return { job: null, resumed: false, reason: 'OWNED_BY_OTHER' };
    }

    current.owner = token;
    current.leaseUntil = leaseUntil;
    current.lastProgressAt = now;
    state.inFlight = current;

    // แยกให้ชัด: ยกยอดมาอย่างเรียบร้อย vs ยึดงานที่เจ้าของเดิมถูก kill
    const reason = (mine || yielded) ? 'RESUMED' : 'TAKEOVER';
    return {
      job: current,
      resumed: true,
      takeover: reason === 'TAKEOVER',
      reason: reason
    };
  }

  state.items = (state.items || [])
    .map(function(item) { return checkerTriggerSanitizeQueueItem_(item); })
    .filter(Boolean);

  if (!state.items.length) return { job: null, resumed: false, reason: 'EMPTY' };

  const next = state.items.shift();
  const claimed = checkerTriggerSanitizeInFlight_({
    sheetRow: next.sheetRow,
    docId: next.docId,
    tabId: next.tabId,
    enqueuedAt: next.enqueuedAt,
    attempts: next.attempts,
    cursor: 0,
    checkpoint: null,
    phase: 'SCAN',
    startedAt: now,
    lastProgressAt: now,
    owner: token,
    leaseUntil: leaseUntil
  });

  state.inFlight = claimed;
  return { job: claimed, resumed: false, reason: 'CLAIMED' };
}

/**
 * บันทึกความคืบหน้าหนึ่ง chunk ลง state
 *
 * ต้องเป็นเจ้าของ lease ปัจจุบันเท่านั้นจึงจะเขียนได้ เพื่อไม่ให้ worker เก่า
 * ที่กลับมาหลังถูกยึดงานไปแล้ว เขียนทับความคืบหน้าใหม่หรือปลดงานของเจ้าของใหม่
 *
 * งานจะถูกลบออกจาก inFlight ก็ต่อเมื่อ finalize เสร็จแล้วเท่านั้น
 */
function checkerTriggerApplyChunkResult_(state, result, nowMs, cfg, ownerToken) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  const now = Number(nowMs || 0);

  if (!state.inFlight) return { completed: false, applied: false, phase: '', reason: 'NO_INFLIGHT' };

  if (!checkerTriggerOwnsInFlight_(state.inFlight, ownerToken)) {
    return { completed: false, applied: false, phase: '', reason: 'STALE_OWNER' };
  }

  // finalize เสร็จ = ผลถูกเขียนลง Column L แล้ว จึงปลดงานออกได้
  if (result && result.finalized) {
    state.inFlight = null;
    return { completed: true, applied: true, phase: 'DONE', reason: '' };
  }

  const inFlight = checkerTriggerSanitizeInFlight_(state.inFlight);
  inFlight.cursor = Math.max(0, Number(
    result && result.nextCursor != null ? result.nextCursor : inFlight.cursor
  ));
  inFlight.checkpoint = checkerTriggerSanitizeCheckpoint_(
    (result && (result.checkpoint || result.summary)) || inFlight.checkpoint
  );
  // สแกนครบทุกแท็บแล้ว รอบถัดไปจึงเป็นขั้น finalize
  inFlight.phase = (result && result.done) ? 'FINALIZE' : 'SCAN';
  inFlight.lastProgressAt = now;
  // ต่ออายุ lease ระหว่างที่ยังเดินงานอยู่
  inFlight.leaseUntil = now + Number(cfg.IN_FLIGHT_LEASE_MS || 0);

  state.inFlight = inFlight;
  return { completed: false, applied: true, phase: inFlight.phase, reason: '' };
}

/**
 * คืน lease ของงานที่กำลังทำอยู่ โดยคงความคืบหน้าไว้ครบ
 *
 * ใช้ตอน worker ตัดสินใจยกยอดให้ execution ถัดไป (หมดงบเวลา หรือจบรอบ)
 * เพื่อไม่ให้ lease ที่ยาว 8 นาทีไปกั้น execution ถัดไปที่ตั้งใจให้ทำต่อ
 *
 * เฉพาะเจ้าของปัจจุบันเท่านั้นที่คืนได้ worker เก่าที่ถูกยึดงานไปแล้ว
 * จึงปลด lease ของเจ้าของใหม่ไม่ได้
 */
function checkerTriggerYieldInFlight_(state, nowMs, cfg, ownerToken) {
  cfg = cfg || CHECKER_TRIGGER_CFG;

  if (!state.inFlight) return { yielded: false, reason: 'NO_INFLIGHT' };
  if (!checkerTriggerOwnsInFlight_(state.inFlight, ownerToken)) {
    return { yielded: false, reason: 'STALE_OWNER' };
  }

  const inFlight = checkerTriggerSanitizeInFlight_(state.inFlight);
  // ปล่อยเฉพาะความเป็นเจ้าของ ความคืบหน้า (cursor/checkpoint/phase) ต้องอยู่ครบ
  inFlight.owner = '';
  inFlight.leaseUntil = 0;
  inFlight.lastProgressAt = Number(nowMs || 0);
  state.inFlight = inFlight;

  return { yielded: true, reason: '' };
}

/**
 * จัดการงานที่ล้ม: นับ attempts แล้วส่งกลับเข้าคิวถ้ายังลองใหม่ได้
 * ล้างความคืบหน้าเดิมทิ้ง เพื่อให้รอบใหม่เริ่มจากศูนย์อย่างชัดเจน
 */
function checkerTriggerApplyFailure_(state, nowMs, cfg, ownerToken) {
  cfg = cfg || CHECKER_TRIGGER_CFG;

  if (!state.inFlight) {
    return { applied: false, willRetry: false, attempts: 0, sheetRow: 0, reason: 'NO_INFLIGHT' };
  }

  // worker เก่าที่ถูกยึดงานไปแล้ว ห้ามปลดงานของเจ้าของใหม่
  if (!checkerTriggerOwnsInFlight_(state.inFlight, ownerToken)) {
    return { applied: false, willRetry: false, attempts: 0, sheetRow: 0, reason: 'STALE_OWNER' };
  }

  const inFlight = checkerTriggerSanitizeInFlight_(state.inFlight);
  state.inFlight = null;

  const attempts = Number(inFlight.attempts || 0) + 1;
  const willRetry = attempts < Number(cfg.MAX_ATTEMPTS || 1);

  if (willRetry) {
    state.items = state.items || [];
    state.items.push(checkerTriggerSanitizeQueueItem_({
      sheetRow: inFlight.sheetRow,
      docId: inFlight.docId,
      tabId: inFlight.tabId,
      enqueuedAt: inFlight.enqueuedAt,
      attempts: attempts
    }));
  }

  return {
    applied: true,
    willRetry: willRetry,
    attempts: attempts,
    sheetRow: inFlight.sheetRow,
    reason: ''
  };
}

/**
 * ตัดสินใจว่ารอบ worker นี้ควรทำอะไร โดยไม่แตะ service ใด ๆ
 * แยกออกมาเพื่อทดสอบพฤติกรรม lock / คิวว่าง / งบเวลา ได้
 */
function checkerTriggerPlanWorkerRun_(options, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  options = options || {};

  if (!options.lockAcquired) {
    return { action: 'RESCHEDULE', reason: 'LOCKED', delayMs: Number(cfg.RETRY_DELAY_MS || 0) };
  }

  const hasWork = !!options.hasInFlight || Number(options.queueLength || 0) > 0;
  if (!hasWork) return { action: 'IDLE', reason: 'EMPTY', delayMs: 0 };

  // เริ่ม chunk ใหม่เฉพาะเมื่อยังมีงบเวลาเหลือพอ
  // chunk หนึ่งครั้งอาจใช้เวลาถึง SERVER_TIME_BUDGET_MS ของ Checker_Batch
  if (Number(options.elapsedMs || 0) >= Number(cfg.MAX_RUN_MS || 0)) {
    return { action: 'RESCHEDULE', reason: 'TIME_BUDGET', delayMs: Number(cfg.SCHEDULE_DELAY_MS || 0) };
  }

  return { action: 'PROCESS', reason: '', delayMs: 0 };
}

/** ข้อความแจ้งเมื่อรอบตรวจล้มเหลว (ไม่แนบข้อความเอกสารหรือ error ดิบ) */
function checkerTriggerBuildFailureNote_(attempts, willRetry, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  const n = Number(attempts || 0);
  return willRetry
    ? ('ตรวจไม่สำเร็จ (ครั้งที่ ' + n + ') ระบบจะลองใหม่อัตโนมัติ')
    : (cfg.NOTE_FAILED_PREFIX + ' (ลองแล้ว ' + n + ' ครั้ง)');
}

/** payload สำหรับเรียก scanWholeDocumentChunk หนึ่งครั้งจากงานที่ claim ไว้ */
function checkerTriggerBuildChunkPayload_(job, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;
  if (!job) return null;

  const payload = {
    sheetRow: Number(job.sheetRow || 0),
    docId: String(job.docId || ''),
    cursor: Math.max(0, Number(job.cursor || 0)),
    accumulated: job.checkpoint || null,
    finalize: job.phase === 'FINALIZE'
  };
  // โหมดตรวจตาม LIGHT_SCAN: true = lightScan (เร็ว ไม่จัดฟอร์แมต เขียน M/N/O)
  // false = ตรวจเต็มแบบเดิม (จัดฟอร์แมตครบ เขียนโน้ตรวมที่ M)
  if (cfg.LIGHT_SCAN !== false) {
    payload.lightScan = true;
    payload.runId = 'trig-' + Date.now() + '-' + String(Math.random()).slice(2, 8);
  }

  if (cfg.CHUNK_SIZE) payload.chunkSize = Number(cfg.CHUNK_SIZE);
  return payload;
}

/* =========================
 * Durable state (critical section)
 * ========================= */

function getCheckerCommandQueuePropertyKey_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ไม่พบ Spreadsheet ที่ผูกกับ Apps Script');
  return CHECKER_TRIGGER_CFG.QUEUE_PROPERTY_PREFIX + ss.getId();
}

function readCheckerCommandQueue_() {
  try {
    const raw = PropertiesService.getScriptProperties()
      .getProperty(getCheckerCommandQueuePropertyKey_());
    return checkerTriggerParseQueueState_(raw);
  } catch (e) {
    return { items: [], inFlight: null, updatedAt: 0 };
  }
}

function writeCheckerCommandQueue_(state) {
  PropertiesService.getScriptProperties().setProperty(
    getCheckerCommandQueuePropertyKey_(),
    checkerTriggerSerializeQueueState_({
      items: (state && state.items) || [],
      inFlight: (state && state.inFlight) || null,
      updatedAt: Date.now()
    })
  );
}

/**
 * critical section เดียวของฟีเจอร์นี้
 *
 * ทุกการอ่าน-แก้-เขียน state ต้องผ่านฟังก์ชันนี้ ทั้งฝั่ง onEdit และฝั่ง worker
 * เพื่อไม่ให้เกิด lost update จากการแก้ property เดียวกันพร้อมกัน
 *
 * worker จะ "ไม่" ถือล็อกไว้ตลอดการสแกน แต่จะเข้า-ออก critical section
 * เป็นช่วงสั้น ๆ ต่อการเปลี่ยน state หนึ่งครั้ง
 */
function withCheckerCommandState_(mutator) {
  const lock = LockService.getScriptLock();

  let acquired = false;
  try {
    acquired = lock.tryLock(Number(CHECKER_TRIGGER_CFG.LOCK_WAIT_MS || 0));
  } catch (e) {
    acquired = false;
  }

  if (!acquired) return { ok: false, reason: 'LOCKED', result: null };

  try {
    const state = readCheckerCommandQueue_();
    const result = mutator(state);
    writeCheckerCommandQueue_(state);
    return { ok: true, reason: '', result: result };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* =========================
 * Sheet helpers
 * ========================= */

/** ปลดติ๊ก checkbox เพื่อให้แอดมินติ๊กซ้ำเพื่อ retry ได้เสมอ */
function clearCheckerCommandCheckbox_(sheet, sheetRow) {
  try {
    sheet.getRange(sheetRow, CHECKER_TRIGGER_CFG.COMMAND_COL).setValue(false);
  } catch (e) {}
}

function setCheckerCommandNote_(sheetRow, note) {
  try {
    updateCheckerFields({ sheetRow: sheetRow, note: note });
  } catch (e) {}
}

/** token ประจำ worker execution (metadata ล้วน ไม่มีข้อมูลเอกสาร) */
function createCheckerCommandOwnerToken_() {
  try {
    return 'w-' + Utilities.getUuid();
  } catch (e) {
    return 'w-' + String(Date.now()) + '-' + String(Math.random()).slice(2, 10);
  }
}

function touchCheckerDataRevisionSafe_() {
  try {
    if (typeof touchCheckerDataRevision_ === 'function') touchCheckerDataRevision_();
  } catch (e) {}
}

/* =========================
 * Apps Script entry points
 * ========================= */

/**
 * Installable onEdit handler สำหรับ checkbox คอลัมน์ K
 *
 * ต้องเบาที่สุด: validate + enqueue (ใน critical section) + ตั้ง worker แล้วจบ
 * ห้ามสแกนเอกสารในนี้
 */
function onCheckerCommandEdit(e) {
  const cfg = CHECKER_TRIGGER_CFG;

  const normalized = checkerTriggerNormalizeEvent_(e, cfg);
  if (!normalized) return;

  const sheet = e.range.getSheet();
  if (String(sheet.getName()) !== String(CHECKER_CFG.SHEET_NAME)) return;

  const values = e.range.getValues();
  const commandRows = checkerTriggerCollectCommandRows_(normalized, values, cfg)
    .filter(function(rowNumber) { return rowNumber >= CHECKER_CFG.START_ROW; });

  if (!commandRows.length) return;

  const incoming = [];
  const now = Date.now();

  commandRows.forEach(function(sheetRow) {
    let title = '';
    let url = '';
    try {
      title = sheet.getRange(sheetRow, CHECKER_CFG.COL.title).getDisplayValue();
      url = getRichTextUrlSafe_(sheet.getRange(sheetRow, CHECKER_CFG.COL.episodeUrl)) ||
        sheet.getRange(sheetRow, CHECKER_CFG.COL.episodeUrl).getDisplayValue();
    } catch (readError) {
      title = '';
      url = '';
    }

    const validation = checkerTriggerValidateRow_(title, url, cfg);

    // ปลดติ๊กทุกกรณี เพื่อให้สถานะ checkbox ชัดเจนและ retry ได้
    clearCheckerCommandCheckbox_(sheet, sheetRow);

    if (!validation.ok) {
      setCheckerCommandNote_(sheetRow, validation.note);
      return;
    }

    incoming.push({
      sheetRow: sheetRow,
      docId: validation.docId,
      tabId: validation.tabId,
      enqueuedAt: now,
      attempts: 0
    });
  });

  if (!incoming.length) {
    touchCheckerDataRevisionSafe_();
    return;
  }

  // อ่าน-แก้-เขียน state ภายใน critical section เดียวกับ worker
  const outcome = withCheckerCommandState_(function(state) {
    return checkerTriggerEnqueue_(state, incoming, cfg);
  });

  if (!outcome.ok) {
    // ล็อกไม่ว่างจริง ๆ: แจ้งให้ลองใหม่แทนการเขียนทับ state ของ worker
    incoming.forEach(function(item) {
      setCheckerCommandNote_(item.sheetRow, cfg.NOTE_BUSY);
    });
    touchCheckerDataRevisionSafe_();
    return;
  }

  const merged = outcome.result;
  merged.accepted.forEach(function(item) {
    setCheckerCommandNote_(item.sheetRow, cfg.NOTE_QUEUED);
  });
  merged.rejected.forEach(function(item) {
    setCheckerCommandNote_(item.sheetRow, cfg.NOTE_QUEUE_FULL);
  });
  // duplicates: งานเดิมยังอยู่ในคิว/กำลังตรวจ ไม่เขียนทับหมายเหตุและไม่เพิ่มงานซ้ำ

  touchCheckerDataRevisionSafe_();

  if (merged.accepted.length) scheduleCheckerCommandWorker_(cfg.SCHEDULE_DELAY_MS);
}

/**
 * Worker: เดินงานทีละ chunk ภายในงบเวลา แล้วยกยอดไปรอบถัดไป
 *
 * ทุกการเปลี่ยน state ผ่าน withCheckerCommandState_ ส่วนการสแกนทำนอกล็อก
 * เพื่อไม่ให้ onEdit ถูกบล็อกนานและไม่ชน lock timeout ของ Apps Script
 */
function runCheckerCommandQueue() {
  const cfg = CHECKER_TRIGGER_CFG;
  const startedAt = Date.now();

  // token ประจำ execution นี้ ใช้เป็นเจ้าของ lease ของงานที่ถืออยู่
  const ownerToken = createCheckerCommandOwnerToken_();

  let processedChunks = 0;
  let completed = 0;
  let failed = 0;

  // ไม่ล้างทริกเกอร์ตอนเริ่ม เพราะทริกเกอร์ที่ค้างอยู่อาจเป็นของงานอื่นที่ยังรอคิว
  // การรันซ้อนไม่เป็นอันตรายแล้ว เพราะ lease กันการสแกนซ้ำไว้อีกชั้น

  try {
  while (true) {
    const snapshot = withCheckerCommandState_(function(state) {
      return {
        queueLength: (state.items || []).length,
        hasInFlight: !!state.inFlight
      };
    });

    const plan = checkerTriggerPlanWorkerRun_({
      lockAcquired: snapshot.ok,
      queueLength: snapshot.ok ? snapshot.result.queueLength : 0,
      hasInFlight: snapshot.ok ? snapshot.result.hasInFlight : false,
      elapsedMs: Date.now() - startedAt
    }, cfg);

    if (plan.action === 'IDLE') break;
    if (plan.action === 'RESCHEDULE') {
      scheduleCheckerCommandWorker_(plan.delayMs);
      break;
    }

    // claim/resume งานพร้อมจอง lease — งานยังอยู่ใน durable state ตลอดเวลา
    const claim = withCheckerCommandState_(function(state) {
      return checkerTriggerClaimJob_(state, Date.now(), cfg, ownerToken);
    });
    if (!claim.ok) {
      scheduleCheckerCommandWorker_(cfg.RETRY_DELAY_MS);
      break;
    }

    // worker อื่นกำลังสแกนงานนี้อยู่: ห้ามสแกนซ้อน ให้ถอยแล้วมาใหม่
    if (claim.result && claim.result.reason === 'OWNED_BY_OTHER') {
      scheduleCheckerCommandWorker_(cfg.RETRY_DELAY_MS);
      break;
    }

    const job = claim.result && claim.result.job;
    if (!job) break;

    const step = runCheckerCommandChunk_(job, cfg);
    processedChunks++;

    if (step.ok) {
      const applied = withCheckerCommandState_(function(state) {
        return checkerTriggerApplyChunkResult_(state, step.result, Date.now(), cfg, ownerToken);
      });
      // ถูกยึดงานไปแล้วระหว่างที่สแกนอยู่: หยุดทันที อย่าไปแข่งกับเจ้าของใหม่
      if (applied.ok && applied.result && applied.result.reason === 'STALE_OWNER') break;

      if (applied.ok && applied.result && applied.result.completed) {
        completed++;
        touchCheckerDataRevisionSafe_();
      }
    } else {
      const failure = withCheckerCommandState_(function(state) {
        return checkerTriggerApplyFailure_(state, Date.now(), cfg, ownerToken);
      });
      failed++;

      if (failure.ok && failure.result && failure.result.reason === 'STALE_OWNER') break;

      if (failure.ok && failure.result && failure.result.applied) {
        setCheckerCommandNote_(
          failure.result.sheetRow || job.sheetRow,
          checkerTriggerBuildFailureNote_(failure.result.attempts, failure.result.willRetry, cfg)
        );
        touchCheckerDataRevisionSafe_();
        if (failure.result.willRetry) {
          scheduleCheckerCommandWorker_(cfg.RETRY_DELAY_MS);
          break;
        }
      }
    }
  }
  } finally {
    // ยอมยกยอดแล้ว: คืน lease เพื่อให้ execution ถัดไปทำต่อได้ทันที
    // ไม่ต้องรอ 8 นาที เป็น no-op ถ้างานถูกปิดไปแล้วหรือถูก worker อื่นยึดไป
    //
    // ถ้า execution นี้ถูก kill กลางคัน finally จะไม่ทำงาน lease จึงค้างไว้
    // จนหมดอายุ แล้วค่อยถูกยึดต่อ ซึ่งเป็นพฤติกรรมที่ต้องการ
    withCheckerCommandState_(function(state) {
      return checkerTriggerYieldInFlight_(state, Date.now(), cfg, ownerToken);
    });
  }

  return {
    ok: true,
    processedChunks: processedChunks,
    completed: completed,
    failed: failed
  };
}

/**
 * เดินงานหนึ่ง chunk ด้วย primitive เดิมของ Checker_Batch
 * ไม่ใช้ scanRowDocumentFull เพราะฟังก์ชันนั้นวน chunk จนจบภายใน execution เดียว
 */
function runCheckerCommandChunk_(job, cfg) {
  cfg = cfg || CHECKER_TRIGGER_CFG;

  const payload = checkerTriggerBuildChunkPayload_(job, cfg);
  if (!payload || !payload.sheetRow) return { ok: false, reason: 'INVALID_JOB' };

  try {
    if (payload.finalize !== true) {
      setCheckerCommandNote_(payload.sheetRow, cfg.NOTE_RUNNING);
    }
    const result = scanWholeDocumentChunk(payload);
    return { ok: true, result: result };
  } catch (error) {
    // ไม่ส่ง error ดิบต่อ เพื่อไม่ให้ข้อความเอกสารหลุดเข้า state/หมายเหตุ
    return { ok: false, reason: 'SCAN_ERROR' };
  }
}

/* =========================
 * Trigger management (idempotent)
 * ========================= */

function scheduleCheckerCommandWorker_(delayMs) {
  const cfg = CHECKER_TRIGGER_CFG;
  const wait = Math.max(1000, Number(delayMs || cfg.SCHEDULE_DELAY_MS || 60000));

  try {
    clearCheckerCommandTriggers_();
    ScriptApp.newTrigger(cfg.WORKER_FUNCTION).timeBased().after(wait).create();
    return true;
  } catch (e) {
    return false;
  }
}

function clearCheckerCommandTriggers_() {
  try {
    ScriptApp.getProjectTriggers().forEach(function(trigger) {
      if (trigger.getHandlerFunction() === CHECKER_TRIGGER_CFG.WORKER_FUNCTION) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
  } catch (e) {}
}

/**
 * ติดตั้ง installable onEdit trigger แบบ idempotent
 * เรียกซ้ำได้ จะไม่เกิด trigger ซ้อน
 */
function installCheckerCommandTrigger() {
  const cfg = CHECKER_TRIGGER_CFG;
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === cfg.EDIT_HANDLER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  ScriptApp.newTrigger(cfg.EDIT_HANDLER_FUNCTION)
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  ensureCheckerCommandHeader_();

  return { ok: true, removed: removed, created: 1 };
}

function installCheckerCommandTriggerWithAlert() {
  const result = installCheckerCommandTrigger();
  SpreadsheetApp.getUi().alert(
    'ติดตั้งทริกเกอร์สั่งตรวจแล้ว\n\n' +
    'ลบทริกเกอร์เดิม: ' + result.removed + ' รายการ\n' +
    'สร้างใหม่: ' + result.created + ' รายการ\n\n' +
    'วิธีใช้: กรอกชื่อเรื่องคอลัมน์ B และลิงก์ Google Docs คอลัมน์ C ' +
    'แล้วติ๊ก checkbox คอลัมน์ L'
  );
}

function removeCheckerCommandTrigger() {
  const cfg = CHECKER_TRIGGER_CFG;
  let removed = 0;

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    const fn = trigger.getHandlerFunction();
    if (fn === cfg.EDIT_HANDLER_FUNCTION || fn === cfg.WORKER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  return { ok: true, removed: removed };
}

function ensureCheckerCommandHeader_() {
  try {
    const sh = getCheckerSheet_();
    const cell = sh.getRange(CHECKER_CFG.HEADER_ROW, CHECKER_TRIGGER_CFG.COMMAND_COL);
    if (!String(cell.getDisplayValue() || '').trim()) {
      cell.setValue(CHECKER_TRIGGER_CFG.COMMAND_HEADER);
    }
    return true;
  } catch (e) {
    return false;
  }
}

/** ล้างคิว งานที่ค้าง และทริกเกอร์ worker */
function resetCheckerCommandQueue() {
  clearCheckerCommandTriggers_();
  try {
    PropertiesService.getScriptProperties()
      .deleteProperty(getCheckerCommandQueuePropertyKey_());
  } catch (e) {}
  return { ok: true };
}

function resetCheckerCommandQueueWithAlert() {
  resetCheckerCommandQueue();
  SpreadsheetApp.getUi().alert('ล้างคิวสั่งตรวจแล้ว');
}
