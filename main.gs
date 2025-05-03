/**
 * Job Application Tracker - Main Script
 * 
 * This Google Apps Script automatically tracks job applications by:
 * 1. Creating a spreadsheet if it doesn't exist
 * 2. Scanning emails for job application confirmations
 * 3. Updating the spreadsheet with new applications
 * 4. Updating application status when follow-up emails are received
 * 5. Generating visualizations for job application data
 */

// Configuration
const SPREADSHEET_NAME = "Application Tracker";

const GMAIL_SEARCH_QUERY = "(subject:(\"thank you for applying\" OR \"thank you for your application\" OR \"application received\" OR \"we received your application\" OR \"confirmation of your application\" OR \"next steps\" OR \"interview invitation\" OR \"move forward\" OR \"pleased to inform\" OR \"job offer\" OR \"Application\" OR \"Regarding your application\" OR \"Next steps\" OR \"Interview\" OR \"Thank you for your interest\" OR \"We have received\" OR \"received your\" OR \"Position\" OR \"Job opportunity\" OR \"Status update\" OR \"for applying\" OR \"thank you from\" OR \"thanks from\" OR \"thanks for\" OR \"applied\" OR \"follow-up\") OR body:\"thank you for your interest\") -unsubscribe OR from:(@talent OR @careers OR @jobs OR @hr OR @recruiting OR @hire OR candidates.workablemail.com OR @inbound.workablemail.com) -from:jobs-listings@linkedin.com -from:@glassdoor.com -label:social -category:promotions -subject:\"password reset\"";

/**
 * Creates menu items when the spreadsheet is opened
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Job Tracker')
    .addItem('Scan Emails', 'scanEmails')
    .addItem('Set up daily scanning', 'setupTriggers')
    .addItem('Refresh Visualizations', 'refreshVisualizations')
    .addItem('Create Rejection Follow-up Drafts', 'createRejectionFollowupDrafts')
    .addItem('Open Feedback Form', 'openFeedbackForm')
    .addSeparator()
    .addItem('Migrate Spreadsheet (Hide Thread ID)', 'migrateSpreadsheet')
    .addToUi();
}

/**
 * Sets up time-based triggers to run scans automatically
 */
function setupTriggers() {
  // Delete existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  
  // Create daily trigger for scanning emails (combined function)
  ScriptApp.newTrigger('scanEmails')
    .timeBased()
    .everyDays(1)
    .create();
    
  SpreadsheetApp.getActive().toast('Automatic daily scanning has been set up!');
}

/**
 * Gets or creates the tracking spreadsheet
 */
function getOrCreateSpreadsheet() {
  let spreadsheet;
  let isNewSpreadsheet = false;

  // Try to find existing spreadsheet
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    const file = files.next();
    spreadsheet = SpreadsheetApp.open(file);
  } 
  else {
    // Create new spreadsheet
    spreadsheet = SpreadsheetApp.create(SPREADSHEET_NAME);
    isNewSpreadsheet = true;
  }
  
  // Set up headers if needed
  const sheet = spreadsheet.getSheetByName("Applications");

  // Check if sheet exists
  if (!sheet) {
    // Create the sheet if it doesn't exist
    const newSheet = spreadsheet.insertSheet("Applications");
    SpreadsheetUtils.setupSheet(newSheet);
    return spreadsheet;
  }

  const firstCell = sheet.getRange(1, 1).getValue();

  if (isNewSpreadsheet || firstCell !== "Job Title") {
    // Use SpreadsheetUtils to set up the sheet
    SpreadsheetUtils.setupSheet(sheet);
  }

return spreadsheet;
}

/**
 * Manually refreshes visualizations without scanning emails
 */
function refreshVisualizations() {
  const spreadsheet = getOrCreateSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Applications");

  // Apply formatting first
  SpreadsheetUtils.enhanceSpreadsheetFormatting(sheet);
  
  try {
    SpreadsheetUtils.createSummaryDashboard(sheet);
    SpreadsheetApp.getActive().toast('Visualizations refreshed successfully!');
  } catch (e) {
    Logger.log("Error refreshing visualizations: " + e.toString());
    SpreadsheetApp.getActive().toast('Error refreshing visualizations: ' + e.toString());
  }
}

/**
 * Migrates an existing spreadsheet to hide the Email Thread ID column
 * and ensures thread IDs are preserved in a hidden column
 */
