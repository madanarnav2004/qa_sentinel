import "dotenv/config";

import { mkdir, writeFile } from "fs/promises";
import path from "path";

import type { JiraIssue } from "../ingestion/jiraClient";
import { jiraClient } from "../ingestion/jiraClient";
import { visionAgent } from "../driver/visionAgent";
import type { StepResult, VerifyResult } from "../driver/visionAgent";
import type { BugAnalysis } from "../reporter/bugReporter";
import { bugReporter } from "../reporter/bugReporter";
import { decomposePRD } from "../reasoning/testDecomposer";
import { DEMO_JIRA_ISSUE } from "./demo";
import { triggerCursorAutoFix } from "./cursorAgent";

function resolveTargetAppUrl(issue: JiraIssue): string {
  const fromJira = issue.stagingUrl?.trim();
  if (fromJira) return fromJira;
  const fromEnv = process.env.TARGET_APP_URL?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    `No staging URL found. Set TARGET_APP_URL in .env or add a Staging URL field to Jira issue ${issue.key}`,
  );
}

function runStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function saveScreenshot(
  runDir: string,
  stepId: string,
  phase: "before" | "after" | "stuck",
  buf: Buffer,
): Promise<string> {
  const safeId = stepId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = path.join(runDir, `${safeId}-${phase}.png`);
  await writeFile(file, buf);
  return file;
}

export async function runSentinel(
  jiraTicketKey: string,
  options?: { demo?: boolean; dryRun?: boolean },
): Promise<void> {
  const stamp = runStamp();
  const runDir = path.join(process.cwd(), "reports", stamp);
  await mkdir(runDir, { recursive: true });

  const demoMode = options?.demo === true;
  const dryRun = options?.dryRun === true;

  let issue: JiraIssue;
  let effectiveKey = jiraTicketKey;

  if (demoMode) {
    issue = DEMO_JIRA_ISSUE;
    effectiveKey = DEMO_JIRA_ISSUE.key;
    console.warn(`[Sentinel] Demo mode: mock issue ${issue.key}`);
  } else {
    try {
      issue = await jiraClient.fetchIssue(jiraTicketKey);
    } catch (e) {
      console.warn("[Sentinel] Jira unreachable — using demo issue and public login URL.", e);
      issue = DEMO_JIRA_ISSUE;
      effectiveKey = DEMO_JIRA_ISSUE.key;
    }
  }

  console.log(`[Sentinel] Loaded: ${issue.summary}`);

  const plan = await decomposePRD(issue);
  console.log(
    `[Sentinel] ${plan.steps.length} steps (${plan.happyPath.length} happy, ${plan.edgeCases.length} edge)`,
  );

  process.env.TARGET_APP_URL = resolveTargetAppUrl(issue);
  console.log(`[Sentinel] TARGET_APP_URL=${process.env.TARGET_APP_URL}`);

  await visionAgent.init();
  const results: StepResult[] = [];
  const pendingBugs: Array<{ analysis: BugAnalysis; shots: string[] }> = [];
  const stepOutcomes: Array<"pass" | "fail" | "skipped" | "stuck"> = [];

  try {
    for (const step of plan.steps) {
      console.log(`[Step ${step.id}] ${step.action}: ${step.target ?? ""}`);

      let screenshotStuckCount = 0;
      let domStreak = 0;
      let prevDomFp = "";
      let domStuck = false;

      let result: StepResult | null = null;
      let lastVerify: VerifyResult | undefined;
      let previousAfter: Buffer | null = null;

      while (screenshotStuckCount < 5 && !domStuck) {
        result = await visionAgent.executeStep(step);
        const fp = result.domFingerprint;

        if (fp && prevDomFp === fp) {
          domStreak++;
        } else {
          domStreak = 0;
        }
        prevDomFp = fp;

        if (fp && domStreak >= 4) {
          console.warn(
            `[STUCK] Same DOM fingerprint (${fp.slice(0, 12)}…) for 5 iterations — saving screenshot and advancing.`,
          );
          result.stuck = true;
          await saveScreenshot(runDir, step.id, "stuck", result.screenshotAfter);
          domStuck = true;
          break;
        }

        lastVerify = await visionAgent.verifyExpectation(step.expectedResult);

        if (lastVerify.satisfied) break;

        if (previousAfter !== null && result.screenshotAfter.equals(previousAfter)) {
          screenshotStuckCount++;
        } else {
          screenshotStuckCount = 0;
        }
        previousAfter = result.screenshotAfter;
      }

      const verifyPassed = lastVerify?.satisfied === true;
      if (result?.stuck) {
        stepOutcomes.push("stuck");
      } else {
        stepOutcomes.push(verifyPassed ? "pass" : "fail");
      }

      const stepFailed = Boolean(
        result && (!result.success || !verifyPassed || result.stuck),
      );

      if (stepFailed && result) {
        const shots = [
          await saveScreenshot(runDir, step.id, "before", result.screenshotBefore),
          await saveScreenshot(runDir, step.id, "after", result.screenshotAfter),
        ];
        try {
          const analysis = await bugReporter.analyzeFailure(step, result, lastVerify!, shots);
          if (demoMode) {
            console.warn("[Sentinel] Demo mode: skipping Jira bug creation and Cursor auto-fix.");
          } else if (dryRun) {
            console.log(`[DRY-RUN] Would file Jira bug: ${analysis.title} (${analysis.severity})`);
            console.log(`[DRY-RUN] Screenshots saved locally: ${shots.join(", ")}`);
          } else {
            pendingBugs.push({ analysis, shots });
          }
        } catch (e) {
          console.warn("[Sentinel] Bug analysis / Jira pipeline failed:", e);
        }
      }

      results.push(result!);
    }

    const sessionVideoPath = await visionAgent.saveVideo(runDir);

    const bugKeys: string[] = [];
    for (const pending of pendingBugs) {
      try {
        const bugKey = await bugReporter.createJiraBug(
          pending.analysis,
          effectiveKey,
          pending.shots,
          sessionVideoPath ?? undefined,
        );
        bugKeys.push(bugKey);
        console.log(`[FAIL] Bug filed: ${bugKey}`);
        try {
          await triggerCursorAutoFix(bugKey, pending.analysis, issue, { dryRun });
        } catch (e) {
          console.warn("[Sentinel] Cursor auto-fix failed:", e);
        }
      } catch (e) {
        console.warn("[Sentinel] Jira bug creation failed:", e);
      }
    }

    await bugReporter.generateTestReport(plan, results, bugKeys, {
      outputDirectory: runDir,
      stepOutcomes,
      videoPath: sessionVideoPath ?? undefined,
    });

    console.log(`[Sentinel] Report written under ${runDir}`);
  } finally {
    await visionAgent.close();
  }
}

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const ticketArg = args.find((a) => !a.startsWith("--"));

if (ticketArg === "--demo" || args[0] === "--demo") {
  void runSentinel("DEMO-1", { demo: true, dryRun: isDryRun }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (ticketArg) {
  void runSentinel(ticketArg, { dryRun: isDryRun }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.error("Usage: sentinel <JIRA-KEY> [--dry-run] | --demo [--dry-run]");
  process.exit(1);
}
