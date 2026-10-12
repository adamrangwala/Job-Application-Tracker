#!/usr/bin/env node
// Evaluation over tests/eval/cases.js.
//
//   node tests/eval/run-eval.js            guard evaluation (no API key, no cost): feeds both the
//                                          correct answer and deliberately wrong high-impact answers
//                                          through the real validation/guards/matching code and counts
//                                          how many dangerous results would be applied automatically.
//   GROQ_API_KEY=... node tests/eval/run-eval.js --live [--examples feedback.json] [--only id,id]
//   ANTHROPIC_API_KEY=... node tests/eval/run-eval.js --live ...
//                                          live evaluation: real model, real prompt, real request code
//                                          (llmProvider.gs) sent with curl. Uses Groq when GROQ_API_KEY is set,
//                                          otherwise Anthropic. Anthropic costs money (estimate printed);
//                                          Groq's free tier is rate limited, so the run paces itself.
//
// --examples: JSON array of Feedback Examples rows ({Excerpt, Original Prediction, Corrected Value,
// Use As Example}) to measure whether stored corrections change results (run with and without).
// Exit code 1 when a dangerous-error threshold is exceeded.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createEnv } = require('../harness');
const cases = require('./cases');

const args = process.argv.slice(2);
const live = args.includes('--live');
const exIdx = args.indexOf('--examples');
const examples = exIdx !== -1 ? JSON.parse(fs.readFileSync(args[exIdx + 1], 'utf8')) : [];
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1].split(',') : null;
const THRESHOLDS = { dangerousAutoApplied: 0, wrongMatchAutoApplied: 0 };

const env = createEnv({ config: { USER_TIMEZONE: 'Asia/Kolkata' } });
const { Extract, Semantic, Status, Matcher, Dates, LLM, CONFIG } = env.x;

function toEmail(k) {
  const sender = Extract.parseSender(k.from);
  return { messageId: k.id, threadId: 't-' + k.id, date: new Date(k.date), direction: k.direction, sender: sender, to: k.to,
    subject: k.subject, current: k.body, quoted: k.quoted, forwarded: false, labels: [], source: Extract.platformFor(sender.domain) || 'Email' };
}

function indexFor(k) {
  return { apps: k.candidates.map(c => ({ id: c.application_id, company: c.company, title: c.job_title, normCompany: Extract.normalizeCompany(c.company),
    normTitle: Extract.normalizeTitle(c.job_title), urlKey: '', status: c.status, lastActivity: c.last_activity, recruiterEmail: '' })), threadApps: new Map() };
}

/** What the pipeline would do with this classification: 'auto:<status|none>' or 'review', plus the matched app. */
function outcome(k, json) {
  const email = toEmail(k);
  let cls;
  try { cls = Semantic.validateClassification(json, k.candidates.map(c => c.application_id)); }
  catch (e) { return { invalid: e.message }; }
  const reasons = Status.reviewReasons(cls, email);
  const decision = Matcher.decide(cls, email, indexFor(k));
  if (CONFIG.REVIEW.HIGH_IMPACT.indexOf(cls.eventType) !== -1 && (decision.action === 'match' || decision.action === 'create') &&
      !Status.senderPlausible(email, cls.company, null, false)) reasons.push('sender');
  const dates = cls.dates.map(d => Dates.resolve(d, email.date));
  const auto = !reasons.length && decision.action !== 'review';
  return { cls: cls, auto: auto, decision: decision, reasons: reasons, dateReview: dates.some(d => d.review),
    effect: Status.effect({ type: cls.eventType, qualifier: cls.qualifier, direction: email.direction }) };
}

function expectedTypes(k) { return k.expect.types || [k.expect.type]; }