function migrateSpreadsheet() {
  const spreadsheet = getOrCreateSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Applications");
  
  // Get existing data
  const existingData = sheet.getDataRange().getValues();
  const headers = existingData[0];
  
  // Check if the Email Thread ID column exists
  const threadIdColumnIndex = headers.indexOf('Email Thread ID');
  
  if (threadIdColumnIndex !== -1) {
    // Create a new hidden ThreadId column if it doesn't exist
    const hiddenThreadIdColumnName = "ThreadId";
    let hiddenThreadIdColumnIndex = headers.indexOf(hiddenThreadIdColumnName);
    
    if (hiddenThreadIdColumnIndex === -1) {
      // Add the hidden ThreadId column at the end
      const lastColumn = sheet.getLastColumn();
      sheet.insertColumnAfter(lastColumn);
      sheet.getRange(1, lastColumn + 1).setValue(hiddenThreadIdColumnName);
      hiddenThreadIdColumnIndex = lastColumn;
      
      // Copy data from visible Email Thread ID column to hidden ThreadId column
      // Skip the header row (row 1)
      for (let i = 2; i <= sheet.getLastRow(); i++) {
        const threadId = sheet.getRange(i, threadIdColumnIndex + 1).getValue();
        sheet.getRange(i, lastColumn + 1).setValue(threadId);
      }
      
      // Hide the new ThreadId column
      sheet.hideColumn(sheet.getRange(1, lastColumn + 1, 1, 1));
    }
    
    // Remove the visible Email Thread ID column
    sheet.deleteColumn(threadIdColumnIndex + 1);
    
    // Update column formatting and auto-resize
    sheet.autoResizeColumns(1, sheet.getLastColumn());
    
    // Show confirmation message
    SpreadsheetApp.getActive().toast('Email Thread ID column has been migrated to a hidden column');
  } else {
    SpreadsheetApp.getActive().toast('No Email Thread ID column found to migrate');
  }
}

