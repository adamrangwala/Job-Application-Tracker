/**
 * extractionUtils.gs
 * 
 * This file contains utility functions for extracting information from emails:
 * - CompanyUtils: For extracting company names
 * - JobUtils: For extracting job titles 
 */

// =============================================================
// Company Name Extraction Utilities
// =============================================================
const CompanyUtils = {
  
  isLikelyNotCompany: function(text) {
    // Common job words that should indicate it's actually a job title
    const jobWords = [
      // Accidentally captured job
      "position", "role", "intern", "internship",

      // Job site names
      "Indeed", "Glassdoor"
    ];
  
    // First, check if any job words are present as standalone words
    const textLower = text.toLowerCase();
    
    // Check for job words in any context within the text
    return jobWords.some(word => {
      // Look for the word surrounded by word boundaries, commas, hyphens, or other separators
      // This will match standalone words, hyphenated words, and comma-separated lists
      const pattern = new RegExp(`(^|\\s|,|-|/|\\(|\\)|&)${word}($|\\s|,|-|/|\\(|\\)|&|s|ing|er)`, 'i');
      return pattern.test(textLower);
    });
  },

  /**
   * Extracts company name from email content using various methods
   * @param {string} subject - Email subject line
   * @param {string} body - Email plain text body
   * @param {string} from - Email sender field
   * @param {string} htmlBody - Email HTML body content
   * @return {string} Extracted company name or "Unknown Company"
   */
  extractCompany: function(subject, body, from, htmlBody) {
    console.log("Subject text: " + subject);
    // Method 1: Look for patterns in subject
    let match;
    const subjectPatterns = [
      /for your interest in(?:.*?)([A-Za-z0-9&.,-]+(?:\s+[A-Za-z0-9&.,-]+)*)/i,
      /applying to join ([A-Za-z0-9\s&-]+){1,50}/i,
      /at\s+([A-Za-z0-9\s&.,-]+){1,50}/i, 
      /to\s+([A-Za-z0-9\s&.,-]+){1,50}/i,
      /with\s+([A-Za-z0-9\s&.,-]+){1,50}/i,
      /join\s+([A-Za-z0-9\s&.,-]+){1,50}/i,
      /from\s+([A-Za-z0-9\s&.,-]+){1,50}/i
    ];
    
    for (const pattern of subjectPatterns) {
      let match = subject.match(pattern);
      if (match) {
        console.log("Match found: " + match[0]);
        console.log("Captured group: " + match[1]);

        const candidate = match[1].trim();
        console.log("Is likely not company? " + this.isLikelyNotCompany(candidate));

        if (!this.isLikelyNotCompany(candidate)) {
          return candidate; // Return immediately if it doesn't have a job descriptor
        }
      }else{
        console.log("No match found for pattern: " + pattern);
      }
    } 

    // Method 2: Look for common phrases in the plain text email body
    const bodyPatterns = [
      /role at ([A-Za-z0-9\s&,-]+){1,50}/i,
      /job at ([A-Za-z0-9\s&,-]+){1,50}/i,
      /position at ([A-Za-z0-9\s&,-]+){1,50}/i,
      /team at ([A-Za-z0-9\s&,-]+){1,50}/i,
      /career (?:with|at) ([A-Za-z0-9\s&-]+){1,50}/i,
      /applying to join ([A-Za-z0-9\s&-]+){1,50}/i,
      /in joining ([A-Za-z0-9\s&,-]+){1,50}/i,
      /for your interest in(?:\s+employment)?(?:\s+with|at)? ([A-Za-z0-9\s&,-]+){1,50}/i,
      /employment with ([A-Za-z0-9\s&,-]+){1,50}/i,
      /thank you for applying to ([A-Za-z0-9\s&,-]+){1,50}/i,
      /your application to ([A-Za-z0-9\s&,-]+){1,50}/i,
      /your application with ([A-Za-z0-9\s&,-]+){1,50}/i,
      /application at ([A-Za-z0-9\s&,-]+){1,50}/i,
      /application with ([A-Za-z0-9\s&,-]+){1,50}/i,
      /application received ([A-Za-z0-9\s&,-]+){1,50}/i,
      /new message from ([A-Za-z0-9\s&,-]+){1,50}/i

    ];
    
    for (const pattern of bodyPatterns) {
      let match = body.match(pattern);
      if (match) {
        console.log("Match found: " + match[0]);
        console.log("Captured group: " + match[1]);

        const candidate = match[1].trim();
        console.log("Is likely not company? " + this.isLikelyNotCompany(candidate));

        if (!this.isLikelyNotCompany(candidate)) {
          return candidate; // Return immediately if it doesn't have a job descriptor
        }
      }else{
        console.log("No match found for pattern: " + pattern);
      }

    } 
    
    // Method 3: Look for company logo alt text or company name in HTML
    if (htmlBody) {
      // Logo alt text often contains company name
      match = htmlBody.match(/<img[^>]*alt=['"]([^'"]*(?:logo|Logo)[^'"]*?)['"][^>]*>/i);
      if (match && match[1].length > 4) {
        const altText = match[1].replace(/logo|Logo/, '').trim();
        if (altText.length > 2) return altText;
      }
      
      // Look for company name in HTML header or footer
      const headerFooterPatterns = [
        /<(?:header|footer)[^>]*>(?:[\s\S]*?)([A-Za-z0-9\s&.,-]{2,30})(?:[\s\S]*?)<\/(?:header|footer)>/i,
        /<(?:div)[^>]*?(?:class|id)=['"](?:header|footer|company-name|brand|logo-container)['"][^>]*>(?:[\s\S]*?)([A-Za-z0-9\s&.,-]{2,30})(?:[\s\S]*?)<\/(?:div)>/i
      ];
      
      for (const pattern of headerFooterPatterns) {
        match = htmlBody.match(pattern);
        if (match && match[1].trim().length > 2) return match[1].trim();
      else{
        console.log("No match found for pattern: " + pattern);
      }  
      }
    }
    
    // Method 4: Extract from sender email
    const emailMatch = from.match(/.*?([a-zA-Z0-9.-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch) {
      const email = emailMatch[1].trim();
      
      // Extract domain and clean common subdomains
      const domain = email.split('@')[1];
      const domainParts = domain.split('.');
      
      // Remove common TLDs and second-level domains
      if (domainParts.length >= 3) {
        // Remove common subdomains like careers, jobs, talent, hr
        const commonSubdomains = ["careers", "jobs", "talent", "hr", "recruiting", "apply", "hire", "recruitment"];
        const firstPart = domainParts[0].toLowerCase();
        
        if (commonSubdomains.includes(firstPart)) {
          // Return the main domain name (second part), capitalized
          return this.capitalizeCompanyName(domainParts[1]);
        }
      }
      
      // Use main domain name (without TLD)
      const mainDomain = domainParts[domainParts.length - 2];
      
      // Don't return common non-company usernames
      const commonUsernames = ["notifications", "jobs", "recruiters", "no-reply", "noreply", "careers", "talent", "hr"];
      if (!commonUsernames.includes(mainDomain.toLowerCase())) {
        return this.capitalizeCompanyName(mainDomain);
      }
    }

    return "Unlisted";
  },
  
  /**
   * Extracts sender name from the "from" field
   * @param {string} from - Email from field
   * @return {string|null} Extracted sender name or null
   */
  extractSenderName: function(from) {
    // For names wrapped in ** markdown bold markers
    const markdownBoldPattern = /\*\*([^*]+)\*\*/;
    
    // For names in quotes
    const quotedNamePattern = /"([^"]+)"/;
    
    // For names that appear before the email address without special formatting
    const plainNamePattern = /^([^<]+?)\s*</;
    
    // Try each pattern in order of specificity
    let match = from.match(markdownBoldPattern);
    if (match && match[1]) return match[1].trim();
    
    match = from.match(quotedNamePattern);
    if (match && match[1]) return match[1].trim();
    
    match = from.match(plainNamePattern);
    if (match && match[1]) return match[1].trim();
    
    return null;
  },
  
  /**
   * Helper function to capitalize company names extracted from domains
   * @param {string} name - Company name to capitalize
   * @return {string} Capitalized company name
   */
  capitalizeCompanyName: function(name) {
    // Handle empty input
    if (!name) return "";
    
    // Handle hyphenated names (e.g., "acme-inc" → "Acme-Inc")
    if (name.includes('-')) {
      return name.split('-')
        .map(part => this.capitalizeCompanyName(part))
        .join('-');
    }
    
    // Handle common domain name patterns
    const commonSuffixes = {
      "co": "Co",
      "inc": "Inc",
      "corp": "Corp",
      "llc": "LLC",
      "ltd": "Ltd",
      "tech": "Tech",
      "io": "IO",
      "ai": "AI"
    };
    
    if (commonSuffixes[name.toLowerCase()]) {
      return commonSuffixes[name.toLowerCase()];
    }
    
    // Standard capitalization
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
};

// =============================================================
// Job Information Extraction Utilities
// =============================================================
const JobUtils = {
  /**
   * Extracts job title from email content using various methods
   * @param {string} subject - Email subject line
   * @param {string} body - Email plain text body
   * @param {string} htmlBody - Email HTML body content
   * @return {string} Extracted job title or "Unlisted"
   */

  isLikelyJobTitle: function(text) {
    // Common job words that should indicate it's actually a job title
    const jobWords = [
      // Level/Seniority Indicators
      "associate", "assistant", "junior", "senior", "lead", 
      "head", "chief", "director", "manager", "supervisor", 
      "coordinator", "executive", "intern", "entry-level",
      
      // Function Words
      "specialist", "analyst", "engineer", "developer", 
      "administrator", "technician", "officer", "representative", 
      "consultant", "advisor",
      
      // Department/Field Indicators
      "data", "software", "marketing", "sales", "operations", 
      "human resources", "hr", "it", "project", "business", 
      "financial", "technical", "customer", "product",
      
      // Additional Common Role Words
      "scientist", "designer", "strategist"
    ];
  
    // First, check if any job words are present as standalone words
    const textLower = text.toLowerCase();
    
    // Check for job words in any context within the text
    return jobWords.some(word => {
      // Look for the word surrounded by word boundaries, commas, hyphens, or other separators
      // This will match standalone words, hyphenated words, and comma-separated lists
      const pattern = new RegExp(`(^|\\s|,|-|/|\\(|\\)|&)${word}($|\\s|,|-|/|\\(|\\)|&|s|ing|er)`, 'i');
      return pattern.test(textLower);
    });
  },

  extractJobTitle: function(subject, body, from, htmlBody) {
    console.log("Body text: " + body);
    // Preprocess body to standardize spaces and HTML entities
    if (body) {
      // Replace non-breaking spaces with regular spaces
      body = body.replace(/&nbsp;/g, ' ');
      
      // You could also add other common HTML entity replacements
      body = body.replace(/&amp;/g, '&');
      body = body.replace(/&lt;/g, '<');
      body = body.replace(/&gt;/g, '>');
      body = body.replace(/\*/g, '');
      
      // Remove excessive whitespace
      body = body.replace(/\s+/g, ' ').trim();
    }
    
    // Similarly preprocess HTML content if it exists
    if (htmlBody) {
      htmlBody = htmlBody.replace(/&nbsp;/g, ' ');
      // Add other entity replacements as needed
    }

    // Method 0: Look for Indeed application submitted pattern
    const indeedPattern =  /Application submitted\s+([^\n<]+)/i;
    let match = body.match(indeedPattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      console.log("Found Indeed application pattern: " + candidate);
      if (this.isLikelyJobTitle(candidate)) {
        return candidate;
      }
    }

    // Method 1: Look for common patterns in subject
    const subjectPatterns = [
      /application received for ([A-Za-z0-9\s&(),.'-:]+)/i,
      /applied for our ([A-Za-z0-9\s&(),.'-]+) position/i,
      /applied for the ([A-Za-z0-9\s&(),.'-]+) position/i,
      /your application for our ([A-Za-z0-9\s&(),.'-]+)(\s+at|\s+with)?/i,
      /your application for ([A-Za-z0-9\s&(),.'-]+)(\s+at|\s+with)?/i,
      /(?:post|job|position|role) of ([A-Za-z0-9\s&(),.'-]+)/i,
      /role of ([A-Za-z0-9\s&(),.'-]+)/i,
      /to the ([A-Za-z0-9\s&(),.'-]+) position/i,
      /- ([A-Za-z0-9\s&(),.'-]+) \./i,
      /: ([A-Za-z0-9\s&(),.'-]+) at/i
    ];
    
    for (const pattern of subjectPatterns) {
      let match = subject.match(pattern);
      if (match) {
        console.log("Match found: " + match[0]);
        console.log("Captured group: " + match[1]);
        const candidate = match[1].trim();
        if (this.isLikelyJobTitle(candidate)) {
          return candidate; // Return immediately if it looks like a job title
        }
      }
    }
    
    // Method 2: Look for common patterns in plain text body
    const bodyPatterns = [
      // Application patterns
      /apply(?:ing)? (?:to|for) (?:the|our)? ([A-Za-z0-9\s&(),'-.]+)(?:\s+position|\s+role|\s+at|\s+with|\s+job)/i,
      /your application for (?:the)? (?:position|role|job|post)? (?:of)? ([A-Za-z0-9\s&(),'-]+)(?:,|.|\s+position|\s+role|\s+job)? (?:at|with)?/i,
      
      // Receipt patterns
      /received your application for (?:the )?([A-Za-z0-9\s&(),'-]+)(?:,|\s+position|\s+role|\s+job)?/i,
      /received your application for (?:the position of)?([A-Za-z0-9\s&(),'-]+){1,40}(?:,|\s+position|\s+role|\s+job)?/i,
      
      // Application patterns with "for"
      /for the (?:position|role|job|post) of ([A-Za-z0-9\s&(),'-]+)(?:,|\s+at|\s+with)/i,
      /for the (?:current)?(?:position|role|job|post) of ([A-Za-z0-9\s&(),'-]+)/i,
      /for (?:the|our)(?:\s+current)?([A-Za-z0-9\s&(),'-]+)(?:,|\s+position|\s+role|\s+job|\s+at|\s+with)/i,
      /application for ([A-Za-z0-9\s&(),.'-]+)(\s+at|\s+with)?/i,

      // Position reference patterns
      /(?:in|to) the ([A-Za-z0-9\s&(),'-]+)(?:,|\s+position|\s+role|\s+job)/i,
      
      // Job listing specific patterns
      /job title:?\s*([A-Za-z0-9\s&(),'-]+)/i,
      /position:?\s*([A-Za-z0-9\s&(),'-]+)/i,
      /role:?\s*([A-Za-z0-9\s&(),'-]+)/i,
      /job:?\s*([A-Za-z0-9\s&(),'-]+)/i
    ];
    
    for (const pattern of bodyPatterns) {
      let match = body.match(pattern);
      if (match) {
        console.log("Match found: " + match[0]);
        console.log("Captured group: " + match[1]);

        const candidate = match[1].trim();
        console.log("Is likely job title? " + this.isLikelyJobTitle(candidate));

        if (this.isLikelyJobTitle(candidate)) {
          return candidate; // Return immediately if it looks like a job title
        }else{
          console.log("Failed isLikelyJobTitle check for: " + candidate);
        }
      }else{
        console.log("No match found for pattern: " + pattern);
      }
        // Continue checking other patterns if this doesn't look like a job title
    }
    
    // Method 3: Extract from HTML content
    if (htmlBody) {
      // Look for job title in structured HTML
      const htmlPatterns = [
        /<[^>]*?(?:class|id)=['"](?:job-title|position-title|role-title)['"][^>]*>([^<]+)<\/[^>]+>/i,
        /<[^>]*?(?:class|id)=['"](?:.*?job.*?|.*?position.*?|.*?role.*?)['"][^>]*>([^<]+)<\/[^>]+>/i,
        /<strong>(?:Job|Position|Role)(?:\s+Title)?:?\s*<\/strong>([^<]+)/i,
        /<b>(?:Job|Position|Role)(?:\s+Title)?:?\s*<\/b>([^<]+)/i,
        /(?:Job|Position|Role)(?:\s+Title)?:?\s*<[^>]+>([^<]+)<\/[^>]+>/i
      ];
      
      for (const pattern of htmlPatterns) {
        let match = htmlBody.match(pattern);
        if (match && match[1].trim().length > 3) return match[1].trim();
      }
      
      // Try to extract from meta tags or title
      const metaPatterns = [
        /<meta\s+(?:name|property)=["'](?:og:title|twitter:title)["']\s+content=["']([^"']+)["']/i,
        /<title>([^<]+)<\/title>/i
      ];
      
      for (const pattern of metaPatterns) {
        let match = htmlBody.match(pattern);
        if (match) {
          // Clean up title to extract just the job part
          const title = match[1].trim();
          // Look for job title patterns in the title
          const jobMatch = title.match(/(?:Application|Applied) for ([A-Za-z0-9\s&(),.'-]+)/i);
          if (jobMatch) return jobMatch[1].trim();
        }
      }
    }
    
    return "Unlisted";
  },
  
  /**
 * Cleans up extracted job title to remove common noise
 * @param {string} title - Raw job title
 * @return {string} Cleaned job title
 */
cleanJobTitle: function(title) {
  // Check if title is undefined, null, or not a string
  if (!title || typeof title !== 'string') return "Unlisted Position";
  
  // Remove common noisy prefixes
  let cleaned = title
    .replace(/^(re:|fwd:|fw:)/i, '')
    .trim();
    
  // Remove "our", "the" from the beginning
  cleaned = cleaned
    .replace(/^(our|the)\s+/i, '')
    .trim();
    
  // Remove common noisy suffixes and phrases
  cleaned = cleaned
    .replace(/(?:position|role|opportunity|opening)(?:(,|.|\s+)(?:at|with|and)?\s+[A-Za-z0-9\s&(),.'-]+)?$/i, '')
    .trim();
  
  // Remove "at ___" from the end of the title
  cleaned = cleaned
    .replace(/\s+at\s+[A-Za-z0-9\s&(),.'-]+$/i, '')
    .trim();

  // Remove "and your/are ___"
  cleaned = cleaned
    .replace(/\s+and\s+(:?your|are|we|we're)\s+[A-Za-z0-9\s&(),.'-]+$/i, '')
    .trim();

  // Remove excessive spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  
  // Remove period or comma from the end of the string
  cleaned = cleaned
  .replace(/[.,]$/i, '')
  .trim();

  // If the title is exceptionally long (likely grabbed too much text)
  if (cleaned.length > 100) {
    // Try to take just the first phrase
    const parts = cleaned.split(/[,.;:]/);
    if (parts[0] && parts[0].length > 3) {
      cleaned = parts[0].trim();
    } else {
      // Truncate with ellipsis
      cleaned = cleaned.substring(0, 47) + '...';
    }
  }
  
  return cleaned || "Unlisted Position";
}
};
