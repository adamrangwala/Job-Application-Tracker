# Job Application Tracker

An automated Google Apps Script tool that helps you track and manage your job applications by scanning your Gmail inbox.

[Job Application Tracker Template](https://docs.google.com/spreadsheets/d/1Ua5ceM5PYgIgHTctTdV5-S3uwWB0pzG1_yHwgBhyfVA/edit?usp=sharing)


![Tracker Demo](https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExMHExMjQ1Mmp1ejcxazdidzBzdm0xbG1tZmx2amttNmhkZjE4OTNiYiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/haJ5ii4ALvt2zIOdKB/giphy.gif)

<p align="center">
  <img src="[demo.gif](https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExMHExMjQ1Mmp1ejcxazdidzBzdm0xbG1tZmx2amttNmhkZjE4OTNiYiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/haJ5ii4ALvt2zIOdKB/giphy.gif)" alt="animated" />
</p>

## Overview

The Job Application Tracker is a powerful Google Apps Script application that automatically scans your Gmail inbox for job application-related emails and organizes them into a structured Google Sheets dashboard. It detects different application statuses, extracts company and job title information, automatically generates draft replies to rejections and provides insightful visualizations of your job search progress.

## Features

- **Automatic Email Scanning**: Detects job application emails, interview invitations, assessments, and offer/rejection notices
- **Smart Data Extraction**: Extracts job titles, company names, and status updates from email content
- **Status Tracking**: Automatically categorizes applications into statuses like "Applied," "Assessment," "Interview Request," "Offer Received," or "Rejected"
- **Dynamic Dashboard**: Visualizes your application data with charts and graphs
- **Follow-up Tools**: Creates draft emails to follow up on rejections to maintain professional connections
- **Application Insights**: Analyzes job titles, application timing, and success rates
- **Fully Automated**: Runs daily to keep your application tracking up-to-date

## Getting Started

### Prerequisites

- A Google account
- A Gmail account used for submitting job applications

### Installation

**Option 1:** [Use the Template](https://docs.google.com/spreadsheets/d/1Ua5ceM5PYgIgHTctTdV5-S3uwWB0pzG1_yHwgBhyfVA/edit?usp=sharing)and follow the instructions

**Option 2:** Set up the the Extension yourself using the JS files in this repository 
1. Create a new Google Sheet
2. Name the first sheet "Instructions" and the second sheet "Applications"
3. Click on "Extensions" > "Apps Script" to open the script editor
4. Copy and paste each of the script files from this repository into separate script files in the Apps Script editor:
   - `main.gs` (Main script)
   - `extractionUtils.gs` (Company and job title extraction)
   - `statusUtils.gs` (Application status detection)
   - `spreadsheetUtils.gs` (Spreadsheet formatting)
   - `applicationInsights.gs` (Analytics tools)
   - `jobTitleVisualization.gs` (Job title analysis)
5. Save all files
6. Return to your spreadsheet and refresh the page

### Setup

1. After refreshing, you should see a new menu item called "Job Tracker"
2. Click on "Job Tracker" > "Scan Emails" to run the initial scan
3. Allow the necessary permissions when prompted
4. The script will automatically set up your spreadsheet with the correct headers and formatting
5. To enable daily automatic scanning, click "Job Tracker" > "Set up daily scanning"

## Advanced Features

### Rejection Follow-up Drafts

The tool can automatically create draft emails for rejected applications to help you maintain professional relationships. To use this feature:

1. Click "Job Tracker" > "Create Rejection Follow-up Drafts"
2. Review the created drafts in your Gmail drafts folder
3. Personalize and send as appropriate

## How It Works

1. **Email Detection**: The script uses a sophisticated search query to find job-related emails in your Gmail
2. **Information Extraction**: For each relevant email, it extracts:
   - Job title from the subject and body
   - Company name from the sender and content
   - Current application status based on email content
3. **Status Updates**: When follow-up emails arrive, it updates the status of existing applications
4. **Visualization**: Creates charts and insights based on your application data

## Status Categories

The tracker categorizes applications into the following statuses:

- **Applied**: Initial application confirmation
- **Status Update**: General updates without a specific status change
- **Assessment**: Technical assessments or skills tests
- **Interview Request**: Invitations for interviews
- **Offer Received**: Job offers
- **Rejected**: Application rejections

### Application Insights

The summary dashboard provides insights into your job search:

- Application activity timeline
- Applications by company
- Job title analysis
- Seniority level distribution
- Application funnel analysis
- Day-of-week application patterns

## Customization

You can customize the script by modifying:

- **Email Search Query**: Adjust the `GMAIL_SEARCH_QUERY` constant to refine which emails are detected
- **Status Detection Keywords**: Modify the status detection patterns in `statusUtils.gs`
- **Company/Job Title Extraction**: Update extraction patterns in `extractionUtils.gs`

## Troubleshooting

### No Applications Showing Up

If the script runs but no applications appear:
1. Ensure you've granted the script permission to access Gmail and Google Sheets
2. Check that your sheet is named "Applications" (case-sensitive)
3. Manually test the Gmail search query to make sure it finds job application emails
4. Check the logs in the Apps Script editor for any errors

### Script Authorization Issues

If you're having trouble with permissions:
1. Go to your Google Account's security settings
2. Remove the script's access
3. Run the script again and reauthorize

## Contributing / Feeback

Contributions to improve the Job Application Tracker are welcome! Please feel free to submit a pull request or open an issue to suggest improvements.
Feedback: Please [use the feedback form](https://docs.google.com/forms/d/e/1FAIpQLSfz4PxUTe7wPaL4At_qpSuxAMa3rP4GUGMmTYASDKkST71XtA/viewform?usp=dialog) to provide quick 2 minutes of feedback for me to help improve the app.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- Built using Google Apps Script
- Inspired by the challenges of managing a modern job search process
