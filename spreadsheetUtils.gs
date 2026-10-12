/**
 * spreadsheetUtils.gs
 *
 * Workbook schema, non-destructive setup/migration, and a small table helper that
 * reads a tab once and writes back only new rows and changed cells.
 * Columns are always located by header name, never by position.
 */

const SCHEMA = {
  APPS: ['Application ID', 'Company', 'Job Title', 'Normalized Company', 'Normalized Job Title',
    'Application Date', 'Current Status', 'Auto Status', 'Status Source', 'Job URL', 'Location', 'Work Arrangement',
    'Job Source', 'Recruiter Name', 'Recruiter Email', 'Last Activity Date', 'Last Relevant Gmail Thread URL',
    'Interview Date', 'Interview Details', 'Assessment Deadline', 'Assessment Details', 'Next Action', 'Follow-up Date',
    'Resume Version', 'Manual Status Override', 'Review State', 'Confidence', 'Notes', 'Created At', 'Updated At'],
  EVENTS: ['Event ID', 'Gmail Message ID', 'Gmail Thread ID', 'Gmail Thread URL', 'Email Timestamp', 'Direction',
    'Sender', 'Subject', 'Event Type', 'Event Qualifier', 'Application ID', 'Extracted Company', 'Extracted Job Title',
    'Event Dates', 'Evidence', 'Classification Reason', 'Confidence', 'Model', 'Prompt Version', 'Content Hash',
    'Classification JSON', 'Processing State', 'Processed At', 'Corrected Event Type', 'Corrected Application ID'],
  REVIEW: ['Review ID', 'Kind', 'Gmail Message ID', 'Gmail Thread ID', 'Gmail Thread URL', 'Date', 'Sender', 'Subject',
    'Proposed Company', 'Proposed Job Title', 'Proposed Event Type', 'Proposed Dates', 'Proposed Application ID',
    'Evidence', 'Uncertainty', 'Confidence', 'Review Reason', 'Review Status', 'Corrected Company', 'Corrected Job Title',
    'Corrected Event Type', 'Corrected Application ID', 'Corrected Date', 'Reviewer Notes', 'Reviewed At'],
  QUEUE: ['Task ID', 'Gmail Message ID', 'Gmail Thread ID', 'Email Date', 'Source', 'Stage', 'State', 'Attempts', 'Last Attempt At',
    'Next Attempt At', 'Error Category', 'Error Summary', 'Needs Manual', 'Discovered At', 'Completed At', 'Outcome', 'Force'],
  FEEDBACK: ['Feedback ID', 'Created At', 'Gmail Message ID', 'Correction Type', 'Original Prediction', 'Corrected Value',
    'Excerpt', 'Model', 'Prompt Version', 'Review Outcome', 'Use As Example'],
  LOG: ['Run ID', 'Mode', 'Started At', 'Finished At', 'Result', 'Discovered', 'Triaged', 'Classified', 'Written',
    'Skipped', 'Retried', 'Failed', 'Dead', 'Sent to Review', 'Model Calls', 'Input Tokens', 'Output Tokens',
    'Est. Cost USD', 'Avg Latency ms', 'Queue Pending', 'Oldest Pending', 'Notes']
};

// Columns the user may edit (green headers). Sync only fills these when blank,
// except Interview Date / Assessment Deadline from a newer confirmed email (see README).
const USER_COLUMNS = {
  APPS: ['Company', 'Job Title', 'Application Date', 'Job URL', 'Location', 'Work Arrangement', 'Recruiter Name',
    'Recruiter Email', 'Interview Date', 'Assessment Deadline', 'Next Action', 'Follow-up Date', 'Resume Version',
    'Manual Status Override', 'Notes'],
  EVENTS: ['Corrected Event Type', 'Corrected Application ID'],
  REVIEW: ['Review Status', 'Corrected Company', 'Corrected Job Title', 'Corrected Event Type', 'Corrected Application ID',
    'Corrected Date', 'Reviewer Notes'],
  QUEUE: [],
  FEEDBACK: ['Use As Example'],
  LOG: []
};

