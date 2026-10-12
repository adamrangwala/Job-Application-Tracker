// Loads the .gs sources into a Node vm context with small in-memory fakes of the
// Apps Script services they use (Sheets, Gmail advanced service, UrlFetchApp,
// Properties, Lock, ScriptApp, Utilities). The fakes model only what the code
// calls; they prove the logic, not live Google or LLM behaviour.
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['config.gs', 'extractionUtils.gs', 'dateUtils.gs', 'llmProvider.gs', 'semanticUtils.gs', 'statusUtils.gs',
  'matchUtils.gs', 'spreadsheetUtils.gs', 'syncUtils.gs', 'dashboardUtils.gs', 'main.gs'];
const CODE = SOURCES.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
  '\n;this.__x = {CONFIG, Extract, Dates, LLM, LLM_PROVIDERS, Semantic, Status, Matcher, SCHEMA, EVENT_TYPES, CLASSIFY_SCHEMA, SYSTEM_PROMPT, PROMPT_VERSION};';

function chain() {
  const p = new Proxy(function() {}, { get: (t, k) => (k === 'then' || typeof k === 'symbol') ? undefined : p, apply: () => p });
  return p;
}
const isRead = name => /^(get|is|has)/.test(name);
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

function lenient(obj, ss) {
  return new Proxy(obj, {
    get(t, k) {
      if (k in t || typeof k === 'symbol') return t[k];
      return () => { if (!isRead(k)) ss.write(k); return chain(); };
    }
  });
}

// ---------------- Sheets ----------------

class FakeRange {
  constructor(sheet, row, col, nr, nc) {
    if (row < 1 || col < 1 || row + nr - 1 > sheet.maxRows || col + nc - 1 > sheet.maxCols) {
      throw new Error('Range out of bounds on ' + sheet.name + ': ' + row + ',' + col + ' ' + nr + 'x' + nc + ' (sheet is ' + sheet.maxRows + 'x' + sheet.maxCols + ')');
    }
    Object.assign(this, { sheet, row, col, nr, nc });
    return lenient(this, sheet.ss);
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        const v = src[this.col - 1 + c];
        // Dates come back from the script's realm, as in Apps Script (instanceof Date must hold).
        line.push(v === undefined ? '' : isDate(v) ? new this.sheet.ss.DateCtor(v.getTime()) : v);
      }
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    if (values.length !== this.nr || values.some(r => r.length !== this.nc)) throw new Error('setValues dimension mismatch');
    this.sheet.ss.write('setValues', this.sheet.name);
    values.forEach((line, r) => {
      const i = this.row - 1 + r;
      while (this.sheet.data.length <= i) this.sheet.data.push([]);
      line.forEach((v, c) => {
        if (typeof v === 'string' && v.startsWith('=') && this.sheet.name !== 'Dashboard') this.sheet.ss.writeLog.push('formula:' + this.sheet.name);
        // Sheets stores "'=x" as the text "=x".
        this.sheet.data[i][this.col - 1 + c] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : (isDate(v) ? new Date(v.getTime()) : v);
      });
    });
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFormula(f) { return this.setValues([[f]]); }
  createFilter() { this.sheet.ss.write('createFilter'); this.sheet.filter = {}; return this.sheet.filter; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.nr; }
  getLastRow() { return this.row + this.nr - 1; }
  getLastColumn() { return this.col + this.nc - 1; }
  getSheet() { return this.sheet.proxy; }
}

