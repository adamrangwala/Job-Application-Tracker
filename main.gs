/**
 * Job Application Tracker - entry points
 *
 * Everything the user runs is in the "Job Tracker" menu. One time-driven trigger
 * (scheduledSync) does discovery, backfill continuation, thread monitoring, retries
 * and classification. Nothing here sends email or modifies Gmail (gmail.readonly).
 */

const TRIGGER_HANDLERS = ['scheduledSync'];

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Job Tracker')
    .addSubMenu(ui.createMenu('Setup')
      .addItem('Setup / migrate workbook', 'setupWorkbook')
      .addItem('Set LLM API key', 'setApiKey')
      .addItem('Diagnostics and configuration check', 'runDiagnostics')
      .addItem('Test LLM connection', 'testProvider'))
    .addSeparator()
    .addItem('Dry run on a sample (no writes)', 'dryRunSync')
    .addItem('Sync now', 'syncNow')
    .addItem('Process approved reviews and corrections', 'processApprovedReviews')
    .addItem('Reclassify selected message(s)', 'reclassifySelected')
    .addItem('Reconcile application statuses', 'reconcileStatuses')
    .addSeparator()
    .addItem('Queue health', 'showQueueHealth')
    .addItem('Retry waiting work now', 'retryNow')
    .addSubMenu(ui.createMenu('Backfill')
      .addItem('Start / resume backfill', 'startBackfill')
      .addItem('Pause backfill', 'pauseBackfill')
      .addItem('Rescan a date range', 'rescanRange')
      .addItem('Restart backfill from BACKFILL_START', 'restartBackfill'))
    .addSubMenu(ui.createMenu('Schedule')
      .addItem('Install scheduled sync', 'installSyncTrigger')
      .addItem('Remove all tracker triggers', 'removeTrackerTriggers'))
    .addSubMenu(ui.createMenu('Data')
      .addItem('Delete all feedback examples', 'deleteFeedback')
      .addItem('Clear tracker data (backs up first)', 'clearTrackerData'))
    .addToUi();
}

/** Shows a message in the sheet when run from the menu; logs it when run by a trigger. */
function notify_(title, lines) {
  const text = [].concat(lines).join('\n');
  log_('INFO', title + ': ' + text.slice(0, 2000));
  try { SpreadsheetApp.getUi().alert(title, text.slice(0, 3000), SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* no UI in triggers */ }
}

function ask_(title, prompt) {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt(title, prompt, ui.ButtonSet.OK_CANCEL);
  return r.getSelectedButton() === ui.Button.OK ? String(r.getResponseText() || '').trim() : null;
}

function summary_(r) {
  const s = r.stats, l = r.llm || LLM.stats;
  const h = s.health;
  return ['Result: ' + r.result + (r.result === 'partial' ? ' (time budget or retries pending; the next run continues)' : ''),
    'Discovered ' + s.discovered + ', triaged ' + s.triaged + ', classified ' + s.classified + ', written ' + s.written +
      ', skipped ' + s.skipped + ', to review ' + s.reviewed + ', retrying ' + s.retried + ', failed permanently ' + s.dead,
    'Model calls ' + l.calls + ' (errors ' + l.errors + '), tokens in/out ' + l.inputTokens + '/' + l.outputTokens +
      ', est. cost $' + l.costUsd.toFixed(4) + (l.calls ? ', avg latency ' + Math.round(l.latencyMs / l.calls) + ' ms' : '')]
    .concat(h ? ['Queue: ' + h.open + ' waiting' + (h.oldest ? ', oldest from ' + fmtDay_(h.oldest) : '')] : [])
    .concat(s.notes.length ? ['Notes: ' + s.notes.join(' | ')] : []);
}

// ---------------- setup ----------------

function setupWorkbook() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return notify_('Setup', 'A sync is running; try again shortly.');
  try {
    notify_('Setup complete', setupWorkbook_(getSpreadsheet_()).concat(['', 'Next: Setup > Set LLM API key, then Diagnostics, then Dry run.']));
  } finally {
    lock.releaseLock();
  }
}