function score(results) {
  const m = { n: 0, relevance: 0, event: 0, company: 0, companyN: 0, title: 0, titleN: 0, match: 0, matchN: 0, review: 0, invalid: 0,
    dangerousAutoApplied: [], wrongMatchAutoApplied: [], falseStatusChanges: [] };
  results.forEach(({ k, o }) => {
    m.n++;
    if (o.invalid) { m.invalid++; return; }
    const c = o.cls;
    if (c.relevant === k.expect.relevant) m.relevance++;
    if (expectedTypes(k).indexOf(c.eventType) !== -1) m.event++;
    if ('company' in k.expect) { m.companyN++; if (Extract.normalizeCompany(c.company) === Extract.normalizeCompany(k.expect.company)) m.company++; }
    if ('title' in k.expect) { m.titleN++; if (Extract.normalizeTitle(c.title) === Extract.normalizeTitle(k.expect.title)) m.title++; }
    if (!o.auto) m.review++;
    if ('match' in k.expect) {
      m.matchN++;
      const got = o.decision.action === 'match' ? o.decision.appId : null;
      if (got === k.expect.match) m.match++;
      else if (o.auto && got) m.wrongMatchAutoApplied.push(k.id + ' -> ' + got);
    }
    if (o.auto && (k.expect.dangerous || []).indexOf(c.eventType) !== -1) m.dangerousAutoApplied.push(k.id + ': ' + c.eventType);
    const expectedEffect = Status.effect({ type: expectedTypes(k)[0], qualifier: 'actual', direction: k.direction });
    if (o.auto && o.effect && o.effect !== expectedEffect) m.falseStatusChanges.push(k.id + ': ' + o.effect + ' (expected ' + (expectedEffect || 'none') + ')');
  });
  return m;
}

function report(title, m, extra) {
  const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '% (' + a + '/' + b + ')' : 'n/a';
  console.log('\n== ' + title + ' ==');
  console.log('cases ' + m.n + ', invalid outputs ' + m.invalid);
  console.log('relevance ' + pct(m.relevance, m.n) + ' | event type ' + pct(m.event, m.n) + ' | company ' + pct(m.company, m.companyN) +
    ' | title ' + pct(m.title, m.titleN) + ' | match ' + pct(m.match, m.matchN) + ' | sent to review ' + pct(m.review, m.n));
  console.log('dangerous results applied automatically: ' + m.dangerousAutoApplied.length + (m.dangerousAutoApplied.length ? ' ' + m.dangerousAutoApplied.join('; ') : ''));
  console.log('wrong application matches applied automatically: ' + m.wrongMatchAutoApplied.length + (m.wrongMatchAutoApplied.length ? ' ' + m.wrongMatchAutoApplied.join('; ') : ''));
  console.log('status changes different from the label (applied automatically): ' + m.falseStatusChanges.length + (m.falseStatusChanges.length ? ' ' + m.falseStatusChanges.join('; ') : ''));
  if (extra) console.log(extra);
  return m.dangerousAutoApplied.length <= THRESHOLDS.dangerousAutoApplied && m.wrongMatchAutoApplied.length <= THRESHOLDS.wrongMatchAutoApplied;
}

const selected = cases.filter(k => !only || only.indexOf(k.id) !== -1);

if (!live) {
  // Oracle answers: what a correct model would say. Measures the code path, not a model.
  const oracle = k => ({ relevant: k.expect.relevant, communication_category: k.expect.relevant ? 'application_activity' : 'unrelated', intent: 'oracle',
    event_type: expectedTypes(k)[0], event_qualifier: 'actual', company: k.expect.company || null, job_title: k.expect.title || null, job_url: null,
    location: null, work_arrangement: null, sender_name: null, sender_role: k.direction === 'sent' ? 'user' : 'recruiter', dates: [], next_action: null,
    match: { application_id: k.expect.match || null, is_new_application: !k.expect.match, confidence: 'high', reason: 'oracle' },
    evidence: [k.body.slice(0, 60)], missing_information: [], contradictions: [], confidence: 'high', explanation: 'oracle' });
  // Adversarial answers: each dangerous type, confidently asserted, with the best evidence a fooled model could cite.
  const adversarial = [];
  selected.forEach(k => (k.expect.dangerous || []).forEach(t => {
    const j = oracle(k);
    j.event_type = t; j.relevant = true;
    j.company = j.company || 'Acme Robotics';
    j.evidence = [(k.quoted ? k.quoted.replace(/^>\s*/, '') : k.body).slice(0, 80)];
    j.match = { application_id: k.candidates[0] ? k.candidates[0].application_id : null, is_new_application: !k.candidates[0], confidence: 'high', reason: 'adversarial' };
    adversarial.push({ k: Object.assign({}, k, { expect: Object.assign({}, k.expect, { type: t, types: null, dangerous: [t] }) }), o: outcome(k, j) });
  }));
  if (process.env.VERBOSE) selected.forEach(k => { const o = outcome(k, oracle(k)); if (!o.auto) console.log('review:', k.id, '-', o.reasons.concat(o.decision.action === 'review' ? [o.decision.reason] : []).join('; ')); });
  const okOracle = report('Guard evaluation: correct model answers (' + selected.length + ' cases)', score(selected.map(k => ({ k: k, o: outcome(k, oracle(k)) }))));
  const adv = score(adversarial);
  console.log('\n== Guard evaluation: deliberately wrong high-impact answers (' + adversarial.length + ') ==');
  console.log('applied automatically: ' + adv.dangerousAutoApplied.length + (adv.dangerousAutoApplied.length ? ' ' + adv.dangerousAutoApplied.join('; ') : '') +
    ' | stopped for review: ' + adversarial.filter(a => !a.o.auto).length);
  console.log('\nThis mode does not measure model quality. Run with --live and your API key for that.');
  process.exit(okOracle && adv.dangerousAutoApplied.length === 0 ? 0 : 1);
}

