import axios from "axios";
import { z } from "zod";

import type { JiraIssue } from "../ingestion/jiraClient";
import { jiraClient } from "../ingestion/jiraClient";
import type { BugAnalysis } from "../reporter/bugReporter";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CreateAgentResponseSchema = z
  .object({
    agent: z.object({ id: z.string() }).passthrough(),
    run: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough();

const RunPollSchema = z
  .object({
    status: z.string(),
  })
  .passthrough();

function normalizeRunStatus(status: unknown): string {
  return String(status ?? "").toUpperCase();
}

function extractPrInfo(data: unknown): { prUrl?: string; branch?: string } {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  const branch =
    typeof d.branchName === "string"
      ? d.branchName
      : typeof d.branch === "string"
        ? d.branch
        : undefined;

  const pr = d.pullRequest ?? d.pull_request ?? d.pr;
  let prUrl: string | undefined;
  if (pr && typeof pr === "object") {
    const p = pr as Record<string, unknown>;
    prUrl =
      typeof p.url === "string"
        ? p.url
        : typeof p.htmlUrl === "string"
          ? p.htmlUrl
          : typeof p.html_url === "string"
            ? p.html_url
            : undefined;
  }

  return { prUrl, branch };
}

export async function triggerCursorAutoFix(
  bugKey: string,
  analysis: BugAnalysis,
  _issue: JiraIssue,
): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  const repoUrl = process.env.REPO_URL?.trim();
  if (!apiKey) {
    console.warn("[Sentinel] CURSOR_API_KEY not set; skipping Cursor auto-fix.");
    return;
  }
  if (!repoUrl) {
    console.warn("[Sentinel] REPO_URL not set; skipping Cursor auto-fix.");
    return;
  }

  const auth = { username: apiKey, password: "" };

  const createRes = await axios.post(
    "https://api.cursor.com/v1/agents",
    {
      prompt: {
        text: `Bug ${bugKey} was found by automated QA. 
Title: ${analysis.title}
Steps to reproduce: ${analysis.stepsToReproduce.join("\n")}
Expected: ${analysis.expectedResult}
Actual: ${analysis.actualResult}
Root cause hypothesis: ${analysis.rootCause}

Please investigate and fix this bug. Create a PR when done.`,
      },
      repos: [{ url: repoUrl, startingRef: "main" }],
      autoCreatePR: true,
    },
    { auth },
  );

  const created = CreateAgentResponseSchema.parse(createRes.data);
  const agentId = created.agent.id;
  const runId = created.run.id;

  const terminal = new Set(["FINISHED", "FAILED", "CANCELLED"]);
  const deadline = Date.now() + 10 * 60 * 1000;
  let status = "CREATING";

  while (!terminal.has(normalizeRunStatus(status)) && Date.now() < deadline) {
    await sleep(15_000);
    const runRes = await axios.get(
      `https://api.cursor.com/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      { auth },
    );
    const polled = RunPollSchema.safeParse(runRes.data);
    status = polled.success ? polled.data.status : String(runRes.data?.status ?? status);
  }

  if (!terminal.has(normalizeRunStatus(status))) {
    console.warn(
      `[Sentinel] Cursor agent ${agentId} timed out after 10m (last status: ${status}).`,
    );
    return;
  }

  if (normalizeRunStatus(status) !== "FINISHED") {
    console.warn(`[Sentinel] Cursor agent ended with status ${status}.`);
    return;
  }

  const agentRes = await axios.get(`https://api.cursor.com/v1/agents/${encodeURIComponent(agentId)}`, {
    auth,
  });

  const { prUrl, branch } = extractPrInfo(agentRes.data);
  const note = prUrl
    ? `Cursor agent created fix PR: ${prUrl}`
    : branch
      ? `Cursor agent created fix branch: ${branch}`
      : `Cursor agent ${agentId} finished (see Cursor dashboard for PR/branch).`;

  await jiraClient.addComment(bugKey, note);
}
