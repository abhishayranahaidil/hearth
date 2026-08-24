/**
 * Hearth — household bridge
 * Apps Script bound to the household Sheet. Deployed as a web app:
 *   Execute as:  Me (the shared household account)
 *   Who has access: Anyone with the link
 *
 * All auth is by token, not by Google identity, so neither phone needs
 * any Google permission. Tokens map to a person; every row records `who`.
 *
 * Script Properties required (Project Settings -> Script Properties):
 *   TOKENS          {"long-random-1":"Ravi","long-random-2":"Priya"}
 *   CAL_HOUSEHOLD   calendar id for money/health (shared with the two adults only)
 *   CAL_FAMILY      calendar id for kid-facing things (the auto-created Family calendar)
 *   DRIVE_FOLDER    id of the root Drive folder for documents
 *   ANTHROPIC_KEY   (optional) enables voice/text parsing
 *   PARSE_MODEL     (optional) defaults to claude-haiku-4-5-20251001
 *
 * After ANY code change: Deploy -> Manage deployments -> edit -> New version.
 * Editing the code alone changes nothing. This is the classic trap.
 */

var VERSION = '0.1.0';

// ---------------------------------------------------------------- schema

var SCHEMA = {
  subjects: ['id', 'kind', 'name', 'note', 'colour', 'active',
             'who', 'created_at', 'updated_at', 'deleted'],

  obligations: ['id', 'subject_id', 'kind', 'title', 'provider', 'account_ref',
                'category', 'amount', 'cadence', 'next_due', 'ends_on',
                'notice_days', 'calendar', 'cal_due_id', 'cal_notice_id',
                'owner', 'status', 'note', 'confidence', 'review',
                'who', 'created_at', 'updated_at', 'deleted'],

  // append-only: never edit a row, add a reversing one
  payments: ['id', 'obligation_id', 'subject_id', 'paid_on', 'amount',
             'category', 'method', 'note', 'reverses_id',
             'who', 'created_at'],

  activities: ['id', 'subject_id', 'title', 'provider', 'venue', 'day_of_week',
               'start_time', 'end_time', 'term_start', 'term_end',
               'fee_obligation_id', 'cal_event_id', 'note',
               'who', 'created_at', 'updated_at', 'deleted'],

  events: ['id', 'subject_id', 'title', 'category', 'on_date', 'start_time',
           'venue', 'contact_id', 'calendar', 'cal_event_id', 'note',
           'who', 'created_at', 'updated_at', 'deleted'],

  documents: ['id', 'subject_id', 'obligation_id', 'title', 'category',
              'drive_file_id', 'drive_url', 'mime', 'ocr_text', 'doc_date',
              'expires_on', 'note', 'who', 'created_at', 'updated_at', 'deleted'],

  readings: ['id', 'subject_id', 'kind', 'taken_on', 'label', 'value', 'unit',
             'ref_low', 'ref_high', 'document_id', 'note',
             'who', 'created_at', 'updated_at', 'deleted'],

  contacts: ['id', 'subject_id', 'name', 'relation', 'phone', 'email',
             'address', 'note', 'who', 'created_at', 'updated_at', 'deleted'],

  vocab: ['id', 'list', 'value', 'sort', 'active']
};

var PREFIX = {
  subjects: 'sub', obligations: 'obl', payments: 'pay', activities: 'act',
  events: 'evt', documents: 'doc', readings: 'rdg', contacts: 'con', vocab: 'voc'
};

var SEED_VOCAB = [
  ['category', 'Insurance'], ['category', 'Vehicle'], ['category', 'Mortgage'],
  ['category', 'Utilities'], ['category', 'Water'], ['category', 'Council tax'],
  ['category', 'Broadband & phone'], ['category', 'Estate & grounds'],
  ['category', 'Kids activities'], ['category', 'School'], ['category', 'Health'],
  ['category', 'Subscriptions'], ['category', 'Other'],
  ['cadence', 'once'], ['cadence', 'weekly'], ['cadence', 'fortnightly'],
  ['cadence', 'monthly'], ['cadence', 'quarterly'], ['cadence', 'half-yearly'],
  ['cadence', 'yearly'], ['cadence', '2-yearly'],
  ['subject_kind', 'person'], ['subject_kind', 'vehicle'],
  ['subject_kind', 'property'], ['subject_kind', 'household'],
  ['method', 'Direct debit'], ['method', 'Standing order'], ['method', 'Card'],
  ['method', 'Bank transfer'], ['method', 'Cash'],
  ['event_category', 'Appointment'], ['event_category', 'Party'],
  ['event_category', 'School'], ['event_category', 'Exam'],
  ['event_category', 'Holiday'], ['event_category', 'Other'],
  ['doc_category', 'Contract'], ['doc_category', 'Policy'], ['doc_category', 'Bill'],
  ['doc_category', 'Letter'], ['doc_category', 'Report'], ['doc_category', 'Receipt'],
  ['reading_kind', 'Blood test'], ['reading_kind', 'School report'],
  ['reading_kind', 'Measurement']
];

