/**
 * statusUtils.gs
 *
 * Code-side rules around the model's interpretation. Pure functions.
 *  - Status.reviewReasons(): safety checks deciding whether an interpreted event may be
 *    applied automatically or must be reviewed.
 *  - Status.derive(): the current status of an application from its whole event history,
 *    in chronological order. Re-deriving from history (instead of patching a status cell)
 *    means late-arriving or reprocessed messages cannot corrupt the status.
 */

const STATUSES = ['Applied', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];

// Status an *actual* event implies. Events not listed (outreach, cancellations, document
// requests, other) are kept in history but do not change the status.
const EVENT_STATUS = {
  APPLICATION_SUBMITTED: 'Applied',
  APPLICATION_CONFIRMATION: 'Applied',
  ASSESSMENT_INVITATION: 'Assessment',
  ASSESSMENT_REMINDER: 'Assessment',
  INTERVIEW_INVITATION: 'Interview',
  INTERVIEW_SCHEDULED: 'Interview',
  INTERVIEW_UPDATED: 'Interview',
  INTERVIEW_COMPLETED: 'Interview',
  OFFER_RECEIVED: 'Offer',
  REJECTION_RECEIVED: 'Rejected',
  APPLICATION_WITHDRAWN: 'Withdrawn',
  WITHDRAWAL_REQUESTED: 'Withdrawn'    // only when the user sent it (see effect())
};

const NON_APPLICATION_TYPES = ['RECRUITER_OUTREACH', 'JOB_ADVERTISEMENT', 'UNRELATED'];

const Status = {
  /** Status implied by one event, or null. */
  effect: function(ev) {
    if (ev.qualifier !== 'actual') return null;
    if (ev.type === 'WITHDRAWAL_REQUESTED' && ev.direction !== 'sent') return null;
    return EVENT_STATUS[ev.type] || null;
  },

  /**
   * events: [{id, type, qualifier, direction, at (ms), confirmed (user-approved)}]
   * Returns {status, eventId, conflicts: [{eventId, reason}]}.
   */
  derive: function(events) {
    const RANK = { Applied: 1, Assessment: 2, Interview: 3, Offer: 4 };
    const closed = s => s === 'Rejected' || s === 'Withdrawn';
    const sorted = events.slice().sort((a, b) => (a.at - b.at) || String(a.id).localeCompare(String(b.id)));
    let status = null, eventId = null;
    const conflicts = [];
    const set = ev => { status = Status.effect(ev); eventId = ev.id; };
    for (const ev of sorted) {
      const s = Status.effect(ev);
      if (!s || s === status) continue;
      if (!status) set(ev);
      else if (closed(s)) {
        if (status === 'Offer' && s === 'Rejected' && !ev.confirmed) conflicts.push({ eventId: ev.id, reason: 'Rejection after an offer' });
        else set(ev);
      } else if (closed(status)) {
        if (s === 'Applied') continue;   // routine acknowledgement after closing
        if (ev.confirmed) set(ev);
        else conflicts.push({ eventId: ev.id, reason: s + ' after the application was ' + status });
      } else if (RANK[s] > RANK[status]) set(ev);
      // else: lower stage after a higher one (e.g. late confirmation) - no downgrade
    }
    return { status: status, eventId: eventId, conflicts: conflicts };
  },

  /**
   * High-impact events must come from someone plausibly speaking for the employer: the user,
   * a hiring platform, the application's known thread or recruiter domain, or a domain that
   * contains the company name. Blocks e.g. an injected "offer" from an unrelated sender.
   */
  senderPlausible: function(email, company, app, threadLinked) {
    if (email.direction === 'sent' || threadLinked || Extract.platformFor(email.sender.domain)) return true;
    const domain = String(email.sender.domain || '').toLowerCase();
    if (!domain) return false;
    if (app && app['Recruiter Email'] && String(app['Recruiter Email']).toLowerCase().split('@')[1] === domain) return true;
    const label = domain.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/, '').replace(/[^a-z0-9]/g, '');
    const words = Extract.normalizeCompany(company || (app && app['Company'])).split(' ').filter(w => w.length >= 3);
    return words.length > 0 && (words.some(w => label.indexOf(w) !== -1) || label.indexOf(words.join('')) !== -1);
  },

  /**
   * Reasons this interpreted message must not be applied automatically ([] = safe).
   * cls: validated classification; email: parsed email.
   */
  reviewReasons: function(cls, email) {
    const r = [];
    const high = CONFIG.REVIEW.HIGH_IMPACT.indexOf(cls.eventType) !== -1;
    if (cls.eventType === 'NEEDS_REVIEW') r.push('Model could not determine the meaning');
    if (!cls.relevant && EVENT_STATUS[cls.eventType]) r.push('Marked not relevant but typed as ' + cls.eventType);
    if (cls.confidence === 'low') r.push('Model confidence is low');
    if (high && cls.confidence !== 'high') r.push(cls.eventType + ' needs high confidence');
    if (high && cls.qualifier === 'actual' && !cls.evidence.some(e => Extract.occursIn(e, email.current))) {
      r.push('No supporting quote found in the new part of the message');
    }
    if (high && email.forwarded) r.push('Outcome found in a forwarded message');
    if (['OFFER_RECEIVED', 'REJECTION_RECEIVED', 'APPLICATION_WITHDRAWN'].indexOf(cls.eventType) !== -1 && email.direction === 'sent') {
      r.push('Employer outcome in a message the user sent');
    }
    if (cls.eventType === 'WITHDRAWAL_REQUESTED' && email.direction !== 'sent') r.push('Withdrawal request not sent by the user');
    if (cls.contradictions.length) r.push('Contradictions: ' + cls.contradictions.join('; '));
    if (cls.qualifier === 'unclear' && EVENT_STATUS[cls.eventType]) r.push('Unclear whether the event actually happened');
    return r;
  }
};