class FakeSheet {
  constructor(ss, name) {
    Object.assign(this, { ss, name, data: [], maxRows: 1000, maxCols: 26, charts: [], filter: null, rules: [] });
    this.proxy = lenient(this, ss);
    return this.proxy;
  }
  getName() { return this.name; }
  setName(n) { this.ss.write('setName'); this.name = n; return this.proxy; }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) if ((this.data[r - 1] || []).some(v => v !== '' && v !== undefined && v !== null)) return r;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.data.forEach(row => { for (let c = row.length; c > 0; c--) if (row[c - 1] !== '' && row[c - 1] !== undefined) { m = Math.max(m, c); break; } });
    return m;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsBefore(before, n) { this.ss.write('insertRowsBefore'); this.data.splice(before - 1, 0, ...Array.from({ length: n }, () => [])); this.maxRows += n; }
  insertColumnsAfter(after, n) { this.ss.write('insertColumnsAfter'); this.maxCols += n; }
  deleteRows(start, n) { this.ss.write('deleteRows'); this.data.splice(start - 1, n); }
  appendRow(values) { this.ss.write('appendRow', this.name); this.data.splice(this.getLastRow(), 0, values.slice()); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = a.match(/^([A-Z]+)(\d+)$/);
      return new FakeRange(this, +m[2], m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0), 1, 1);
    }
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  copyTo(ss) {
    this.ss.write('copyTo');
    const s = ss.insertSheet('Copy of ' + this.name);
    s.data = this.data.map(r => r.slice());
    s.maxRows = this.maxRows;
    s.maxCols = this.maxCols;
    return s;
  }
  getFilter() { return this.filter; }
  getCharts() { return this.charts.slice(); }
  insertChart(c) { this.ss.write('insertChart'); this.charts.push(c); }
  removeChart(c) { this.ss.write('removeChart'); this.charts.splice(this.charts.indexOf(c), 1); }
  newChart() { return chain(); }
  getConditionalFormatRules() { return this.rules; }
  setConditionalFormatRules(r) { this.ss.write('setConditionalFormatRules'); this.rules = r; }
  clear() { this.ss.write('clear'); this.data = []; }
  /** Test helper: tab as array of {header: value} objects. */
  records() {
    const [head, ...rows] = this.data;
    return rows.filter(r => r.some(v => v !== '' && v !== undefined)).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
  }
}

