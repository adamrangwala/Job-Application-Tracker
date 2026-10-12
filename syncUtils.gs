/**
 * syncUtils.gs
 *
 * Discovery -> durable work queue -> triage -> classification -> persistence.
 *
 * Discovery only records message IDs in the Work Queue (cheap, checkpointed):
 *   history    Gmail change history since the last sync: every new message, sent or received,
 *              whatever its wording (falls back to a date-window search if the history expired)
 *   backfill   paginated search over a date range, resumable via a saved page token
 *   monitor    rotating re-check of threads linked to applications, to catch replies
 * Processing drains the queue within the execution time budget:
 *   triage     batched LLM relevance check on subject/sender/snippet (skipped for known threads)
 *   classify   full LLM interpretation with thread context, then code-side validation,
 *              matching and status derivation
 * Every task keeps its attempts, next retry time and last error; exhausted or permanent
 * failures become "dead" and get a Review Queue row. A task is marked done only after
 * its effects are written, so an interrupted run is simply resumed next time.
 * Write order per batch: Applications -> Review Queue -> Email Events -> Feedback -> Work Queue.
 */

const STATE_KEY = 'TRACKER_STATE_V3';

function log_(level, msg) {
  const order = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  if (order[level] >= order[CONFIG.LOG_LEVEL]) console.log('[' + level + '] ' + msg);
}

function isTransient_(e) {
  return /rate limit|too many|backend error|internal error|service unavailable|timed? ?out|try again|\b(429|500|502|503)\b|temporarily|unavailable|service spreadsheets failed|service .* failed while accessing/i.test(String(e && e.message || e));
}

function withRetry_(fn, what) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 2 || !isTransient_(e)) throw e;
      log_('WARN', what + ' failed (' + e.message + '), retrying');
      Utilities.sleep(1000 * Math.pow(2, attempt));
    }
  }
}

function getState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  return raw ? JSON.parse(raw) : {};
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function getSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet: this script must be bound to the tracker sheet (Extensions > Apps Script from the sheet).');
  return ss;
}

