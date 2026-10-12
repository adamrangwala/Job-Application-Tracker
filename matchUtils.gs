/**
 * matchUtils.gs
 *
 * Application identity. Code picks the candidate applications shown to the model,
 * and code makes the final decision; the model's proposed match is one input that
 * must agree with the extracted company/title. Pure functions.
 *
 * Decision order (first rule that decides wins):
 *  1. Gmail thread already linked to exactly one application (unless the email clearly
 *     concerns a different role, or the model confidently names another candidate -> review).
 *  2. Same job URL.
 *  3. Model-proposed candidate, if its company and title agree with the email's (offers, rejections and
 *     withdrawals must also state the role here).
 *  4. Same normalized company AND title.
 *  5. Same company, but no title or only a similar title          -> review
 *  6. Company + title known, nothing matches, status-bearing event -> new application
 *  7. Otherwise                                                     -> review
 * Company alone never merges two applications.
 */

const Matcher = {
  /**
   * Up to `limit` existing applications that may relate to this email.
   * index: {apps: [{id, company, title, normCompany, normTitle, urlKey, status, lastActivity, recruiterEmail}],
   *         threadApps: Map<threadId, Set<appId>>}
   */
  candidates: function(email, index, limit) {
    const linked = index.threadApps.get(email.threadId) || new Set();
    const probe = new Set(Extract.tokens(email.subject + ' ' + email.sender.name + ' ' + email.sender.domain.replace(/\./g, ' ') + ' ' + email.to + ' ' + email.current.slice(0, 2000)));
    const scored = index.apps.map(a => {
      let score = linked.has(a.id) ? 100 : 0;
      if (a.recruiterEmail && (a.recruiterEmail === email.sender.email || email.to.toLowerCase().indexOf(a.recruiterEmail) !== -1)) score += 50;
      const ct = Extract.tokens(a.normCompany);
      if (ct.length) score += 30 * ct.filter(t => probe.has(t)).length / ct.length;
      return { a: a, score: score };
    }).filter(x => x.score >= 15).sort((x, y) => y.score - x.score).slice(0, limit || 6);
    return scored.map(x => ({ application_id: x.a.id, company: x.a.company, job_title: x.a.title, status: x.a.status,
      last_activity: x.a.lastActivity, job_url: x.a.urlKey || null }));
  },

  /**
   * @return {{action: 'match'|'create'|'link'|'none'|'review', appId: string, reason: string}}
   */
  decide: function(cls, email, index) {
    const byId = id => index.apps.find(a => a.id === id);
    const review = (reason, appId) => ({ action: 'review', appId: appId || '', reason: reason });
    const linked = index.threadApps.get(email.threadId);
    const nc = Extract.normalizeCompany(cls.company), nt = Extract.normalizeTitle(cls.title);
    const sameCo = a => nc && (a.normCompany === nc || Extract.similarity(a.normCompany, nc) >= 0.5);
    const titleOk = a => !nt || !a.normTitle || Extract.similarity(a.normTitle, nt) >= 0.5;

    if (NON_APPLICATION_TYPES.indexOf(cls.eventType) !== -1) {
      if (linked && linked.size === 1) return { action: 'link', appId: Array.from(linked)[0], reason: 'Same Gmail thread' };
      return { action: 'none', appId: '', reason: 'Not about an existing application' };
    }

    // 1. thread
    if (linked && linked.size === 1) {
      const a = byId(Array.from(linked)[0]);
      if (a) {
        const m = cls.match.applicationId;
        if (m && m !== a.id && cls.match.confidence === 'high') return review('Thread belongs to ' + a.id + ' but the model matched ' + m, m);
        if (nt && a.normTitle && Extract.similarity(nt, a.normTitle) < 0.5 && (!nc || sameCo(a)) && m !== a.id) {
          return review('Thread belongs to "' + a.title + '" but the email mentions "' + cls.title + '"', a.id);
        }
        return { action: 'match', appId: a.id, reason: 'Same Gmail thread' };
      }
    }
    const pool = linked && linked.size > 1 ? index.apps.filter(a => linked.has(a.id)) : index.apps;

    // 2. job URL
    const urlKey = Extract.urlKey(cls.jobUrl);
    if (urlKey) {
      const byUrl = pool.filter(a => a.urlKey === urlKey);
      if (byUrl.length === 1) return { action: 'match', appId: byUrl[0].id, reason: 'Same job URL' };
      if (byUrl.length > 1) return review('Several applications share this job URL', byUrl[0].id);
    }

    // 3. model-proposed candidate, verified
    const proposed = cls.match.applicationId && byId(cls.match.applicationId);
    if (proposed) {
      const agrees = (!nc || sameCo(proposed)) && titleOk(proposed);
      if (!agrees) return review('Model matched ' + proposed.id + ' but the email names a different company or role', proposed.id);
      // Outcomes (offer/rejection/withdrawal) must name the role when not in the application's thread or job URL.
      if (!nt && CONFIG.REVIEW.HIGH_IMPACT.indexOf(cls.eventType) !== -1) return review(cls.eventType + ' without a stated role outside the application\'s thread', proposed.id);
      if (cls.match.confidence === 'high' || (nt && proposed.normTitle === nt)) {
        return { action: 'match', appId: proposed.id, reason: 'Model match (' + cls.match.confidence + '): ' + cls.match.reason };
      }
      return review('Uncertain model match: ' + cls.match.reason, proposed.id);
    }

    if (!nc) return review(linked && linked.size > 1 ? 'Thread linked to several applications and no company stated' : 'Company not stated');
    const company = pool.filter(a => a.normCompany === nc);

    // 4. exact company + title
    if (nt) {
      const exact = company.filter(a => a.normTitle === nt);
      if (exact.length === 1) return { action: 'match', appId: exact[0].id, reason: 'Same company and job title' };
      if (exact.length > 1) return review('Several applications with the same company and title', exact[0].id);
      // 5. similar title at the same company (renamed role?)
      const similar = company.filter(a => a.normTitle && Extract.similarity(a.normTitle, nt) >= 0.6);
      if (similar.length) return review('"' + cls.title + '" is similar to an existing application at this company', similar[0].id);
    } else if (company.length) {
      return review('Job title not stated; ' + company.length + ' application(s) at ' + cls.company, company.length === 1 ? company[0].id : '');
    }

    // 6. new application
    if (nt && Status.effect({ type: cls.eventType, qualifier: cls.qualifier, direction: email.direction })) {
      return { action: 'create', appId: '', reason: 'New application' };
    }
    return review(nt ? 'Event does not start an application and no existing one matches' : 'Job title not stated for a new application');
  }
};