class FakeSpreadsheet {
  constructor() {
    Object.assign(this, { sheets: [], writes: 0, writeLog: [], failWrite: null, DateCtor: Date, tz: 'Asia/Kolkata' });
  }
  write(kind, tab) {
    if (this.failWrite && this.failWrite(kind, tab)) throw new Error('Simulated Sheets failure on ' + tab);
    this.writes++;
    this.writeLog.push(kind + (tab ? ':' + tab : ''));
  }
  getName() { return 'Test tracker'; }
  getSpreadsheetTimeZone() { return this.tz; }
  getSheetByName(n) { return this.sheets.find(s => s.getName() === n) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(name, index) {
    this.write('insertSheet');
    const s = new FakeSheet(this, name);
    if (index === 0) this.sheets.unshift(s); else this.sheets.push(s);
    return s;
  }
  tab(name) { return this.getSheetByName(name); }
}

// ---------------- Gmail ----------------

const b64url = s => Buffer.from(s, 'utf8').toString('base64url');

/**
 * mailbox: [{id, threadId, date, from, to, subject, body, html, labels}].
 * addMail() also records a Gmail history entry, as new mail would.
 */
function makeGmail(mailbox, me) {
  const g = { calls: { list: 0, get: 0, thread: 0, history: 0 }, failList: null, failGet: new Set(), failThreads: new Set(),
    historyExpired: false, historyId: 1000, history: [], me: me || 'sam.student@example.com', mailbox: mailbox };
  g.addMail = m => {
    mailbox.push(m);
    g.historyId++;
    g.history.push({ id: String(g.historyId), messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labels || ['INBOX'] } }] });
  };
  const resource = (m, format) => {
    const headers = [];
    if (m.from !== undefined) headers.push({ name: 'From', value: m.from });
    if (m.to !== undefined) headers.push({ name: 'To', value: m.to });
    if (m.subject !== undefined) headers.push({ name: 'Subject', value: m.subject });
    const parts = [];
    if (format === 'full') {
      if (m.body !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64url(m.body) } });
      if (m.html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64url(m.html) } });
      parts.push({ mimeType: 'application/pdf', filename: 'resume.pdf', body: { attachmentId: 'x' } });
    }
    return { id: m.id, threadId: m.threadId, internalDate: String(m.date.getTime()), labelIds: m.labels || ['INBOX'],
      snippet: String(m.body || '').slice(0, 120), payload: format === 'minimal' ? undefined : { mimeType: 'multipart/mixed', headers, parts } };
  };
  const find = id => { const m = mailbox.find(x => x.id === id); if (!m) throw new Error('Requested entity was not found. (404)'); return m; };
  g.Users = {
    getProfile: () => ({ emailAddress: g.me, messagesTotal: mailbox.length, historyId: String(g.historyId) }),
    Messages: {
      list(user, opts) {
        g.calls.list++;
        if (g.failList && g.failList(g.calls.list)) throw new Error('Simulated fatal Gmail list failure');
        const after = (opts.q.match(/after:(\d+)/) || [])[1], before = (opts.q.match(/before:(\d+)/) || [])[1];
        const newer = (opts.q.match(/newer_than:(\d+)d/) || [])[1];
        const hits = mailbox.filter(m => (!after || m.date / 1000 > +after) && (!before || m.date / 1000 < +before) &&
          (!newer || m.date > g.now() - newer * 864e5) && !(m.labels || []).some(l => /CATEGORY_PROMOTIONS|SPAM|TRASH/.test(l)))
          .sort((a, b) => b.date - a.date);
        const start = Number(opts.pageToken || 0);
        const page = hits.slice(start, start + opts.maxResults).map(m => ({ id: m.id, threadId: m.threadId }));
        return { messages: page.length ? page : undefined, resultSizeEstimate: hits.length,
          nextPageToken: start + opts.maxResults < hits.length ? String(start + opts.maxResults) : undefined };
      },
      get(user, id, opts) {
        g.calls.get++;
        if (g.failGet.has(id)) throw new Error('Simulated Gmail backend error, try again');
        return resource(find(id), opts.format);
      }
    },
    Threads: {
      get(user, tid, opts) {
        g.calls.thread++;
        if (g.failThreads.has(tid)) throw new Error('Simulated Gmail backend error, try again');
        const msgs = mailbox.filter(m => m.threadId === tid);
        if (!msgs.length) throw new Error('Requested entity was not found. (404)');
        return { id: tid, messages: msgs.map(m => resource(m, opts.format)) };
      }
    },
    History: {
      list(user, opts) {
        g.calls.history++;
        if (g.historyExpired) throw new Error('Requested entity was not found. (404)');
        const recs = g.history.filter(h => Number(h.id) > Number(opts.startHistoryId));
        const start = Number(opts.pageToken || 0), size = 2;   // tiny pages to exercise paging
        return { history: recs.slice(start, start + size), historyId: String(g.historyId),
          nextPageToken: start + size < recs.length ? String(start + size) : undefined };
      }
    }
  };
  g.now = () => Date.now();
  return g;
}

// ---------------- LLM (UrlFetchApp) ----------------

/** model(call) -> {status, body, headers}; call = {url, headers, body (parsed request JSON)}. */
function makeUrlFetch(model) {
  const f = { calls: [], throwNext: 0 };
  f.fetchAll = reqs => {
    if (f.throwNext > 0) { f.throwNext--; throw new Error('Timeout: https://api.anthropic.com/v1/messages'); }
    return reqs.map(r => {
      const call = { url: r.url, headers: r.headers, body: JSON.parse(r.payload) };
      f.calls.push(call);
      const out = model(call);
      const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      return { getResponseCode: () => out.status || 200, getContentText: () => text, getHeaders: () => out.headers || {} };
    });
  };
  return f;
}

/** Wraps a JSON object as a Groq (OpenAI-compatible) chat completion. */
function groqOk(json, model, headers) {
  return { status: 200, headers: headers || {}, body: { id: 'chatcmpl-test', object: 'chat.completion', model: model || 'openai/gpt-oss-120b',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof json === 'string' ? json : JSON.stringify(json) } }],
    usage: { prompt_tokens: 1500, completion_tokens: 400, total_tokens: 1900 } } };
}