function setApiKey() {
  const p = LLM.provider();
  const v = ask_('LLM API key', 'Paste your ' + p.label + ' API key (provider set by LLM.PROVIDER in config.gs). It is stored in this script\'s Script Properties and never shown or logged.\nType DELETE to remove the stored key. Leave blank to keep the current key.');
  if (v === null || v === '') return;
  const props = PropertiesService.getScriptProperties();
  if (v === 'DELETE') { props.deleteProperty(p.keyProperty); return notify_('API key', 'Stored ' + p.label + ' key removed.'); }
  if (!p.keyPattern.test(v)) return notify_('API key', 'That does not look like a ' + p.label + ' API key. Nothing was saved.');
  props.setProperty(p.keyProperty, v);
  notify_('API key', 'Saved. Run Setup > Test LLM connection.');
}

function testProvider() {
  LLM.resetStats();
  const res = LLM.run([{ model: llm_().TRIAGE_MODEL, maxTokens: 1000, system: 'Reply with the requested JSON only.',
    user: 'Return {"ok": true}.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }])[0];
  notify_('LLM connection', res.ok && res.json.ok === true
    ? ['OK: ' + res.model + ' answered in ' + res.latencyMs + ' ms', 'Tokens in/out: ' + (res.usage.input + res.usage.cacheRead + res.usage.cacheWrite) + '/' + res.usage.output + ', est. $' + res.costUsd.toFixed(5)]
    : ['FAILED: ' + (res.error ? res.error.category + ' - ' + res.error.message : 'unexpected response')]);
}

// ---------------- sync ----------------

function dryRunSync() {
  const n = ask_('Dry run', 'How many not-yet-processed messages to sample? (default ' + CONFIG.DRY_RUN_DEFAULT_MESSAGES + ')');
  if (n === null) return;
  const range = ask_('Dry run', 'Optional date range YYYY-MM-DD..YYYY-MM-DD (blank = last 7 days)');
  if (range === null) return;
  const m = range.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
  if (range && !m) return notify_('Dry run', 'Date range must look like 2026-03-01..2026-03-31');
  const r = runSync_('dry-run', { limit: Math.max(1, Math.min(200, Number(n) || CONFIG.DRY_RUN_DEFAULT_MESSAGES)), from: m && m[1], to: m && m[2] });
  notify_('Dry run: nothing was written', summary_(r).concat(['', 'Proposed results:'], r.lines.length ? r.lines : ['(no messages found)']));
}

function syncNow() {
  notify_('Sync', summary_(runSync_('sync')));
}

function scheduledSync() {
  runSync_('sync');
}

function processApprovedReviews() {
  const r = processReviews_();
  notify_('Reviews and corrections', ['Reviews processed: ' + r.done + ', corrections recorded as feedback: ' + r.corrections]
    .concat(r.errors.length ? ['Not processed:'].concat(r.errors) : []));
}

/** Selected rows in Email Events, Review Queue or Work Queue -> classified again on the next sync. */
function reclassifySelected() {
  const range = SpreadsheetApp.getActiveRange();
  const sheet = range.getSheet();
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const c = head.indexOf('Gmail Message ID');
  if (c === -1) return notify_('Reclassify', 'Select rows in Email Events, Review Queue or Work Queue first.');
  const ids = sheet.getRange(range.getRow(), c + 1, range.getNumRows(), 1).getValues().map(r => String(r[0])).filter(id => id && !/^legacy/.test(id));
  const n = requeue_(Array.from(new Set(ids)));
  notify_('Reclassify', n + ' message(s) queued. They are classified again (ignoring the cache) on the next sync; run Sync now to do it immediately.');
}

function reconcileStatuses() {
  notify_('Reconcile', reconcile_());
}

function showQueueHealth() {
  const s = loadStore_(getSpreadsheet_());
  const h = queueHealth_(s);
  const st = getState_();
  const b = st.backfill;
  notify_('Queue health', ['Tasks by state: ' + JSON.stringify(h.byState),
    'Waiting: ' + h.open + (h.oldest ? ' (oldest discovered ' + fmtDay_(h.oldest) + ')' : '') + (h.nextRetry ? ', next retry ' + h.nextRetry : ''),
    'Backfill: ' + (!b ? 'not started' : b.completedAt ? 'complete (' + b.completedAt + ')' :
      (b.paused ? 'paused, ' : '') + (b.listingDone ? 'all pages listed, ' + h.backfillOpen + ' message(s) still being processed' : (b.listed || 0) + ' messages listed so far')),
    'Last fully successful sync: ' + (st.lastSuccessAt || 'never')]);
}

function retryNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return notify_('Retry', 'A sync is running; try again shortly.');
  let n = 0;
  try {
    const s = loadStore_(getSpreadsheet_());
    s.queue.rows.forEach(r => { if (r.data['State'] === 'retry') { r.data['Next Attempt At'] = ''; n++; } });
    flushTable_(s.queue, 'Task ID');
  } finally {
    lock.releaseLock();
  }
  notify_('Retry', [n + ' waiting task(s) made eligible now. Permanently failed tasks are in the Review Queue (kind "processing-failed": approve to retry).', ''].concat(summary_(runSync_('sync'))));
}

// ---------------- backfill ----------------

function backfillQuery_(fromDay, toDay) {
  const tz = Dates.userTz();
  return CONFIG.DISCOVERY.BACKFILL_QUERY + ' after:' + epochSec_(Dates.zonedToUtc(fromDay, '00:00', tz).ms) +
    ' before:' + (toDay ? epochSec_(Dates.zonedToUtc(Dates.addDays(toDay, 1), '00:00', tz).ms) : epochSec_(new Date()));
}

function startBackfill() {
  const state = getState_();
  if (!state.backfill) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(CONFIG.DISCOVERY.BACKFILL_START)) return notify_('Backfill', 'Set DISCOVERY.BACKFILL_START in config.gs (YYYY-MM-DD).');
    // Fixed upper bound keeps page tokens stable; newer mail is found by the change history.
    state.backfill = { query: backfillQuery_(CONFIG.DISCOVERY.BACKFILL_START), pageToken: null, listed: 0, startedAt: new Date().toISOString() };
  }
  state.backfill.paused = false;
  saveState_(state);
  ensureTrigger_('scheduledSync', CONFIG.SYNC_EVERY_MINUTES);
  notify_('Backfill started', ['Each run lists more messages and processes queued ones within the time limit; the scheduled sync (every ' +
    CONFIG.SYNC_EVERY_MINUTES + ' min) continues until done. Progress: Queue health and the Sync Log.', ''].concat(summary_(runSync_('sync'))));
}