const REVIEW_STATUSES = ['Pending', 'Approved', 'Ignored', 'Done'];
const LEGACY_STATUS_EVENT = { 'Applied': 'APPLICATION_CONFIRMATION', 'Status Update': 'APPLICATION_CONFIRMATION',
  'Assessment': 'ASSESSMENT_INVITATION', 'Interview Request': 'INTERVIEW_INVITATION', 'Offer Received': 'OFFER_RECEIVED',
  'Rejected': 'REJECTION_RECEIVED' };

/** Makes untrusted text safe to store: no formula execution, bounded length. */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date || typeof v === 'number' || typeof v === 'boolean') return v;
  let s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 5000);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function same_(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const t = v => v instanceof Date ? v.getTime() : (v === '' || v === null || v === undefined ? '' : new Date(v).getTime());
    return t(a) === t(b);
  }
  return String(a === null || a === undefined ? '' : a) === String(b === null || b === undefined ? '' : b);
}

function threadUrl_(threadId) {
  return threadId && !/^legacy/.test(threadId) ? 'https://mail.google.com/mail/#all/' + threadId : '';
}

/** Reads a whole tab once. Rows whose cells are all blank are skipped. */
function loadTable_(ss, tabName, headers) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('Missing tab "' + tabName + '". Run Job Tracker > Setup / migrate workbook.');
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  const values = lastRow && lastCol ? withRetry_(() => sheet.getRange(1, 1, lastRow, lastCol).getValues(), 'read ' + tabName) : [[]];
  const col = {};
  values[0].forEach((h, i) => { if (h !== '' && !(h in col)) col[String(h)] = i; });
  const missing = headers.filter(h => !(h in col));
  if (missing.length) throw new Error('Tab "' + tabName + '" is missing columns: ' + missing.join(', ') + '. Run Job Tracker > Setup / migrate workbook.');
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    if (values[r].every(v => v === '' || v === null)) continue;
    const data = {};
    headers.forEach(h => { data[h] = values[r][col[h]]; });
    rows.push({ row: r + 1, data: data, orig: Object.assign({}, data) });
  }
  return { sheet: sheet, name: tabName, headers: headers, col: col, rows: rows, added: [] };
}

/** Keeps one blank row at the bottom and grows the sheet inside any existing filter range. */
function ensureRows_(sheet, lastNeededRow) {
  const max = sheet.getMaxRows();
  if (lastNeededRow >= max) sheet.insertRowsBefore(max, lastNeededRow - max + 500);
}

/**
 * Writes changed cells of existing rows, then appends new rows in one call.
 * Rows are re-located by key before writing, in case the user sorted the tab mid-run.
 */
function flushTable_(t, keyHeader) {
  const changed = t.rows.filter(r => t.headers.some(h => !same_(r.data[h], r.orig[h])));
  if (changed.length) {
    const keyCol = t.col[keyHeader] + 1;
    const n = t.sheet.getLastRow() - 1;
    const keys = n > 0 ? t.sheet.getRange(2, keyCol, n, 1).getValues().map(r => String(r[0])) : [];
    for (const r of changed) {
      const key = String(r.orig[keyHeader]);
      let rowNum = r.row;
      if (keys[rowNum - 2] !== key) {
        const i = key ? keys.indexOf(key) : -1;
        if (i === -1) { log_('WARN', t.name + ': row "' + (key || r.data[keyHeader]) + '" moved during the run; skipped, retried next run'); continue; }
        rowNum = i + 2;
      }
      const cols = t.headers.filter(h => !same_(r.data[h], r.orig[h])).map(h => t.col[h]).sort((a, b) => a - b);
      // Contiguous runs of changed columns only, so user edits elsewhere in the row are untouched.
      for (let i = 0; i < cols.length;) {
        let j = i;
        while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
        const vals = [];
        for (let c = cols[i]; c <= cols[j]; c++) vals.push(cell_(r.data[t.headers.find(x => t.col[x] === c)]));
        withRetry_(() => t.sheet.getRange(rowNum, cols[i] + 1, 1, vals.length).setValues([vals]), 'write ' + t.name);
        i = j + 1;
      }
      r.row = rowNum;
      r.orig = Object.assign({}, r.data);
    }
  }
  if (t.added.length) {
    const width = t.sheet.getLastColumn();
    const start = t.sheet.getLastRow() + 1;
    const matrix = t.added.map(d => {
      const row = new Array(width).fill('');
      t.headers.forEach(h => { row[t.col[h]] = cell_(d[h]); });
      return row;
    });
    ensureRows_(t.sheet, start + matrix.length - 1);
    withRetry_(() => t.sheet.getRange(start, 1, matrix.length, width).setValues(matrix), 'append ' + t.name);
    t.added.forEach((d, i) => t.rows.push({ row: start + i, data: d, orig: Object.assign({}, d) }));
    t.added = [];
  }
}