function epochSec_(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function fmtDay_(d) {
  return d ? Utilities.formatDate(new Date(d), Dates.userTz(), 'yyyy-MM-dd') : '';
}

// ------------------------------------------------------------------
// Gmail access (Advanced Gmail service, gmail.readonly)
// ------------------------------------------------------------------

function decodeBody_(data) {
  if (typeof data !== 'string') return Utilities.newBlob(data).getDataAsString('UTF-8');
  let s = data;
  while (s.length % 4) s += '=';
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8');
}

function headersOf_(m) {
  const h = {};
  ((m.payload && m.payload.headers) || []).forEach(x => { h[String(x.name).toLowerCase()] = x.value; });
  return h;
}

/** Gmail API message resource -> raw email used by Extract.parseEmail. */
function toRawEmail_(m) {
  const h = headersOf_(m);
  let plain = '', html = '';
  (function walk(p) {
    if (!p || p.filename) return;   // attachments are never read
    const type = String(p.mimeType || '').toLowerCase();
    if (p.body && p.body.data) {
      if (type === 'text/plain' && !plain) plain = decodeBody_(p.body.data);
      else if (type === 'text/html' && !html) html = decodeBody_(p.body.data);
    }
    (p.parts || []).forEach(walk);
  })(m.payload);
  return { id: m.id, threadId: m.threadId, internalDate: Number(m.internalDate), from: h.from || '', to: h.to || '',
    subject: h.subject || '', plainBody: plain, htmlBody: html, labelIds: m.labelIds || [], snippet: m.snippet || '' };
}

function gmailErrorCategory_(e) {
  const msg = String(e && e.message || e);
  if (/not found|404/i.test(msg)) return 'permanent';
  return 'transient';   // other Gmail errors are retried, bounded by MAX_ATTEMPTS
}

// ------------------------------------------------------------------
// Store: all tabs loaded once per run
// ------------------------------------------------------------------

function loadStore_(ss) {
  const s = {
    apps: loadTable_(ss, CONFIG.TABS.APPS, SCHEMA.APPS),
    events: loadTable_(ss, CONFIG.TABS.EVENTS, SCHEMA.EVENTS),
    reviews: loadTable_(ss, CONFIG.TABS.REVIEW, SCHEMA.REVIEW),
    queue: loadTable_(ss, CONFIG.TABS.QUEUE, SCHEMA.QUEUE),
    feedback: loadTable_(ss, CONFIG.TABS.FEEDBACK, SCHEMA.FEEDBACK),
    appById: new Map(), activeEvent: new Map(), eventById: new Map(), taskByMsg: new Map(), reviewById: new Map(),
    feedbackIds: new Set(), index: { apps: [], threadApps: new Map() }, touched: new Set(), created: 0
  };
  const now = new Date();
  s.apps.rows.forEach(r => {
    const a = r.data;
    if (!a['Application ID']) { a['Application ID'] = newId_('APP-'); a['Created At'] = now; a['Status Source'] = a['Status Source'] || 'manual'; }
    a['Normalized Company'] = Extract.normalizeCompany(a['Company']);
    a['Normalized Job Title'] = Extract.normalizeTitle(a['Job Title']);
    refreshEffectiveStatus_(a);
    indexApp_(s, a);
  });
  s.events.rows.forEach(r => indexEvent_(s, r.data));
  s.reviews.rows.forEach(r => s.reviewById.set(String(r.data['Review ID']), r.data));
  s.queue.rows.forEach(r => s.taskByMsg.set(String(r.data['Gmail Message ID']), r.data));
  s.feedback.rows.forEach(r => s.feedbackIds.add(String(r.data['Feedback ID'])));
  return s;
}

function indexApp_(s, a) {
  s.appById.set(a['Application ID'], a);
  const fresh = { id: a['Application ID'], company: a['Company'], title: a['Job Title'], normCompany: a['Normalized Company'],
    normTitle: a['Normalized Job Title'], urlKey: Extract.urlKey(a['Job URL']), status: a['Current Status'],
    lastActivity: fmtDay_(a['Last Activity Date']), recruiterEmail: String(a['Recruiter Email'] || '').toLowerCase() };
  const i = s.index.apps.findIndex(x => x.id === fresh.id);
  if (i === -1) s.index.apps.push(fresh); else s.index.apps[i] = fresh;
}

const INACTIVE_EVENT_STATES = ['superseded', 'ignored'];

function indexEvent_(s, e) {
  s.eventById.set(String(e['Event ID']), e);
  if (INACTIVE_EVENT_STATES.indexOf(e['Processing State']) === -1) s.activeEvent.set(String(e['Gmail Message ID']), e);
  const appId = String(e['Corrected Application ID'] || e['Application ID'] || '');
  const tid = String(e['Gmail Thread ID'] || '');
  if (tid && appId && s.appById.has(appId) && INACTIVE_EVENT_STATES.indexOf(e['Processing State']) === -1) {
    if (!s.index.threadApps.has(tid)) s.index.threadApps.set(tid, new Set());
    s.index.threadApps.get(tid).add(appId);
  }
}

function flushStore_(s) {
  flushTable_(s.apps, 'Application ID');
  flushTable_(s.reviews, 'Review ID');
  flushTable_(s.events, 'Event ID');
  flushTable_(s.feedback, 'Feedback ID');
  flushTable_(s.queue, 'Task ID');
}

function refreshEffectiveStatus_(a) {
  const override = String(a['Manual Status Override'] || '').trim();
  if (override) {
    a['Current Status'] = override;
    a['Status Source'] = 'manual';
  } else {
    a['Current Status'] = a['Auto Status'];
    if (a['Status Source'] === 'manual') a['Status Source'] = 'auto';
  }
}

function createApp_(s, company, title) {
  const now = new Date();
  const a = addRow_(s.apps, { 'Application ID': newId_('APP-'), 'Company': company || '', 'Job Title': title || '',
    'Normalized Company': Extract.normalizeCompany(company), 'Normalized Job Title': Extract.normalizeTitle(title),
    'Status Source': 'auto', 'Created At': now, 'Updated At': now });
  s.created++;
  indexApp_(s, a);
  return a;
}

/** Re-derives an application's status from its active events; queues conflicts for review. */
function recomputeApp_(s, appId) {
  const a = s.appById.get(appId);
  if (!a) return;
  const evs = [];
  s.activeEvent.forEach(e => {
    if (String(e['Corrected Application ID'] || e['Application ID']) === appId && ['applied', 'linked', 'confirmed', 'migrated'].indexOf(e['Processing State']) !== -1) evs.push(e);
  });
  const d = Status.derive(evs.map(eventForDerive_));
  const before = [a['Auto Status'], a['Current Status'], a['Review State']].join('|');
  if (d.status && (a['Auto Status'] !== d.status)) {
    a['Auto Status'] = d.status;
    if (a['Status Source'] !== 'legacy' || evs.some(e => e['Processing State'] !== 'migrated')) a['Status Source'] = 'auto';
  }
  d.conflicts.forEach(c => {
    const ev = s.eventById.get(c.eventId);
    queueReview_(s, 'REV-C-' + c.eventId, {
      'Kind': 'conflict', 'Gmail Message ID': ev ? ev['Gmail Message ID'] : '', 'Gmail Thread ID': ev ? ev['Gmail Thread ID'] : '',
      'Date': ev ? ev['Email Timestamp'] : '', 'Subject': ev ? ev['Subject'] : '', 'Proposed Event Type': ev ? ev['Event Type'] : '',
      'Proposed Application ID': appId, 'Review Reason': c.reason + ' - status kept as ' + d.status + '. Approve to apply this event anyway.'
    });
  });
  refreshEffectiveStatus_(a);
  const pending = s.reviews.rows.map(r => r.data).concat(s.reviews.added)
    .filter(r => r['Review Status'] === 'Pending' && String(r['Proposed Application ID']) === appId).length;
  a['Review State'] = pending ? pending + ' pending review(s)' : '';
  if ([a['Auto Status'], a['Current Status'], a['Review State']].join('|') !== before) a['Updated At'] = new Date();
  indexApp_(s, a);
}

function queueReview_(s, reviewId, fields) {
  if (s.reviewById.has(reviewId)) return null;
  const r = addRow_(s.reviews, Object.assign({ 'Review ID': reviewId, 'Review Status': 'Pending',
    'Gmail Thread URL': threadUrl_(fields['Gmail Thread ID']) }, fields));
  s.reviewById.set(reviewId, r);
  return r;
}

// ------------------------------------------------------------------
// Work queue
// ------------------------------------------------------------------

function enqueue_(s, msgId, threadId, source, stats) {
  msgId = String(msgId);
  if (s.taskByMsg.has(msgId) || s.activeEvent.has(msgId)) return false;
  const known = s.index.threadApps.has(String(threadId));
  const t = addRow_(s.queue, { 'Task ID': 'T-' + msgId, 'Gmail Message ID': msgId, 'Gmail Thread ID': threadId || '',
    'Source': source, 'Stage': known ? 'classify' : 'triage', 'State': 'pending', 'Attempts': 0, 'Discovered At': new Date() });
  s.taskByMsg.set(msgId, t);
  stats.discovered++;
  return true;
}

function eligible_(t, stage, now) {
  return t['Stage'] === stage && (t['State'] === 'pending' || t['State'] === 'retry') &&
    (!(t['Next Attempt At'] instanceof Date) || t['Next Attempt At'].getTime() <= now);
}

function tasksFor_(s, stage, n) {
  const now = Date.now();
  const all = s.queue.rows.map(r => r.data).concat(s.queue.added);
  // Oldest email first, so a confirmation creates its application before later replies are matched.
  const when = t => t['Email Date'] instanceof Date ? t['Email Date'].getTime() : new Date(t['Discovered At']).getTime();
  return all.filter(t => eligible_(t, stage, now)).sort((a, b) => when(a) - when(b)).slice(0, n);
}

function completeTask_(t, outcome) {
  t['State'] = 'done';
  t['Outcome'] = String(outcome).slice(0, 300);
  t['Completed At'] = new Date();
  t['Error Category'] = '';
  t['Next Attempt At'] = '';
  t['Force'] = '';
}

/**
 * Records a failure. Returns 'stop' when the provider is unusable (bad key/model) so the
 * run ends without burning attempts on every task.
 */
function failTask_(s, t, category, message, retryAfterSec, stats) {
  t['Last Attempt At'] = new Date();
  t['Error Category'] = category;
  t['Error Summary'] = String(message).slice(0, 300);
  if (category === 'config') {
    t['State'] = 'retry';
    t['Next Attempt At'] = new Date(Date.now() + 15 * 60000);
    return 'stop';
  }
  t['Attempts'] = Number(t['Attempts'] || 0) + 1;
  if (category === 'permanent' || category === 'refusal' || t['Attempts'] >= CONFIG.QUEUE.MAX_ATTEMPTS) {
    t['State'] = 'dead';
    t['Needs Manual'] = 'Yes';
    stats.dead++;
    queueReview_(s, 'REV-F-' + t['Gmail Message ID'], { 'Kind': 'processing-failed', 'Gmail Message ID': t['Gmail Message ID'],
      'Gmail Thread ID': t['Gmail Thread ID'], 'Review Reason': 'Processing failed (' + category + ', ' + t['Attempts'] +
      ' attempt(s)): ' + t['Error Summary'] + '. Approve to retry, Ignore to drop.' });
    return 'dead';
  }
  const minutes = CONFIG.QUEUE.BACKOFF_MINUTES[Math.min(t['Attempts'], CONFIG.QUEUE.BACKOFF_MINUTES.length) - 1];
  t['State'] = 'retry';
  t['Next Attempt At'] = new Date(Date.now() + Math.max(minutes * 60000, (retryAfterSec || 0) * 1000));
  stats.retried++;
  return 'retry';
}

// ------------------------------------------------------------------
// Discovery
// ------------------------------------------------------------------

function myAddress_(state) {
  if (!state.myAddress) state.myAddress = withRetry_(() => Gmail.Users.getProfile('me'), 'Gmail profile').emailAddress;
  return state.myAddress;
}

/** Enqueues every message added since the saved history ID (or a search window if history expired). */
function discoverHistory_(s, state, stats, timeLeft) {
  const h = state.history || (state.history = {});
  if (!h.historyId) {
    // First incremental run: start the change history now, and search the recent window once.
    h.historyId = String(withRetry_(() => Gmail.Users.getProfile('me'), 'Gmail profile').historyId);
    h.fallback = { query: CONFIG.DISCOVERY.BACKFILL_QUERY + ' newer_than:' + Math.max(1, CONFIG.DISCOVERY.FALLBACK_OVERLAP_DAYS) + 'd', pageToken: null };
  }
  if (h.fallback) {
    if (!searchPages_(s, h.fallback, 'history-fallback', stats, timeLeft)) return false;
    delete h.fallback;
  }
  while (timeLeft() > 60000) {
    let page;
    try {
      const args = { startHistoryId: h.historyId, historyTypes: ['messageAdded'], maxResults: 500 };
      if (h.pageToken) args.pageToken = h.pageToken;
      page = withRetry_(() => Gmail.Users.History.list('me', args), 'Gmail history');
    } catch (e) {
      if (!/not found|404/i.test(String(e.message))) throw e;
      // History older than Gmail keeps it: search a window around the last successful sync instead.
      const since = state.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : Date.now() - 7 * 864e5;
      h.historyId = String(withRetry_(() => Gmail.Users.getProfile('me'), 'Gmail profile').historyId);
      h.pageToken = null;
      h.fallback = { query: CONFIG.DISCOVERY.BACKFILL_QUERY + ' after:' + epochSec_(since - CONFIG.DISCOVERY.FALLBACK_OVERLAP_DAYS * 864e5), pageToken: null };
      stats.notes.push('Gmail history expired; searched since the last sync instead');
      return searchPages_(s, h.fallback, 'history-fallback', stats, timeLeft) && (delete h.fallback, true);
    }
    (page.history || []).forEach(rec => (rec.messagesAdded || []).forEach(ma => {
      const m = ma.message || {};
      if ((m.labelIds || []).some(l => CONFIG.DISCOVERY.SKIP_LABELS.indexOf(l) !== -1)) return;
      enqueue_(s, m.id, m.threadId, 'history', stats);
    }));
    if (page.nextPageToken) { h.pageToken = page.nextPageToken; continue; }
    h.historyId = String(page.historyId || h.historyId);
    h.pageToken = null;
    return true;
  }
  return false;
}

/** Pages through a search job ({query, pageToken}); returns true when finished. */
function searchPages_(s, job, source, stats, timeLeft, limit) {
  while (timeLeft() > 60000) {
    const args = { q: job.query, maxResults: Math.min(CONFIG.DISCOVERY.PAGE_SIZE, limit || 500) };
    if (job.pageToken) args.pageToken = job.pageToken;
    const page = withRetry_(() => Gmail.Users.Messages.list('me', args), 'Gmail search');
    (page.messages || []).forEach(m => { if (!limit || stats.discovered < limit) enqueue_(s, m.id, m.threadId, source, stats); });
    job.listed = (job.listed || 0) + (page.messages || []).length;
    job.pageToken = page.nextPageToken || null;
    if (!job.pageToken || (limit && stats.discovered >= limit)) return true;
  }
  return false;
}

function discoverBackfill_(s, state, stats, timeLeft) {
  const b = state.backfill;
  if (b && !b.listingDone && !b.paused && searchPages_(s, b, 'backfill', stats, timeLeft)) {
    b.listingDone = true;
    b.listingDoneAt = new Date().toISOString();
  }
  if (state.rescan && searchPages_(s, state.rescan, 'rescan', stats, timeLeft)) delete state.rescan;
}

/** Re-checks a rotating slice of threads linked to open (or recently closed) applications. */
function monitorThreads_(s, state, stats, timeLeft) {
  const cutoff = Date.now() - CONFIG.DISCOVERY.WATCH_CLOSED_DAYS * 864e5;
  const watched = [];
  s.index.threadApps.forEach((ids, tid) => {
    if (/^legacy/.test(tid)) return;
    const keep = Array.from(ids).some(id => {
      const a = s.appById.get(id);
      if (!a) return false;
      const closed = a['Current Status'] === 'Rejected' || a['Current Status'] === 'Withdrawn';
      return !closed || (a['Last Activity Date'] instanceof Date && a['Last Activity Date'].getTime() > cutoff);
    });
    if (keep) watched.push(tid);
  });
  watched.sort();
  if (!watched.length) return;
  let cursor = Number(state.monitorCursor || 0) % watched.length;
  const n = Math.min(CONFIG.DISCOVERY.THREADS_PER_RUN, watched.length);
  for (let i = 0; i < n && timeLeft() > 60000; i++) {
    const tid = watched[cursor];
    cursor = (cursor + 1) % watched.length;
    try {
      const th = withRetry_(() => Gmail.Users.Threads.get('me', tid, { format: 'minimal' }), 'Gmail thread');
      (th.messages || []).forEach(m => {
        if ((m.labelIds || []).some(l => CONFIG.DISCOVERY.SKIP_LABELS.indexOf(l) !== -1)) return;
        enqueue_(s, m.id, tid, 'thread-monitor', stats);
      });
    } catch (e) {
      stats.notes.push('Thread ' + tid + ' not readable: ' + String(e.message).slice(0, 80));
    }
  }
  state.monitorCursor = cursor;
}

// ------------------------------------------------------------------
// Triage and classification
// ------------------------------------------------------------------

function processTriage_(s, state, stats, timeLeft, out) {
  while (timeLeft() > 90000) {
    const batch = tasksFor_(s, 'triage', llm_().TRIAGE_BATCH);
    if (!batch.length) return true;
    const items = [];
    for (const t of batch) {
      try {
        const m = withRetry_(() => Gmail.Users.Messages.get('me', t['Gmail Message ID'], { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject'] }), 'Gmail get');
        const h = headersOf_(m);
        t['Email Date'] = new Date(Number(m.internalDate));
        if ((m.labelIds || []).some(l => CONFIG.DISCOVERY.SKIP_LABELS.indexOf(l) !== -1)) { completeTask_(t, 'skipped: label'); stats.skipped++; continue; }
        const sender = Extract.parseSender(h.from);
        const sent = (m.labelIds || []).indexOf('SENT') !== -1 || sender.email === String(state.myAddress || '').toLowerCase();
        if (s.index.threadApps.has(String(m.threadId))) { t['Stage'] = 'classify'; continue; }   // joined a known thread meanwhile
        items.push({ t: t, id: String(m.id), direction: sent ? 'sent' : 'received', from: h.from || '', to: h.to || '', subject: h.subject || '', snippet: m.snippet || '' });
      } catch (e) {
        failTask_(s, t, gmailErrorCategory_(e), 'Gmail: ' + e.message, 0, stats);
      }
    }
    if (items.length) {
      const res = LLM.run([Semantic.buildTriageRequest(items)])[0];
      if (!res.ok) {
        let stop = false;
        items.forEach(x => { if (failTask_(s, x.t, res.error.category, 'Triage: ' + res.error.message, res.error.retryAfterSec, stats) === 'stop') stop = true; });
        if (stop) { stats.notes.push('LLM provider unusable: ' + res.error.message); return false; }
      } else {
        let verdicts;
        try { verdicts = Semantic.validateTriage(res.json, items.map(x => x.id)); } catch (e) { verdicts = new Map(); }
        items.forEach(x => {
          const v = verdicts.get(x.id);
          stats.triaged++;
          if (!v) failTask_(s, x.t, 'invalid_output', 'Triage result missing for this message', 0, stats);
          else if (v.relevant) { x.t['Stage'] = 'classify'; x.t['State'] = 'pending'; x.t['Outcome'] = 'triage: possibly relevant'; }
          else { completeTask_(x.t, 'not relevant (triage): ' + v.reason); stats.skipped++; if (out) out.push('not relevant | ' + x.subject.slice(0, 70) + ' | ' + v.reason); }
        });
      }
    }
    if (!out) flushStore_(s);
  }
  return false;
}

/** Fetches the message with up to CONTEXT_MESSAGES earlier messages of its thread. */
function fetchWithContext_(msgId, threadId, myAddress) {
  const th = withRetry_(() => Gmail.Users.Threads.get('me', threadId, { format: 'full' }), 'Gmail thread');
  const msgs = (th.messages || []).slice().sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const i = msgs.findIndex(m => String(m.id) === String(msgId));
  if (i === -1) throw new Error('not found: message ' + msgId + ' is no longer in its thread');
  const email = Extract.parseEmail(toRawEmail_(msgs[i]), myAddress);
  const tz = Dates.userTz();
  const context = msgs.slice(Math.max(0, i - llm_().CONTEXT_MESSAGES), i).map(m => {
    const e = Extract.parseEmail(toRawEmail_(m), myAddress);
    return { direction: e.direction, sentAt: e.date ? Dates.isoWithOffset(e.date.getTime(), tz) : '', from: e.sender.email,
      text: (e.subject + '\n' + e.current).slice(0, llm_().CONTEXT_CHARS) };
  });
  return { email: email, context: context };
}

function contentHash_(email, context) {
  return Extract.sha256([PROMPT_VERSION, llm_().MODEL, email.subject, email.sender.email, email.date && email.date.getTime(),
    email.current, email.quoted, context.map(c => c.text).join('|')].join('\u0001'));
}

function processClassify_(s, state, stats, timeLeft, out) {
  const examplesPool = s.feedback.rows.map(r => r.data);
  let processed = 0;
  while (timeLeft() > 90000 && processed < CONFIG.QUEUE.CLASSIFY_PER_RUN) {
    const batch = tasksFor_(s, 'classify', llm_().PARALLEL_REQUESTS);
    if (!batch.length) return true;
    const jobs = [];
    for (const t of batch) {
      processed++;
      try {
        const threadId = t['Gmail Thread ID'] || withRetry_(() => Gmail.Users.Messages.get('me', t['Gmail Message ID'], { format: 'minimal' }), 'Gmail get').threadId;
        t['Gmail Thread ID'] = threadId;
        const fc = fetchWithContext_(t['Gmail Message ID'], threadId, state.myAddress);
        if (fc.email.date) t['Email Date'] = fc.email.date;
        const hash = contentHash_(fc.email, fc.context);
        const cached = s.activeEvent.get(String(t['Gmail Message ID']));
        if (cached && cached['Content Hash'] === hash && !t['Force']) { completeTask_(t, 'unchanged since last classification'); stats.skipped++; continue; }
        const candidates = Matcher.candidates(fc.email, s.index, 6);
        const examples = Semantic.pickExamples(fc.email, examplesPool, CONFIG.REVIEW.FEW_SHOT_EXAMPLES);
        jobs.push({ t: t, email: fc.email, hash: hash, candidateIds: candidates.map(c => c.application_id),
          req: Semantic.buildClassifyRequest(fc.email, fc.context, candidates, examples) });
      } catch (e) {
        failTask_(s, t, gmailErrorCategory_(e), 'Gmail: ' + e.message, 0, stats);
      }
    }
    if (jobs.length) {
      const results = LLM.run(jobs.map(j => j.req));
      let stop = false;
      jobs.forEach((j, k) => {
        const res = results[k];
        if (!res.ok) { if (failTask_(s, j.t, res.error.category, res.error.message, res.error.retryAfterSec, stats) === 'stop') stop = true; return; }
        let cls;
        try { cls = Semantic.validateClassification(res.json, j.candidateIds); }
        catch (e) { failTask_(s, j.t, 'invalid_output', e.message, 0, stats); return; }
        stats.classified++;
        const line = applyClassification_(s, j.email, cls, { hash: j.hash, model: res.model, json: res.json }, stats);
        completeTask_(j.t, line);
        if (out) out.push(line);
      });
      if (stop) { stats.notes.push('LLM provider unusable: ' + results.find(r => !r.ok).error.message); if (!out) flushStore_(s); return false; }
    }
    if (!out) flushStore_(s);
  }
  return false;
}

/**
 * Applies a validated classification. Never throws for content reasons: anything
 * doubtful becomes a Review Queue row. Returns a one-line summary.
 */
function applyClassification_(s, email, cls, meta, stats) {
  const msgId = email.messageId;
  const eventId = 'EVT-' + msgId + '-' + meta.hash.slice(0, 8);
  if (s.eventById.has(eventId)) return 'already recorded (' + eventId + ')';   // re-run after a partial write

  const previous = s.activeEvent.get(msgId);
  const linked = s.index.threadApps.get(email.threadId);
  const notApplication = !cls.relevant || cls.eventType === 'UNRELATED' || cls.eventType === 'JOB_ADVERTISEMENT';
  if (notApplication && !(linked && linked.size)) {
    if (previous) { previous['Processing State'] = 'superseded'; s.activeEvent.delete(msgId); recomputeLinked_(s, previous); }
    stats.skipped++;
    return 'not relevant: ' + cls.eventType + ' | "' + email.subject.slice(0, 70) + '"';
  }

  const dates = cls.dates.map(d => Dates.resolve(d, email.date));
  const reasons = Status.reviewReasons(cls, email);
  const decision = Matcher.decide(cls, email, s.index);
  if (CONFIG.REVIEW.HIGH_IMPACT.indexOf(cls.eventType) !== -1 && (decision.action === 'match' || decision.action === 'create') &&
      !Status.senderPlausible(email, cls.company, s.appById.get(decision.appId), !!(linked && linked.has(decision.appId)))) {
    reasons.push('Sender ' + email.sender.email + ' is not clearly associated with ' + (cls.company || 'the employer'));
  }
  const datesText = dates.map(d => d.kind + ' (' + d.status + '): ' + d.display + (d.review ? ' [needs review: ' + d.review + ']' : '')).join('\n');

  let state, appId = '';
  if (reasons.length || decision.action === 'review') {
    state = 'review';
    queueReview_(s, 'REV-' + msgId, {
      'Kind': reasons.length ? 'classification' : 'match', 'Gmail Message ID': msgId, 'Gmail Thread ID': email.threadId,
      'Date': email.date || '', 'Sender': email.sender.email, 'Subject': email.subject.slice(0, 300),
      'Proposed Company': cls.company || '', 'Proposed Job Title': cls.title || '', 'Proposed Event Type': cls.eventType,
      'Proposed Dates': datesText, 'Proposed Application ID': decision.appId || cls.match.applicationId || '',
      'Evidence': cls.evidence.join(' | '), 'Uncertainty': cls.missing.concat(cls.contradictions).join('; '),
      'Confidence': cls.confidence, 'Review Reason': reasons.concat(decision.action === 'review' ? [decision.reason] : []).join('; ')
    });
    stats.reviewed++;
  } else if (decision.action === 'none') {
    state = 'logged';
  } else {
    const a = decision.action === 'create' ? createApp_(s, cls.company, cls.title) : s.appById.get(decision.appId);
    appId = a['Application ID'];
    state = decision.action === 'link' ? 'linked' : 'applied';
    updateAppFromEvent_(a, email, cls, dates);
    dates.filter(d => d.review).forEach((d, i) => {
      queueReview_(s, 'REV-D-' + msgId + '-' + i, { 'Kind': 'date', 'Gmail Message ID': msgId, 'Gmail Thread ID': email.threadId,
        'Date': email.date || '', 'Sender': email.sender.email, 'Subject': email.subject.slice(0, 300), 'Proposed Event Type': cls.eventType,
        'Proposed Dates': d.display, 'Proposed Application ID': appId, 'Review Reason': 'Date not applied: ' + d.review +
        '. Put the correct date/time in Corrected Date and approve.' });
      stats.reviewed++;
    });
  }

  if (previous) { previous['Processing State'] = 'superseded'; s.activeEvent.delete(msgId); }
  const ev = addRow_(s.events, {
    'Event ID': eventId, 'Gmail Message ID': msgId, 'Gmail Thread ID': email.threadId, 'Gmail Thread URL': threadUrl_(email.threadId),
    'Email Timestamp': email.date || '', 'Direction': email.direction, 'Sender': email.sender.email,
    'Subject': email.subject.slice(0, 300), 'Event Type': cls.eventType, 'Event Qualifier': cls.qualifier, 'Application ID': appId,
    'Extracted Company': cls.company || '', 'Extracted Job Title': cls.title || '', 'Event Dates': datesText,
    'Evidence': cls.evidence.join(' | '), 'Classification Reason': cls.explanation, 'Confidence': cls.confidence,
    'Model': meta.model, 'Prompt Version': PROMPT_VERSION, 'Content Hash': meta.hash,
    'Classification JSON': JSON.stringify(meta.json).slice(0, 4500), 'Processing State': state, 'Processed At': new Date()
  });
  indexEvent_(s, ev);
  if (appId) { recomputeApp_(s, appId); s.touched.add(appId); }
  if (previous) recomputeLinked_(s, previous);
  if (state !== 'review') stats.written++;
  return state + ': ' + cls.eventType + (cls.qualifier !== 'actual' ? ' (' + cls.qualifier + ')' : '') + ' | ' + (cls.company || '?') + ' / ' +
    (cls.title || '?') + (appId ? ' -> ' + appId + ' [' + s.appById.get(appId)['Current Status'] + ']' : '') + ' | "' + email.subject.slice(0, 70) + '"';
}

function recomputeLinked_(s, ev) {
  const id = String(ev['Corrected Application ID'] || ev['Application ID'] || '');
  if (id) recomputeApp_(s, id);
}

/** Fills blank fields; dates follow the rules in README "How fields are updated". */
function updateAppFromEvent_(a, email, cls, dates) {
  const fill = (h, v) => { if (v && !a[h]) a[h] = v; };
  fill('Company', cls.company);
  fill('Job Title', cls.title);
  fill('Job URL', cls.jobUrl);
  fill('Location', cls.location);
  fill('Work Arrangement', cls.arrangement ? { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' }[cls.arrangement] : '');
  fill('Job Source', email.source);
  if (email.direction === 'received' && ['recruiter', 'hiring_manager'].indexOf(cls.senderRole) !== -1) {
    fill('Recruiter Name', cls.senderName);
    fill('Recruiter Email', email.sender.email);
  }
  fill('Next Action', cls.nextAction);
  const d = email.date;
  if (d && (!(a['Last Activity Date'] instanceof Date) || d > a['Last Activity Date'])) {
    a['Last Activity Date'] = d;
    a['Last Relevant Gmail Thread URL'] = threadUrl_(email.threadId);
  }
  const appDate = dates.find(x => x.kind === 'application_date' && x.value && !x.review);
  const startDate = appDate ? appDate.value : (['APPLICATION_SUBMITTED', 'APPLICATION_CONFIRMATION'].indexOf(cls.eventType) !== -1 && cls.qualifier === 'actual' ? d : null);
  if (startDate && (!(a['Application Date'] instanceof Date) || startDate < a['Application Date'])) a['Application Date'] = startDate;

  const usable = kind => dates.filter(x => x.kind === kind && x.value && !x.review);
  const iv = usable('interview');
  const confirmed = iv.find(x => x.status === 'confirmed');
  if (confirmed && cls.eventType !== 'INTERVIEW_CANCELLED') {
    const cur = a['Interview Date'] instanceof Date ? a['Interview Date'] : null;
    if (!cur || cls.eventType === 'INTERVIEW_UPDATED' || (d && cur < d)) {
      a['Interview Date'] = confirmed.value;
      a['Interview Details'] = 'confirmed: ' + confirmed.display;
    }
  } else if (iv.length && cls.eventType !== 'INTERVIEW_CANCELLED' && !(a['Interview Date'] instanceof Date)) {
    a['Interview Details'] = 'proposed (not confirmed): ' + iv.map(x => x.display).join('; ');
  }
  if (cls.eventType === 'INTERVIEW_CANCELLED' && cls.qualifier === 'actual') {
    if (a['Interview Date'] instanceof Date && (!d || a['Interview Date'] >= d)) a['Interview Date'] = '';
    a['Interview Details'] = 'cancelled per email of ' + fmtDay_(d);
  }
  const dl = usable('assessment_deadline')[0];
  if (dl) {
    const cur = a['Assessment Deadline'] instanceof Date ? a['Assessment Deadline'] : null;
    if (!cur || (d && cur < d) || dl.value > cur) { a['Assessment Deadline'] = dl.value; a['Assessment Details'] = dl.display; }
  }
  if (cls.confidence) a['Confidence'] = cls.confidence;
  a['Updated At'] = new Date();
  a['Normalized Company'] = Extract.normalizeCompany(a['Company']);
  a['Normalized Job Title'] = Extract.normalizeTitle(a['Job Title']);
}

// ------------------------------------------------------------------
// Runs
// ------------------------------------------------------------------

function newStats_() {
  return { discovered: 0, triaged: 0, classified: 0, written: 0, skipped: 0, retried: 0, failed: 0, dead: 0, reviewed: 0, notes: [] };
}

function queueHealth_(s) {
  const all = s.queue.rows.map(r => r.data).concat(s.queue.added);
  const by = {};
  let oldest = null;
  all.forEach(t => {
    const k = t['State'] + (t['State'] === 'pending' || t['State'] === 'retry' ? ':' + t['Stage'] : '');
    by[k] = (by[k] || 0) + 1;
    if ((t['State'] === 'pending' || t['State'] === 'retry') && t['Discovered At'] instanceof Date && (!oldest || t['Discovered At'] < oldest)) oldest = t['Discovered At'];
  });
  const open = all.filter(t => t['State'] === 'pending' || t['State'] === 'retry');
  return { byState: by, open: open.length, backfillOpen: open.filter(t => t['Source'] === 'backfill').length, oldest: oldest,
    nextRetry: open.map(t => t['Next Attempt At']).filter(x => x instanceof Date).sort((a, b) => a - b)[0] || null };
}

/**
 * One bounded run. mode: 'sync' (scheduled/menu) | 'dry-run'.
 * opts (dry run): {limit, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD'}
 */
function runSync_(mode, opts) {
  opts = opts || {};
  const dryRun = mode === 'dry-run';
  const started = Date.now();
  const timeLeft = () => CONFIG.MAX_RUNTIME_MS - (Date.now() - started);
  const stats = newStats_();
  const lines = dryRun ? [] : null;
  LLM.resetStats();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    log_('WARN', mode + ': another run holds the lock; skipped');
    return { result: 'locked', stats: stats, lines: ['Another sync is running. Try again in a few minutes.'] };
  }
  let ss = null, result = 'failed', errorText = '', s = null;
  try {
    ss = getSpreadsheet_();
    s = loadStore_(ss);
    const state = getState_();
    myAddress_(state);
    if (dryRun) {
      // Sample a period without touching the real queue: everything stays in memory.
      const q = CONFIG.DISCOVERY.BACKFILL_QUERY + (opts.from ? ' after:' + epochSec_(Dates.zonedToUtc(opts.from, '00:00', Dates.userTz()).ms) : ' newer_than:7d') +
        (opts.to ? ' before:' + epochSec_(Dates.zonedToUtc(Dates.addDays(opts.to, 1), '00:00', Dates.userTz()).ms) : '');
      searchPages_(s, { query: q, pageToken: null }, 'dry-run', stats, timeLeft, opts.limit || CONFIG.DRY_RUN_DEFAULT_MESSAGES);
    } else {
      flushStore_(s);   // persists IDs given to hand-typed application rows
      if (!LLM.hasKey()) stats.notes.push('No LLM API key set: discovery only');
      discoverHistory_(s, state, stats, timeLeft);
      discoverBackfill_(s, state, stats, timeLeft);
      monitorThreads_(s, state, stats, timeLeft);
      flushStore_(s);
      saveState_(state);   // discovery checkpoint: IDs are safely in the Work Queue
    }
    let done = true;
    if (LLM.hasKey()) {
      // Classify known-thread messages first (cheapest, most valuable), then triage, then classify what triage passed.
      done = processClassify_(s, state, stats, timeLeft, lines) && processTriage_(s, state, stats, timeLeft, lines) &&
        processClassify_(s, state, stats, timeLeft, lines);
    } else {
      done = false;
    }
    if (!dryRun) {
      s.apps.rows.forEach(r => recomputeApp_(s, r.data['Application ID']));
      flushStore_(s);
      const health = queueHealth_(s);
      if (state.backfill && state.backfill.listingDone && !state.backfill.completedAt && health.backfillOpen === 0) {
        state.backfill.completedAt = new Date().toISOString();
      }
      if (done && health.open === 0) state.lastSuccessAt = new Date(started).toISOString();
      else if (done) stats.notes.push(health.open + ' message(s) waiting for retry or later processing');
      saveState_(state);
      stats.health = health;
      done = done && health.open === 0;   // never report complete while work remains
    }
    result = done ? 'complete' : 'partial';
  } catch (e) {
    errorText = e.message;
    log_('ERROR', mode + ' failed: ' + e.stack);
    throw e;
  } finally {
    if (!dryRun && ss) {
      try { appendLog_(ss, mode, started, result, stats, (errorText ? 'ERROR: ' + errorText + ' | ' : '') + stats.notes.join(' | ')); }
      catch (e2) { log_('ERROR', 'Could not write Sync Log: ' + e2.message); }
    }
    lock.releaseLock();
  }
  log_('INFO', mode + ' ' + result + ' ' + JSON.stringify(stats) + ' llm=' + JSON.stringify(LLM.stats));
  return { result: result, stats: stats, llm: LLM.stats, lines: lines || [] };
}

function appendLog_(ss, mode, started, result, stats, notes) {
  const t = loadTable_(ss, CONFIG.TABS.LOG, SCHEMA.LOG);
  const h = stats.health || {};
  addRow_(t, {
    'Run ID': Utilities.formatDate(new Date(started), Session.getScriptTimeZone(), "yyyyMMdd'T'HHmmss") + '-' + mode,
    'Mode': mode, 'Started At': new Date(started), 'Finished At': new Date(), 'Result': result,
    'Discovered': stats.discovered, 'Triaged': stats.triaged, 'Classified': stats.classified, 'Written': stats.written,
    'Skipped': stats.skipped, 'Retried': stats.retried, 'Failed': stats.retried + stats.dead, 'Dead': stats.dead,
    'Sent to Review': stats.reviewed, 'Model Calls': LLM.stats.calls, 'Input Tokens': LLM.stats.inputTokens,
    'Output Tokens': LLM.stats.outputTokens, 'Est. Cost USD': Math.round(LLM.stats.costUsd * 10000) / 10000,
    'Avg Latency ms': LLM.stats.calls ? Math.round(LLM.stats.latencyMs / LLM.stats.calls) : '',
    'Queue Pending': h.open === undefined ? '' : h.open, 'Oldest Pending': h.oldest || '', 'Notes': String(notes).slice(0, 2000)
  });
  flushTable_(t, 'Run ID');
}

// ------------------------------------------------------------------
// Review Queue, event corrections and feedback
// ------------------------------------------------------------------

function addFeedback_(s, id, fields) {
  if (s.feedbackIds.has(id)) return;
  s.feedbackIds.add(id);
  addRow_(s.feedback, Object.assign({ 'Feedback ID': id, 'Created At': new Date(), 'Use As Example': 'Yes' }, fields));
}

function excerptOf_(r) {
  return ('Subject: ' + (r['Subject'] || '') + ' | From: ' + (r['Sender'] || '') + ' | Evidence: ' + (r['Evidence'] || '')).slice(0, 600);
}

/**
 * Applies "Approved"/"Ignored" Review Queue rows and Email Events corrections, records the
 * corrections as feedback examples, and marks reviews Done (written last, so a crash just
 * repeats the work without duplicating anything).
 */
function processReviews_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return { done: 0, corrections: 0, errors: ['Another sync is running; try again shortly.'] };
  try {
    const s = loadStore_(getSpreadsheet_());
    const errors = [];
    let done = 0, corrections = 0;

    for (const row of s.reviews.rows) {
      const v = row.data;
      const decision = String(v['Review Status']);
      if (decision !== 'Approved' && decision !== 'Ignored') continue;
      const id = String(v['Review ID']);
      const msgId = String(v['Gmail Message ID'] || '');
      const ev = s.activeEvent.get(msgId);
      const kind = String(v['Kind']);
      const original = JSON.stringify({ event_type: v['Proposed Event Type'], company: v['Proposed Company'], job_title: v['Proposed Job Title'], application_id: v['Proposed Application ID'] });

      if (decision === 'Ignored') {
        if (ev && kind !== 'conflict' && kind !== 'date') { ev['Processing State'] = 'ignored'; s.activeEvent.delete(msgId); recomputeLinked_(s, ev); }
        if (kind === 'classification' || kind === 'match') {
          addFeedback_(s, 'FB-' + id, { 'Gmail Message ID': msgId, 'Correction Type': 'not_relevant', 'Original Prediction': original,
            'Corrected Value': JSON.stringify({ relevant: false }), 'Excerpt': excerptOf_(v), 'Model': ev ? ev['Model'] : '',
            'Prompt Version': ev ? ev['Prompt Version'] : '', 'Review Outcome': 'ignored by user' });
        }
      } else if (kind === 'processing-failed') {
        const t = s.taskByMsg.get(msgId);
        if (t) { t['State'] = 'pending'; t['Attempts'] = 0; t['Needs Manual'] = ''; t['Next Attempt At'] = ''; t['Force'] = 'Yes'; }
      } else if (kind === 'conflict') {
        const target = s.eventById.get(id.replace(/^REV-C-/, ''));
        if (target) { target['Processing State'] = 'confirmed'; recomputeLinked_(s, target); }
      } else {
        const type = String(v['Corrected Event Type'] || v['Proposed Event Type']);
        const company = String(v['Corrected Company'] || v['Proposed Company'] || '').trim();
        const title = String(v['Corrected Job Title'] || v['Proposed Job Title'] || '').trim();
        const forceNew = String(v['Corrected Application ID']).trim().toUpperCase() === 'NEW';
        let appId = forceNew ? '' : String(v['Corrected Application ID'] || v['Proposed Application ID'] || '').trim();
        if (EVENT_TYPES.indexOf(type) === -1 || type === 'NEEDS_REVIEW') { errors.push(id + ': set Corrected Event Type (or choose Ignored)'); continue; }
        if (appId && !s.appById.has(appId)) { errors.push(id + ': application ID ' + appId + ' not found'); continue; }
        const needsApp = NON_APPLICATION_TYPES.indexOf(type) === -1;
        if (needsApp && !appId) {
          if (!company || !title) { errors.push(id + ': set Corrected Company and Corrected Job Title, or a Corrected Application ID'); continue; }
          const nc = Extract.normalizeCompany(company), nt = Extract.normalizeTitle(title);
          const existing = forceNew ? null : s.index.apps.find(a => a.normCompany === nc && a.normTitle === nt);
          appId = existing ? existing.id : createApp_(s, company, title)['Application ID'];
        }
        let target = ev;
        if (!target) {
          target = addRow_(s.events, { 'Event ID': 'EVT-' + msgId + '-review', 'Gmail Message ID': msgId, 'Gmail Thread ID': v['Gmail Thread ID'],
            'Gmail Thread URL': threadUrl_(v['Gmail Thread ID']), 'Email Timestamp': v['Date'], 'Direction': 'received',
            'Sender': v['Sender'], 'Subject': v['Subject'], 'Event Type': type, 'Event Qualifier': 'actual', 'Processed At': new Date() });
          indexEvent_(s, target);
        }
        if (kind !== 'date') {
          if (type !== target['Event Type']) target['Corrected Event Type'] = type;
          target['Event Qualifier'] = 'actual';
          target['Application ID'] = needsApp ? appId : '';
          target['Processing State'] = needsApp ? 'confirmed' : 'logged';
          indexEvent_(s, target);
        }
        const a = appId && s.appById.get(appId);
        if (a) {
          if (company && !a['Company']) a['Company'] = company;
          if (title && !a['Job Title']) a['Job Title'] = title;
          const when = v['Corrected Date'];
          if (when instanceof Date) {
            const evType = String(target['Corrected Event Type'] || target['Event Type'] || type);
            if (/^ASSESSMENT/.test(evType)) { a['Assessment Deadline'] = when; a['Assessment Details'] = 'set in review'; }
            else if (/^INTERVIEW/.test(evType)) { a['Interview Date'] = when; a['Interview Details'] = 'set in review'; }
          }
          if (target['Email Timestamp'] instanceof Date && (!(a['Last Activity Date'] instanceof Date) || target['Email Timestamp'] > a['Last Activity Date'])) a['Last Activity Date'] = target['Email Timestamp'];
          a['Normalized Company'] = Extract.normalizeCompany(a['Company']);
          a['Normalized Job Title'] = Extract.normalizeTitle(a['Job Title']);
          indexApp_(s, a);
          recomputeApp_(s, appId);
        }
        const changed = ['Corrected Company', 'Corrected Job Title', 'Corrected Event Type', 'Corrected Application ID']
          .filter(h => String(v[h] || '').trim() && String(v[h]).trim() !== String(v[h.replace('Corrected', 'Proposed')] || '').trim());
        if (changed.length && kind !== 'date') {
          addFeedback_(s, 'FB-' + id, { 'Gmail Message ID': msgId, 'Correction Type': changed.map(h => h.replace('Corrected ', '').toLowerCase()).join(','),
            'Original Prediction': original, 'Corrected Value': JSON.stringify({ event_type: type, company: company || null, job_title: title || null, application_id: appId || null }),
            'Excerpt': excerptOf_(v), 'Model': ev ? ev['Model'] : '', 'Prompt Version': ev ? ev['Prompt Version'] : '', 'Review Outcome': 'approved with correction' });
          corrections++;
        }
      }
      v['Review Status'] = 'Done';
      v['Reviewed At'] = new Date();
      done++;
    }

    // Corrections typed directly into Email Events.
    s.events.rows.forEach(r => {
      const e = r.data;
      const ct = String(e['Corrected Event Type'] || ''), ca = String(e['Corrected Application ID'] || '');
      if (!ct && !ca) return;
      if (ca && !s.appById.has(ca)) { errors.push(e['Event ID'] + ': Corrected Application ID ' + ca + ' not found'); return; }
      if (ct && EVENT_TYPES.indexOf(ct) === -1) { errors.push(e['Event ID'] + ': unknown Corrected Event Type ' + ct); return; }
      const fid = 'FB-' + e['Event ID'] + '-' + ct + '-' + ca;
      if (s.feedbackIds.has(fid)) return;
      const before = String(e['Application ID'] || '');
      if (ca && ca !== before) { e['Application ID'] = ca; if (before) recomputeApp_(s, before); }
      if (e['Processing State'] === 'review' || e['Processing State'] === 'logged') e['Processing State'] = 'confirmed';
      indexEvent_(s, e);
      recomputeLinked_(s, e);
      addFeedback_(s, fid, { 'Gmail Message ID': e['Gmail Message ID'], 'Correction Type': [ct && 'event_type', ca && 'application'].filter(Boolean).join(','),
        'Original Prediction': JSON.stringify({ event_type: e['Event Type'], application_id: before || null }),
        'Corrected Value': JSON.stringify({ event_type: ct || e['Event Type'], application_id: ca || before || null }),
        'Excerpt': excerptOf_(e), 'Model': e['Model'], 'Prompt Version': e['Prompt Version'], 'Review Outcome': 'event corrected by user' });
      corrections++;
    });

    flushTable_(s.apps, 'Application ID');
    flushTable_(s.events, 'Event ID');
    flushTable_(s.feedback, 'Feedback ID');
    flushTable_(s.queue, 'Task ID');
    flushTable_(s.reviews, 'Review ID');   // "Done" is written last
    return { done: done, corrections: corrections, errors: errors };
  } finally {
    lock.releaseLock();
  }
}

/** Re-derives every application's status from its events (no LLM calls). */
function reconcile_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return ['Another sync is running; try again shortly.'];
  try {
    const s = loadStore_(getSpreadsheet_());
    const changes = [];
    s.apps.rows.forEach(r => {
      const before = r.data['Current Status'];
      recomputeApp_(s, r.data['Application ID']);
      if (before !== r.data['Current Status']) changes.push(r.data['Application ID'] + ' ' + (r.data['Company'] || '?') + ': ' + (before || '(blank)') + ' -> ' + r.data['Current Status']);
    });
    flushTable_(s.apps, 'Application ID');
    flushTable_(s.reviews, 'Review ID');
    return changes.length ? changes : ['All statuses already match their event history.'];
  } finally {
    lock.releaseLock();
  }
}

/** Marks messages for fresh classification (bypassing the cache) on the next run. */
function requeue_(msgIds) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return 0;
  try {
    const s = loadStore_(getSpreadsheet_());
    let n = 0;
    msgIds.forEach(id => {
      let t = s.taskByMsg.get(String(id));
      if (!t) {
        const ev = s.activeEvent.get(String(id));
        t = addRow_(s.queue, { 'Task ID': 'T-' + id, 'Gmail Message ID': id, 'Gmail Thread ID': ev ? ev['Gmail Thread ID'] : '', 'Source': 'manual', 'Discovered At': new Date() });
        s.taskByMsg.set(String(id), t);
      }
      Object.assign(t, { 'Stage': 'classify', 'State': 'pending', 'Attempts': 0, 'Next Attempt At': '', 'Needs Manual': '', 'Force': 'Yes' });
      n++;
    });
    flushTable_(s.queue, 'Task ID');
    return n;
  } finally {
    lock.releaseLock();
  }
}
