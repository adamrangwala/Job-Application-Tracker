/**
 * spreadsheetUtils.gs
 * 
 * This file contains core utility functions for spreadsheet operations
 * used in the Job Application Tracker, including automatic formatting
 * for the main data table.
 */

// =============================================================
// Spreadsheet Operation Utilities
// =============================================================
const SpreadsheetUtils = {
  /**
   * Sets up a new spreadsheet with appropriate headers and formatting
   * @param {Sheet} sheet - Google Sheets sheet object
   */
  setupSheet: function(sheet) {
    // Set up headers - removed Email Thread ID, but keep it in processing logic
    const headers = ["Job Title", "Company", "Date Submitted", "Date Updated", "Status", "Raw Body"];
    
    // Get the range for the headers (first row, columns A through F)
    const headerRange = sheet.getRange(1, 1, 1, headers.length);

    // Set the values for the headers
    headerRange.setValues([headers]);

    // Format the headers with enhanced styling
    this.formatHeader(sheet);

    // Freeze the header row
    sheet.setFrozenRows(1);

    // Auto-resize columns
    sheet.autoResizeColumns(1, headers.length);
    
    return sheet;
  },
  
  /**
   * Formats a date cell as a hyperlink to the email thread
   * @param {Sheet} sheet - Google Sheets sheet object
   * @param {number} row - Row number for the cell
   * @param {number} column - Column number for the cell
   * @param {string} threadLink - URL to the email thread
   * @param {Date} date - Date to display
   */
  formatDateAsLink: function(sheet, row, column, threadLink, date) {
    const dateCell = sheet.getRange(row, column);
    const formattedDate = Utilities.formatDate(date, Session.getScriptTimeZone(), "MM/dd/yyyy");
    dateCell.setFormula(`=HYPERLINK("${threadLink}", "${formattedDate}")`);
  },
  
  /**
  * Applies color coding to status cells and highlights recently updated applications
  * @param {Sheet} sheet - Google Sheets sheet object
  * @param {number} statusColumn - Column index for status values
  * @param {number} startRow - Starting row for formatting
  * @param {number} endRow - Ending row for formatting
  */
  applyStatusFormatting: function(sheet, statusColumn, startRow, endRow) {
    // Get headers to find the Date Updated column
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const dateUpdatedIndex = headers.indexOf("Date Updated");
    
    // If Date Updated column is found, use it; otherwise, assume it's before Status
    const dateUpdatedColumn = dateUpdatedIndex !== -1 ? 
      dateUpdatedIndex + 1 : statusColumn - 1;
    
    // Get all status values and updated dates
    const statusRange = sheet.getRange(startRow, statusColumn, endRow - startRow + 1, 1);
    const statusValues = statusRange.getValues();
    
    const dateUpdatedRange = sheet.getRange(startRow, dateUpdatedColumn, endRow - startRow + 1, 1);
    const dateUpdatedValues = dateUpdatedRange.getValues();
    
    // Calculate cutoff for recent updates (7 days ago)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    // Apply formatting to each cell individually based on value
    for (let i = 0; i < statusValues.length; i++) {
      const status = statusValues[i][0];
      const updatedDate = dateUpdatedValues[i][0];
      const cell = sheet.getRange(startRow + i, statusColumn);
      
      // Center the status text
      cell.setHorizontalAlignment('center');
      cell.setVerticalAlignment('middle');
      
      let isRecentUpdate = false;
      if (updatedDate instanceof Date && updatedDate > sevenDaysAgo) {
        isRecentUpdate = true;
      }
      
      // Define colors based on status
      let bgColor, textColor, fontWeight;
      
      switch(status) {
        case "Applied":
          bgColor = isRecentUpdate ? "#bbdefb" : "#e3f2fd"; // Darker blue for recent
          textColor = "#0d47a1"; // Dark blue
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        case "Assessment":
          bgColor = isRecentUpdate ? "#fff59d" : "#fff9c4"; // Darker yellow for recent
          textColor = "#f57f17"; // Dark orange
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        case "Interview Request":
          bgColor = isRecentUpdate ? "#a5d6a7" : "#c8e6c9"; // Darker green for recent
          textColor = "#1b5e20"; // Dark green
          fontWeight = "bold";
          break;
        case "Offer Received":
          bgColor = isRecentUpdate ? "#81c784" : "#a5d6a7"; // Darker green for recent
          textColor = "#1b5e20"; // Dark green
          fontWeight = "bold";
          break;
        case "Rejected":
          bgColor = isRecentUpdate ? "#ef9a9a" : "#ffcdd2"; // Darker red for recent
          textColor = "#b71c1c"; // Dark red
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        case "Status Update":
          bgColor = isRecentUpdate ? "#e0e0e0" : "#f5f5f5"; // Darker gray for recent
          textColor = "#424242"; // Dark gray
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        default:
          bgColor = "#f5f5f5"; // Light gray
          textColor = "#424242"; // Dark gray
          fontWeight = "normal";
      }
      
      // Apply the enhanced formatting
      cell.setBackground(bgColor);
      cell.setFontColor(textColor);
      cell.setFontWeight(fontWeight);
      
      // Add a subtle border around status cells
      cell.setBorder(true, true, true, true, null, null, '#bdbdbd', SpreadsheetApp.BorderStyle.SOLID);
      
      // Highlight the entire row for recent updates with a subtle border
      if (isRecentUpdate) {
        const rowRange = sheet.getRange(startRow + i, 1, 1, sheet.getLastColumn());
        rowRange.setBorder(
          true, true, true, true, // top, left, bottom, right
          false, false,           // vertical, horizontal
          "#9e9e9e",              // color
          SpreadsheetApp.BorderStyle.DOTTED
        );
      }
    }
  },
  
  /**
   * Creates a summary dashboard of application statuses
   * This is the main entry point for the dashboard that delegates to other utilities
   * @param {Sheet} sheet - Google Sheets sheet object
   */
  createSummaryDashboard: function(sheet) {
    // Check if summary already exists, if so, clear and update
    let summarySheet;
    
    try {
      summarySheet = sheet.getParent().getSheetByName("Summary");
      if (summarySheet) {
        summarySheet.clear();
      } else {
        summarySheet = sheet.getParent().insertSheet("Summary");
      }
    } catch (e) {
      Logger.log("Error creating summary sheet: " + e.toString());
      return;
    }
    
    // Create enhanced dashboard header
    this.createDashboardHeader(summarySheet);
    
    // Get all status values from main sheet
    const mainSheet = sheet;
    const lastRow = mainSheet.getLastRow();
    const statusColumnIndex = 5; // Status is column E (index 5)
    
    if (lastRow <= 1) {
      summarySheet.getRange("A1").setValue("No applications found");
      return;
    }
    
    const statusRange = mainSheet.getRange(2, statusColumnIndex, lastRow - 1, 1);
    const statusValues = statusRange.getValues();
    
    // Count different statuses
    const counts = {
      "Applied": 0,
      "Assessment": 0,
      "Interview Request": 0,
      "Offer Received": 0,
      "Rejected": 0,
      "Status Update": 0,
      "Total": 0
    };
    
    for (const row of statusValues) {
      const status = row[0];
      if (status in counts) {
        counts[status]++;
      }
      counts["Total"]++;
    }
    
    // Create enhanced status summary table
    let row = 3;
    this.createStatusSummaryTable(summarySheet, row, counts);
    
    // Find where the status table ends
    row = row + Object.keys(counts).length + 1; // +1 for header and total row
    
    // Add enhanced pie chart
    if (counts["Total"] > 0) {
      this.createStatusPieChart(summarySheet, 3, row, counts);
    }
    
    // Add recent activity section
    row += 14; // Leave space for the chart
    this.createRecentActivitySection(summarySheet, mainSheet, row);
    
    // Add job title analysis visualizations
    try {
      // Find the last used row after recent activity
      row = this.findLastRowInSheet(summarySheet) + 3;
      
      // Call the JobTitleVisualization function with the correct starting row
      JobTitleVisualization.createJobTitleVisualizations(mainSheet, summarySheet, row);
    } catch (e) {
      Logger.log("Error creating job title visualizations: " + e.toString());
      summarySheet.getRange(row + 2, 1).setValue("Error creating job title visualizations: " + e.toString());
    }
    
    // Add application insights
    try {
      // Find the last used row after job title visualizations
      row = this.findLastRowInSheet(summarySheet) + 3;
      
      // Call the ApplicationInsights function with the correct starting row
      ApplicationInsights.createApplicationInsights(mainSheet, summarySheet, row);
    } catch (e) {
      Logger.log("Error creating application insights: " + e.toString());
      summarySheet.getRange(row + 3, 1).setValue("Error creating application insights: " + e.toString());
    }
  },
  
  /**
   * Helper function to find the last used row in a sheet
   * @param {Sheet} sheet - The sheet to check
   * @return {number} The last used row
   */
  findLastRowInSheet: function(sheet) {
    const lastRow = sheet.getLastRow();
    
    // If there are no rows, return 1
    if (lastRow === 0) return 1;
    
    return lastRow;
  },
  
  /**
   * Auto-formats the main spreadsheet with enhanced styling
   * @param {Sheet} sheet - The sheet to format
   */
  enhanceSpreadsheetFormatting: function(sheet) {
    // Get the number of rows and columns in the sheet
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    
    if (lastRow <= 1) {
      // No data yet, just format the header
      this.formatHeader(sheet);
      return;
    }
    
    // 1. Format the header row
    this.formatHeader(sheet);
    
    // 2. Apply alternating row colors to data rows
    this.applyAlternatingRowColors(sheet, 2, lastRow);
    
    // 3. Format the Raw Body column
    this.formatRawBodyColumn(sheet, lastColumn);
    
    // 4. Apply status formatting on top of alternating colors
    this.applyStatusFormattingEnhanced(sheet, lastRow);
    
    // 5. Format dates and add borders
    this.formatDatesAndBorders(sheet, lastRow, lastColumn);
    
    // 6. Auto-resize columns for better readability
    this.autoResizeColumns(sheet, lastColumn);
  },
  
  /**
   * Formats the header row with improved styling
   * @param {Sheet} sheet - The sheet to format
   */
  formatHeader: function(sheet) {
    const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
    
    // Apply gradient background to header
    headerRange.setBackground('#2c3e50'); // Dark blue header background
    headerRange.setFontColor('#ffffff'); // White text
    headerRange.setFontWeight('bold');
    headerRange.setVerticalAlignment('middle');
    headerRange.setHorizontalAlignment('center');
    
    // Add bottom border to header
    headerRange.setBorder(null, null, true, null, null, null, '#ffffff', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    
    // Increase row height for header
    sheet.setRowHeight(1, 30);
  },
  
  /**
   * Applies alternating row colors to the specified range
   * @param {Sheet} sheet - The sheet to format
   * @param {number} startRow - The first row to format
   * @param {number} endRow - The last row to format
   */
  applyAlternatingRowColors: function(sheet, startRow, endRow) {
    for (let i = startRow; i <= endRow; i++) {
      const rowRange = sheet.getRange(i, 1, 1, sheet.getLastColumn());
      
      // Apply alternating colors
      if (i % 2 === 0) {
        rowRange.setBackground('#f5f7fa'); // Light blue-gray
      } else {
        rowRange.setBackground('#ffffff'); // White
      }
      
      // Set text formatting
      rowRange.setFontFamily('Arial');
      rowRange.setFontSize(10);
      rowRange.setVerticalAlignment('middle');
    }
  },
  
  /**
   * Formats or hides the Raw Body column
   * @param {Sheet} sheet - The sheet to format
   * @param {number} lastColumn - The last column in the sheet
   */
  formatRawBodyColumn: function(sheet, lastColumn) {
    // Find the Raw Body column
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    const rawBodyIndex = headers.indexOf('Raw Body');
    
    if (rawBodyIndex !== -1) {
      const rawBodyColumn = rawBodyIndex + 1; // Convert to 1-based index
      
      // Clip text and add tooltip
      const dataRange = sheet.getRange(2, rawBodyColumn, sheet.getLastRow() - 1, 1);
      
      // Apply text wrapping and set a fixed column width
      dataRange.setWrap(true);
      sheet.setColumnWidth(rawBodyColumn, 200);
    }
  },
  
  /**
   * Enhanced version of status formatting with improved color scheme and text colors
   * @param {Sheet} sheet - The sheet to format
   * @param {number} lastRow - The last row in the sheet
   */
  applyStatusFormattingEnhanced: function(sheet, lastRow) {
    // Find the Status column
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusIndex = headers.indexOf('Status');
    const dateUpdatedIndex = headers.indexOf('Date Updated');
    
    if (statusIndex === -1) return;
    
    const statusColumn = statusIndex + 1; // Convert to 1-based index
    const dateUpdatedColumn = dateUpdatedIndex !== -1 ? dateUpdatedIndex + 1 : statusColumn - 1;
    
    const statusRange = sheet.getRange(2, statusColumn, lastRow - 1, 1);
    const statusValues = statusRange.getValues();
    
    const dateUpdatedRange = sheet.getRange(2, dateUpdatedColumn, lastRow - 1, 1);
    const dateUpdatedValues = dateUpdatedRange.getValues();
    
    // Calculate cutoff for recent updates (7 days ago)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    // Apply formatting to each status cell
    for (let i = 0; i < statusValues.length; i++) {
      const status = statusValues[i][0];
      const updatedDate = dateUpdatedValues[i][0];
      const cell = sheet.getRange(i + 2, statusColumn);
      
      // Check if this is a recent update
      let isRecentUpdate = false;
      if (updatedDate instanceof Date && updatedDate > sevenDaysAgo) {
        isRecentUpdate = true;
      }
      
      // Center the status text
      cell.setHorizontalAlignment('center');
      cell.setVerticalAlignment('middle');
      
      // Define enhanced status formatting
      let bgColor, textColor, fontWeight;
      
      switch(status) {
        case "Applied":
          bgColor = isRecentUpdate ? "#bbdefb" : "#e3f2fd"; // Blue
          textColor = "#0d47a1"; // Dark blue
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        case "Assessment":
          bgColor = isRecentUpdate ? "#fff59d" : "#fff9c4"; // Yellow
          textColor = "#f57f17"; // Dark orange
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        case "Interview Request":
          bgColor = isRecentUpdate ? "#a5d6a7" : "#c8e6c9"; // Green
          textColor = "#1b5e20"; // Dark green
          fontWeight = "bold";
          break;
        case "Offer Received":
          bgColor = isRecentUpdate ? "#81c784" : "#a5d6a7"; // Green
          textColor = "#1b5e20"; // Dark green
          fontWeight = "bold";
          break;
        case "Rejected":
          bgColor = isRecentUpdate ? "#ef9a9a" : "#ffcdd2"; // Red
          textColor = "#b71c1c"; // Dark red
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        case "Status Update":
          bgColor = isRecentUpdate ? "#e0e0e0" : "#f5f5f5"; // Gray
          textColor = "#424242"; // Dark gray
          fontWeight = isRecentUpdate ? "bold" : "normal";
          break;
        default:
          bgColor = "#f5f5f5"; // Light gray
          textColor = "#424242"; // Dark gray
          fontWeight = "normal";
      }
      
      // Apply the formatting
      cell.setBackground(bgColor);
      cell.setFontColor(textColor);
      cell.setFontWeight(fontWeight);
      
      // Add a subtle border around status cells
      cell.setBorder(true, true, true, true, null, null, '#bdbdbd', SpreadsheetApp.BorderStyle.SOLID);
    }
  },
  
  /**
   * Formats dates and adds borders to the table
   * @param {Sheet} sheet - The sheet to format
   * @param {number} lastRow - The last row in the sheet
   * @param {number} lastColumn - The last column in the sheet
   */
  formatDatesAndBorders: function(sheet, lastRow, lastColumn) {
    // Find date columns
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    const dateSubmittedIndex = headers.indexOf('Date Submitted');
    const dateUpdatedIndex = headers.indexOf('Date Updated');
    
    // Format date columns
    if (dateSubmittedIndex !== -1) {
      const dateColumn = dateSubmittedIndex + 1; // Convert to 1-based index
      const dateRange = sheet.getRange(2, dateColumn, lastRow - 1, 1);
      dateRange.setHorizontalAlignment('center');
    }
    
    if (dateUpdatedIndex !== -1) {
      const dateColumn = dateUpdatedIndex + 1; // Convert to 1-based index
      const dateRange = sheet.getRange(2, dateColumn, lastRow - 1, 1);
      dateRange.setHorizontalAlignment('center');
    }
    
    // Add a border around the entire table
    const tableRange = sheet.getRange(1, 1, lastRow, lastColumn);
    tableRange.setBorder(
      true, true, true, true, // top, left, bottom, right
      null, null, // vertical, horizontal internal borders
      '#9e9e9e', SpreadsheetApp.BorderStyle.SOLID // border color and style
    );
  },
  
  /**
   * Auto-resizes columns for better readability
   * @param {Sheet} sheet - The sheet to format
   * @param {number} lastColumn - The last column in the sheet
   */
  autoResizeColumns: function(sheet, lastColumn) {
    // Auto-resize all columns except Raw Body (which we've already handled)
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    const rawBodyIndex = headers.indexOf('Raw Body');
    
    for (let i = 1; i <= lastColumn; i++) {
      if (i !== rawBodyIndex + 1) { // Skip Raw Body column
        sheet.autoResizeColumn(i);
      }
    }
    
    // Set minimum widths for specific columns
    const jobTitleIndex = headers.indexOf('Job Title');
    const companyIndex = headers.indexOf('Company');
    
    if (jobTitleIndex !== -1) {
      const currentWidth = sheet.getColumnWidth(jobTitleIndex + 1);
      const minWidth = 200;
      if (currentWidth < minWidth) {
        sheet.setColumnWidth(jobTitleIndex + 1, minWidth);
      }
    }
    
    if (companyIndex !== -1) {
      const currentWidth = sheet.getColumnWidth(companyIndex + 1);
      const minWidth = 150;
      if (currentWidth < minWidth) {
        sheet.setColumnWidth(companyIndex + 1, minWidth);
      }
    }
  },
  
  /**
   * Creates a dashboard header with professional styling
   * @param {Sheet} sheet - Summary sheet object
   */
  createDashboardHeader: function(sheet) {
    // Create a bold, attractive header for the dashboard
    sheet.getRange("A1:D1").merge();
    const headerRange = sheet.getRange("A1:D1");
    headerRange.setValue("Job Application Dashboard");
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(16);
    headerRange.setBackground("#3f51b5"); // Indigo
    headerRange.setFontColor("#ffffff"); // White
    headerRange.setVerticalAlignment("middle");
    headerRange.setHorizontalAlignment("center");
    
    // Set row height for header
    sheet.setRowHeight(1, 40);
  },
  
  /**
   * Creates a status summary table with improved styling
   * @param {Sheet} sheet - Summary sheet object
   * @param {number} startRow - Starting row for the table
   * @param {Object} counts - Status counts object
   */
  createStatusSummaryTable: function(sheet, startRow, counts) {
    // Create table header
    const headerRange = sheet.getRange(startRow, 1, 1, 3);
    headerRange.setValues([["Status", "Count", "Percentage"]]);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#e8eaf6"); // Light indigo
    headerRange.setFontColor("#3f51b5"); // Indigo
    headerRange.setVerticalAlignment("middle");
    headerRange.setHorizontalAlignment("center");
    
    // Apply borders to header
    headerRange.setBorder(
      true, true, true, true, // top, left, bottom, right
      null, null, // vertical, horizontal internal borders
      "#9e9e9e", SpreadsheetApp.BorderStyle.SOLID // color and style
    );
    
    // Add status data rows
    let row = startRow + 1;
    const statusColors = {
      "Applied": {bg: "#e3f2fd", text: "#0d47a1"},
      "Assessment": {bg: "#fff9c4", text: "#f57f17"},
      "Interview Request": {bg: "#c8e6c9", text: "#1b5e20"},
      "Offer Received": {bg: "#a5d6a7", text: "#1b5e20"},
      "Rejected": {bg: "#ffcdd2", text: "#b71c1c"},
      "Status Update": {bg: "#f5f5f5", text: "#424242"}
    };
    
    for (const status in counts) {
      if (status === "Total") continue; // Add total at the end
      
      const count = counts[status];
      const percentage = counts["Total"] > 0 ? (count / counts["Total"] * 100).toFixed(1) + "%" : "0%";
      
      sheet.getRange(row, 1).setValue(status);
      sheet.getRange(row, 2).setValue(count);
      sheet.getRange(row, 3).setValue(percentage);
      
      // Set cell alignment
      sheet.getRange(row, 1).setHorizontalAlignment("left");
      sheet.getRange(row, 2).setHorizontalAlignment("center");
      sheet.getRange(row, 3).setHorizontalAlignment("center");
      
      // Apply status-specific colors
      if (statusColors[status]) {
        sheet.getRange(row, 1).setBackground(statusColors[status].bg);
        sheet.getRange(row, 1).setFontColor(statusColors[status].text);
      }
      
      // Add subtle borders
      sheet.getRange(row, 1, 1, 3).setBorder(
        true, true, true, true, // top, left, bottom, right
        null, null, // vertical, horizontal
        "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID // color and style
      );
      
      row++;
    }
    
    // Add total row with distinct styling
    sheet.getRange(row, 1).setValue("Total");
    sheet.getRange(row, 2).setValue(counts["Total"]);
    sheet.getRange(row, 3).setValue("100%");
    
    // Format total row
    sheet.getRange(row, 1, 1, 3).setBackground("#e0e0e0");
    sheet.getRange(row, 1, 1, 3).setFontWeight("bold");
    sheet.getRange(row, 2).setHorizontalAlignment("center");
    sheet.getRange(row, 3).setHorizontalAlignment("center");
    
    // Add more prominent border to total row
    sheet.getRange(row, 1, 1, 3).setBorder(
      true, true, true, true, // top, left, bottom, right
      null, null, // vertical, horizontal
      "#9e9e9e", SpreadsheetApp.BorderStyle.SOLID_MEDIUM // color and style
    );
    
    // Auto-resize columns
    sheet.autoResizeColumns(1, 3);
  },
  
  /**
   * Creates a recent activity section to highlight recent applications and updates
   * @param {Sheet} sheet - Summary sheet object
   * @param {Sheet} mainSheet - Main sheet with application data
   * @param {number} startRow - Starting row for the section
   */
  createRecentActivitySection: function(sheet, mainSheet, startRow) {
    // Create section header
    const headerRange = sheet.getRange(startRow, 1, 1, 4);
    headerRange.setValues([["Recent Application Activity"]]);
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(14);
    headerRange.setBackground("#3f51b5"); // Indigo
    headerRange.setFontColor("#ffffff"); // White
    headerRange.merge();
    
    // Get data from main sheet
    const lastRow = mainSheet.getLastRow();
    if (lastRow <= 1) return;
    
    const headers = mainSheet.getRange(1, 1, 1, 6).getValues()[0];
    const jobTitleIndex = headers.indexOf('Job Title');
    const companyIndex = headers.indexOf('Company');
    const dateUpdatedIndex = headers.indexOf('Date Updated');
    const statusIndex = headers.indexOf('Status');
    
    if (jobTitleIndex === -1 || companyIndex === -1 || 
        dateUpdatedIndex === -1 || statusIndex === -1) {
      return;
    }
    
    // Get all applications
    const dataRange = mainSheet.getRange(2, 1, lastRow - 1, 6).getValues();
    
    // Filter applications with valid dates
    const applicationsWithDates = dataRange.filter(row => 
      row[dateUpdatedIndex] instanceof Date
    );
    
    if (applicationsWithDates.length === 0) return;
    
    // Sort applications by update date (newest first)
    applicationsWithDates.sort((a, b) => b[dateUpdatedIndex] - a[dateUpdatedIndex]);
    
    // Take the 5 most recently updated applications
    const recentApplications = applicationsWithDates.slice(0, 5);
    
    // Create headers for recent activity table
    const tableHeaders = ["Job Title", "Company", "Last Updated", "Status"];
    sheet.getRange(startRow + 1, 1, 1, 4).setValues([tableHeaders]);
    sheet.getRange(startRow + 1, 1, 1, 4).setFontWeight("bold");
    sheet.getRange(startRow + 1, 1, 1, 4).setBackground("#e8eaf6"); // Light indigo
    sheet.getRange(startRow + 1, 1, 1, 4).setFontColor("#3f51b5"); // Indigo
    
    // Prepare data for the table
    const today = new Date();
    const recentActivityData = recentApplications.map(app => {
      const updatedDate = app[dateUpdatedIndex];
      const updatedFormatted = Utilities.formatDate(updatedDate, Session.getScriptTimeZone(), "MM/dd/yyyy");
      
      return [
        app[jobTitleIndex],
        app[companyIndex],
        updatedFormatted,
        app[statusIndex]
      ];
    });
    
    // Add data to the table
    sheet.getRange(startRow + 2, 1, recentActivityData.length, 4).setValues(recentActivityData);
    
    // Style the table
    const tableRange = sheet.getRange(startRow + 1, 1, recentActivityData.length + 1, 4);
    tableRange.setBorder(
      true, true, true, true, // top, left, bottom, right
      true, true, // vertical, horizontal
      "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID // color and style
    );
    
    // Apply alternating row colors
    for (let i = 0; i < recentActivityData.length; i++) {
      const rowRange = sheet.getRange(startRow + 2 + i, 1, 1, 4);
      if (i % 2 === 0) {
        rowRange.setBackground("#f5f7fa"); // Light blue-gray
      } else {
        rowRange.setBackground("#ffffff"); // White
      }
    }
    
    // Format status column
    for (let i = 0; i < recentActivityData.length; i++) {
      const status = recentActivityData[i][3];
      const cell = sheet.getRange(startRow + 2 + i, 4);
      
      // Apply same color coding as main sheet
      switch(status) {
        case "Applied":
          cell.setBackground("#e3f2fd");
          cell.setFontColor("#0d47a1");
          break;
        case "Assessment":
          cell.setBackground("#fff9c4");
          cell.setFontColor("#f57f17");
          break;
        case "Interview Request":
          cell.setBackground("#c8e6c9");
          cell.setFontColor("#1b5e20");
          break;
        case "Offer Received":
          cell.setBackground("#a5d6a7");
          cell.setFontColor("#1b5e20");
          break;
        case "Rejected":
          cell.setBackground("#ffcdd2");
          cell.setFontColor("#b71c1c");
          break;
        case "Status Update":
          cell.setBackground("#f5f5f5");
          cell.setFontColor("#424242");
          break;
      }
    }
    
    // Auto-resize columns
    sheet.autoResizeColumns(1, 4);
  },
  
  /**
   * Creates a pie chart showing application status distribution
   * @param {Sheet} sheet - Summary sheet object
   * @param {number} startRow - Starting row of data
   * @param {number} endRow - Ending row of data
   * @param {Object} counts - Status counts object
   */
  createStatusPieChart: function(sheet, startRow, endRow, counts) {
    // Only create chart if there's data
    if (counts["Total"] === 0) return;
    
    // Create chart with enhanced options
    const chartDataRange = sheet.getRange(startRow, 1, endRow - startRow, 2);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.PIE)
      .addRange(chartDataRange)
      .setPosition(endRow + 2, 1, 0, 0)
      .setOption('title', 'Application Status Distribution')
      .setOption('titleTextStyle', {
        color: '#3f51b5',
        fontSize: 14,
        bold: true
      })
      .setOption('pieSliceText', 'percentage')
      .setOption('legend', {
        position: 'right',
        textStyle: {fontSize: 12}
      })
      .setOption('pieHole', 0.4) // Create a donut chart
      .setOption('colors', [
        '#e3f2fd', // Applied
        '#f5f5f5', // Status Update
        '#fff9c4', // Assessment
        '#c8e6c9', // Interview Request
        '#a5d6a7', // Offer Received
        '#ffcdd2'  // Rejected
      ])
      .setOption('width', 600)
      .setOption('height', 400)
      .setOption('chartArea', {
        left: '10%',
        top: '10%',
        width: '70%',
        height: '80%'
      })
      .build();
    
    sheet.insertChart(chart);
  }
};

/**
 * Hook for applying formatting after scanning emails
 * This function should be called at the end of the scanEmails function
 * to ensure the spreadsheet is always formatted correctly
 */
function applyFormattingAfterUpdate() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getActiveSheet();
  
  // Apply enhanced formatting
  SpreadsheetUtils.enhanceSpreadsheetFormatting(sheet);
}
