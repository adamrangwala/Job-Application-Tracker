/**
 * statusUtils.gs
 * 
 * This file contains utility functions for determining the status of job applications
 * from follow-up emails.
 */

// =============================================================
// Status Detection Utilities
// =============================================================
const StatusUtils = {
  /**
   * Determines the status from a follow-up email
   * @param {string} subject - Email subject line
   * @param {string} body - Email plain text body
   * @param {string} htmlBody - Email HTML body content
   * @return {string} Determined application status
   */
  determineStatus: function(subject, body, htmlBody) {
    const lowerSubject = subject.toLowerCase();
    const lowerBody = body.toLowerCase();
    const lowerHtmlBody = htmlBody ? htmlBody.toLowerCase() : "";
    
    // Combined content for searching
    const combinedContent = lowerSubject + " " + lowerBody + " " + lowerHtmlBody;
    
    // First check for rejection - the most common status for most job applications
    if (this.containsRejection(combinedContent)) {
      return "Rejected";
    }
    // Offer detection (highest priority)
    else if (this.containsOffer(combinedContent)) {
      return "Offer Received";
    }
    // Interview detection
    else if (this.containsInterview(combinedContent)) {
      return "Interview Request";
    } 
    // Assessment detection
    else if (this.containsAssessment(combinedContent)) {
      return "Assessment";
    } 
    // Look for application confirmation
    else if (this.containsApplication(combinedContent)) {
      return "Applied";
    }
    // Default status if nothing else matches
    else {
      return "Status Update";
    }
  },
  
  /**
   * Checks if content indicates a new application
   * @param {string} content - Combined email content
   * @return {boolean} True if application confirmation detected
   */
  containsApplication: function(content) {
    const applicationIndicators = [
      "thank you for applying",
      "thank you for your application",
      "application received",
      "we received your application",
      "confirmation of your application",
      "we have received your",
      "thank you for your interest",
      "application has been received",
      "application confirmed",
      "successfully applied",
      "application submitted"
    ];
    
    return applicationIndicators.some(indicator => content.includes(indicator));
  },
  
  /**
   * Checks if content indicates an interview request
   * @param {string} content - Combined email content
   * @return {boolean} True if interview detected
   */
  containsInterview: function(content) {
    const interviewIndicators = [
      "would like to meet",
      "schedule a meeting",
      "talk to you further",
      "meet the team",
      "meeting invitation",
      "discuss your application",
      "speak with you",
      "invite you to meet",
      "interview preparation",
    ];
    
    return interviewIndicators.some(indicator => content.includes(indicator));
  },
  
  /**
   * Checks if content indicates an assessment request
   * @param {string} content - Combined email content
   * @return {boolean} True if assessment detected
   */
  containsAssessment: function(content) {
    const assessmentIndicators = [
      "coding challenge",
      "technical challenge",
      "skills evaluation",
      "online test",
      "take-home",
      "take home",
      "project assignment",
      "technical screening",
      "skills assessment",
      "evaluation exercise",
      "homework assignment",
      "case study",
      "problem solving",
      "technical test"
    ];
    
    return assessmentIndicators.some(indicator => content.includes(indicator));
  },
  
  /**
   * Checks if content indicates a job offer
   * @param {string} content - Combined email content
   * @return {boolean} True if offer detected
   */
  containsOffer: function(content) {
    const offerIndicators = [
      "pleased to offer",
      "offer letter",
      "congratulations",
      "welcome aboard",
      "employment contract",
      "selected for the position",
      "extending an offer",
      "position is yours"
    ];
    
    return offerIndicators.some(indicator => content.includes(indicator));
  },
  
  /**
   * Checks if content indicates a rejection
   * @param {string} content - Combined email content
   * @return {boolean} True if rejection detected
   */
  containsRejection: function(content) {
    const rejectionIndicators = [
      "not moving forward",
      "other candidates",
      "not successful",
      "position has been filled",
      "decided to pursue",
      "regret to inform",,
      "unable to offer",
      "will not be progressing",
      "we have decided to proceed with",
      "more closely aligned",
      "going in a different direction",
      "won't be moving forward",
      "we will not move forward",
      "we're moving forward with those",
      "understand how disappointing",
      "selected another candidate",
      "pursuing other candidates",
      "no longer being considered",
      "not a good fit",
      "consider other applicants",
      "decision has been made",
      "has been closed",
      "position is closed",
      "we've filled",
      "we have filled",
      "has been filled"
    ];
    
    // If any of the rejection indicators are found AND we don't have positive indicators, it's a rejection
    const hasRejectionIndicator = rejectionIndicators.some(indicator => content.includes(indicator));
    const hasPositiveIndicator = content.includes("congratulations") || 
                                content.includes("offer") || 
                                content.includes("invitation to interview") ||
                                content.includes("would like to invite you");
                                content.includes("we have received your application"); 
    
    return hasRejectionIndicator && !hasPositiveIndicator;
  }
};