function scanEmails() {
  const spreadsheet = getOrCreateSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Applications");

  // Get all existing data from the spreadsheet
  const existingData = sheet.getDataRange().getValues();
  const headers = existingData[0];
  
  Logger.log("Starting scan with headers: " + headers.join(", "));

  // Get column indices - all 0-based
  const jobTitleIndex = headers.indexOf('Job Title');
  const companyIndex = headers.indexOf('Company');
  const dateSubmittedIndex = headers.indexOf('Date Submitted');
  const dateUpdatedIndex = headers.indexOf('Date Updated');
  const statusIndex = headers.indexOf('Status');
  
  // Validate column indices
  if (jobTitleIndex === -1 || companyIndex === -1 || 
      dateSubmittedIndex === -1 || dateUpdatedIndex === -1 || 
      statusIndex === -1) {
    SpreadsheetApp.getActive().toast('Error: Required columns are missing in the spreadsheet. Please check your column headers.');
    return;
  }
  
  // Create a hidden column for thread IDs if it doesn't exist
  const threadIdColumnName = "ThreadId";
  let threadIdIndex;
  
  // Check if the ThreadId column exists
  if (headers.indexOf(threadIdColumnName) === -1) {
    // Add ThreadId column at the end (hidden)
    const lastColumn = sheet.getLastColumn();
    sheet.insertColumnAfter(lastColumn);
    sheet.getRange(1, lastColumn + 1).setValue(threadIdColumnName);
    threadIdIndex = lastColumn;
    
    // Hide the Thread ID column
    sheet.hideColumn(sheet.getRange(1, threadIdIndex + 1, 1, 1));
  } else {
    threadIdIndex = headers.indexOf(threadIdColumnName);
  }

  // Create maps to store existing data for lookup
  const existingThreadIds = new Map(); // threadId -> row number
  const existingJobApplications = new Map(); // "jobtitle|company" -> row number
  
  // Reload the data after potentially adding the ThreadId column
  const updatedData = sheet.getDataRange().getValues();
  
  for (let i = 1; i < updatedData.length; i++) {
    const row = updatedData[i];
    // Store threadId -> row number mapping if ThreadId column exists
    if (threadIdIndex < row.length && row[threadIdIndex]) { 
      existingThreadIds.set(row[threadIdIndex], i + 1); // Store thread ID and row number (1-indexed)
    }
    
    // Store "jobtitle|company" -> row number mapping
    if (row[jobTitleIndex] && row[companyIndex]) {
      const key = (row[jobTitleIndex] + '|' + row[companyIndex]).toLowerCase();
      existingJobApplications.set(key, i + 1);
    }
  }
  
  // -- PART 1: SCAN FOR STATUS UPDATES FIRST --
  let updatesCount = 0;
  
  // Search for all job-related emails
  const threads = GmailApp.search(GMAIL_SEARCH_QUERY, 0, 300);
  Logger.log("Found " + threads.length + " threads matching the query");

  
  // First pass: Process existing thread IDs for status updates
  for (const thread of threads) {
    const threadId = thread.getId();
    const threadLink = "https://mail.google.com/mail/u/0/#inbox/" + threadId;
    
    // Check if this is a thread we're already tracking
    if (existingThreadIds.has(threadId)) {
      const rowNumber = existingThreadIds.get(threadId);
      const messages = thread.getMessages();
      const lastMessage = messages[messages.length - 1]; // Get the latest message
      
      const subject = lastMessage.getSubject();
      const body = lastMessage.getPlainBody();
      const htmlBody = lastMessage.getBody();
      const date = lastMessage.getDate();
      
      // Determine new status
      const status = StatusUtils.determineStatus(subject, body, htmlBody);
      
      // Update the spreadsheet with status and date - add 1 to index for getRange
      sheet.getRange(rowNumber, statusIndex + 1).setValue(status);
      
      // Update the Date Updated column with latest message date and link - add 1 to index for getRange
      sheet.getRange(rowNumber, dateUpdatedIndex + 1).setValue(date);
      SpreadsheetUtils.formatDateAsLink(sheet, rowNumber, dateUpdatedIndex + 1, threadLink, date);
      
      updatesCount++;
    }
  }
  
  // -- PART 2: SCAN FOR NEW APPLICATIONS --
  let newApplicationsCount = 0;
  let updatedApplicationsCount = 0;
  
  for (const thread of threads) {
    const threadId = thread.getId();
    const threadLink = "https://mail.google.com/mail/u/0/#inbox/" + threadId;
    
    // Skip if already processed by thread ID
    if (existingThreadIds.has(threadId)) continue;
    
    const messages = thread.getMessages();
    const message = messages[0]; // Get the first message in the thread
    const lastMessage = messages[messages.length - 1]; // Get the latest message
    
    const subject = message.getSubject();
    const from = message.getFrom();
    const body = message.getPlainBody();
    const htmlBody = message.getBody(); // Get HTML content
    const date = message.getDate();
    const lastDate = lastMessage.getDate();

    // Extract data using utility functions
    const company = CompanyUtils.extractCompany(subject, body, from, htmlBody);
    const rawJobTitle = JobUtils.extractJobTitle(subject, body, from, htmlBody);
    const jobTitle = JobUtils.cleanJobTitle(JobUtils.cleanJobTitle(rawJobTitle));

    // Determine the initial status
    let initialStatus = StatusUtils.determineStatus(subject, body, htmlBody);
    
    // If there are multiple messages, check all messages for status clues
    if (messages.length > 1) {
      // Iterate through all messages in reverse (newest first)
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const msgSubject = msg.getSubject();
        const msgBody = msg.getPlainBody();
        const msgHtmlBody = msg.getBody();
        
        // Determine status from this message
        const msgStatus = StatusUtils.determineStatus(msgSubject, msgBody, msgHtmlBody);
        
        // Priority order: Offer > Interview > Assessment > Rejected > Status Update > Applied
        if (msgStatus === "Offer Received" || 
            (initialStatus !== "Offer Received" && msgStatus === "Interview Request") ||
            (initialStatus !== "Offer Received" && initialStatus !== "Interview Request" && 
             msgStatus === "Assessment") ||
            (initialStatus !== "Offer Received" && initialStatus !== "Interview Request" && 
             initialStatus !== "Assessment" && msgStatus === "Rejected") ||
            (initialStatus === "Applied" && msgStatus === "Status Update")) {
          initialStatus = msgStatus;
        }
      }
    }

    // Create lookup key for checking if this is a duplicate application
    const lookupKey = (jobTitle + '|' + company).toLowerCase();
    
    // Check if we already have an entry for this job title and company combination
    if (existingJobApplications.has(lookupKey)) {
      // This is a duplicate - update the existing entry
      const existingRowNum = existingJobApplications.get(lookupKey);
      
      // Get the current status from the sheet
      const currentStatus = sheet.getRange(existingRowNum, statusIndex + 1).getValue();
      
      // Define status priority (higher number = higher priority)
      const statusPriority = {
        "Applied": 1,
        "Status Update": 2,
        "Rejected": 3,
        "Assessment": 4,
        "Interview Request": 5,
        "Offer Received": 6
      };
      
      // Check if the new status has higher priority than the current one
      let shouldUpdateStatus = false;
      if (statusPriority[initialStatus] > statusPriority[currentStatus]) {
        shouldUpdateStatus = true;
      }
      
      // Always update the thread ID (in hidden column)
      sheet.getRange(existingRowNum, threadIdIndex + 1).setValue(threadId);
      
      // Update the Date Updated column with the latest message date
      sheet.getRange(existingRowNum, dateUpdatedIndex + 1).setValue(lastDate);
      SpreadsheetUtils.formatDateAsLink(sheet, existingRowNum, dateUpdatedIndex + 1, threadLink, lastDate);
      
      // Only update status if it should be updated based on priority
      if (shouldUpdateStatus) {
        sheet.getRange(existingRowNum, statusIndex + 1).setValue(initialStatus);
      }
      
      updatedApplicationsCount++;
    } else {
      // This is a new application - add a new row
      const rowData = [
        jobTitle,
        company,
        date,                  // Date Submitted
        lastDate,              // Date Updated (same as Date Submitted for new applications)
        initialStatus,         // Use the determined status instead of "Applied"
        body.slice(0, 100)     // Raw Body
      ];
      
      sheet.appendRow(rowData);
      const newRow = sheet.getLastRow();
      
      // Store the thread ID in the hidden column
      sheet.getRange(newRow, threadIdIndex + 1).setValue(threadId);
      
      // Format the dates as hyperlinks
      SpreadsheetUtils.formatDateAsLink(sheet, newRow, dateSubmittedIndex + 1, threadLink, date);
      SpreadsheetUtils.formatDateAsLink(sheet, newRow, dateUpdatedIndex + 1, threadLink, lastDate);
      
      // Add this to our maps so we can detect duplicates in the same batch
      existingThreadIds.set(threadId, newRow);
      existingJobApplications.set(lookupKey, newRow);
      
      newApplicationsCount++;
    }
  }
  
  // Apply color formatting to status cells
  if (updatesCount > 0 || newApplicationsCount > 0 || updatedApplicationsCount > 0) {
    SpreadsheetUtils.applyStatusFormatting(sheet, statusIndex + 1, 2, sheet.getLastRow());
  }
  
  // Format the spreadsheet
  sheet.autoResizeColumns(1, 6);
  
  // Show confirmation
  let message = '';
  if (newApplicationsCount > 0) {
    message += `Added ${newApplicationsCount} new job applications. `;
  }
  if (updatedApplicationsCount > 0) {
    message += `Updated ${updatedApplicationsCount} duplicate applications. `;
  }
  if (updatesCount > 0) {
    message += `Updated status for ${updatesCount} existing applications.`;
  }
  if (message === '') {
    message = 'No new applications or status updates found.';
  }
  
  SpreadsheetApp.getActive().toast(message);
  
  // Update the summary dashboard if it exists
  try {
    SpreadsheetUtils.createSummaryDashboard(sheet);
  } catch (e) {
    Logger.log("Error creating summary dashboard: " + e.toString());
  }
  
  // Apply formatting after completing the scan
  applyFormattingAfterUpdate();
}

