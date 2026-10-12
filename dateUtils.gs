/**
 * dateUtils.gs
 *
 * The model reads dates in context and reports the local wall-clock date/time
 * plus the time zone it believes applies, with the original text. This file
 * checks that interpretation deterministically and converts it to an instant:
 *  - ambiguous all-numeric dates (03/04/2026), unless NUMERIC_DATE_ORDER is set
 *  - relative dates ("tomorrow", "next Monday") re-resolved from the email's own timestamp
 *  - dates with no year far from the email date
 *  - ambiguous zone abbreviations (IST, CST, BST, ...) without a stated basis
 *  - wall times that do not exist in the zone (daylight-saving gaps)
 * Anything that fails a check is returned with a review reason instead of a value.
 */

const AMBIGUOUS_TZ_ABBREVIATIONS = ['IST', 'CST', 'BST', 'AST', 'GST', 'SST', 'ECT', 'MST', 'CDT', 'PST'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const Dates = {
  userTz: function() {
    return CONFIG.USER_TIMEZONE || Session.getScriptTimeZone();
  },

  isOffset: function(tz) { return /^(?:UTC|GMT)?[+-]\d{2}:?\d{2}$/.test(String(tz)); },
  isUtc: function(tz) { return /^(Z|UTC|GMT|Etc\/UTC|Etc\/GMT)$/.test(String(tz)); },
  isIana: function(tz) { return /^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(String(tz)); },

  offsetMinutesOfLiteral: function(tz) {
    const m = String(tz).match(/([+-])(\d{2}):?(\d{2})$/);
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  },

  /** Utilities.formatDate in a zone; fixed offsets are applied arithmetically. */
  fmt: function(ms, tz, pattern) {
    if (this.isUtc(tz)) return Utilities.formatDate(new Date(ms), 'UTC', pattern);
    if (this.isOffset(tz)) return Utilities.formatDate(new Date(ms + this.offsetMinutesOfLiteral(tz) * 60000), 'UTC', pattern);
    return Utilities.formatDate(new Date(ms), tz, pattern);
  },

  offsetMinutes: function(ms, tz) {
    if (this.isUtc(tz)) return 0;
    if (this.isOffset(tz)) return this.offsetMinutesOfLiteral(tz);
    const s = Utilities.formatDate(new Date(ms), tz, 'XXX');
    return s === 'Z' ? 0 : this.offsetMinutesOfLiteral(s);
  },

  /** Wall-clock date/time in a zone -> epoch ms, or {gap:true} when that time does not exist. */
  zonedToUtc: function(dateStr, timeStr, tz) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [h, mi] = (timeStr || '00:00').split(':').map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi);
    let t = wall - this.offsetMinutes(wall, tz) * 60000;
    t = wall - this.offsetMinutes(t, tz) * 60000;
    const back = this.fmt(t, tz, 'yyyy-MM-dd HH:mm');
    return back === dateStr + ' ' + (timeStr || '00:00') ? { ms: t } : { gap: true };
  },

  isoWithOffset: function(ms, tz) {
    const off = this.offsetMinutes(ms, tz);
    const sign = off < 0 ? '-' : '+';
    const a = Math.abs(off);
    return this.fmt(ms, tz, "yyyy-MM-dd'T'HH:mm:ss") + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
  },

  addDays: function(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  },

  /**
   * Dates a relative expression can mean, resolved from the email's own send time
   * in the given zone. Returns null when no supported relative expression is present.
   */
  relativeCandidates: function(text, emailMs, tz) {
    const t = String(text || '').toLowerCase();
    const today = this.fmt(emailMs, tz, 'yyyy-MM-dd');
    const dow = WEEKDAYS.indexOf(this.fmt(emailMs, tz, 'EEEE').toLowerCase());
    if (/\bday after tomorrow\b/.test(t)) return [this.addDays(today, 2)];
    if (/\btomorrow\b/.test(t)) return [this.addDays(today, 1)];
    if (/\b(today|tonight|this (?:morning|afternoon|evening))\b/.test(t)) return [today];
    const m = t.match(/\b(next|this|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (!m) return null;
    let ahead = (WEEKDAYS.indexOf(m[2]) - dow + 7) % 7;
    if (m[1] === 'next') {
      // "next Friday" is read both ways in practice: the coming one or the one after.
      if (ahead === 0) ahead = 7;
      return [this.addDays(today, ahead), this.addDays(today, ahead + 7)];
    }
    if (ahead === 0) return [today, this.addDays(today, 7)];
    return [this.addDays(today, ahead)];
  },

  /**
   * Validates one model-reported date against the email it came from.
   * d: {kind, source_text, local_date, local_time, timezone, timezone_basis, relative_to_email, ambiguous, status}
   * Returns {value: Date|null, dateOnly, iso, display, tz, review: string|null}
   */
  resolve: function(d, emailDate) {
    const reasons = [];
    const src = String(d.source_text || '');
    const out = { value: null, dateOnly: !d.local_time, iso: '', display: '', tz: '', review: null, kind: d.kind, status: d.status };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.local_date || ''))) { out.review = 'No usable date in "' + src.slice(0, 60) + '"'; return out; }
    const [y, mo, da] = d.local_date.split('-').map(Number);
    if (new Date(Date.UTC(y, mo - 1, da)).getUTCDate() !== da) { out.review = 'Impossible date ' + d.local_date; return out; }
    if (d.local_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.local_time)) { out.review = 'Unreadable time "' + d.local_time + '"'; return out; }

    let tz = d.timezone ? String(d.timezone).trim() : '';
    let basis = d.timezone_basis ? String(d.timezone_basis) : '';
    if (tz && !this.isOffset(tz) && !this.isUtc(tz) && !this.isIana(tz)) reasons.push('Unrecognised time zone "' + tz + '"');
    if (!tz) { tz = this.userTz(); basis = 'assumed your time zone'; }
    const abbr = (src.match(/\b[A-Z]{2,5}\b/g) || []).find(a => AMBIGUOUS_TZ_ABBREVIATIONS.indexOf(a) !== -1);
    if (abbr && !d.timezone_basis) reasons.push('"' + abbr + '" can mean several time zones and no basis was given');
    if (d.ambiguous) reasons.push('Model marked the date as ambiguous');

    const numeric = src.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/);
    if (numeric) {
      const a = Number(numeric[1]), b = Number(numeric[2]);
      if (a <= 12 && b <= 12 && a !== b) {
        const order = CONFIG.NUMERIC_DATE_ORDER;
        if (!order) reasons.push('"' + numeric[0] + '" could be day/month or month/day');
        else {
          const [mm, dd] = order === 'DMY' ? [b, a] : [a, b];
          if (mm !== mo || dd !== da) reasons.push('"' + numeric[0] + '" read as ' + order + ' does not match ' + d.local_date);
        }
      }
    }

    const emailMs = emailDate ? emailDate.getTime() : null;
    if (emailMs !== null) {
      const rel = this.relativeCandidates(src, emailMs, this.isIana(tz) || this.isOffset(tz) || this.isUtc(tz) ? tz : this.userTz());
      if (rel && rel.indexOf(d.local_date) === -1) reasons.push('"' + src.slice(0, 40) + '" relative to the email date means ' + rel.join(' or ') + ', not ' + d.local_date);
      if (!rel && !/\b(19|20)\d{2}\b/.test(src)) {
        const diffDays = (Date.UTC(y, mo - 1, da) - emailMs) / 864e5;
        if (diffDays < -2 || diffDays > 300) reasons.push('No year in "' + src.slice(0, 40) + '" and ' + d.local_date + ' is far from the email date');
      }
    }

    if (!reasons.length) {
      const z = this.zonedToUtc(d.local_date, d.local_time || '00:00', d.local_time ? tz : this.userTz());
      if (z.gap) reasons.push(d.local_date + ' ' + d.local_time + ' does not exist in ' + tz + ' (daylight-saving change)');
      else {
        out.value = new Date(z.ms);
        out.iso = d.local_time ? this.isoWithOffset(z.ms, tz) : d.local_date;
        out.tz = d.local_time ? tz : '';
      }
    }
    out.display = (out.iso || d.local_date + (d.local_time ? ' ' + d.local_time : '')) + (d.local_time ? ' [' + tz + (basis ? '; ' + basis : '') + ']' : '') + ' from "' + src.slice(0, 80) + '"';
    out.review = reasons.length ? reasons.join('; ') : null;
    return out;
  }
};
