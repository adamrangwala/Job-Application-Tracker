/**
 * extractionUtils.gs
 *
 * Structural helpers only (no meaning is decided here): sender parsing, HTML to
 * text, separating the new part of a message from quoted history, normalization
 * for matching, URL keys, and hashing.
 */

const Extract = {
  /** Parses "Name <a@b.com>" into parts. */
  parseSender: function(from) {
    from = String(from || '');
    const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const email = (m ? m[2] : from).trim().toLowerCase();
    const name = (m ? m[1] : '').trim();
    const valid = /^[^@\s,]+@[^@\s,]+$/.test(email);
    return { name: name, email: valid ? email : '', domain: valid ? email.split('@')[1] : '' };
  },

  /** Platform name for a domain or any parent domain, else ''. */
  platformFor: function(domain) {
    const parts = String(domain || '').toLowerCase().split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts.slice(i).join('.');
      if (CONFIG.PLATFORM_DOMAINS[d]) return CONFIG.PLATFORM_DOMAINS[d];
    }
    return '';
  },

  htmlToText: function(html) {
    return String(html || '')
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '\n[quoted text removed]\n')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  },

  /**
   * Splits a plain-text body into the sender's new text and quoted history.
   * Forwarded mail with no new text of its own: the forwarded part becomes
   * "current" and forwarded=true (the model is told it is a forward).
   */
  splitQuoted: function(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    const markers = [
      /^[ \t]*On [^\n]{0,200}(\n[^\n]{0,200})?wrote:[ \t]*$/m,
      /^[ \t]*-{2,}\s*Original Message\s*-{2,}/mi,
      /^[ \t]*From:[^\n]+\n(?:[^\n]*\n){0,3}?[ \t]*(Sent|Date):/mi,
      /^[ \t]*_{10,}[ \t]*$/m,
      /^[ \t]*-{2,}\s*Forwarded message\s*-{2,}/mi
    ];
    let cut = text.length;
    markers.forEach(re => { const i = text.search(re); if (i !== -1 && i < cut) cut = i; });
    const head = text.slice(0, cut).split('\n');
    const isQuote = l => /^[ \t]*>/.test(l);
    let current = head.filter(l => !isQuote(l)).join('\n').trim();
    let quoted = (head.filter(isQuote).join('\n') + '\n' + text.slice(cut)).trim();
    let forwarded = false;
    if (/^[ \t]*-{2,}\s*Forwarded message/i.test(text.slice(cut, cut + 80)) && current.replace(/\s/g, '').length < 40) {
      forwarded = true;
      current = text.slice(cut).replace(/^.*\n/, '').split('\n').filter(l => !isQuote(l)).join('\n').trim();
      quoted = '';
    }
    return { current: current, quoted: quoted, forwarded: forwarded };
  },

  normalizeCompany: function(name) {
    return String(name || '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\b(the|inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pvt|private|pte|ag|sa|bv)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  },

  normalizeTitle: function(title) {
    const synonyms = {
      engineering: 'engineer', internship: 'intern', sr: 'senior', jr: 'junior', swe: 'software engineer',
      sde: 'software development engineer', dev: 'developer', ii: '2', iii: '3', i: '1', coop: 'co op'
    };
    return String(title || '').toLowerCase()
      .replace(/\((?:[^)]*\d[^)]*)\)/g, ' ')
      .replace(/[^a-z0-9+# ]+/g, ' ')
      .split(/\s+/).filter(Boolean)
      .map(w => synonyms[w] || w)
      .filter(w => !/^(the|a|an|position|role|job|opening|opportunity|req|requisition)$/.test(w))
      .join(' ').trim();
  },

  tokens: function(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
  },

  /** Jaccard similarity of two strings' word sets, 0..1. */
  similarity: function(a, b) {
    const A = new Set(this.tokens(a)), B = new Set(this.tokens(b));
    if (!A.size || !B.size) return 0;
    let both = 0;
    A.forEach(w => { if (B.has(w)) both++; });
    return both / (A.size + B.size - both);
  },

  /** Comparable key for a job URL: host + path, no query/fragment/trailing slash. */
  urlKey: function(url) {
    const m = String(url || '').toLowerCase().match(/^https?:\/\/(?:www\.)?([^/?#\s]+)([^?#\s]*)/);
    return m ? (m[1] + m[2]).replace(/\/+$/, '') : '';
  },

  /** True when a quoted evidence snippet really occurs in the text (case/whitespace-insensitive). */
  occursIn: function(snippet, text) {
    const norm = s => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[^a-z0-9'" ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const n = norm(snippet);
    return n.length >= 8 && norm(text).indexOf(n) !== -1;
  },

  sha256: function(s) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
      .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  },

  /**
   * Raw Gmail message -> normalized message used by the pipeline.
   * raw: {id, threadId, internalDate, from, to, subject, plainBody, htmlBody, labelIds}
   */
  parseEmail: function(raw, myAddress) {
    if (!raw || !raw.id) throw new Error('Malformed email: missing message id');
    const sender = this.parseSender(raw.from);
    const labels = raw.labelIds || [];
    const body = raw.plainBody ? String(raw.plainBody) : this.htmlToText(raw.htmlBody);
    const parts = this.splitQuoted(body.slice(0, 60000));
    const date = new Date(Number(raw.internalDate) || NaN);
    const sent = labels.indexOf('SENT') !== -1 || (!!myAddress && !!sender.email && sender.email === String(myAddress).toLowerCase());
    return {
      messageId: String(raw.id),
      threadId: String(raw.threadId || ''),
      date: isNaN(date) ? null : date,
      direction: sent ? 'sent' : 'received',
      sender: sender,
      to: String(raw.to || '').slice(0, 300),
      subject: String(raw.subject || '').slice(0, 500),
      current: parts.current.slice(0, 8000),
      quoted: parts.quoted.slice(0, 3000),
      forwarded: parts.forwarded,
      labels: labels,
      source: this.platformFor(sender.domain) || 'Email'
    };
  }
};