/**
 * Creates draft email responses for rejected job applications
 * to help maintain professional relationships
 */
function createRejectionFollowupDrafts() {
  const spreadsheet = getOrCreateSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Applications");
  
  // Get all data from the spreadsheet
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  // Find relevant column indices
  const jobTitleIndex = headers.indexOf('Job Title');
  const companyIndex = headers.indexOf('Company');
  const statusIndex = headers.indexOf('Status');
  const dateUpdatedIndex = headers.indexOf('Date Updated');
  const threadIdColumnName = "ThreadId";
  const threadIdIndex = headers.indexOf(threadIdColumnName);
  
  if (jobTitleIndex === -1 || companyIndex === -1 || statusIndex === -1 || threadIdIndex === -1) {
    SpreadsheetApp.getActive().toast('Error: Required columns are missing. Please check your column headers.');
    return;
  }
  
  // Track rejected applications that haven't had follow-up emails yet
  let draftCount = 0;
  const followupStatus = "Rejection Follow-up Sent";
  
  // Create a new column for tracking follow-up status if it doesn't exist
  let followupStatusIndex = headers.indexOf('Follow-up Status');
  if (followupStatusIndex === -1) {
    // Add the column at the end
    sheet.insertColumnAfter(sheet.getLastColumn());
    sheet.getRange(1, sheet.getLastColumn()).setValue('Follow-up Status');
    followupStatusIndex = sheet.getLastColumn() - 1; // 0-based index
    
    // Initialize all cells in the new column to empty
    for (let i = 2; i <= sheet.getLastRow(); i++) {
      sheet.getRange(i, followupStatusIndex + 1).setValue('');
    }
  }
  
  // Process each row (skipping header)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[statusIndex];
    const followupSent = row[followupStatusIndex];
    
    // Only process rejected applications that haven't had follow-ups
    if (status === "Rejected" && followupSent !== followupStatus) {
      const jobTitle = row[jobTitleIndex];
      const company = row[companyIndex];
      const threadId = row[threadIdIndex];
      
      // Skip if missing essential data
      if (!jobTitle || !company || !threadId) continue;
      
      try {
        // Retrieve the original email thread
        const thread = GmailApp.getThreadById(threadId);
        if (!thread) continue;
        
        // Get the messages in the thread
        const messages = thread.getMessages();
        if (messages.length === 0) continue;
        
        // Typically, the rejection message would be the last message in the thread
        const rejectionMessage = messages[messages.length - 1];
        
        // Create a draft response
        const draftEmail = createRejectionFollowupEmail(company, jobTitle);
        
        // Create a draft that's a reply to the thread
        // This will automatically address it to the sender of the rejection email
        rejectionMessage.createDraftReply(draftEmail, {
          htmlBody: draftEmail.replace(/\n/g, '<br>')
        });
        
        // Update the follow-up status in the spreadsheet
        sheet.getRange(i + 1, followupStatusIndex + 1).setValue(followupStatus);
        draftCount++;
        
      } catch (e) {
        Logger.log(`Error creating draft for ${company} - ${jobTitle}: ${e.toString()}`);
        continue;
      }
    }
  }
  
  // Show confirmation toast
  if (draftCount > 0) {
    SpreadsheetApp.getActive().toast(`Created ${draftCount} rejection follow-up email drafts. Check your Gmail drafts folder.`);
  } else {
    SpreadsheetApp.getActive().toast('No new rejected applications found that need follow-up emails.');
  }
}

