import { createHash } from "crypto";
import { copyFile, mkdir } from "fs/promises";
import path from "path";

import type { ChatSession } from "@google/generative-ai";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { z } from "zod";

import { visionModel } from "../llm/geminiClient";
import { withRetry } from "../llm/withRetry";
import type { TestStep } from "../reasoning/testDecomposer";

export type AgentAction = {
  action: "click" | "type" | "navigate" | "select" | "assert" | "done" | "wait";
  selector?: string;
  value?: string;
  reasoning: string;
};

export type StepResult = {
  success: boolean;
  screenshotBefore: Buffer;
  screenshotAfter: Buffer;
  action: AgentAction;
  /** SHA-256 of extracted interactive DOM summary (vision loop stagnation detection). */
  domFingerprint: string;
  /** Agent exhausted retries / stagnation without satisfying the step. */
  stuck?: boolean;
};

export type VerifyResult = {
  satisfied: boolean;
  reason: string;
  discrepancy?: string;
};

type DomElementSummary = {
  tag: string;
  text: string;
  ariaLabel: string;
  id: string;
  type: string;
  placeholder: string;
  visible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number };
};

const AgentActionSchema = z.object({
  action: z.enum(["click", "type", "navigate", "select", "assert", "done", "wait"]),
  selector: z.string().optional(),
  value: z.string().optional(),
  reasoning: z.string(),
});

const VerifyResultSchema = z.object({
  satisfied: z.boolean(),
  reason: z.string(),
  discrepancy: z.string().optional(),
});