function pauseBackfill() {
  const state = getState_();
  if (state.backfill) { state.backfill.paused = true; saveState_(state); }
  notify_('Backfill paused', 'No new pages are listed; already-queued messages are still processed. Progress is kept: Start / resume continues.');
}

function rescanRange() {
  const range = ask_('Rescan a date range', 'Range YYYY-MM-DD..YYYY-MM-DD. Messages not seen before are queued; processed ones are skipped (use Reclassify for those).');
  const m = range && range.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
  if (!m) return;
  const state = getState_();
  state.rescan = { query: backfillQuery_(m[1], m[2]), pageToken: null, listed: 0, startedAt: new Date().toISOString() };
  saveState_(state);
  notify_('Rescan', ['Queued for listing.', ''].concat(summary_(runSync_('sync'))));
}

function restartBackfill() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Restart backfill?', 'Lists messages again from ' + CONFIG.DISCOVERY.BACKFILL_START +
      '. Already-processed messages are skipped without new model calls.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const state = getState_();
  state.backfill = null;
  saveState_(state);
  notify_('Backfill reset', 'Now run Backfill > Start / resume backfill.');
}

// ---------------- triggers ----------------

function installSyncTrigger() {
  ensureTrigger_('scheduledSync', CONFIG.SYNC_EVERY_MINUTES);
  notify_('Scheduled sync', 'Installed: every ' + CONFIG.SYNC_EVERY_MINUTES + ' minutes. Installing again does not add a second trigger.');
}

function ensureTrigger_(handler, minutes) {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === handler)) return;
  const b = ScriptApp.newTrigger(handler).timeBased();
  (minutes >= 60 ? b.everyHours(Math.round(minutes / 60)) : b.everyMinutes(minutes)).create();
}

/** Removes only this tracker's triggers (including obsolete v1/v2 ones), never unrelated ones. */
function removeTrackerTriggers() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (TRIGGER_HANDLERS.concat(['scanEmails', 'continueBackfill']).indexOf(t.getHandlerFunction()) !== -1) { ScriptApp.deleteTrigger(t); n++; }
  });
  notify_('Triggers removed', n + ' trigger(s) removed. Your data is unchanged.');
}

// ---------------- data ----------------