/**
 * Creates the email body for a rejection follow-up email
 * @param {string} company - Company name
 * @param {string} jobTitle - Job title
 * @return {string} Email body text
 */
function createRejectionFollowupEmail(company, jobTitle) {
  // Create an array of several different templates to choose from randomly
  const templates = [
    `Dear Hiring Team at ${company},

Thank you for considering my application for the ${jobTitle} position and for taking the time to review my qualifications. I appreciate the opportunity to have been considered for this role.

While I'm disappointed that I wasn't selected, I remain very interested in ${company} and would welcome the opportunity to be considered for other positions that match my skills and experience in the future.

I would greatly appreciate any feedback you might be able to provide regarding my application or interview that could help me improve.

Thank you again for your time and consideration. I wish you and the team continued success.

Best regards,
[YOUR NAME]`,

    `Dear ${company} Recruiting Team,

Thank you for informing me of your decision regarding the ${jobTitle} position. I appreciate your consideration and the time your team invested in reviewing my application.

Although I'm disappointed that we won't be working together at this time, I remain enthusiastic about ${company}'s work and mission. I would be grateful to be kept in mind for future opportunities that might be a better match for my skills in [relevant skill areas].

If you're able to share any feedback about my application that could help me grow professionally, I would greatly value that insight.

Thank you again for this opportunity, and I wish you and your team all the best.

Sincerely,
[YOUR NAME]`,

    `Dear Hiring Manager,

Thank you for letting me know about your decision regarding the ${jobTitle} role at ${company}. While I'm disappointed not to move forward, I appreciate the opportunity to have been considered.

I continue to be impressed by ${company}'s [mention something specific about the company you admire] and would be interested in future opportunities that align with my background in [your key skills].

If you have a moment, any constructive feedback would be invaluable to my professional development.

Thank you again for your time and consideration.

Best regards,
[YOUR NAME]`
  ];
  
  // Choose a random template
  const randomIndex = Math.floor(Math.random() * templates.length);
  return templates[randomIndex];
}

function openFeedbackForm() {
  // Opens feedback form as a sidebar
  var htmlOutput = HtmlService
      .createHtmlOutput('<iframe src="https://docs.google.com/forms/d/e/1FAIpQLSfz4PxUTe7wPaL4At_qpSuxAMa3rP4GUGMmTYASDKkST71XtA/viewform?usp=dialog" width="100%" height="500px"></iframe>')
      .setTitle('Feedback Form');
  SpreadsheetApp.getUi().showSidebar(htmlOutput);
}

/**
 * Legacy function for backward compatibility - delegates to scanEmails
 */
function scanForNewApplications() {
  scanEmails();
}

/**
 * Legacy function for backward compatibility - delegates to scanEmails
 */
function scanForStatusUpdates() {
  scanEmails();
}