/** Request text and schema, whichever provider format the call uses. */
function requestView(call) {
  const b = call.body;
  if (b.response_format) return { user: b.messages.find(m => m.role === 'user').content, schema: b.response_format.json_schema.schema, provider: 'groq' };
  return { user: b.messages[0].content, schema: b.output_config.format.schema, provider: 'anthropic' };
}

/** Wraps a JSON object as a Messages API success response. */
function apiOk(json, model) {
  return { status: 200, body: { id: 'msg_test', type: 'message', model: model || 'claude-opus-5-5', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
}

// ---------------- Utilities ----------------

function formatDate(date, tz, pattern) {
  const d = new Date(date);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' }).formatToParts(d).map(p => [p.type, p.value]));
  const wallUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const off = Math.round((wallUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const offStr = off === 0 ? 'Z' : (off < 0 ? '-' : '+') + String(Math.floor(Math.abs(off) / 60)).padStart(2, '0') + ':' + String(Math.abs(off) % 60).padStart(2, '0');
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss|EEEE|XXX/g, (tok, lit) => lit !== undefined ? lit :
    ({ yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second, EEEE: parts.weekday, XXX: offStr })[tok]);
}

// ---------------- environment ----------------

/**
 * One "execution": fresh code context over shared, persistent fakes.
 * opts: {ss, props, gmail, fetch, triggers, lockHeld, config, scriptTz, prompts}
 */
function createEnv(opts) {
  opts = opts || {};
  const ss = opts.ss || new FakeSpreadsheet();
  const props = opts.props || new Map();
  const triggers = opts.triggers || [];
  const env = { ss, props, triggers, sleeps: [], alerts: [], prompts: opts.prompts || [], lockHeld: !!opts.lockHeld, gmail: opts.gmail, fetch: opts.fetch };
  const ctx = {
    console: { log: (...a) => { if (process.env.DEBUG) console.log(...a); } },
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: formatDate,
      sleep: ms => { env.sleeps.push(ms); },
      base64DecodeWebSafe: s => Array.from(Buffer.from(s, 'base64url')),
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }
    },
    Session: { getScriptTimeZone: () => opts.scriptTz || 'Asia/Kolkata' },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, String(v)); },
      deleteProperty: k => { props.delete(k); }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !env.lockHeld, releaseLock: () => {} }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getActiveRange: () => env.activeRange,
      getUi: () => ({
        alert: (...a) => { env.alerts.push(a.slice(0, 2).join(': ')); return 'YES'; },
        prompt: () => { const v = env.prompts.shift(); return { getSelectedButton: () => (v === null ? 'CANCEL' : 'OK'), getResponseText: () => v || '' }; },
        ButtonSet: { OK: 'OK', YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' }, Button: { YES: 'YES', OK: 'OK' },
        createMenu: () => chain()
      }),
      newDataValidation: () => chain(),
      newConditionalFormatRule: () => chain()
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      newTrigger: h => {
        const b = new Proxy({}, { get: (t, k) => k === 'create' ? () => { triggers.push({ getHandlerFunction: () => h }); } : () => b });
        return b;
      },
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); }
    },
    UrlFetchApp: opts.fetch,
    Charts: { ChartType: { BAR: 'BAR', COLUMN: 'COLUMN', PIE: 'PIE' } },
    Gmail: opts.gmail
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'tracker.gs' });
  ss.DateCtor = vm.runInContext('Date', ctx);
  const cfg = ctx.__x.CONFIG;
  for (const [k, v] of Object.entries(opts.config || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object') Object.assign(cfg[k], v); else cfg[k] = v;
  }
  env.ctx = ctx;
  env.x = ctx.__x;
  env.run = (fn, ...args) => ctx[fn](...args);
  return env;
}

module.exports = { createEnv, makeGmail, makeUrlFetch, apiOk, groqOk, requestView, FakeSpreadsheet, formatDate };
