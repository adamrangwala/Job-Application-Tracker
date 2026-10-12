/**
 * dashboardUtils.gs
 *
 * Builds the Dashboard tab once (during setup). Every number on it is a live
 * formula over the data tabs, so syncs never rewrite the dashboard and manual
 * edits (status overrides, follow-up dates) show up immediately.
 * Columns are found by header name, so inserting/reordering columns is safe.
 */

const DASHBOARD_TITLE = 'Job Application Dashboard';

// Last column letter of each data tab, set by buildDashboard_ so formulas never reach past the grid.
let DASH_LAST_COL_ = {};

/** Whole-column reference to a header in a tab, e.g. col_('Applications', 'Current Status'). */
function col_(tab, header) {
  const t = "'" + tab + "'", last = DASH_LAST_COL_[tab] || 'AZ';
  return 'INDEX(' + t + '!$A:$' + last + ',0,MATCH("' + header + '",' + t + '!$A$1:$' + last + '$1,0))';
}

function dashboardFormulas_() {
  const A = h => col_(CONFIG.TABS.APPS, h);
  const E = h => col_(CONFIG.TABS.EVENTS, h);
  const R = h => col_(CONFIG.TABS.REVIEW, h);
  const Q = h => col_(CONFIG.TABS.QUEUE, h);
  const L = h => col_(CONFIG.TABS.LOG, h);
  const status = A('Current Status');
  const open = status + '<>"Rejected",' + status + '<>"Withdrawn"';
  const list = (cols, cond, sortCol, asc, empty) =>
    '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({' + cols.map(A).join(',') + '},' + cond + '),' + sortCol + ',' + asc + '),10,' + cols.length + '),"' + empty + '")';
  const fu = A('Follow-up Date'), iv = A('Interview Date'), as = A('Assessment Deadline'), last = A('Last Activity Date');
  const qState = Q('State');

  return {
    kpis: [
      ['Total applications', '=MAX(0,COUNTA(' + A('Application ID') + ')-1)'],
      ['Active (Applied / Assessment / Interview / Offer)', '=SUMPRODUCT(COUNTIF(' + status + ',{"Applied","Assessment","Interview","Offer"}))'],
      ['Offers', '=COUNTIF(' + status + ',"Offer")'],
      ['Rejections', '=COUNTIF(' + status + ',"Rejected")'],
      ['Upcoming interviews', '=COUNTIFS(' + iv + ',">="&NOW(),' + status + ',"<>Rejected",' + status + ',"<>Withdrawn")'],
      ['Pending assessments', '=COUNTIFS(' + status + ',"Assessment",' + as + ',">="&NOW())+COUNTIFS(' + status + ',"Assessment",' + as + ',"")'],
      ['Pending reviews', '=COUNTIF(' + R('Review Status') + ',"Pending")'],
      ['Overdue follow-ups', '=COUNTIFS(' + fu + ',"<"&TODAY(),' + status + ',"<>Rejected",' + status + ',"<>Withdrawn")'],
      ['Follow-ups due in ' + CONFIG.FOLLOW_UP_SOON_DAYS + ' days', '=COUNTIFS(' + fu + ',">="&TODAY(),' + fu + ',"<="&TODAY()+' + CONFIG.FOLLOW_UP_SOON_DAYS + ',' + status + ',"<>Rejected",' + status + ',"<>Withdrawn")'],
      ['No reply for ' + CONFIG.NO_RESPONSE_DAYS + '+ days (label only)', '=COUNTIFS(' + status + ',"Applied",' + last + ',"<"&TODAY()-' + CONFIG.NO_RESPONSE_DAYS + ')'],
      ['Work queue: waiting / failed permanently', '=COUNTIF(' + qState + ',"pending")+COUNTIF(' + qState + ',"retry")&" / "&COUNTIF(' + qState + ',"dead")'],
      ['Last sync finished', '=IF(COUNT(' + L('Finished At') + ')=0,"Never",TEXT(MAX(' + L('Finished At') + '),"yyyy-mm-dd hh:mm"))'],
      ['Last sync result', '=IFERROR(INDEX(' + L('Result') + ',MATCH(MAX(' + L('Finished At') + '),' + L('Finished At') + ',0)),"")']
    ],
    statusCount: s => '=COUNTIF(' + status + ',"' + s + '")',
    trend: '=IFERROR(QUERY(ARRAYFORMULA(IF(ISNUMBER(' + A('Application Date') + '),DATE(YEAR(' + A('Application Date') + '),MONTH(' + A('Application Date') + '),1),)),' +
      '"select Col1, count(Col1) where Col1 is not null group by Col1 order by Col1 label Col1 \'Month\', count(Col1) \'Applications\'",0),"No dated applications yet")',
    sections: [
      ['Upcoming interviews', ['Company', 'Job Title', 'Interview Date', 'Last Relevant Gmail Thread URL'],
        list(['Company', 'Job Title', 'Interview Date', 'Last Relevant Gmail Thread URL'], 'ISNUMBER(' + iv + '),' + iv + '>=NOW(),' + open, 3, 'TRUE', 'None scheduled')],
      ['Assessment deadlines', ['Company', 'Job Title', 'Assessment Deadline', 'Last Relevant Gmail Thread URL'],
        list(['Company', 'Job Title', 'Assessment Deadline', 'Last Relevant Gmail Thread URL'], 'ISNUMBER(' + as + '),' + as + '>=NOW()-1,' + open, 3, 'TRUE', 'None pending')],
      ['Overdue follow-ups', ['Company', 'Job Title', 'Follow-up Date', 'Next Action'],
        list(['Company', 'Job Title', 'Follow-up Date', 'Next Action'], 'ISNUMBER(' + fu + '),' + fu + '<TODAY(),' + open, 3, 'TRUE', 'Nothing overdue')],
      ['Follow-ups due soon', ['Company', 'Job Title', 'Follow-up Date', 'Next Action'],
        list(['Company', 'Job Title', 'Follow-up Date', 'Next Action'], 'ISNUMBER(' + fu + '),' + fu + '>=TODAY(),' + fu + '<=TODAY()+' + CONFIG.FOLLOW_UP_SOON_DAYS + ',' + open, 3, 'TRUE', 'Nothing due soon')],
      ['No reply for ' + CONFIG.NO_RESPONSE_DAYS + '+ days (consider a follow-up)', ['Company', 'Job Title', 'Application Date', 'Last Activity Date'],
        list(['Company', 'Job Title', 'Application Date', 'Last Activity Date'], status + '="Applied",ISNUMBER(' + last + '),' + last + '<TODAY()-' + CONFIG.NO_RESPONSE_DAYS, 4, 'TRUE', 'None')],
      ['Recently detected email events', ['Email Timestamp', 'Event Type', 'Subject', 'Application ID'],
        '=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({' + E('Email Timestamp') + ',' + E('Event Type') + ',' + E('Subject') + ',' + E('Application ID') + '},' +
        'ISNUMBER(' + E('Email Timestamp') + '),' + E('Processing State') + '<>"superseded",' + E('Processing State') + '<>"ignored"),1,FALSE),10,4),"No events yet")']
    ]
  };
}