// ---------- live ----------
CONFIG.LLM.PROVIDER = process.env.GROQ_API_KEY ? 'groq' : 'anthropic';
const key = process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('Set GROQ_API_KEY (or ANTHROPIC_API_KEY) to run the live evaluation.'); process.exit(2); }
env.props.set(env.x.LLM.provider().keyProperty, key);
if (process.env.EVAL_ENDPOINT) env.x.LLM.provider().endpoint = process.env.EVAL_ENDPOINT;   // only for testing this script
env.ctx.Utilities.sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);   // real wait for rate limits
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-eval-'));
// Synchronous UrlFetchApp shim over curl, so the real llmProvider.gs request/parse code is exercised.
env.ctx.UrlFetchApp = { fetchAll: reqs => reqs.map(r => {
  const hdr = path.join(tmp, 'h');
  fs.writeFileSync(hdr, Object.entries(Object.assign({ 'content-type': r.contentType }, r.headers)).map(([h, v]) => h + ': ' + v).join('\n'), { mode: 0o600 });
  const hdrOut = path.join(tmp, 'resp-headers');
  const p = spawnSync('curl', ['-sS', '-m', '120', '-X', 'POST', r.url, '-H', '@' + hdr, '-D', hdrOut, '--data-binary', '@-', '-w', '\n%{http_code}'], { input: r.payload, encoding: 'utf8', maxBuffer: 1 << 24 });
  fs.unlinkSync(hdr);
  if (p.status !== 0) throw new Error('curl failed: ' + p.stderr.slice(0, 200));
  const i = p.stdout.lastIndexOf('\n');
  const body = p.stdout.slice(0, i), code = Number(p.stdout.slice(i + 1));
  const headers = {};
  if (fs.existsSync(hdrOut)) {
    fs.readFileSync(hdrOut, 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^([^:]+):\s*(.*)$/); if (m) headers[m[1].toLowerCase()] = m[2]; });
    fs.unlinkSync(hdrOut);
  }
  return { getResponseCode: () => code, getContentText: () => body, getHeaders: () => headers };
}) };

LLM.resetStats();
const results = [];
for (const k of selected) {
  const email = toEmail(k);
  const ex = Semantic.pickExamples(email, examples, CONFIG.REVIEW.FEW_SHOT_EXAMPLES);
  const res = LLM.run([Semantic.buildClassifyRequest(email, k.context, k.candidates, ex)])[0];
  const o = res.ok ? outcome(k, res.json) : { invalid: res.error.category + ': ' + res.error.message };
  results.push({ k: k, o: o });
  console.log((o.invalid ? 'ERR ' : (expectedTypes(k).indexOf(o.cls.eventType) !== -1 ? 'ok  ' : 'MISS')) + ' ' + k.id + ' -> ' +
    (o.invalid || o.cls.eventType + '/' + o.cls.qualifier + (o.auto ? ' auto' : ' review: ' + o.reasons.concat(o.decision.action === 'review' ? [o.decision.reason] : []).join('; '))));
}
fs.rmSync(tmp, { recursive: true, force: true });
const s = LLM.stats;
const ok = report('Live evaluation: ' + CONFIG.LLM.PROVIDER + ' ' + env.run('llm_').MODEL + ', prompt ' + env.x.PROMPT_VERSION + (examples.length ? ', ' + examples.length + ' feedback examples' : ''), score(results),
  'model calls ' + s.calls + ', errors ' + s.errors + ', tokens in/out ' + s.inputTokens + '/' + s.outputTokens + ', est. cost $' + s.costUsd.toFixed(4) +
  ', avg latency ' + (s.calls ? Math.round(s.latencyMs / s.calls) : 0) + ' ms');
process.exit(ok ? 0 : 1);
