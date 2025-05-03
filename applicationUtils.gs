/**
 * applicationInsights.gs
 * 
 * This file contains utility functions for advanced job application insights and visualizations
 * used in the Job Application Tracker.
 */

// =============================================================
// Application Insights and Advanced Visualization Utilities
// =============================================================
const ApplicationInsights = {
  /**
   * Creates advanced application insights on the summary dashboard
   * @param {Sheet} mainSheet - The main application tracker sheet
   * @param {Sheet} summarySheet - The summary sheet where visualizations will be added
   */
  createApplicationInsights: function(mainSheet, summarySheet) {
    // Get all data from main sheet
    const lastRow = mainSheet.getLastRow();
    if (lastRow <= 1) return; // No data to analyze
    
    // Get relevant column indices
    const dataRange = mainSheet.getRange(1, 1, lastRow, 7).getValues();
    const headers = dataRange[0];
    
    const jobTitleIndex = headers.indexOf('Job Title');
    const companyIndex = headers.indexOf('Company');
    const dateSubmittedIndex = headers.indexOf('Date Submitted');
    const dateUpdatedIndex = headers.indexOf('Date Updated');
    const statusIndex = headers.indexOf('Status');
    
    // Extract data (skip header row)
    const applications = [];
    for (let i = 1; i < dataRange.length; i++) {
      const row = dataRange[i];
      applications.push({
        jobTitle: row[jobTitleIndex],
        company: row[companyIndex],
        dateSubmitted: row[dateSubmittedIndex] instanceof Date ? row[dateSubmittedIndex] : null,
        dateUpdated: row[dateUpdatedIndex] instanceof Date ? row[dateUpdatedIndex] : null,
        status: row[statusIndex]
      });
    }
    
    // Find first empty row in summary sheet
    const startRow = this.findLastRowInSheet(summarySheet) + 3;
    
    // Add application insights section header
    summarySheet.getRange(startRow, 1).setValue("Advanced Application Insights");
    summarySheet.getRange(startRow, 1, 1, 2).merge();
    summarySheet.getRange(startRow, 1).setFontWeight("bold");
    summarySheet.getRange(startRow, 1).setBackground("#4285f4");
    summarySheet.getRange(startRow, 1).setFontColor("white");
    
    // Add the application activity timeline
    this.createApplicationActivityTimeline(mainSheet, summarySheet, startRow + 2);
    
    // Add different insights sections - start after the timeline
    const timelineHeight = 20; // Approximate number of rows for timeline
    this.createTimeBasedAnalysis(summarySheet, applications, startRow + timelineHeight + 5);
    this.createCompanyAnalysis(summarySheet, applications, startRow + timelineHeight + 18);
    this.createConversionFunnelAnalysis(summarySheet, applications, startRow + timelineHeight + 31);
  },
  
  /**
   * Finds the last non-empty row in a sheet
   * @param {Sheet} sheet - The sheet to check
   * @return {number} The row number of the last non-empty row
   */
  findLastRowInSheet: function(sheet) {
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    
    if (lastRow === 0) return 0;
    
    // Check the rows from the bottom up
    for (let i = lastRow; i > 0; i--) {
      const rowValues = sheet.getRange(i, 1, 1, lastColumn).getValues()[0];
      if (rowValues.some(cell => cell !== "")) {
        return i;
      }
    }
    
    return 0;
  },
  
  /**
   * Creates application activity timeline visualization
   * @param {Sheet} mainSheet - The main application tracker sheet
   * @param {Sheet} summarySheet - The summary sheet where visualizations will be added
   * @param {number} startRow - Starting row for the visualization
   */
  createApplicationActivityTimeline: function(mainSheet, summarySheet, startRow) {
    // Create section header
    summarySheet.getRange(startRow, 1).setValue("Application Activity Timeline");
    summarySheet.getRange(startRow, 1).setFontWeight("bold");
    
    // Get relevant data from main sheet
    const lastRow = mainSheet.getLastRow();
    if (lastRow <= 1) {
      summarySheet.getRange(startRow + 1, 1).setValue("No application data available for timeline");
      return;
    }
    
    const headers = mainSheet.getRange(1, 1, 1, 7).getValues()[0];
    const jobTitleIndex = headers.indexOf('Job Title');
    const companyIndex = headers.indexOf('Company');
    const dateSubmittedIndex = headers.indexOf('Date Submitted');
    const dateUpdatedIndex = headers.indexOf('Date Updated');
    const statusIndex = headers.indexOf('Status');
    
    // Get all applications data
    const dataRange = mainSheet.getRange(2, 1, lastRow - 1, 7).getValues();
    
    // Filter applications with valid dates
    const applicationsWithDates = dataRange.filter(row => 
      row[dateSubmittedIndex] instanceof Date && row[dateUpdatedIndex] instanceof Date
    );
    
    if (applicationsWithDates.length === 0) {
      summarySheet.getRange(startRow + 1, 1).setValue("No valid date data available for timeline");
      return;
    }
    
    // Sort applications by submission date (newest first)
    applicationsWithDates.sort((a, b) => b[dateSubmittedIndex] - a[dateSubmittedIndex]);
    
    // Take the 10 most recent applications for the timeline
    const recentApplications = applicationsWithDates.slice(0, 10);
    
    // Create headers
    const timelineHeaders = ["Job Title", "Company", "Submitted", "Last Updated", "Days Since Update", "Status"];
    summarySheet.getRange(startRow + 2, 1, 1, timelineHeaders.length).setValues([timelineHeaders]);
    summarySheet.getRange(startRow + 2, 1, 1, timelineHeaders.length).setFontWeight("bold");
    summarySheet.getRange(startRow + 2, 1, 1, timelineHeaders.length).setBackground("#e0e0e0");
    
    // Prepare data for the timeline
    const today = new Date();
    const timelineData = recentApplications.map(app => {
      const submittedDate = app[dateSubmittedIndex];
      const updatedDate = app[dateUpdatedIndex];
      
      // Calculate days since last update
      const timeDiff = today.getTime() - updatedDate.getTime();
      const daysSinceUpdate = Math.floor(timeDiff / (1000 * 3600 * 24));
      
      // Format dates
      const submittedFormatted = Utilities.formatDate(submittedDate, Session.getScriptTimeZone(), "MM/dd/yyyy");
      const updatedFormatted = Utilities.formatDate(updatedDate, Session.getScriptTimeZone(), "MM/dd/yyyy");
      
      return [
        app[jobTitleIndex],
        app[companyIndex],
        submittedFormatted,
        updatedFormatted,
        daysSinceUpdate,
        app[statusIndex]
      ];
    });
    
    // Write data to sheet
    summarySheet.getRange(startRow + 3, 1, timelineData.length, timelineData[0].length).setValues(timelineData);
    
    // Apply conditional formatting for days since update
    const daysColumn = summarySheet.getRange(startRow + 3, 5, timelineData.length, 1);
    
    // Apply color scale based on days (green to red)
    const rule = SpreadsheetApp.newConditionalFormatRule()
      .setGradientMaxpoint("#f4c7c3") // Red for older updates
      .setGradientMidpoint("#ffe0b2") // Yellow for medium updates
      .setGradientMinpoint("#b7e1cd") // Green for recent updates
      .setRanges([daysColumn])
      .build();
    
    const rules = summarySheet.getConditionalFormatRules();
    rules.push(rule);
    summarySheet.setConditionalFormatRules(rules);
    
    // Format status column
    const statusColumn = summarySheet.getRange(startRow + 3, 6, timelineData.length, 1);
    
    for (let i = 0; i < timelineData.length; i++) {
      const status = timelineData[i][5];
      const cell = summarySheet.getRange(startRow + 3 + i, 6);
      
      // Apply same color coding as main sheet
      switch(status) {
        case "Applied":
          cell.setBackground("#e3f2fd"); // Light blue
          break;
        case "Assessment":
          cell.setBackground("#fff9c4"); // Light yellow
          break;
        case "Interview Request":
          cell.setBackground("#c8e6c9"); // Light green
          break;
        case "Offer Received":
          cell.setBackground("#a5d6a7"); // Medium green
          break;
        case "Rejected":
          cell.setBackground("#ffcdd2"); // Light red
          break;
        case "Status Update":
          cell.setBackground("#f5f5f5"); // Light gray
          break;
      }
    }
    
    // Auto-resize columns
    summarySheet.autoResizeColumns(1, timelineHeaders.length);
    
    // Create a horizontal timeline chart
    // First, prepare data for the chart
    const chartData = [];
    
    // Add header row for chart
    chartData.push(["Job", "Status", "Start", "End"]);
    
    // Calculate earliest and latest dates for timeline range
    let earliestDate = new Date();
    let latestDate = new Date(0); // Jan 1, 1970
    
    recentApplications.forEach(app => {
      if (app[dateSubmittedIndex] < earliestDate) {
        earliestDate = new Date(app[dateSubmittedIndex]);
      }
      if (app[dateUpdatedIndex] > latestDate) {
        latestDate = new Date(app[dateUpdatedIndex]);
      }
    });
    
    // Add a buffer of 5 days on each end
    earliestDate.setDate(earliestDate.getDate() - 5);
    latestDate.setDate(latestDate.getDate() + 5);
    
    // Add rows for each application
    recentApplications.forEach(app => {
      const jobLabel = `${app[jobTitleIndex]} (${app[companyIndex]})`;
      chartData.push([
        jobLabel,
        app[statusIndex],
        app[dateSubmittedIndex],
        app[dateUpdatedIndex]
      ]);
    });
    
    // Create a temporary range for chart data
    const chartStartRow = startRow + timelineData.length + 5;
    const chartRange = summarySheet.getRange(
      chartStartRow, 
      1, 
      chartData.length, 
      chartData[0].length
    );
    chartRange.setValues(chartData);
    
    // Create timeline chart
    const chart = summarySheet.newChart()
      .setChartType(Charts.ChartType.TIMELINE)
      .addRange(chartRange)
      .setPosition(startRow + timelineData.length + 5, 1, 0, 0)
      .setOption('title', 'Application Activity Timeline')
      .setOption('width', 900)
      .setOption('height', 400)
      .setOption('timeline', {
        showRowLabels: true,
        groupByRowLabel: false
      })
      .build();
    
    summarySheet.insertChart(chart);
    
    // Hide the temporary data used for the chart
    summarySheet.hideRows(chartStartRow, chartData.length);
  },
  
  /**
   * Creates time-based analysis for application insights
   * @param {Sheet} sheet - The sheet to add the visualization to
   * @param {Array} applications - Array of application objects
   * @param {number} startRow - Starting row for the visualization
   */
  createTimeBasedAnalysis: function(sheet, applications, startRow) {
    // Create section header
    sheet.getRange(startRow, 1).setValue("Application Activity Over Time");
    sheet.getRange(startRow, 1).setFontWeight("bold");
    
    // Filter applications with valid dates
    const validApplications = applications.filter(app => app.dateSubmitted instanceof Date);
    
    if (validApplications.length === 0) {
      sheet.getRange(startRow + 1, 1).setValue("No valid date data available for time analysis");
      return;
    }
    
    // Group applications by month and year
    const applicationsByMonth = {};
    validApplications.forEach(app => {
      const date = new Date(app.dateSubmitted);
      const monthYear = `${date.getFullYear()}-${date.getMonth() + 1}`;
      
      if (!applicationsByMonth[monthYear]) {
        applicationsByMonth[monthYear] = {
          count: 0,
          month: date.getMonth() + 1,
          year: date.getFullYear(),
          monthName: new Date(date.getFullYear(), date.getMonth(), 1).toLocaleString('default', { month: 'short' }) + ' ' + date.getFullYear(),
          dateObj: new Date(date.getFullYear(), date.getMonth(), 1)
        };
      }
      
      applicationsByMonth[monthYear].count++;
    });
    
    // Convert to array and sort by date
    const monthlyData = Object.values(applicationsByMonth).sort((a, b) => a.dateObj - b.dateObj);
    
    // Create data for the chart
    const headers = ["Month", "Applications"];
    const data = monthlyData.map(item => [item.monthName, item.count]);
    
    // Add data to sheet
    sheet.getRange(startRow + 2, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(startRow + 2, 1, 1, headers.length).setFontWeight("bold");
    sheet.getRange(startRow + 2, 1, 1, headers.length).setBackground("#e0e0e0");
    
    sheet.getRange(startRow + 3, 1, data.length, data[0].length).setValues(data);
    
    // Create chart
    const chartRange = sheet.getRange(startRow + 2, 1, data.length + 1, data[0].length);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.LINE)
      .addRange(chartRange)
      .setPosition(startRow + 2, 4, 0, 0)
      .setOption('title', 'Applications Submitted Per Month')
      .setOption('legend', {position: 'none'})
      .setOption('width', 600)
      .setOption('height', 300)
      .setOption('colors', ['#4285f4'])
      .setOption('hAxis', {title: 'Month'})
      .setOption('vAxis', {title: 'Number of Applications'})
      .setOption('curveType', 'function') // Smooth curve
      .build();
    
    sheet.insertChart(chart);
    
    // Add day of week analysis
    this.createDayOfWeekAnalysis(sheet, validApplications, startRow + data.length + 5);
  },
  
  /**
   * Creates day of week analysis for application insights
   * @param {Sheet} sheet - The sheet to add the visualization to
   * @param {Array} applications - Array of application objects with valid dates
   * @param {number} startRow - Starting row for the visualization
   */
  createDayOfWeekAnalysis: function(sheet, applications, startRow) {
    // Create section header
    sheet.getRange(startRow, 1).setValue("Applications by Day of Week");
    sheet.getRange(startRow, 1).setFontWeight("bold");
    
    // Group applications by day of week
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const applicationsByDay = Array(7).fill(0);
    
    applications.forEach(app => {
      const date = new Date(app.dateSubmitted);
      const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
      applicationsByDay[dayOfWeek]++;
    });
    
    // Create data for the chart
    const data = dayNames.map((day, index) => [day, applicationsByDay[index]]);
    
    // Add data to sheet
    const headers = ["Day of Week", "Applications"];
    sheet.getRange(startRow + 2, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(startRow + 2, 1, 1, headers.length).setFontWeight("bold");
    sheet.getRange(startRow + 2, 1, 1, headers.length).setBackground("#e0e0e0");
    
    sheet.getRange(startRow + 3, 1, data.length, data[0].length).setValues(data);
    
    // Create chart
    const chartRange = sheet.getRange(startRow + 2, 1, data.length + 1, data[0].length);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(chartRange)
      .setPosition(startRow + 2, 4, 0, 0)
      .setOption('title', 'Applications by Day of Week')
      .setOption('legend', {position: 'none'})
      .setOption('width', 600)
      .setOption('height', 300)
      .setOption('colors', ['#34a853'])
      .setOption('hAxis', {title: 'Day of Week'})
      .setOption('vAxis', {title: 'Number of Applications'})
      .build();
    
    sheet.insertChart(chart);
  },
  
  /**
   * Creates company analysis for application insights
   * @param {Sheet} sheet - The sheet to add the visualization to
   * @param {Array} applications - Array of application objects
   * @param {number} startRow - Starting row for the visualization
   */
  createCompanyAnalysis: function(sheet, applications, startRow) {
    // Create section header
    sheet.getRange(startRow, 1).setValue("Company Analysis");
    sheet.getRange(startRow, 1).setFontWeight("bold");
    
    // Group applications by company
    const applicationsByCompany = {};
    applications.forEach(app => {
      if (!app.company || app.company === "Unlisted") return;
      
      if (!applicationsByCompany[app.company]) {
        applicationsByCompany[app.company] = {
          count: 0,
          statuses: {}
        };
      }
      
      applicationsByCompany[app.company].count++;
      
      // Track status counts for each company
      const status = app.status || "Unknown";
      applicationsByCompany[app.company].statuses[status] = 
        (applicationsByCompany[app.company].statuses[status] || 0) + 1;
    });
    
    // Find companies with multiple applications
    const companiesWithMultiple = Object.entries(applicationsByCompany)
      .filter(([_, data]) => data.count > 1)
      .sort((a, b) => b[1].count - a[1].count);
    
    if (companiesWithMultiple.length === 0) {
      sheet.getRange(startRow + 1, 1).setValue("No companies with multiple applications found");
      return;
    }
    
    // Create data for the chart
    const headers = ["Company", "Applications"];
    const data = companiesWithMultiple.map(([company, data]) => [company, data.count]);
    
    // Add data to sheet
    sheet.getRange(startRow + 2, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(startRow + 2, 1, 1, headers.length).setFontWeight("bold");
    sheet.getRange(startRow + 2, 1, 1, headers.length).setBackground("#e0e0e0");
    
    sheet.getRange(startRow + 3, 1, data.length, data[0].length).setValues(data);
    
    // Create chart
    const chartRange = sheet.getRange(startRow + 2, 1, data.length + 1, data[0].length);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.BAR)
      .addRange(chartRange)
      .setPosition(startRow + 2, 4, 0, 0)
      .setOption('title', 'Companies with Multiple Applications')
      .setOption('legend', {position: 'none'})
      .setOption('width', 600)
      .setOption('height', 300)
      .setOption('colors', ['#ea4335'])
      .setOption('hAxis', {title: 'Number of Applications'})
      .setOption('vAxis', {title: ''})
      .build();
    
    sheet.insertChart(chart);
  },
  
  /**
   * Creates conversion funnel analysis for application insights
   * @param {Sheet} sheet - The sheet to add the visualization to
   * @param {Array} applications - Array of application objects
   * @param {number} startRow - Starting row for the visualization
   */
  createConversionFunnelAnalysis: function(sheet, applications, startRow) {
    // Create section header
    sheet.getRange(startRow, 1).setValue("Application Funnel Analysis");
    sheet.getRange(startRow, 1).setFontWeight("bold");
    
    // Count applications by status
    const statusCounts = {
      "Applied": 0,
      "Status Update": 0,
      "Assessment": 0,
      "Interview Request": 0,
      "Offer Received": 0,
      "Rejected": 0
    };
    
    let totalApplications = 0;
    
    applications.forEach(app => {
      if (app.status && statusCounts.hasOwnProperty(app.status)) {
        statusCounts[app.status]++;
        totalApplications++;
      }
    });
    
    if (totalApplications === 0) {
      sheet.getRange(startRow + 1, 1).setValue("No application status data available for funnel analysis");
      return;
    }
    
    // Define funnel stages in order
    const funnelStages = [
      "Applied",
      "Status Update",
      "Assessment",
      "Interview Request",
      "Offer Received"
    ];
    
    // Calculate conversion rates and create data
    const headers = ["Stage", "Count", "% of Total", "Conversion Rate"];
    const data = [];
    let previousStageCount = null;
    
    funnelStages.forEach(stage => {
      const count = statusCounts[stage];
      const percentOfTotal = totalApplications > 0 ? (count / totalApplications) * 100 : 0;
      let conversionRate = previousStageCount !== null && previousStageCount > 0 ? (count / previousStageCount) * 100 : null;
      
      data.push([
        stage, 
        count, 
        percentOfTotal.toFixed(1) + "%", 
        conversionRate !== null ? conversionRate.toFixed(1) + "%" : "N/A"
      ]);
      
      previousStageCount = count;
    });
    
    // Add Rejected as separate row
    data.push([
      "Rejected", 
      statusCounts["Rejected"], 
      totalApplications > 0 ? ((statusCounts["Rejected"] / totalApplications) * 100).toFixed(1) + "%" : "0.0%", 
      "N/A"
    ]);
    
    // Add data to sheet
    sheet.getRange(startRow + 2, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(startRow + 2, 1, 1, headers.length).setFontWeight("bold");
    sheet.getRange(startRow + 2, 1, 1, headers.length).setBackground("#e0e0e0");
    
    sheet.getRange(startRow + 3, 1, data.length, data[0].length).setValues(data);
    
    // Format percentage columns
    sheet.getRange(startRow + 3, 3, data.length, 1).setHorizontalAlignment("right");
    sheet.getRange(startRow + 3, 4, data.length, 1).setHorizontalAlignment("right");
    
    // Create funnel chart (using bar chart as funnel)
    // We'll only use the main funnel stages, not Rejected
    const chartData = funnelStages.map(stage => [stage, statusCounts[stage]]);
    const chartHeaders = ["Stage", "Count"];
    
    // Create a temporary range for chart data
    const tempStartRow = startRow + data.length + 5;
    sheet.getRange(tempStartRow, 1, 1, chartHeaders.length).setValues([chartHeaders]);
    sheet.getRange(tempStartRow + 1, 1, chartData.length, chartData[0].length).setValues(chartData);
    
    const chartRange = sheet.getRange(tempStartRow, 1, chartData.length + 1, chartData[0].length);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.BAR)
      .addRange(chartRange)
      .setPosition(startRow + 2, 6, 0, 0)
      .setOption('title', 'Application Funnel')
      .setOption('legend', {position: 'none'})
      .setOption('width', 500)
      .setOption('height', 300)
      .setOption('colors', ['#fbbc04'])
      .setOption('hAxis', {title: 'Number of Applications'})
      .setOption('vAxis', {
        title: '',
        direction: -1 // Reverse order to make funnel shape
      })
      .build();
    
    sheet.insertChart(chart);
    
    // Hide the temporary data used for the chart
    sheet.hideRows(tempStartRow, chartData.length + 1);
  }
};