// ---------------------------------------------------------------- entry

function doGet(e) {
  return json({ ok: true, service: 'hearth', version: VERSION });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Body was not valid JSON.' });
  }

  var who = whoIs(body.token);
  if (!who) return json({ ok: false, error: 'auth', message: 'Token not recognised.' });

  try {
    switch (body.action) {
      case 'ping':       return json({ ok: true, version: VERSION, who: who });
      case 'pull':       return json({ ok: true, version: VERSION, who: who, data: pull() });
      case 'upsert':     return json({ ok: true, row: upsert(body.tab, body.row, who) });
      case 'upsertMany': return json({ ok: true, rows: body.rows.map(function (r) {
                                  return upsert(r.tab, r.row, who); }) });
      case 'remove':     return json({ ok: true, row: softDelete(body.tab, body.id, who) });
      case 'markPaid':   return json({ ok: true, result: markPaid(body, who) });
      case 'upload':     return json({ ok: true, doc: uploadDocument(body, who) });
      case 'parse':      return json({ ok: true, parsed: parseText(body.text, body.today) });
      case 'snapshot':   return json({ ok: true, file: snapshot() });
      default:           return json({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function prop(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function whoIs(token) {
  if (!token) return null;
  var raw = prop('TOKENS');
  if (!raw) throw new Error('TOKENS is not set in Script Properties.');
  var map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    throw new Error('TOKENS is not valid JSON. It must look like ' +
      '{"longtoken":"Abhishek","othertoken":"Deepika"} — curly braces included.');
  }
  return map[token] || null;
}

// ---------------------------------------------------------------- setup

/** Run once, by hand, from the Apps Script editor. Safe to re-run. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(SCHEMA).forEach(function (tab) {
    var sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
    var cols = SCHEMA[tab];
    sh.getRange(1, 1, 1, cols.length).setValues([cols])
      .setFontWeight('bold').setBackground('#EDF0F7');
    sh.setFrozenRows(1);
    // keep dates as text so nothing gets silently reformatted
    sh.getRange(2, 1, sh.getMaxRows() - 1, cols.length).setNumberFormat('@');
  });

  var vocab = ss.getSheetByName('vocab');
  if (vocab.getLastRow() < 2) {
    var rows = SEED_VOCAB.map(function (v, i) {
      return [PREFIX.vocab + '_' + pad(i + 1), v[0], v[1], i + 1, 'yes'];
    });
    vocab.getRange(2, 1, rows.length, 5).setValues(rows);
  }

  var subs = ss.getSheetByName('subjects');
  if (subs.getLastRow() < 2) {
    upsert('subjects', { kind: 'household', name: 'Household', active: 'yes' }, 'setup');
  }

  var first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0) ss.deleteSheet(first);

  return 'Tabs ready. Now set Script Properties, then deploy.';
}

function pad(n) { return ('000' + n).slice(-4); }

/**
 * Convenience: prints a TOKENS value you can paste straight into
 * Script Properties, no editing needed. The long strings are the secrets;
 * the names are only labels for the `who` column on every row.
 */
function makeTokens() {
  var t = function () { return Utilities.getUuid().replace(/-/g, ''); };
  var out = {};
  out[t()] = 'Abhishek';
  out[t()] = 'Deepika';
  var text = JSON.stringify(out, null, 2);
  Logger.log('Paste this into Script Properties as TOKENS:\n\n' + text);
  return text;
}

// ---------------------------------------------------------------- read

function sheetOf(tab) {
  if (!SCHEMA[tab]) throw new Error('Unknown tab: ' + tab);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  if (!sh) throw new Error('Tab missing: ' + tab + '. Run setup().');
  return sh;
}

function readTab(tab) {
  var sh = sheetOf(tab);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var cols = SCHEMA[tab];
  var values = sh.getRange(2, 1, last - 1, cols.length).getDisplayValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    if (!values[r][0]) continue;
    var row = {};
    for (var c = 0; c < cols.length; c++) row[cols[c]] = values[r][c];
    if (row.deleted === 'yes') continue;
    out.push(row);
  }
  return out;
}

function pull() {
  var data = {};
  Object.keys(SCHEMA).forEach(function (tab) { data[tab] = readTab(tab); });
  return data;
}

// ---------------------------------------------------------------- write

function upsert(tab, row, who) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheetOf(tab);
    var cols = SCHEMA[tab];
    var now = new Date().toISOString();

    row = row || {};
    row.who = row.who || who;
    if (!row.id) {
      row.id = PREFIX[tab] + '_' + Date.now().toString(36) +
               Math.random().toString(36).slice(2, 6);
      row.created_at = now;
    }
    if (cols.indexOf('updated_at') >= 0) row.updated_at = now;
    if (!row.created_at && cols.indexOf('created_at') >= 0) row.created_at = now;

    var rowIndex = findRow(sh, row.id);
    var existing = {};
    if (rowIndex > 0) {
      var cur = sh.getRange(rowIndex, 1, 1, cols.length).getDisplayValues()[0];
      for (var i = 0; i < cols.length; i++) existing[cols[i]] = cur[i];
    }

    var merged = cols.map(function (c) {
      return row[c] !== undefined && row[c] !== null ? String(row[c])
           : (existing[c] !== undefined ? existing[c] : '');
    });

    if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, cols.length).setValues([merged]);
    else sh.appendRow(merged);

    var saved = {};
    cols.forEach(function (c, i) { saved[c] = merged[i]; });

    if (tab === 'obligations') saved = syncObligationCalendar(saved);
    if (tab === 'events')      saved = syncEventCalendar(saved);
    if (tab === 'activities')  saved = syncActivityCalendar(saved);

    return saved;
  } finally {
    lock.releaseLock();
  }
}