const SelfHealSchema = z.object({
  selector: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

function extractJsonFromModelText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function parseModelJson<T>(text: string, schema: z.ZodType<T>): T {
  const raw: unknown = JSON.parse(extractJsonFromModelText(text));
  return schema.parse(raw);
}

export class VisionAgent {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private chat?: ChatSession;

  private getSession(): { page: Page; chat: ChatSession } {
    if (!this.page || !this.chat) {
      throw new Error("VisionAgent.init() must be called before using this agent.");
    }
    return { page: this.page, chat: this.chat };
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    const videoDir = path.join(process.cwd(), "reports", "videos");
    await mkdir(videoDir, { recursive: true });

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: {
        dir: videoDir,
        size: { width: 1280, height: 800 },
      },
    });
    this.page = await this.context.newPage();

    const target = process.env.TARGET_APP_URL?.trim();
    if (target) {
      await this.page.goto(target, { waitUntil: "domcontentloaded" });
    }

    const systemInstruction = `You are a browser automation agent. You will receive screenshots 
 and DOM summaries. For each test step, output ONE action as JSON:
 { action: 'click'|'type'|'navigate'|'select'|'assert'|'done'|'wait',
   selector?: string, value?: string, reasoning: string }
 Use CSS selectors. Prefer aria-label, data-testid, or text content.
 Never repeat a failed action — try a different approach.`;

    this.chat = visionModel.startChat({
      systemInstruction,
      history: [],
    });
  }

  async executeStep(step: TestStep): Promise<StepResult> {
    const { page, chat } = this.getSession();
    const screenshotBuffer = await page.screenshot({ fullPage: true });

    const domSummary = await page.evaluate((): DomElementSummary[] => {
      const selectors = [
        "button",
        "input",
        "select",
        "textarea",
        'a[href]',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="tab"]',
        '[contenteditable="true"]',
      ];
      const seen = new Set<Element>();
      const candidates: Element[] = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          if (!seen.has(el)) {
            seen.add(el);
            candidates.push(el);
          }
        });
      }

      const rows: Array<DomElementSummary & { sortY: number; sortX: number }> = [];

      for (const el of candidates) {
        const html = el as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = window.getComputedStyle(html);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          parseFloat(style.opacity || "1") > 0;

        const text = (html.innerText || "").trim().slice(0, 160);
        rows.push({
          tag: html.tagName.toLowerCase(),
          text,
          ariaLabel: html.getAttribute("aria-label")?.trim() ?? "",
          id: html.id ?? "",
          type: html.getAttribute("type")?.trim() ?? "",
          placeholder: html.getAttribute("placeholder")?.trim() ?? "",
          visible,
          boundingBox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          sortY: rect.top,
          sortX: rect.left,
        });
      }

      return rows
        .filter((r) => r.visible)
        .sort((a, b) => a.sortY - b.sortY || a.sortX - b.sortX)
        .slice(0, 50)
        .map(({ sortY: _sy, sortX: _sx, ...rest }) => rest);
    });

    const domFingerprint = createHash("sha256")
      .update(JSON.stringify(domSummary))
      .digest("hex");

    const message = [
      {
        inlineData: {
          mimeType: "image/png",
          data: screenshotBuffer.toString("base64"),
        },
      },
      {
        text: `Current URL: ${page.url()}

DOM elements: ${JSON.stringify(domSummary, null, 2)}

Test step to execute:
Action: ${step.action}
Target: ${step.target || "N/A"}
Value: ${step.value || "N/A"}
Expected result: ${step.expectedResult}

What single action should I take next? Return JSON only.`,
      },
    ];

    const result = await withRetry(() => chat.sendMessage(message));
    const action = parseModelJson(result.response.text(), AgentActionSchema);

    try {
      await this.performAction(action);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    } catch {
      const afterFail = await page.screenshot({ fullPage: true }).catch(() => screenshotBuffer);
      return {
        success: false,
        screenshotBefore: screenshotBuffer,
        screenshotAfter: afterFail,
        action,
        domFingerprint,
      };
    }

    const afterShot = await page.screenshot({ fullPage: true });
    return {
      success: true,
      screenshotBefore: screenshotBuffer,
      screenshotAfter: afterShot,
      action,
      domFingerprint,
    };
  }

  async selfHeal(failedSelector: string): Promise<string | null> {
    const { page, chat } = this.getSession();
    const screenshot = await page.screenshot({ fullPage: true });
    const result = await withRetry(() =>
      chat.sendMessage([
      {
        inlineData: {
          mimeType: "image/png",
          data: screenshot.toString("base64"),
        },
      },
      {
        text: `The selector '${failedSelector}' was not found.
 Look at this screenshot and suggest the correct CSS selector
 for the element we're trying to interact with.
 Return JSON: { selector: string, confidence: 'high'|'medium'|'low' }`,
      },
    ]),
    );

    try {
      const parsed = parseModelJson(result.response.text(), SelfHealSchema);
      return parsed.selector;
    } catch {
      return null;
    }
  }

  async verifyExpectation(expected: string): Promise<VerifyResult> {
    const { page, chat } = this.getSession();
    const screenshot = await page.screenshot({ fullPage: true });
    const result = await withRetry(() =>
      chat.sendMessage([
      {
        inlineData: {
          mimeType: "image/png",
          data: screenshot.toString("base64"),
        },
      },
      {
        text: `Does this screen satisfy the condition: "${expected}"?
Return JSON: { satisfied: boolean, reason: string, discrepancy?: string }`,
      },
    ]),
    );
    return parseModelJson(result.response.text(), VerifyResultSchema);
  }

  private async performAction(action: AgentAction): Promise<void> {
    this.getSession();
    try {
      await this.performActionOnce(action);
    } catch {
      const sel = action.selector;
      if (!sel) throw new Error(`Action ${action.action} failed`);
      const healed = await this.selfHeal(sel);
      if (!healed) throw new Error(`Self-heal could not fix selector: ${sel}`);
      await this.performActionOnce({ ...action, selector: healed });
    }
  }

  private async performActionOnce(action: AgentAction): Promise<void> {
    const page = this.page;
    if (!page) throw new Error("VisionAgent.init() must be called first");

    switch (action.action) {
      case "done":
        return;
      case "navigate": {
        const url = action.value?.trim();
        if (!url) throw new Error("navigate requires value (URL)");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        return;
      }
      case "click": {
        const sel = action.selector;
        if (!sel) throw new Error("click requires selector");
        await page.click(sel, { timeout: 15_000 });
        return;
      }
      case "type": {
        const sel = action.selector;
        if (!sel) throw new Error("type requires selector");
        await page.fill(sel, action.value ?? "", { timeout: 15_000 });
        return;
      }
      case "select": {
        const sel = action.selector;
        if (!sel) throw new Error("select requires selector");
        await page.selectOption(sel, action.value ?? "", { timeout: 15_000 });
        return;
      }
      case "wait": {
        if (action.selector) {
          await page.waitForSelector(action.selector, {
            state: "visible",
            timeout: Number(action.value) || 15_000,
          });
          return;
        }
        const ms = Number(action.value);
        await page.waitForTimeout(Number.isFinite(ms) && ms > 0 ? ms : 1000);
        return;
      }
      case "assert": {
        const sel = action.selector;
        if (!sel) throw new Error("assert requires selector");
        await page.locator(sel).first().waitFor({ state: "visible", timeout: 15_000 });
        return;
      }
    }
  }

  /**
   * Finalizes the tab recording (closes the page), copies WebM into destDir/session.webm.
   * Call before {@link close}; context/browser shutdown still happens in {@link close}.
   */
  async saveVideo(destDir: string): Promise<string | null> {
    await mkdir(destDir, { recursive: true });
    const page = this.page;
    if (!page) return null;

    const video = page.video();
    await page.close();
    this.page = undefined;

    if (!video) return null;

    const videoPath = await video.path();
    const dest = path.join(destDir, "session.webm");
    await copyFile(videoPath, dest);
    return dest;
  }

  async close(): Promise<void> {
    // IMPORTANT: context must close before browser to flush video artifacts.
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = undefined;
    }
    await this.context?.close();
    this.context = undefined;
    await this.browser?.close();
    this.browser = undefined;
    this.chat = undefined;
  }
}

export const visionAgent = new VisionAgent();
