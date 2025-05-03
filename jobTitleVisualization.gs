/**
 * jobTitleVisualization.gs
 * 
 * This file contains enhanced utility functions for job title analysis and visualization
 * used in the Job Application Tracker.
 */

// =============================================================
// Job Title Analysis and Visualization Utilities
// =============================================================
const JobTitleVisualization = {
  /**
   * Analyzes job titles and creates visualizations for the job application tracker
   * with enhanced styling for a more professional appearance
   * 
   * @param {Sheet} mainSheet - The main application tracker sheet
   * @param {Sheet} summarySheet - The summary sheet where visualizations will be added
   * @param {number} startRow - Starting row for the job title analysis section
   */
  createJobTitleVisualizations: function(mainSheet, summarySheet, startRow) {
    // Get all job titles from main sheet
    const lastRow = mainSheet.getLastRow();
    if (lastRow <= 1) return; // No data to analyze
    
    const jobTitleColumnIndex = 1; // Job Title is column A (index 1)
    const jobTitleRange = mainSheet.getRange(2, jobTitleColumnIndex, lastRow - 1, 1);
    const jobTitleValues = jobTitleRange.getValues();
    
    // Extract and prepare job title data
    const jobTitles = jobTitleValues.map(row => row[0]).filter(title => title && title !== "Unlisted");
    
    // Skip if no valid job titles
    if (jobTitles.length === 0) {
      summarySheet.getRange(startRow, 1).setValue("No job title data available for analysis");
      return;
    }
    
    // Create title for the job title analysis section
    const titleRow = startRow;
    const headerRange = summarySheet.getRange(titleRow, 1, 1, 4);
    headerRange.setValue("Job Title Analysis");
    headerRange.setFontWeight("bold");
    headerRange.setFontSize(14);
    headerRange.setBackground("#3f51b5"); // Indigo
    headerRange.setFontColor("#ffffff"); // White
    headerRange.merge();
    
    // Create the job role category analysis
    this.createEnhancedJobRoleCategoryAnalysis(summarySheet, jobTitles, titleRow + 2);
    
    // Create the job seniority level analysis
    this.createEnhancedSeniorityLevelAnalysis(summarySheet, jobTitles, titleRow + 15);
    
    // Create word cloud data table (for visualization in dashboard)
    this.createEnhancedWordFrequencyTable(summarySheet, jobTitles, titleRow + 28);
  },
  
  /**
   * Categorizes job titles by role/function and creates a visualization with enhanced styling
   * @param {Sheet} sheet - The sheet to add the visualization to
   * @param {Array} jobTitles - Array of job titles
   * @param {number} startRow - Starting row for the visualization
   */
  createEnhancedJobRoleCategoryAnalysis: function(sheet, jobTitles, startRow) {
    // Define common job role categories and related keywords
    const roleCategories = {
      "Software Development": ["developer", "engineer", "software", "web", "backend", "frontend", "full stack", "fullstack", "iOS", "android", "mobile", "java", "python", ".net", "c#", "javascript", "react", "angular", "vue", "node"],
      "Data Science": ["data scientist", "machine learning", "ml", "ai", "artificial intelligence", "deep learning", "nlp", "natural language", "analytics"],
      "Data Engineering": ["data engineer", "etl", "big data", "hadoop", "spark", "database", "sql", "nosql", "dba", "database administrator"],
      "DevOps/Infrastructure": ["devops", "sre", "site reliability", "infrastructure", "cloud", "aws", "azure", "gcp", "terraform", "kubernetes", "k8s", "docker", "cicd", "ci/cd", "pipeline"],
      "Product/Project Management": ["product manager", "project manager", "product owner", "scrum master", "agile", "program manager", "delivery manager"],
      "UX/UI Design": ["ux", "ui", "user experience", "user interface", "designer", "graphic", "visual", "product designer"],
      "Marketing/Growth": ["marketing", "growth", "seo", "content", "social media", "digital marketing", "brand", "communications"],
      "Sales/Business Development": ["sales", "business development", "account", "customer success", "client"],
      "Finance/Accounting": ["finance", "accounting", "accountant", "financial", "controller", "tax", "audit", "treasurer"],
      "HR/People": ["hr", "human resources", "people", "talent", "recruiter", "recruitment", "benefits", "compensation"],
      "Operations": ["operations", "business operations", "bizops", "process", "logistics", "supply chain"],
      "Customer Support": ["support", "customer service", "help desk", "technical support"]
    };
    
    // Initialize category counts
    const categoryCounts = {};
    for (const category in roleCategories) {
      categoryCounts[category] = 0;
    }
    categoryCounts["Other"] = 0;
    
    // Categorize each job title
    for (const title of jobTitles) {
      const lowerTitle = title.toLowerCase();
      let categorized = false;
      
      for (const category in roleCategories) {
        for (const keyword of roleCategories[category]) {
          if (lowerTitle.includes(keyword)) {
            categoryCounts[category]++;
            categorized = true;
            break;
          }
        }
        if (categorized) break;
      }
      
      if (!categorized) {
        categoryCounts["Other"]++;
      }
    }
    
    // Remove categories with zero count
    Object.keys(categoryCounts).forEach(category => {
      if (categoryCounts[category] === 0) {
        delete categoryCounts[category];
      }
    });
    
    // Sort categories by count (descending)
    const sortedCategories = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10); // Keep only top 10 categories
    
    // Create enhanced header
    const headerRange = sheet.getRange(startRow, 1, 1, 2);
    headerRange.setValues([["Job Role Categories", "Count"]]);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#e8eaf6"); // Light indigo
    headerRange.setFontColor("#3f51b5"); // Indigo
    headerRange.setVerticalAlignment("middle");
    headerRange.setHorizontalAlignment("center");
    
    // Populate data with enhanced styling
    let row = startRow + 1;
    for (const [category, count] of sortedCategories) {
      sheet.getRange(row, 1).setValue(category);
      sheet.getRange(row, 2).setValue(count);
      
      // Add background color gradient based on count
      const maxCount = sortedCategories[0][1];
      const colorIntensity = Math.floor(100 + (155 * count / maxCount)); // 100-255
      const colorHex = this.rgbToHex(colorIntensity, 217, 253);
      sheet.getRange(row, 1).setBackground(colorHex);
      
      // Add subtle borders
      sheet.getRange(row, 1, 1, 2).setBorder(
        true, true, true, true, // top, left, bottom, right
        null, null, // vertical, horizontal
        "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID // color and style
      );
      
      row++;
    }
    
    // Create enhanced chart
    const chartDataRange = sheet.getRange(startRow, 1, row - startRow, 2);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.BAR)
      .addRange(chartDataRange)
      .setPosition(startRow, 4, 0, 0)
      .setOption('title', 'Job Role Categories')
      .setOption('titleTextStyle', {
        color: '#3f51b5',
        fontSize: 14,
        bold: true
      })
      .setOption('legend', {position: 'none'})
      .setOption('width', 500)
      .setOption('height', 300)
      .setOption('colors', ['#4285f4'])
      .setOption('hAxis', {title: 'Number of Applications'})
      .setOption('vAxis', {title: ''})
      .setOption('chartArea', {
        left: '20%',
        top: '10%',
        width: '65%',
        height: '75%'
      })
      .build();
    
    sheet.insertChart(chart);
  },
  
  /**
   * Categorizes job titles by seniority level and creates a visualization with enhanced styling
   * @param {Sheet} sheet - The sheet to add the visualization to
   * @param {Array} jobTitles - Array of job titles
   * @param {number} startRow - Starting row for the visualization
   */
  createEnhancedSeniorityLevelAnalysis: function(sheet, jobTitles, startRow) {
    // Define seniority levels and related keywords
    const seniorityLevels = {
      "Entry Level": ["junior", "entry", "entry level", "associate", "trainee", "intern", "apprentice", "graduate", "new grad"],
      "Mid Level": ["mid", "mid level", "intermediate", "ii", "2"],
      "Senior Level": ["senior", "sr", "lead", "iii", "3"],
      "Management": ["manager", "director", "vp", "vice president", "head of", "chief", "executive", "c-level", "cto", "cio", "ceo", "cfo"]
    };
    
    // Initialize seniority counts
    const seniorityCounts = {};
    for (const level in seniorityLevels) {
      seniorityCounts[level] = 0;
    }
    seniorityCounts["Unspecified"] = 0;
    
    // Categorize each job title
    for (const title of jobTitles) {
      const lowerTitle = title.toLowerCase();
      let categorized = false;
      
      for (const level in seniorityLevels) {
        for (const keyword of seniorityLevels[level]) {
          if (lowerTitle.includes(keyword)) {
            seniorityCounts[level]++;
            categorized = true;
            break;
          }
        }
        if (categorized) break;
      }
      
      if (!categorized) {
        seniorityCounts["Unspecified"]++;
      }
    }
    
    // Create enhanced header
    const headerRange = sheet.getRange(startRow, 1, 1, 2);
    headerRange.setValues([["Seniority Levels", "Count"]]);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#e8eaf6"); // Light indigo
    headerRange.setFontColor("#3f51b5"); // Indigo
    headerRange.setVerticalAlignment("middle");
    headerRange.setHorizontalAlignment("center");
    
    // Populate data - in a specific order to maintain hierarchy
    const orderedLevels = ["Entry Level", "Mid Level", "Senior Level", "Management", "Unspecified"];
    let row = startRow + 1;
    
    for (const level of orderedLevels) {
      if (seniorityCounts[level] > 0) {
        sheet.getRange(row, 1).setValue(level);
        sheet.getRange(row, 2).setValue(seniorityCounts[level]);
        
        // Apply different color for each level
        const colors = {
          "Entry Level": "#a8d1ff",
          "Mid Level": "#5ca3fa",
          "Senior Level": "#2979ff",
          "Management": "#0d47a1",
          "Unspecified": "#e0e0e0"
        };
        
        sheet.getRange(row, 1).setBackground(colors[level]);
        sheet.getRange(row, 1).setFontColor("#ffffff");
        if (level === "Unspecified") {
          sheet.getRange(row, 1).setFontColor("#424242"); // Darker text for light background
        }
        
        // Add subtle borders
        sheet.getRange(row, 1, 1, 2).setBorder(
          true, true, true, true, // top, left, bottom, right
          null, null, // vertical, horizontal
          "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID // color and style
        );
        
        row++;
      }
    }
    
    // Create enhanced donut chart
    const chartDataRange = sheet.getRange(startRow, 1, row - startRow, 2);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.PIE)
      .addRange(chartDataRange)
      .setPosition(startRow, 4, 0, 0)
      .setOption('title', 'Seniority Level Distribution')
      .setOption('titleTextStyle', {
        color: '#3f51b5',
        fontSize: 14,
        bold: true
      })
      .setOption('pieSliceText', 'percentage')
      .setOption('pieHole', 0.4) // Make it a donut chart
      .setOption('legend', {position: 'right', textStyle: {fontSize: 12}})
      .setOption('width', 500)
      .setOption('height', 300)
      .setOption('colors', ['#a8d1ff', '#5ca3fa', '#2979ff', '#0d47a1', '#e0e0e0'])
      .setOption('chartArea', {
        left: '10%',
        top: '10%',
        width: '70%',
        height: '80%'
      })
      .build();
    
    sheet.insertChart(chart);
  },
  
  /**
   * Creates a table of word frequency in job titles with enhanced styling
   * @param {Sheet} sheet - The sheet to add the data to
   * @param {Array} jobTitles - Array of job titles
   * @param {number} startRow - Starting row for the data
   */
  createEnhancedWordFrequencyTable: function(sheet, jobTitles, startRow) {
    // Common words to exclude from analysis
    const excludeWords = [
      "and", "or", "the", "a", "an", "of", "for", "in", "on", "at", "to", "with",
      "job", "position", "role", "title", "opportunity", "opening"
    ];
    
    // Extract all words from job titles
    const wordCounts = {};
    for (const title of jobTitles) {
      // Split by various separators and clean up
      const words = title.toLowerCase()
        .replace(/[^\w\s-]/g, ' ') // Replace non-alphanumeric chars (except dash) with space
        .split(/[\s,-]+/) // Split by spaces, commas, or dashes
        .filter(word => 
          word.length > 2 && // Only words with 3+ chars
          !excludeWords.includes(word) && // Not in exclude list
          !parseInt(word) // Not a number
        );
      
      // Count word occurrences  
      for (const word of words) {
        wordCounts[word] = (wordCounts[word] || 0) + 1;
      }
    }
    
    // Sort words by frequency (descending)
    const sortedWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25); // Keep only top 25 words
    
    // Create enhanced header
    const headerRange = sheet.getRange(startRow, 1, 1, 2);
    headerRange.setValues([["Common Job Title Words", "Frequency"]]);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#e8eaf6"); // Light indigo
    headerRange.setFontColor("#3f51b5"); // Indigo
    headerRange.setVerticalAlignment("middle");
    headerRange.setHorizontalAlignment("center");
    
    // Populate data with enhanced styling
    let row = startRow + 1;
    for (const [word, count] of sortedWords) {
      sheet.getRange(row, 1).setValue(word);
      sheet.getRange(row, 2).setValue(count);
      
      // Add background color with varying intensity based on count
      const maxCount = sortedWords[0][1];
      const colorIntensity = Math.floor(100 + (155 * count / maxCount)); // 100-255
      const colorHex = this.rgbToHex(76, 175, colorIntensity);
      sheet.getRange(row, 1).setBackground(colorHex);
      
      // Add subtle borders
      sheet.getRange(row, 1, 1, 2).setBorder(
        true, true, true, true, // top, left, bottom, right
        null, null, // vertical, horizontal
        "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID // color and style
      );
      
      row++;
    }
    
    // Create enhanced column chart
    const chartDataRange = sheet.getRange(startRow, 1, row - startRow, 2);
    
    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(chartDataRange)
      .setPosition(startRow, 4, 0, 0)
      .setOption('title', 'Most Common Words in Job Titles')
      .setOption('titleTextStyle', {
        color: '#3f51b5',
        fontSize: 14,
        bold: true
      })
      .setOption('legend', {position: 'none'})
      .setOption('width', 600)
      .setOption('height', 350)
      .setOption('colors', ['#34a853'])
      .setOption('vAxis', {title: 'Frequency'})
      .setOption('hAxis', {title: '', slantedText: true, slantedTextAngle: 45})
      .setOption('chartArea', {
        left: '10%',
        top: '10%',
        width: '80%',
        height: '75%'
      })
      .build();
    
    sheet.insertChart(chart);
  },
  
  /**
   * Helper function to convert RGB values to hex color code
   * @param {number} r - Red value (0-255)
   * @param {number} g - Green value (0-255)
   * @param {number} b - Blue value (0-255)
   * @return {string} Hex color code
   */
  rgbToHex: function(r, g, b) {
    return '#' + [r, g, b].map(x => {
      const hex = x.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }
};