function addRow_(t, data) {
  const d = {};
  t.headers.forEach(h => { d[h] = data[h] === undefined ? '' : data[h]; });
  t.added.push(d);
  return d;
}

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
}

// ------------------------------------------------------------------
// Setup and migration
// ------------------------------------------------------------------

const TAB_SPECS = () => [
  [CONFIG.TABS.APPS, SCHEMA.APPS, USER_COLUMNS.APPS],
  [CONFIG.TABS.EVENTS, SCHEMA.EVENTS, USER_COLUMNS.EVENTS],
  [CONFIG.TABS.REVIEW, SCHEMA.REVIEW, USER_COLUMNS.REVIEW],
  [CONFIG.TABS.QUEUE, SCHEMA.QUEUE, USER_COLUMNS.QUEUE],
  [CONFIG.TABS.FEEDBACK, SCHEMA.FEEDBACK, USER_COLUMNS.FEEDBACK],
  [CONFIG.TABS.LOG, SCHEMA.LOG, USER_COLUMNS.LOG]
];

/**
 * Safe to run any number of times. Never clears or deletes a populated tab:
 *  - creates missing tabs,
 *  - appends missing columns (after copying the tab to a backup tab),
 *  - renames a v1 "Applications" tab (kept intact) and imports its rows,
 *  - refuses to touch a tab whose header row it does not recognise.
 * Returns human-readable report lines.
 */
function setupWorkbook_(ss) {
  const report = [];
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  let legacy = null;

  const apps = ss.getSheetByName(CONFIG.TABS.APPS);
  if (apps && apps.getLastRow() > 0) {
    const head = apps.getRange(1, 1, 1, Math.max(1, apps.getLastColumn())).getValues()[0].map(String);
    if (head.indexOf('Application ID') === -1 && head.indexOf('Job Title') !== -1 && head.indexOf('Company') !== -1) {
      legacy = apps.setName('Legacy Applications ' + stamp);
      report.push('Found a v1 "Applications" tab: renamed it to "' + legacy.getName() + '" (contents unchanged).');
    }
  }
  report.push(ss.getSheetByName(CONFIG.TABS.EVENTS) || legacy ? 'Mode: migration of an existing workbook.' : 'Mode: fresh setup.');

  for (const [name, headers, editable] of TAB_SPECS()) {
    formatDataTab_(ensureTab_(ss, name, headers, stamp, report), headers, editable);
  }
  if (legacy) report.push(importLegacy_(ss, legacy));

  buildDashboard_(ss);
  report.push('Dashboard tab built.');

  ScriptApp.getProjectTriggers().forEach(t => {
    if (['scanEmails', 'continueBackfill'].indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      report.push('Removed obsolete trigger "' + t.getHandlerFunction() + '".');
    }
  });
  return report;
}