function findRow(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}

function softDelete(tab, id, who) {
  var sh = sheetOf(tab);
  var cols = SCHEMA[tab];
  var r = findRow(sh, id);
  if (r < 0) throw new Error('Not found: ' + id);

  var row = {};
  var cur = sh.getRange(r, 1, 1, cols.length).getDisplayValues()[0];
  cols.forEach(function (c, i) { row[c] = cur[i]; });

  if (tab === 'obligations') clearObligationCalendar(row);
  if (tab === 'events') deleteCalEvent(calFor(row.calendar), row.cal_event_id);
  if (tab === 'activities') deleteCalEvent(calFor('family'), row.cal_event_id);

  var di = cols.indexOf('deleted');
  if (di >= 0) sh.getRange(r, di + 1).setValue('yes');
  var ui = cols.indexOf('updated_at');
  if (ui >= 0) sh.getRange(r, ui + 1).setValue(new Date().toISOString());
  var wi = cols.indexOf('who');
  if (wi >= 0) sh.getRange(r, wi + 1).setValue(who);

  return { id: id, deleted: 'yes' };
}

// ---------------------------------------------------------------- mark paid

/**
 * One button, three effects: record the payment, advance the due date,
 * move the calendar entries. Never edits a payment row.
 */
function markPaid(body, who) {
  var sh = sheetOf('obligations');
  var r = findRow(sh, body.obligation_id);
  if (r < 0) throw new Error('Obligation not found.');

  var cols = SCHEMA.obligations;
  var cur = sh.getRange(r, 1, 1, cols.length).getDisplayValues()[0];
  var obl = {};
  cols.forEach(function (c, i) { obl[c] = cur[i]; });

  var paidOn = body.paid_on || todayISO();
  var amount = body.amount !== undefined && body.amount !== '' ? body.amount : obl.amount;

  var payment = upsert('payments', {
    obligation_id: obl.id,
    subject_id: obl.subject_id,
    paid_on: paidOn,
    amount: amount,
    category: obl.category,
    method: body.method || '',
    note: body.note || ''
  }, who);

  var next = advance(obl.next_due || paidOn, obl.cadence);
  if (obl.ends_on && next && next > obl.ends_on) {
    obl.status = 'finished';
    clearObligationCalendar(obl);
    obl.next_due = '';
    obl.cal_due_id = '';
    obl.cal_notice_id = '';
  } else {
    obl.next_due = next;
  }

  var updated = upsert('obligations', obl, who);
  return { payment: payment, obligation: updated };
}