function deleteFeedback() {
  if (ask_('Delete all feedback examples', 'This permanently deletes every row in "' + CONFIG.TABS.FEEDBACK + '" (no backup). Type DELETE to confirm.') !== 'DELETE') return;
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.TABS.FEEDBACK);
  if (sheet && sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
  notify_('Feedback', 'All feedback examples deleted.');
}

function clearTrackerData() {
  if (ask_('Clear tracker data', 'Copies Applications, Email Events, Review Queue, Work Queue and Sync Log to backup tabs, then empties them and resets sync progress. Feedback examples are kept. Type CLEAR to confirm.') !== 'CLEAR') return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return notify_('Clear', 'A sync is running; try again shortly.');
  try {
    const ss = getSpreadsheet_();
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
    [CONFIG.TABS.APPS, CONFIG.TABS.EVENTS, CONFIG.TABS.REVIEW, CONFIG.TABS.QUEUE, CONFIG.TABS.LOG].forEach(name => {
      const sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() < 2) return;
      sh.copyTo(ss).setName('Backup ' + name + ' ' + stamp);
      sh.deleteRows(2, sh.getLastRow() - 1);
    });
    PropertiesService.getScriptProperties().deleteProperty(STATE_KEY);
  } finally {
    lock.releaseLock();
  }
  notify_('Clear', 'Data cleared; backups are in the "Backup …" tabs.');
}

// ---------------- simple trigger ----------------

/** A manual status override takes effect as soon as it is edited, and is recorded as feedback. */
function onEdit(e) {
  const sheet = e && e.range && e.range.getSheet();
  if (!sheet || sheet.getName() !== CONFIG.TABS.APPS) return;
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = h => head.indexOf(h) + 1;
  const oc = col('Manual Status Override'), ac = col('Auto Status'), cc = col('Current Status'), sc = col('Status Source');
  const r = e.range;
  if (!oc || !ac || !cc || !sc || oc < r.getColumn() || oc > r.getLastColumn()) return;
  const fb = e.source && e.source.getSheetByName(CONFIG.TABS.FEEDBACK);
  for (let row = Math.max(2, r.getRow()); row <= r.getLastRow(); row++) {
    const a = { 'Manual Status Override': sheet.getRange(row, oc).getValue(), 'Auto Status': sheet.getRange(row, ac).getValue(),
      'Status Source': sheet.getRange(row, sc).getValue() };
    refreshEffectiveStatus_(a);
    sheet.getRange(row, cc).setValue(a['Current Status']);
    sheet.getRange(row, sc).setValue(a['Status Source']);
    if (fb && a['Manual Status Override']) {
      const id = sheet.getRange(row, col('Application ID')).getValue();
      // Status overrides are kept for audit but not used as prompt examples (they carry no email text).
      const values = { 'Feedback ID': 'FB-override-' + id + '-' + Date.now(), 'Created At': new Date(), 'Correction Type': 'status_override',
        'Original Prediction': JSON.stringify({ status: a['Auto Status'] }), 'Corrected Value': JSON.stringify({ status: a['Manual Status Override'] }),
        'Excerpt': cell_('Application ' + id), 'Review Outcome': 'manual override', 'Use As Example': 'No' };
      const fbHead = fb.getRange(1, 1, 1, fb.getLastColumn()).getValues()[0];
      fb.appendRow(fbHead.map(h => (h in values ? values[h] : '')));
    }
  }
}

// ---------------- diagnostics (read-only) ----------------

function runDiagnostics() {
  notify_('Diagnostics', diagnostics_());
}

