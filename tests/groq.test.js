// Groq provider: request shape, response/error handling, rate-limit pacing, and a full
// pipeline run with the Groq profile (scripted model, fake services).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, makeGmail, makeUrlFetch, groqOk, FakeSpreadsheet } = require('./harness');
const { F, scriptedModel, ME } = require('./fixtures');

const KEY = 'gsk_test0000000000000000000000000000';
const plain = v => JSON.parse(JSON.stringify(v));

function providerEnv(responses) {
  const env = createEnv({ config: { USER_TIMEZONE: 'Asia/Kolkata' } });   // default provider: groq
  env.props.set('GROQ_API_KEY', KEY);
  const f = makeUrlFetch(() => responses.shift());
  env.ctx.UrlFetchApp = f;
  return { env, f };
}
const req = { model: 'openai/gpt-oss-120b', maxTokens: 2500, system: 'sys', user: 'u', schema: { type: 'object' } };
const err = (status, message, code, headers) => ({ status, headers: headers || {}, body: { error: { message, type: 'invalid_request_error', code } } });

test('Groq is the default provider and its profile is used', () => {
  const env = createEnv();
  assert.equal(env.x.CONFIG.LLM.PROVIDER, 'groq');
  assert.equal(env.run('llm_').MODEL, 'openai/gpt-oss-120b');
  assert.equal(env.run('llm_').TRIAGE_MODEL, 'openai/gpt-oss-20b');
});

test('request: OpenAI-compatible body with strict JSON schema, bearer key', () => {
  const { env, f } = providerEnv([groqOk({ ok: true })]);
  const out = env.x.LLM.run([req]);
  assert.equal(out[0].ok, true);
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer ' + KEY);
  assert.deepEqual(plain(call.body.messages.map(m => m.role)), ['system', 'user']);
  assert.deepEqual(plain(call.body.response_format), { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: { type: 'object' } } });
  assert.equal(call.body.reasoning_effort, 'low');
  assert.equal(call.body.include_reasoning, false);
  assert.equal(call.body.max_completion_tokens, 2500);
  assert.equal(out[0].costUsd, 0, 'free tier priced at 0');
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('errors are categorised', () => {
  const { env } = providerEnv([
    err(400, 'Generated JSON does not match the expected schema. Please adjust your prompt.', 'json_validate_failed'),
    err(401, 'Invalid API Key', 'invalid_api_key'),
    err(413, 'Request too large for model', 'request_too_large'),
    err(503, 'Service Unavailable'),
    { status: 200, body: { model: 'openai/gpt-oss-120b', choices: [{ finish_reason: 'length', message: { content: '{"a":' } }], usage: {} } },
    groqOk('{not json'),
    err(429, 'Rate limit reached', 'rate_limit_exceeded', { 'retry-after': '120' })
  ]);
  const out = env.x.LLM.run([req, req, req, req, req, req, req]);
  assert.deepEqual(plain(out.map(o => o.ok ? 'ok' : o.error.category)), ['invalid_output', 'config', 'permanent', 'transient', 'invalid_output', 'invalid_output', 'rate_limit']);
  assert.equal(out[6].error.retryAfterSec, 120, 'long waits go back to the queue');
  assert.deepEqual(plain(env.sleeps), []);
});

test('short 429 waits are slept through once; nearly exhausted token window is waited out', () => {
  const { env, f } = providerEnv([
    err(429, 'Rate limit reached', 'rate_limit_exceeded', { 'retry-after': '7' }),
    groqOk({ ok: 1 }, null, { 'x-ratelimit-remaining-tokens': '1200', 'x-ratelimit-reset-tokens': '6.5s' }),
    groqOk({ ok: 2 })
  ]);
  const out = env.x.LLM.run([req, req]);
  assert.deepEqual(plain(out.map(o => o.ok)), [true, true]);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(plain(env.sleeps), [7000, 6500]);
});

test('no Groq key: config error, no request', () => {
  const { env, f } = providerEnv([]);
  env.props.delete('GROQ_API_KEY');
  assert.equal(env.x.LLM.run([req])[0].error.category, 'config');
  assert.equal(f.calls.length, 0);
  assert.equal(env.x.LLM.hasKey(), false);
});

test('Set LLM API key validates and stores a Groq key under GROQ_API_KEY', () => {
  const env = createEnv({ prompts: ['sk-ant-wrong-provider-key-000000000000'] });
  env.run('setApiKey');
  assert.equal(env.props.has('GROQ_API_KEY'), false);
  const env2 = createEnv({ props: env.props, prompts: [KEY] });
  env2.run('setApiKey');
  assert.equal(env.props.get('GROQ_API_KEY'), KEY);
});

test('prompts are trimmed to the Groq profile budget', () => {
  const env = createEnv({ config: { USER_TIMEZONE: 'Asia/Kolkata' } });
  const long = 'x'.repeat(20000);
  const email = { messageId: 'm', threadId: 't', date: new Date('2026-03-09T05:30:00Z'), direction: 'received', sender: { name: '', email: 'a@b.example', domain: 'b.example' },
    to: '', subject: 's', current: long, quoted: long, forwarded: false, labels: [] };
  const r = env.x.Semantic.buildClassifyRequest(email, [], [], []);
  assert.ok(r.user.length < 4000 + 1000 + 1500, 'user prompt ' + r.user.length + ' chars');
  assert.equal(r.model, 'openai/gpt-oss-120b');
});

test('full pipeline with the Groq profile', () => {
  const mailbox = [F.acmeConfirm(), F.acmeDataConfirm(), F.acmeInterviewIndirect(), F.acmeScheduledNoKeywords(), F.acmeOffer(),
    F.globexUnusual(), F.globexRejection(), F.jobAlert(), F.quotedRejectionMisread()];
  const ss = new FakeSpreadsheet();
  const props = new Map([['GROQ_API_KEY', KEY]]);
  const gmail = makeGmail(mailbox, ME);
  const fetch = makeUrlFetch(scriptedModel(mailbox, createEnv().x));
  const mk = () => createEnv({ ss, props, gmail, fetch, config: { USER_TIMEZONE: 'Asia/Kolkata', NUMERIC_DATE_ORDER: '', DISCOVERY: { BACKFILL_START: '2026-01-01', PAGE_SIZE: 100 } } });
  mk().run('setupWorkbook_', ss);
  mk().run('startBackfill');
  const apps = ss.tab('Applications').records();
  const st = (c, t) => apps.find(a => a.Company === c && a['Job Title'] === t)['Current Status'];
  assert.equal(apps.length, 3);
  assert.equal(st('Acme Robotics', 'Software Engineer Intern'), 'Offer');
  assert.equal(st('Acme Robotics', 'Data Analyst Intern'), 'Applied');
  assert.equal(st('Globex', 'Backend Developer (Graduate)'), 'Rejected');
  assert.ok(fetch.calls.every(c => c.body.response_format && /gpt-oss/.test(c.body.model)));
  const triage = fetch.calls.filter(c => c.body.response_format.json_schema.schema.properties.results);
  assert.ok(triage.every(c => c.body.model === 'openai/gpt-oss-20b'));
  assert.ok(triage.every(c => JSON.parse(c.body.messages[1].content.match(/<messages>\n([\s\S]*)\n<\/messages>/)[1]).length <= 10), 'triage batch of 10');
  assert.ok(ss.tab('Review Queue').records().some(r => /No supporting quote/.test(r['Review Reason'])));
  const log = ss.tab('Sync Log').records().slice(-1)[0];
  assert.equal(log['Est. Cost USD'], 0);
});
