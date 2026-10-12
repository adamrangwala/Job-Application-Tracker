/**
 * config.gs
 *
 * Every tunable setting lives here. No secrets: the LLM API key is stored in
 * Script Properties (Job Tracker > Setup > Set LLM API key), never in code.
 */

const CONFIG = {
  TABS: {
    APPS: 'Applications',
    EVENTS: 'Email Events',
    REVIEW: 'Review Queue',
    DASHBOARD: 'Dashboard',
    // System tabs (inspectable, not meant for editing except where noted in README)
    QUEUE: 'Work Queue',
    FEEDBACK: 'Feedback Examples',
    LOG: 'Sync Log'
  },

  // Your time zone (IANA name, e.g. 'Asia/Kolkata', 'America/New_York'). Used to read
  // dates/times in emails that do not state a zone. Leave '' to use the script's
  // time zone (Project Settings). Diagnostics warns if script, sheet and this differ.
  USER_TIMEZONE: 'Asia/Kolkata',
  // How to read all-numeric dates like 03/04/2026: '' = never guess (send to review),
  // 'DMY' or 'MDY' = read them that way.
  NUMERIC_DATE_ORDER: 'DMY',

  LLM: {
    // 'groq' (free tier available, https://console.groq.com) or 'anthropic' (paid).
    // The key goes in Script Properties via Job Tracker > Setup > Set LLM API key.
    PROVIDER: 'groq',
    // Per-provider settings. Model IDs come from each provider's documentation:
    //   Groq: https://console.groq.com/docs/models (structured outputs: openai/gpt-oss-20b, openai/gpt-oss-120b)
    //   Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
    PROFILES: {
      groq: {
        MODEL: 'openai/gpt-oss-120b',        // full classification
        TRIAGE_MODEL: 'openai/gpt-oss-20b',  // relevance screen; a different model has its own daily allowance
        EFFORT: 'low',                       // reasoning_effort: low | medium | high
        MAX_TOKENS: 2500,
        TRIAGE_MAX_TOKENS: 2000,
        // Free tier is ~8,000 tokens/minute per model: one request at a time, smaller prompts.
        PARALLEL_REQUESTS: 1,
        TRIAGE_BATCH: 10,
        EMAIL_CHARS: 4000, QUOTED_CHARS: 1000, CONTEXT_MESSAGES: 2, CONTEXT_CHARS: 700
      },
      anthropic: {
        MODEL: 'claude-opus-5-5',
        TRIAGE_MODEL: 'claude-opus-5-5',
        EFFORT: 'low',                       // output_config.effort: low | medium | high | xhigh | max
        MAX_TOKENS: 8000,
        TRIAGE_MAX_TOKENS: 4000,
        USE_FALLBACKS: true,                 // server-side refusal fallback (beta server-side-fallback-2026-07-01)
        PARALLEL_REQUESTS: 4,
        TRIAGE_BATCH: 25,
        EMAIL_CHARS: 8000, QUOTED_CHARS: 3000, CONTEXT_MESSAGES: 3, CONTEXT_CHARS: 1500
      }
    },
    // USD per million tokens, only for cost estimates in Sync Log / dry run.
    // Groq free tier costs nothing (0); fill in paid prices if you upgrade.
    PRICES: {
      'openai/gpt-oss-120b': { input: 0, output: 0 },
      'openai/gpt-oss-20b': { input: 0, output: 0 },
      'claude-opus-5-5': { input: 4.00, output: 20.00 },
      'claude-sonnet-5-5': { input: 2.00, output: 10.00 },
      'claude-haiku-5-5': { input: 0.10, output: 0.50 }
    }
  },

  DISCOVERY: {
    // Backfill scans every message in this date range that matches BACKFILL_QUERY.
    // The query only excludes mail that is structurally not personal correspondence;
    // relevance is decided by the LLM triage, not by keywords.
    BACKFILL_START: '2026-09-15',
    BACKFILL_QUERY: '-in:chats -in:spam -in:trash -category:promotions -category:social -category:forums',
    PAGE_SIZE: 100,
    // Incremental sync reads the Gmail change history (every new message, sent or received).
    // If that history has expired, it falls back to a search starting this many days
    // before the last successful sync.
    FALLBACK_OVERLAP_DAYS: 2,
    // Gmail labels never sent to triage.
    SKIP_LABELS: ['SPAM', 'TRASH', 'DRAFT', 'CHAT'],
    // Known-thread monitoring: threads re-checked per run (rotating), and how long after an
    // application closes its threads are still watched.
    THREADS_PER_RUN: 40,
    WATCH_CLOSED_DAYS: 30
  },

  QUEUE: {
    CLASSIFY_PER_RUN: 40,              // upper bound; the time budget usually stops earlier
    MAX_ATTEMPTS: 5,
    BACKOFF_MINUTES: [5, 30, 120, 480, 1440]
  },

  MAX_RUNTIME_MS: 4.5 * 60 * 1000,     // stop starting new work after this (hard limit is 6 min)
  LOCK_WAIT_MS: 10 * 1000,
  SYNC_EVERY_MINUTES: 30,              // scheduled sync: 5, 10, 15 or 30 (or a multiple of 60)
  DRY_RUN_DEFAULT_MESSAGES: 20,

  REVIEW: {
    // Event types whose effect is hard to undo get stricter checks (see README "Safety checks").
    HIGH_IMPACT: ['OFFER_RECEIVED', 'REJECTION_RECEIVED', 'APPLICATION_WITHDRAWN', 'WITHDRAWAL_REQUESTED'],
    FEW_SHOT_EXAMPLES: 3
  },

  NO_RESPONSE_DAYS: 21,
  FOLLOW_UP_SOON_DAYS: 7,
  LOG_LEVEL: 'INFO',                   // 'DEBUG' | 'INFO' | 'WARN'

  // Hiring platforms: mail from these is about some company's hiring; the platform is the "Job Source".
  PLATFORM_DOMAINS: {
    'greenhouse.io': 'Greenhouse', 'greenhouse-mail.io': 'Greenhouse', 'lever.co': 'Lever',
    'myworkday.com': 'Workday', 'myworkdayjobs.com': 'Workday', 'ashbyhq.com': 'Ashby',
    'smartrecruiters.com': 'SmartRecruiters', 'workablemail.com': 'Workable', 'workable.com': 'Workable',
    'icims.com': 'iCIMS', 'jobvite.com': 'Jobvite', 'successfactors.com': 'SuccessFactors',
    'taleo.net': 'Taleo', 'bamboohr.com': 'BambooHR', 'recruitee.com': 'Recruitee',
    'teamtailor.com': 'Teamtailor', 'hackerrank.com': 'HackerRank', 'hackerrankforwork.com': 'HackerRank',
    'codesignal.com': 'CodeSignal', 'codility.com': 'Codility', 'hirevue.com': 'HireVue',
    'karat.io': 'Karat', 'testgorilla.com': 'TestGorilla', 'calendly.com': 'Calendly',
    'goodtime.io': 'GoodTime', 'linkedin.com': 'LinkedIn', 'indeed.com': 'Indeed', 'indeedemail.com': 'Indeed',
    'glassdoor.com': 'Glassdoor', 'wellfound.com': 'Wellfound', 'joinhandshake.com': 'Handshake',
    'naukri.com': 'Naukri', 'unstop.com': 'Unstop', 'instahyre.com': 'Instahyre', 'cutshort.io': 'Cutshort'
  }
};