function diagnostics_() {
  const out = [];
  const check = (label, fn) => {
    try { const v = fn(); out.push((String(v).indexOf('WARN') === 0 ? '' : 'OK   ') + label + (v ? ': ' + v : '')); }
    catch (e) { out.push('FAIL ' + label + ': ' + e.message); }
  };
  let ss, store;
  check('Spreadsheet', () => { ss = getSpreadsheet_(); return ss.getName(); });
  check('Time zones', () => {
    const script = Session.getScriptTimeZone(), sheet = ss.getSpreadsheetTimeZone(), user = Dates.userTz();
    if (CONFIG.USER_TIMEZONE && !Dates.isIana(CONFIG.USER_TIMEZONE)) throw new Error('USER_TIMEZONE must be an IANA name like Asia/Kolkata');
    // Compare offsets, not names: Asia/Calcutta and Asia/Kolkata are the same zone.
    const now = Date.now(), off = tz => Dates.offsetMinutes(now, tz) + '|' + Dates.offsetMinutes(now + 182 * 864e5, tz);
    const same = off(script) === off(sheet) && off(sheet) === off(user);
    return (same ? '' : 'WARN ') + 'script ' + script + ', sheet ' + sheet + ', user ' + user + (same ? '' : ' - set them to the same zone so dates display correctly');
  });
  check('Configuration', () => {
    const errs = [];
    if (!LLM_PROVIDERS[CONFIG.LLM.PROVIDER] || !CONFIG.LLM.PROFILES[CONFIG.LLM.PROVIDER]) throw new Error('LLM.PROVIDER must be groq or anthropic');
    if ((CONFIG.LLM.PROVIDER === 'groq' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max']).indexOf(llm_().EFFORT) === -1) errs.push('EFFORT in the ' + CONFIG.LLM.PROVIDER + ' profile');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(CONFIG.DISCOVERY.BACKFILL_START)) errs.push('DISCOVERY.BACKFILL_START');
    if (['', 'DMY', 'MDY'].indexOf(CONFIG.NUMERIC_DATE_ORDER) === -1) errs.push('NUMERIC_DATE_ORDER');
    if (!(CONFIG.SYNC_EVERY_MINUTES % 60 === 0 || [1, 5, 10, 15, 30].indexOf(CONFIG.SYNC_EVERY_MINUTES) !== -1)) errs.push('SYNC_EVERY_MINUTES');
    [llm_().MODEL, llm_().TRIAGE_MODEL].forEach(m => { if (!CONFIG.LLM.PRICES[m]) errs.push('no price for ' + m + ' (cost estimates will be 0)'); });
    if (errs.length) throw new Error('check ' + errs.join(', '));
    return CONFIG.LLM.PROVIDER + ': model ' + llm_().MODEL + ', triage ' + llm_().TRIAGE_MODEL + ', effort ' + llm_().EFFORT + ', prompt ' + PROMPT_VERSION;
  });
  check('LLM API key', () => { if (!LLM.hasKey()) throw new Error(LLM.provider().label + ' key not set: Setup > Set LLM API key'); return LLM.provider().label + ' key stored in Script Properties'; });
  TAB_SPECS().forEach(([name, headers]) => check('Tab "' + name + '"', () => loadTable_(ss, name, headers).rows.length + ' rows'));
  check('Tabs and columns', () => { store = loadStore_(ss); return store.apps.rows.length + ' applications, ' + store.events.rows.length + ' events, ' + store.reviews.rows.length + ' reviews, ' + store.feedback.rows.length + ' feedback examples'; });
  check('Advanced Gmail service', () => {
    if (typeof Gmail === 'undefined') throw new Error('not enabled: check appsscript.json / Services > Gmail API');
    return 'mailbox has ~' + Gmail.Users.getProfile('me').messagesTotal + ' messages';
  });
  check('Backfill query', () => '~' + (Gmail.Users.Messages.list('me', { q: CONFIG.DISCOVERY.BACKFILL_QUERY + ' newer_than:30d', maxResults: 1 }).resultSizeEstimate || 0) + ' messages in the last 30 days would be triaged');
  check('One active event per message', () => {
    if (!store) return 'skipped';
    const seen = new Set(), dup = [];
    store.events.rows.forEach(r => {
      if (INACTIVE_EVENT_STATES.indexOf(r.data['Processing State']) !== -1) return;
      const id = String(r.data['Gmail Message ID']);
      if (seen.has(id)) dup.push(id);
      seen.add(id);
    });
    if (dup.length) throw new Error(dup.length + ' duplicates, e.g. ' + dup[0]);
    return 'yes';
  });
  check('Queue', () => store ? JSON.stringify(queueHealth_(store).byState) : 'skipped');
  check('Triggers', () => ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', ') || 'none installed');
  check('Sync state', () => {
    const st = getState_();
    return 'history ' + (st.history && st.history.historyId ? 'tracking' : 'not started') + '; backfill ' +
      (!st.backfill ? 'not started' : st.backfill.completedAt ? 'complete' : 'in progress') + '; last full success ' + (st.lastSuccessAt || 'never');
  });
  return out;
}