/**
 * Always measured from the original date, never by stepping the last one.
 * A direct debit on the 31st clamps to the 28th in February and returns
 * to the 31st in March; stepping iteratively would leave it stuck on 28.
 */
function advance(fromISO, cadence) {
  if (!cadence || cadence === 'once') return '';
  var base = parseISO(fromISO);
  if (!base) return '';
  var today = parseISO(todayISO());

  var months = { monthly: 1, quarterly: 3, 'half-yearly': 6,
                 yearly: 12, '2-yearly': 24 }[cadence];
  var days = { weekly: 7, fortnightly: 14 }[cadence];
  var custom = /^every-(\d+)-days$/.exec(cadence);
  if (custom) days = parseInt(custom[1], 10);
  if (!months && !days) months = 1;

  var n = 0, d;
  do {
    n++;
    d = months ? addMonths(base, months * n) : addDays(base, days * n);
  } while (d <= today && n < 400);
  return isoOf(d);
}

function addDays(d, days) {
  var n = new Date(d.getTime());
  n.setDate(n.getDate() + days);
  return n;
}

function addMonths(d, months) {
  var day = d.getDate();
  var n = new Date(d.getFullYear(), d.getMonth() + months, 1);
  var lastDay = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
  n.setDate(Math.min(day, lastDay));
  return n;
}

// ---------------------------------------------------------------- calendar

function calFor(which) {
  if (which === 'none') return null;   // tracked in the app, kept off the calendar
  var id = (which === 'family') ? prop('CAL_FAMILY') : prop('CAL_HOUSEHOLD');
  if (!id) return null;
  try { return CalendarApp.getCalendarById(id); } catch (e) { return null; }
}

/**
 * Two all-day events per obligation: one at the notice date, one on the day.
 * Events rather than reminder overrides, because reminders only ever fire
 * for the account that created them — and everything here is created by one.
 */
function syncObligationCalendar(obl) {
  var cal = calFor(obl.calendar || 'household');
  if (!cal) return obl;

  var live = obl.deleted !== 'yes' && obl.status !== 'finished' && obl.next_due;
  if (!live) {
    clearObligationCalendar(obl);
    obl.cal_due_id = '';
    obl.cal_notice_id = '';
    return obl;
  }

  var due = parseISO(obl.next_due);
  if (!due) return obl;

  var money = obl.amount ? ' — £' + obl.amount : '';
  var dueTitle = obl.title + ' due' + money;
  var desc = [obl.provider, obl.account_ref, obl.note]
    .filter(function (x) { return x; }).join('\n');

  obl.cal_due_id = allDay(cal, obl.cal_due_id, dueTitle, due, desc);

  var notice = parseInt(obl.notice_days || '0', 10);
  if (notice > 0) {
    var nd = new Date(due.getTime());
    nd.setDate(nd.getDate() - notice);
    var nTitle = obl.title + ' in ' + notice + ' days' +
                 (obl.provider ? ' — ' + obl.provider : '');
    obl.cal_notice_id = allDay(cal, obl.cal_notice_id, nTitle, nd, desc);
  } else {
    deleteCalEvent(cal, obl.cal_notice_id);
    obl.cal_notice_id = '';
  }

  writeBack('obligations', obl.id,
    { cal_due_id: obl.cal_due_id, cal_notice_id: obl.cal_notice_id });
  return obl;
}

function clearObligationCalendar(obl) {
  var cal = calFor(obl.calendar || 'household');
  deleteCalEvent(cal, obl.cal_due_id);
  deleteCalEvent(cal, obl.cal_notice_id);
}