function ensureTab_(ss, name, headers, stamp, report) {
  let sheet = ss.getSheetByName(name);
  const widen = (s, n) => { if (s.getMaxColumns() < n) s.insertColumnsAfter(s.getMaxColumns(), n - s.getMaxColumns()); };
  if (!sheet || sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    if (!sheet) sheet = ss.insertSheet(name);
    widen(sheet, headers.length);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    report.push('Created tab "' + name + '".');
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  const head = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  if (head.indexOf(headers[0]) === -1) {
    throw new Error('Tab "' + name + '" exists but its first row is not a tracker header row. Rename that tab (nothing was changed) and run setup again.');
  }
  const missing = headers.filter(h => head.indexOf(h) === -1);
  if (missing.length) {
    if (sheet.getLastRow() > 1) {
      const backup = sheet.copyTo(ss).setName('Backup ' + name + ' ' + stamp);
      report.push('Backed up "' + name + '" to "' + backup.getName() + '".');
    }
    widen(sheet, lastCol + missing.length);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    report.push('Added columns to "' + name + '": ' + missing.join(', ') + '.');
  } else {
    report.push('Tab "' + name + '" is up to date.');
  }
  return sheet;
}

/**
 * Imports v1 rows. Exact company+title duplicates are merged. Each imported application gets one
 * synthetic "migrated" event carrying its v1 status and date, so status derivation keeps that
 * status until newer evidence arrives, and its v1 thread is monitored for replies.
 */
function importLegacy_(ss, legacySheet) {
  const values = legacySheet.getDataRange().getValues();
  const head = values[0].map(String);
  const idx = h => head.indexOf(h);
  const clean = v => /^(unlisted( position)?|unknown company)$/i.test(String(v).trim()) ? '' : String(v || '').trim();
  const appsT = loadTable_(ss, CONFIG.TABS.APPS, SCHEMA.APPS);
  const eventsT = loadTable_(ss, CONFIG.TABS.EVENTS, SCHEMA.EVENTS);
  const known = new Set(eventsT.rows.map(r => String(r.data['Gmail Message ID'])));
  const byKey = {};
  const now = new Date();
  let imported = 0, merged = 0;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const company = clean(row[idx('Company')]), title = clean(row[idx('Job Title')]);
    const submitted = row[idx('Date Submitted')] instanceof Date ? row[idx('Date Submitted')] : '';
    const updated = row[idx('Date Updated')] instanceof Date ? row[idx('Date Updated')] : (submitted || '');
    const legacyStatus = String(row[idx('Status')] || '');
    const threadId = idx('ThreadId') !== -1 ? String(row[idx('ThreadId')] || '') : '';
    if (!company && !title && !threadId) continue;
    if (threadId && known.has('legacy:' + threadId)) continue;   // already imported by an earlier setup

    const key = company && title ? Extract.normalizeCompany(company) + '|' + Extract.normalizeTitle(title) : null;
    let app = key && byKey[key];
    if (app) {
      merged++;
      if (submitted && (!app['Application Date'] || submitted < app['Application Date'])) app['Application Date'] = submitted;
    } else {
      app = addRow_(appsT, {
        'Application ID': newId_('APP-'), 'Company': company, 'Job Title': title,
        'Normalized Company': Extract.normalizeCompany(company), 'Normalized Job Title': Extract.normalizeTitle(title),
        'Application Date': submitted, 'Status Source': 'legacy', 'Last Activity Date': updated,
        'Last Relevant Gmail Thread URL': threadUrl_(threadId), 'Created At': now, 'Updated At': now
      });
      if (key) byKey[key] = app;
      imported++;
    }
    const msgId = 'legacy:' + (threadId || app['Application ID'] + ':' + r);
    known.add(msgId);
    addRow_(eventsT, {
      'Event ID': 'EVT-' + msgId, 'Gmail Message ID': msgId, 'Gmail Thread ID': threadId || '',
      'Gmail Thread URL': threadUrl_(threadId), 'Email Timestamp': updated, 'Direction': 'received',
      'Event Type': LEGACY_STATUS_EVENT[legacyStatus] || 'OTHER_RELEVANT', 'Event Qualifier': 'actual',
      'Application ID': app['Application ID'], 'Classification Reason': 'Imported from v1 tracker (v1 status "' + legacyStatus + '")',
      'Processing State': 'migrated', 'Processed At': now
    });
  }
  // Derive the imported applications' statuses from their synthetic events.
  const evs = eventsT.added.concat(eventsT.rows.map(x => x.data));
  appsT.added.forEach(a => {
    const d = Status.derive(evs.filter(e => e['Application ID'] === a['Application ID']).map(eventForDerive_));
    a['Auto Status'] = d.status || '';
    a['Current Status'] = d.status || '';
  });
  flushTable_(appsT, 'Application ID');
  flushTable_(eventsT, 'Gmail Message ID');
  return 'Imported ' + imported + ' application(s) from the v1 tab' + (merged ? ', merging ' + merged + ' exact duplicate row(s)' : '') + '.';
}