function buildDashboard_(ss) {
  let sheet = ss.getSheetByName(CONFIG.TABS.DASHBOARD);
  if (sheet) {
    const a1 = String(sheet.getRange(1, 1).getValue());
    if (a1 !== DASHBOARD_TITLE && sheet.getLastRow() > 0) {
      throw new Error('Tab "' + CONFIG.TABS.DASHBOARD + '" exists but was not created by the tracker. Rename it and run setup again (nothing was changed).');
    }
    sheet.getCharts().forEach(c => sheet.removeChart(c));
    sheet.clear();   // system-owned tab: contains only formulas generated below
  } else {
    sheet = ss.insertSheet(CONFIG.TABS.DASHBOARD, 0);
  }
  DASH_LAST_COL_ = {};
  [CONFIG.TABS.APPS, CONFIG.TABS.EVENTS, CONFIG.TABS.REVIEW, CONFIG.TABS.QUEUE, CONFIG.TABS.LOG].forEach(name => {
    const t = ss.getSheetByName(name);
    if (t) DASH_LAST_COL_[name] = columnLetter_(t.getMaxColumns());
  });
  const f = dashboardFormulas_();

  sheet.getRange('A1').setValue(DASHBOARD_TITLE).setFontSize(16).setFontWeight('bold');
  sheet.getRange('A2').setValue('Live formulas over the data tabs. Rebuilt only by "Setup / migrate workbook".').setFontColor('#666666');

  sheet.getRange(4, 1, 1, 2).setValues([['Summary', '']]).setFontWeight('bold').setBackground('#e0e0e0');
  sheet.getRange(5, 1, f.kpis.length, 2).setValues(f.kpis);

  sheet.getRange(4, 6, 1, 2).setValues([['Status', 'Count']]).setFontWeight('bold').setBackground('#e0e0e0');
  sheet.getRange(5, 6, STATUSES.length, 2).setValues(STATUSES.map(s => [s, f.statusCount(s)]));

  const trendRow = 5 + STATUSES.length + 2;
  sheet.getRange(trendRow, 6, 1, 2).setValues([['Applications by month', '']]).setFontWeight('bold').setBackground('#e0e0e0');
  sheet.getRange(trendRow + 1, 6).setFormula(f.trend);
  sheet.getRange(trendRow + 2, 6, 60, 1).setNumberFormat('mmm yyyy');

  let row = 5 + f.kpis.length + 2;
  for (const [title, headers, formula] of f.sections) {
    sheet.getRange(row, 1, 1, 4).setValues([[title, '', '', '']]).setFontWeight('bold').setBackground('#e0e0e0');
    sheet.getRange(row + 1, 1, 1, headers.length).setValues([headers]).setFontStyle('italic');
    sheet.getRange(row + 2, 1).setFormula(formula);
    if (/Timestamp/.test(headers[0])) sheet.getRange(row + 2, 1, 10, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    else sheet.getRange(row + 2, 3, 10, 2).setNumberFormat(/Interview|Assessment/.test(headers[2]) ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd');
    row += 14;
  }
  sheet.setColumnWidth(1, 300);
  sheet.setColumnWidths(2, 3, 200);
  sheet.setColumnWidth(6, 160);

  sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.BAR)
    .addRange(sheet.getRange(4, 6, STATUSES.length + 1, 2)).setPosition(4, 9, 0, 0)
    .setOption('title', 'Applications by status').setOption('legend', { position: 'none' }).build());
  sheet.insertChart(sheet.newChart().setChartType(Charts.ChartType.COLUMN)
    .addRange(sheet.getRange(trendRow + 1, 6, 37, 2)).setPosition(24, 9, 0, 0)
    .setOption('title', 'Applications by month').setOption('legend', { position: 'none' }).build());
}
