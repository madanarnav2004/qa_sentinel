import type { GenerativeModel } from "@google/generative-ai";
import type { JiraIssue } from "../ingestion/jiraClient";
import { reasoningFallbackModel, reasoningModel } from "../llm/geminiClient";
import { withRetry } from "../llm/withRetry";
import { z } from "zod";

const TestStepSchema = z.object({
  id: z.string(),
  action: z.enum([
    "navigate",
    "click",
    "type",
    "select",
    "wait",
    "assert",
    "screenshot",
  ]),
  target: z.string().optional(),
  value: z.string().optional(),
  expectedResult: z.string(),
  isEdgeCase: z.boolean(),
  priority: z.enum(["critical", "high", "medium"]),
});

export const TestPlanSchema = z.object({
  issueKey: z.string(),
  title: z.string(),
  steps: z.array(TestStepSchema),
  happyPath: z.array(TestStepSchema).min(1),
  edgeCases: z.array(TestStepSchema).min(3),
});

export type TestStep = z.infer<typeof TestStepSchema>;
export type TestPlan = z.infer<typeof TestPlanSchema>;

function extractJsonFromModelText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

async function decomposeWithModel(model: GenerativeModel, issue: JiraIssue): Promise<TestPlan> {
  const systemInstruction = `You are a senior QA engineer. Given a user story 
  and acceptance criteria, decompose into atomic UI test steps covering:
  - Happy path (valid inputs, success flows)
  - Negative cases (invalid inputs, wrong credentials, missing fields)
  - Boundary conditions (max length, special characters)
  - Permission/auth edge cases
  Return ONLY valid JSON matching the TestPlan schema. No markdown, no preamble.`;

  const chat = model.startChat({
    systemInstruction,
    history: [],
  });

  const prompt = `User Story: ${issue.summary}

Issue key (set TestPlan.issueKey to this exact value): ${issue.key}

Description: ${issue.description}

Acceptance Criteria:
${issue.acceptanceCriteria}

Generate a complete TestPlan JSON object. Assign sequential IDs like "step-001".
Ensure edgeCases includes at least 3 negative scenarios.`;

  const result = await withRetry(() => chat.sendMessage(prompt));
  const text = result.response.text();

  const parsed: unknown = JSON.parse(extractJsonFromModelText(text));
  return TestPlanSchema.parse(parsed);
}

export async function decomposePRD(issue: JiraIssue): Promise<TestPlan> {
  try {
    return await decomposeWithModel(reasoningModel, issue);
  } catch (e) {
    console.warn(
      "[Sentinel] Gemini 2.5 Pro reasoning failed after retries; falling back to gemini-2.0-flash.",
      e,
    );
    return await decomposeWithModel(reasoningFallbackModel, issue);
  }
}
