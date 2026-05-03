import type { JiraIssue } from "../ingestion/jiraClient";

/** Public Heroku app — stable login form for vision-agent demos. */
export const DEMO_TARGET_APP_URL = "https://the-internet.herokuapp.com/login";

export const DEMO_JIRA_ISSUE: JiraIssue = {
  key: "DEMO-1",
  summary: "User login with email and password",
  acceptanceCriteria: `
       - Valid email + password → redirect to /dashboard
       - Invalid password → show "Invalid credentials" error
       - Empty email field → show "Email is required" validation
       - Empty password field → show "Password is required" validation
       - SQL injection in email field → rejected gracefully
       - 5 failed attempts → account lockout message
     `.trim(),
  description: "Users must authenticate securely before accessing the app.",
  status: "Demo",
};
