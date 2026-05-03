import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { z } from "zod";

import { jiraClient } from "../ingestion/jiraClient";
import type { StepResult, VerifyResult } from "../driver/visionAgent";
import { analysisModel } from "../llm/geminiClient";
import { withRetry } from "../llm/withRetry";
import type { TestPlan, TestStep } from "../reasoning/testDecomposer";

export type BugAnalysis = {
  title: string;
  stepsToReproduce: string[];
  expectedResult: string;
  actualResult: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  rootCause: string;
  visualDescription: string;
};

function normalizeSeverity(raw: string): BugAnalysis["severity"] {
  const s = raw.trim().toLowerCase();
  if (s === "critical") return "Critical";
  if (s === "high") return "High";
  if (s === "medium") return "Medium";
  if (s === "low") return "Low";
  return "Medium";
}

const BugAnalysisSchema = z.object({
  title: z.string(),
  stepsToReproduce: z.array(z.string()),
  expectedResult: z.string(),
  actualResult: z.string(),
  severity: z.union([
    z.enum(["Critical", "High", "Medium", "Low"]),
    z.string().transform(normalizeSeverity),
  ]),
  rootCause: z.string(),
  visualDescription: z.string(),
});

function extractJsonFromModelText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function textBlock(text: string): Record<string, unknown> {
  return {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
}

function headingBlock(level: number, text: string): Record<string, unknown> {
  return {
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  };
}

function bugAnalysisToDescriptionAdf(analysis: BugAnalysis, relatedTicket: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [
    headingBlock(2, analysis.title),
    headingBlock(3, "Related ticket"),
    textBlock(relatedTicket),
    headingBlock(3, "Severity"),
    textBlock(analysis.severity),
    headingBlock(3, "Steps to reproduce"),
    ...analysis.stepsToReproduce.map((s, i) => textBlock(`${i + 1}. ${s}`)),
    headingBlock(3, "Expected result"),
    textBlock(analysis.expectedResult),
    headingBlock(3, "Actual result"),
    textBlock(analysis.actualResult),
    headingBlock(3, "Root cause"),
    textBlock(analysis.rootCause),
    headingBlock(3, "Visual description"),
    textBlock(analysis.visualDescription),
  ];

  return { type: "doc", version: 1, content };
}

function basenameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class BugReporter {
  async analyzeFailure(
    step: TestStep,
    stepResult: StepResult,
    verifyResult: VerifyResult,
    screenshotPaths: string[],
  ): Promise<BugAnalysis> {
    const imageParts = await Promise.all(
      screenshotPaths.map(async (p) => ({
        inlineData: {
          mimeType: "image/png" as const,
          data: (await readFile(p)).toString("base64"),
        },
      })),
    );

    const actualNarrative =
      verifyResult.discrepancy?.trim() || verifyResult.reason || "(not specified)";

    const result = await withRetry(() =>
      analysisModel.generateContent([
      ...imageParts,
      {
        text: `You are a QA engineer writing a bug report.
        
Test step that failed:
- Planned action: ${step.action} on "${step.target ?? "N/A"}"
- Expected: ${step.expectedResult}
- Actual: ${actualNarrative}
- Agent attempted: ${JSON.stringify(stepResult.action)}

The images show the screen before and after the action.

Write a structured bug analysis as JSON:
{
  "title": "concise bug title under 80 chars",
  "stepsToReproduce": ["numbered step 1", "step 2", ...],
  "expectedResult": "what should have happened",
  "actualResult": "what actually happened (from screenshots)",
  "severity": "Critical|High|Medium|Low",
  "rootCause": "probable technical cause",
  "visualDescription": "describe the visual discrepancy you see in the screenshots"
}`,
      },
    ]),
    );

    const text = result.response.text();
    const parsed: unknown = JSON.parse(extractJsonFromModelText(text));
    return BugAnalysisSchema.parse(parsed);
  }

  async createJiraBug(
    analysis: BugAnalysis,
    relatedTicket: string,
    screenshotPaths: string[],
  ): Promise<string> {
    const summary = analysis.title.length > 255 ? analysis.title.slice(0, 252) + "..." : analysis.title;

    const key = await jiraClient.createBugIssue({
      summary,
      descriptionAdf: bugAnalysisToDescriptionAdf(analysis, relatedTicket),
      severityForPriority: analysis.severity,
      labels: ["sentinel-automated"],
    });

    for (const filePath of screenshotPaths) {
      await jiraClient.uploadAttachment(key, filePath, basenameFromPath(filePath));
    }

    return key;
  }

  async generateTestReport(
    plan: TestPlan,
    results: StepResult[],
    bugKeys: string[],
    options?: {
      outputDirectory?: string;
      /** When provided, drives row status and counts (e.g. verification-based pass/fail). */
      stepOutcomes?: Array<"pass" | "fail" | "skipped" | "stuck">;
    },
  ): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir =
      options?.outputDirectory ?? path.join(process.cwd(), "reports", stamp);
    await mkdir(dir, { recursive: true });

    const jiraBase = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    let bugIdx = 0;

    const rowsHtml = plan.steps
      .map((step, i) => {
        const result = results[i];
        let status: "pass" | "fail" | "skipped" | "stuck";
        const outcomes = options?.stepOutcomes;
        const outcome = outcomes?.[i];
        if (outcomes !== undefined && outcome !== undefined) {
          status = outcome;
          if (status === "pass") passed++;
          else if (status === "fail" || status === "stuck") failed++;
          else skipped++;
        } else if (result === undefined) {
          status = "skipped";
          skipped++;
        } else if (result.stuck) {
          status = "stuck";
          failed++;
        } else if (result.success) {
          status = "pass";
          passed++;
        } else {
          status = "fail";
          failed++;
        }

        const bugKey = status === "fail" || status === "stuck" ? bugKeys[bugIdx++] : undefined;
        const bugUrl =
          bugKey && jiraBase ? `${jiraBase}/browse/${encodeURIComponent(bugKey)}` : "";

        const rowClass =
          status === "pass"
            ? "row-pass"
            : status === "fail"
              ? "row-fail"
              : status === "stuck"
                ? "row-stuck"
                : "row-skip";
        const badgeClass =
          status === "skipped" ? "skipped" : status === "stuck" ? "stuck" : status;

        const beforeB64 = result?.screenshotBefore.toString("base64") ?? "";
        const afterB64 = result?.screenshotAfter.toString("base64") ?? "";

        const beforeImg = beforeB64
          ? `<img alt="before" src="data:image/png;base64,${beforeB64}" />`
          : "<span class=\"muted\">—</span>";
        const afterImg = afterB64
          ? `<img alt="after" src="data:image/png;base64,${afterB64}" />`
          : "<span class=\"muted\">—</span>";

        const bugCell =
          bugKey && bugUrl
            ? `<a href="${escapeHtml(bugUrl)}">${escapeHtml(bugKey)}</a>`
            : status === "fail" || status === "stuck"
              ? "<span class=\"muted\">(no key)</span>"
              : "—";

        return `
      <tr class="${rowClass}">
        <td>${escapeHtml(step.id)}</td>
        <td>${escapeHtml(step.action)}</td>
        <td>${escapeHtml(step.target ?? "")}</td>
        <td><span class="badge badge-${badgeClass}">${status}</span></td>
        <td class="shots">${beforeImg}</td>
        <td class="shots">${afterImg}</td>
        <td>${bugCell}</td>
      </tr>`;
      })
      .join("\n");

    const bugsList =
      bugKeys.length === 0
        ? "<em>None</em>"
        : bugKeys.map((k) => escapeHtml(k)).join(", ");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Sentinel — ${escapeHtml(plan.title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
    h1 { font-size: 1.25rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border: 1px solid #ccc; padding: 8px 10px; vertical-align: top; }
    th { background: #f4f4f4; text-align: left; }
    .row-pass { background: #e8f8ef; }
    .row-fail { background: #fdeaea; }
    .row-skip { background: #fff7e6; }
    .badge { padding: 2px 8px; border-radius: 6px; font-size: 0.75rem; text-transform: uppercase; }
    .badge-pass { background: #28a745; color: #fff; }
    .badge-fail { background: #dc3545; color: #fff; }
    .badge-skipped { background: #fd7e14; color: #fff; }
    .badge-stuck { background: #9c27b0; color: #fff; }
    .row-stuck { background: #f3e5f5; }
    .shots img { max-width: 280px; display: block; margin-top: 4px; }
    .muted { color: #666; }
    .meta { margin: 8px 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(plan.title)}</h1>
  <p class="meta"><strong>Issue:</strong> ${escapeHtml(plan.issueKey)}</p>
  <p class="meta"><strong>Summary:</strong> ${passed}/${plan.steps.length} steps passed,
    ${failed} failed, ${skipped} skipped.</p>
  <p class="meta"><strong>Bugs filed:</strong> ${bugsList}</p>
  <table>
    <thead>
      <tr>
        <th>Step</th>
        <th>Action</th>
        <th>Target</th>
        <th>Status</th>
        <th>Before</th>
        <th>After</th>
        <th>Jira</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`;

    await writeFile(path.join(dir, "report.html"), html, "utf8");
  }
}

export const bugReporter = new BugReporter();