/** Email Events row -> input for Status.derive. */
function eventForDerive_(e) {
  const corrected = String(e['Corrected Event Type'] || '');
  return { id: e['Event ID'], type: corrected || e['Event Type'], qualifier: e['Event Qualifier'] || 'actual',
    direction: e['Direction'], at: e['Email Timestamp'] instanceof Date ? e['Email Timestamp'].getTime() : (Number(new Date(e['Email Timestamp'])) || 0),
    confirmed: e['Processing State'] === 'confirmed' || !!corrected };
}

/** Idempotent formatting. Conditional-format rules are only added to a tab that has none. */
function formatDataTab_(sheet, headers, editable) {
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const colOf = h => head.indexOf(h) + 1;
  const letter = h => columnLetter_(colOf(h));
  const rows = sheet.getMaxRows() - 1;

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#e0e0e0').setWrap(true);
  editable.forEach(h => {
    if (colOf(h)) sheet.getRange(1, colOf(h)).setBackground('#d9ead3').setNote('Editable: your value is kept (see README).');
  });
  if (!sheet.getFilter()) sheet.getRange(1, 1, sheet.getMaxRows(), head.length).createFilter();

  headers.forEach(h => {
    const c = colOf(h);
    if (!c) return;
    const range = sheet.getRange(2, c, rows, 1);
    if (/^(Application Date|Last Activity Date|Follow-up Date|Date)$/.test(h)) range.setNumberFormat('yyyy-mm-dd');
    else if (/(At|Timestamp)$|^(Interview Date|Assessment Deadline)$/.test(h)) range.setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.setColumnWidth(c, /Subject|Reason|Notes|URL|Next Action|Evidence|Details|Dates|Uncertainty|Prediction|Value|Excerpt|JSON/.test(h) ? 240 : /ID$/.test(h) ? 140 : 130);
  });

  const list = (h, values) => {
    if (!colOf(h)) return;
    sheet.getRange(2, colOf(h), rows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build());
  };
  list('Manual Status Override', STATUSES);
  list('Review Status', REVIEW_STATUSES);
  list('Corrected Event Type', EVENT_TYPES);
  list('Use As Example', ['Yes', 'No']);

  if (sheet.getConditionalFormatRules().length === 0 && colOf('Current Status')) {
    const all = sheet.getRange(2, 1, rows, head.length);
    const st = '$' + letter('Current Status') + '2';
    const open = 'NOT(OR(' + st + '="Rejected",' + st + '="Withdrawn"))';
    const rule = (formula, color) => SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setBackground(color).setRanges([all]).build();
    const fu = '$' + letter('Follow-up Date') + '2', iv = '$' + letter('Interview Date') + '2', as = '$' + letter('Assessment Deadline') + '2';
    const rs = '$' + letter('Review State') + '2';
    sheet.setConditionalFormatRules([
      rule('=AND(ISNUMBER(' + fu + '),' + fu + '<TODAY(),' + open + ')', '#f4cccc'),
      rule('=AND(ISNUMBER(' + as + '),' + as + '>=NOW(),' + as + '<=NOW()+3,' + open + ')', '#fce5cd'),
      rule('=AND(ISNUMBER(' + iv + '),' + iv + '>=NOW(),' + iv + '<=NOW()+7,' + open + ')', '#cfe2f3'),
      rule('=AND(ISNUMBER(' + fu + '),' + fu + '>=TODAY(),' + fu + '<=TODAY()+' + CONFIG.FOLLOW_UP_SOON_DAYS + ',' + open + ')', '#fff2cc'),
      rule('=' + rs + '<>""', '#ead1dc'),
      rule('=' + st + '="Offer"', '#d9ead3'),
      rule('=NOT(' + open + ')', '#efefef')
    ]);
  }
}

function columnLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
