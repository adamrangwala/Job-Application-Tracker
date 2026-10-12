/**
 * llmProvider.gs
 *
 * Small provider interface: LLM.run(requests) sends structured-output requests and
 * returns parsed JSON or a categorised error per request. Two providers:
 *   groq       OpenAI-compatible chat completions, strict JSON schema (free tier available)
 *   anthropic  Messages API with output_config.format
 * Both are called with UrlFetchApp (Apps Script cannot load npm SDKs). API keys are read
 * from Script Properties and never logged.
 *
 * request:  {model, maxTokens, system, user, schema}
 * result:   {ok, json, model, usage: {input, output, cacheRead, cacheWrite}, latencyMs, costUsd,
 *            error: {category, message, retryAfterSec}}
 * error categories: rate_limit | transient | invalid_output | refusal | config | permanent
 */

/** Settings of the selected provider (CONFIG.LLM.PROFILES[PROVIDER]). */
function llm_() {
  const p = CONFIG.LLM.PROFILES[CONFIG.LLM.PROVIDER];
  if (!p) throw new Error('Unknown LLM provider "' + CONFIG.LLM.PROVIDER + '" in config.gs');
  return p;
}

const LLM = {
  stats: { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 },

  resetStats: function() {
    this.stats = { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 };
  },

  provider: function() {
    const p = LLM_PROVIDERS[CONFIG.LLM.PROVIDER];
    if (!p) throw new Error('Unknown LLM provider "' + CONFIG.LLM.PROVIDER + '" in config.gs');
    return p;
  },

  run: function(requests) {
    const p = this.provider();
    const key = PropertiesService.getScriptProperties().getProperty(p.keyProperty);
    const results = key ? p.run(requests, key)
      : requests.map(() => ({ ok: false, error: { category: 'config', message: 'No ' + p.label + ' API key: Job Tracker > Setup > Set LLM API key' } }));
    results.forEach(r => {
      if (r.ok || r.usage) {
        const price = CONFIG.LLM.PRICES[r.model];
        const u = r.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        // ponytail: estimate only (cache write ~1.25x, read ~0.1x of input price); fallback billing is not modelled.
        r.costUsd = price ? ((u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1) * price.input + u.output * price.output) / 1e6 : 0;
      }
      this.stats.calls++;
      if (!r.ok) this.stats.errors++;
      if (r.usage) { this.stats.inputTokens += r.usage.input + r.usage.cacheRead + r.usage.cacheWrite; this.stats.outputTokens += r.usage.output; }
      this.stats.latencyMs += r.latencyMs || 0;
      this.stats.costUsd += r.costUsd || 0;
    });
    return results;
  },

  hasKey: function() {
    return !!PropertiesService.getScriptProperties().getProperty(this.provider().keyProperty);
  }
};

/** Shared HTTP-status categorisation. */
function httpFailure_(code, message, retryAfterSec, latencyMs) {
  const category = code === 429 ? 'rate_limit' : code >= 500 ? 'transient'
    : [400, 401, 402, 403, 404].indexOf(code) !== -1 ? 'config' : 'permanent';
  return { ok: false, latencyMs: latencyMs, error: { category: category, message: String(message).slice(0, 300), retryAfterSec: retryAfterSec || 0 } };
}

function header_(resp, name) {
  const h = resp.getHeaders ? resp.getHeaders() : {};
  const k = Object.keys(h).find(x => x.toLowerCase() === name);
  return k ? String(h[k]) : '';
}

/** "7.66s", "2m59.56s", "120ms" -> seconds. */
function durationSec_(s) {
  let t = 0;
  String(s || '').replace(/(\d+(?:\.\d+)?)(ms|h|m|s)/g, (all, n, u) => { t += Number(n) * ({ ms: 0.001, s: 1, m: 60, h: 3600 })[u]; return all; });
  return t;
}

// Anthropic models that accept fallbacks: "default" (server-side refusal fallback).
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