function syncEventCalendar(ev) {
  var cal = calFor(ev.calendar || 'family');
  if (!cal || !ev.on_date) return ev;
  var d = parseISO(ev.on_date);
  if (!d) return ev;
  var desc = [ev.venue, ev.note].filter(function (x) { return x; }).join('\n');

  if (ev.start_time) {
    var parts = ev.start_time.split(':');
    var start = new Date(d.getTime());
    start.setHours(parseInt(parts[0], 10) || 9, parseInt(parts[1], 10) || 0, 0, 0);
    var end = new Date(start.getTime() + 60 * 60 * 1000);
    ev.cal_event_id = timed(cal, ev.cal_event_id, ev.title, start, end, desc, ev.venue);
  } else {
    ev.cal_event_id = allDay(cal, ev.cal_event_id, ev.title, d, desc);
  }
  writeBack('events', ev.id, { cal_event_id: ev.cal_event_id });
  return ev;
}

/** Weekly classes become one recurring event for the term. */
function syncActivityCalendar(act) {
  var cal = calFor('family');
  if (!cal || !act.day_of_week || !act.start_time || !act.term_start) return act;

  deleteCalEvent(cal, act.cal_event_id);

  var days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var idx = days.indexOf(String(act.day_of_week).toLowerCase());
  if (idx < 0) return act;

  var start = parseISO(act.term_start);
  var until = parseISO(act.term_end) || addMonths(start, 4);
  if (!start) return act;
  while (start.getDay() !== idx) start.setDate(start.getDate() + 1);

  var sp = act.start_time.split(':');
  var from = new Date(start.getTime());
  from.setHours(parseInt(sp[0], 10) || 16, parseInt(sp[1], 10) || 0, 0, 0);
  var to = new Date(from.getTime() + 60 * 60 * 1000);
  if (act.end_time) {
    var ep = act.end_time.split(':');
    to = new Date(start.getTime());
    to.setHours(parseInt(ep[0], 10) || 17, parseInt(ep[1], 10) || 0, 0, 0);
  }

  var weekdays = [CalendarApp.Weekday.SUNDAY, CalendarApp.Weekday.MONDAY,
                  CalendarApp.Weekday.TUESDAY, CalendarApp.Weekday.WEDNESDAY,
                  CalendarApp.Weekday.THURSDAY, CalendarApp.Weekday.FRIDAY,
                  CalendarApp.Weekday.SATURDAY];

  var series = cal.createEventSeries(act.title,
    from, to,
    CalendarApp.newRecurrence().addWeeklyRule()
      .onlyOnWeekday(weekdays[idx]).until(until),
    { location: act.venue || '', description: act.note || '' });

  act.cal_event_id = series.getId();
  writeBack('activities', act.id, { cal_event_id: act.cal_event_id });
  return act;
}

function allDay(cal, id, title, date, desc) {
  var ev = getEvent(cal, id);
  if (ev) {
    ev.setTitle(title);
    ev.setAllDayDate(date);
    if (desc) ev.setDescription(desc);
    return id;
  }
  var created = cal.createAllDayEvent(title, date, { description: desc || '' });
  return created.getId();
}

function timed(cal, id, title, start, end, desc, where) {
  var ev = getEvent(cal, id);
  if (ev) {
    ev.setTitle(title);
    ev.setTime(start, end);
    if (desc) ev.setDescription(desc);
    if (where) ev.setLocation(where);
    return id;
  }
  return cal.createEvent(title, start, end,
    { description: desc || '', location: where || '' }).getId();
}

function getEvent(cal, id) {
  if (!cal || !id) return null;
  try { return cal.getEventById(id); } catch (e) { return null; }
}

function deleteCalEvent(cal, id) {
  var ev = getEvent(cal, id);
  if (!ev) return;
  try { ev.deleteEvent(); } catch (e) { /* already gone */ }
}

function writeBack(tab, id, fields) {
  var sh = sheetOf(tab);
  var cols = SCHEMA[tab];
  var r = findRow(sh, id);
  if (r < 0) return;
  Object.keys(fields).forEach(function (k) {
    var c = cols.indexOf(k);
    if (c >= 0) sh.getRange(r, c + 1).setValue(fields[k] || '');
  });
}

// ---------------------------------------------------------------- documents

/**
 * Photograph a letter -> Drive -> Google's OCR pulls the text out ->
 * the Sheet holds the text, so the app can search documents by content.
 */
function uploadDocument(body, who) {
  var folderId = prop('DRIVE_FOLDER');
  if (!folderId) throw new Error('DRIVE_FOLDER is not set.');
  var folder = DriveApp.getFolderById(folderId);

  var bytes = Utilities.base64Decode(body.data);
  var blob = Utilities.newBlob(bytes, body.mime || 'application/octet-stream',
                               body.name || ('scan-' + Date.now()));
  var file = folder.createFile(blob);

  var text = '';
  if (/^image\//.test(body.mime) || body.mime === 'application/pdf') {
    try {
      var doc = Drive.Files.copy(
        { title: file.getName() + ' (ocr)', mimeType: 'application/vnd.google-apps.document' },
        file.getId(), { ocr: true, ocrLanguage: body.lang || 'en' });
      text = DocumentApp.openById(doc.id).getBody().getText();
      Drive.Files.remove(doc.id);
    } catch (e) {
      text = '';  // OCR is a bonus, never a blocker
    }
  }

  return upsert('documents', {
    subject_id: body.subject_id || '',
    obligation_id: body.obligation_id || '',
    title: body.title || file.getName(),
    category: body.category || '',
    drive_file_id: file.getId(),
    drive_url: file.getUrl(),
    mime: body.mime || '',
    ocr_text: text.slice(0, 40000),
    doc_date: body.doc_date || todayISO(),
    expires_on: body.expires_on || '',
    note: body.note || ''
  }, who);
}

// ---------------------------------------------------------------- parsing

var PARSE_SYSTEM =
  'You turn one spoken sentence from a UK household organiser into a single JSON record. ' +
  'Reply with JSON only: no prose, no code fences.\n\n' +
  'Fields: type (obligation|event|payment|activity|note), title, subject_hint, provider, ' +
  'category, amount (number, GBP, no symbol), cadence (once|weekly|fortnightly|monthly|' +
  'quarterly|half-yearly|yearly|2-yearly), next_due (YYYY-MM-DD), on_date (YYYY-MM-DD), ' +
  'start_time (HH:MM), day_of_week, venue, notice_days (integer), note, ' +
  'confidence (0-1), review (true when anything was guessed).\n\n' +
  'Omit fields you have no evidence for; never invent a provider or an amount. ' +
  'Resolve relative dates against the supplied date. Assume UK conventions: ' +
  '"the 14th of March" is 14 March, money is pounds. ' +
  'Sensible notice_days when unstated: insurance and mortgage 30, MOT and tax 14, ' +
  'bills 3, appointments 1. Set review true whenever you inferred rather than heard.';

function parseText(text, todayHint) {
  var key = prop('ANTHROPIC_KEY');
  // a real key starts with sk-ant- ; anything else is a placeholder
  if (!key || key.indexOf('sk-ant-') !== 0) {
    throw new Error('Voice parsing is off. Fill in the form instead, or add a ' +
      'real ANTHROPIC_KEY in Script Properties to switch it on.');
  }
  if (!text) throw new Error('Nothing to parse.');

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: prop('PARSE_MODEL') || 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: PARSE_SYSTEM,
      messages: [{
        role: 'user',
        content: 'Today is ' + (todayHint || todayISO()) + '.\n\n' + text
      }]
    })
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Parser returned ' + res.getResponseCode());
  }

  var body = JSON.parse(res.getContentText());
  var out = (body.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('').trim();

  out = out.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(out); }
  catch (e) { throw new Error('Parser did not return usable JSON.'); }
}

// ---------------------------------------------------------------- snapshot

/** Weekly trigger target: a copy you can read in ten years with no app. */
function snapshot() {
  var folderId = prop('DRIVE_FOLDER');
  var root = DriveApp.getFolderById(folderId);
  var backups;
  var it = root.getFoldersByName('Backups');
  backups = it.hasNext() ? it.next() : root.createFolder('Backups');

  var stamp = Utilities.formatDate(new Date(),
    Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var data = pull();
  var file = backups.createFile('hearth-' + stamp + '.json',
    JSON.stringify(data, null, 2), 'application/json');

  // keep a year of weekly snapshots, no more
  var old = backups.getFiles();
  var files = [];
  while (old.hasNext()) files.push(old.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(53).forEach(function (f) { f.setTrashed(true); });

  return { name: file.getName(), url: file.getUrl() };
}

function installWeeklySnapshot() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'snapshot') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('snapshot').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  return 'Weekly snapshot installed.';
}

// ---------------------------------------------------------------- dates

function todayISO() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function parseISO(s) {
  if (!s) return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

function isoOf(d) {
  if (!d) return '';
  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
  var dd = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + mm + '-' + dd;
}