const LLM_PROVIDERS = {
  groq: {
    label: 'Groq',
    keyProperty: 'GROQ_API_KEY',
    keyPattern: /^gsk_[A-Za-z0-9]{20,}$/,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    maxWaitSec: 30,   // longest in-run wait for a rate-limit window; longer waits go back to the queue

    request: function(req, key) {
      const effort = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }[llm_().EFFORT] || 'low';
      const body = {
        model: req.model,
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
        max_completion_tokens: req.maxTokens,
        reasoning_effort: effort,
        include_reasoning: false,
        response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: req.schema } }
      };
      return { url: this.endpoint, method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key },
        payload: JSON.stringify(body), muteHttpExceptions: true };
    },

    /** Sequential, pacing itself from Groq's x-ratelimit headers so the free tier's per-minute limit is respected. */
    run: function(requests, key) {
      const out = [];
      for (const req of requests) {
        let res = null;
        for (let attempt = 0; attempt < 2 && !res; attempt++) {
          const started = Date.now();
          let resp;
          try {
            resp = UrlFetchApp.fetchAll([this.request(req, key)])[0];
          } catch (e) {
            res = { ok: false, latencyMs: Date.now() - started, error: { category: 'transient', message: 'Network: ' + String(e && e.message || e).replace(key, '[key]').slice(0, 200) } };
            break;
          }
          const latency = Date.now() - started;
          const retryAfter = Number(header_(resp, 'retry-after')) || 0;
          if (resp.getResponseCode() === 429 && attempt === 0 && retryAfter > 0 && retryAfter <= this.maxWaitSec) {
            Utilities.sleep(retryAfter * 1000);
            continue;
          }
          res = this.parse(resp, req, latency, retryAfter);
          // Wait out a nearly exhausted per-minute token window before the next request.
          const remaining = Number(header_(resp, 'x-ratelimit-remaining-tokens'));
          const reset = durationSec_(header_(resp, 'x-ratelimit-reset-tokens'));
          if (header_(resp, 'x-ratelimit-remaining-tokens') && remaining < 4000 && reset > 0 && reset <= this.maxWaitSec) Utilities.sleep(Math.ceil(reset * 1000));
        }
        out.push(res);
      }
      return out;
    },

    parse: function(resp, req, latencyMs, retryAfter) {
      const code = resp.getResponseCode();
      let body = null;
      try { body = JSON.parse(resp.getContentText()); } catch (e) { /* handled below */ }
      const errMsg = body && body.error ? (body.error.code || body.error.type || '') + ' - ' + body.error.message : 'no error body';
      if (code !== 200) {
        if (code === 400 && /does not match the expected schema|json_validate_failed/i.test(errMsg)) {
          return { ok: false, latencyMs: latencyMs, error: { category: 'invalid_output', message: 'HTTP 400: ' + errMsg.slice(0, 250) } };
        }
        if (code === 413) return { ok: false, latencyMs: latencyMs, error: { category: 'permanent', message: 'HTTP 413: request larger than the model allows: ' + errMsg.slice(0, 200) } };
        return httpFailure_(code, 'HTTP ' + code + ': ' + errMsg, retryAfter, latencyMs);
      }
      if (!body || !body.choices || !body.choices[0]) return { ok: false, latencyMs: latencyMs, error: { category: 'invalid_output', message: 'Unexpected response shape' } };
      const u = body.usage || {};
      const base = { latencyMs: latencyMs, model: body.model || req.model,
        usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cacheRead: 0, cacheWrite: 0 } };
      const choice = body.choices[0];
      if (choice.finish_reason === 'length') return Object.assign(base, { ok: false, error: { category: 'invalid_output', message: 'Output hit max_completion_tokens' } });
      try { return Object.assign(base, { ok: true, json: JSON.parse(choice.message && choice.message.content) }); }
      catch (e) { return Object.assign(base, { ok: false, error: { category: 'invalid_output', message: 'Output was not valid JSON' } }); }
    }
  },

  anthropic: {
    label: 'Anthropic',
    keyProperty: 'ANTHROPIC_API_KEY',
    keyPattern: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
    endpoint: 'https://api.anthropic.com/v1/messages',

    request: function(req, key) {
      const body = {
        model: req.model,
        max_tokens: req.maxTokens,
        // Static instructions first so the prefix can be cached across calls.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: llm_().EFFORT, format: { type: 'json_schema', schema: req.schema } }
      };
      const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      if (llm_().USE_FALLBACKS && FALLBACK_MODELS.indexOf(req.model) !== -1) {
        body.fallbacks = 'default';
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      }
      return { url: this.endpoint, method: 'post', contentType: 'application/json', headers: headers,
        payload: JSON.stringify(body), muteHttpExceptions: true };
    },

    run: function(requests, key) {
      const out = [];
      const size = Math.max(1, llm_().PARALLEL_REQUESTS);
      for (let i = 0; i < requests.length; i += size) {
        const chunk = requests.slice(i, i + size);
        const started = Date.now();
        let responses;
        try {
          responses = UrlFetchApp.fetchAll(chunk.map(r => this.request(r, key)));
        } catch (e) {
          // Network failure / UrlFetch timeout affects the whole chunk.
          const msg = String(e && e.message || e).replace(key, '[key]').slice(0, 200);
          chunk.forEach(() => out.push({ ok: false, latencyMs: Date.now() - started, error: { category: 'transient', message: 'Network: ' + msg } }));
          continue;
        }
        const elapsed = Date.now() - started;
        responses.forEach((resp, j) => out.push(this.parse(resp, chunk[j], elapsed)));
      }
      return out;
    },

    parse: function(resp, req, latencyMs) {
      const code = resp.getResponseCode();
      let body = null;
      try { body = JSON.parse(resp.getContentText()); } catch (e) { /* handled below */ }
      if (code !== 200) {
        const msg = 'HTTP ' + code + ': ' + (body && body.error ? body.error.type + ' - ' + body.error.message : 'no error body');
        return httpFailure_(code, msg, Number(header_(resp, 'retry-after')) || 0, latencyMs);
      }
      const fail = (category, message) => ({ ok: false, latencyMs: latencyMs, error: { category: category, message: message } });
      if (!body) return fail('invalid_output', 'Response was not JSON');
      const u = body.usage || {};
      const base = { latencyMs: latencyMs, model: body.model || req.model, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 } };
      if (body.stop_reason === 'refusal') return Object.assign(base, fail('refusal', 'Model declined (' + ((body.stop_details && body.stop_details.category) || 'no category') + ')'));
      if (body.stop_reason === 'max_tokens') return Object.assign(base, fail('invalid_output', 'Output hit max_tokens'));
      const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      try { return Object.assign(base, { ok: true, json: JSON.parse(text) }); }
      catch (e) { return Object.assign(base, fail('invalid_output', 'Output was not valid JSON')); }
    }
  }
};
