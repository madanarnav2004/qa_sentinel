import axios, { AxiosInstance } from "axios";
import { createReadStream } from "fs";
import FormData from "form-data";
import { z } from "zod";

export type JiraIssue = {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  status: string;
};

export type BugReport = {
  title: string;
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
  screenshotPaths: string[];
  videoPath?: string;
  severity: string;
  relatedTicket: string;
};

const IssueFieldsSchema = z
  .object({
    summary: z.string(),
    description: z.unknown().nullable().optional(),
    status: z.object({ name: z.string() }).passthrough(),
  })
  .passthrough();

const IssueEnvelopeSchema = z
  .object({
    key: z.string(),
    fields: IssueFieldsSchema,
  })
  .passthrough();

const FetchIssueResponseSchema = IssueEnvelopeSchema;

const SearchResponseSchema = z
  .object({
    issues: z.array(IssueEnvelopeSchema),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
  })
  .passthrough();

const AgileIssuesResponseSchema = z
  .object({
    issues: z.array(IssueEnvelopeSchema),
    startAt: z.number(),
    maxResults: z.number(),
    total: z.number(),
  })
  .passthrough();

const CreateIssueResponseSchema = z
  .object({
    key: z.string(),
  })
  .passthrough();

function extractTextFromAdfNode(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  const n = node as Record<string, unknown>;

  if (n.type === "hardBreak") return "\n";
  if (typeof n.text === "string") return n.text;

  if (Array.isArray(n.content)) {
    return n.content.map(extractTextFromAdfNode).join("");
  }

  return "";
}

function adfToPlainText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const doc = adf as { content?: unknown[] };
  if (!Array.isArray(doc.content)) return "";

  const parts: string[] = [];
  for (const block of doc.content) {
    const t = extractTextFromAdfNode(block).trim();
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

function splitAdfByHeadings(adf: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!adf || typeof adf !== "object") return map;
  const doc = adf as { content?: unknown[] };
  if (!Array.isArray(doc.content)) return map;

  const preamble = "__preamble__";
  let currentTitle = preamble;
  const chunks: string[] = [];

  const flush = () => {
    const body = chunks.join("\n\n").trim();
    if (!body && currentTitle === preamble) return;
    map.set(currentTitle === preamble ? "" : currentTitle, body);
    chunks.length = 0;
  };

  for (const block of doc.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "heading") {
      flush();
      currentTitle = extractTextFromAdfNode(block).trim() || preamble;
      continue;
    }
    const text = extractTextFromAdfNode(block).trim();
    if (text) chunks.push(text);
  }
  flush();

  return map;
}

function acceptanceCriteriaFromPlainDescription(fullText: string): string {
  const match = fullText.match(
    /(?:^|\n)\s*acceptance\s*criteria\s*[:\n]+\s*([\s\S]*?)(?=\n\s*[A-Za-z][A-Za-z\s]{2,40}\s*:\s*|\n#{1,3}\s|$)/i,
  );
  return match?.[1]?.trim() ?? "";
}

function extractAcceptanceCriteria(
  descriptionAdf: unknown,
  plainDescription: string,
): string {
  const sections = splitAdfByHeadings(descriptionAdf);
  for (const [title, body] of sections) {
    if (/acceptance\s*criteria/i.test(title)) return body.trim();
  }
  const loose = acceptanceCriteriaFromPlainDescription(plainDescription);
  if (loose) return loose;
  return "";
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

function bugReportToDescriptionAdf(data: BugReport): Record<string, unknown> {
  const content: Record<string, unknown>[] = [
    headingBlock(2, data.title),
    headingBlock(3, "Related ticket"),
    textBlock(data.relatedTicket),
    headingBlock(3, "Severity"),
    textBlock(data.severity),
    headingBlock(3, "Steps to reproduce"),
    ...data.stepsToReproduce.split(/\n\n+/).filter(Boolean).map(textBlock),
    headingBlock(3, "Expected result"),
    textBlock(data.expectedResult),
    headingBlock(3, "Actual result"),
    textBlock(data.actualResult),
  ];

  return { type: "doc", version: 1, content };
}

function severityToPriorityName(severity: string): string {
  const s = severity.toLowerCase();
  if (s === "critical") return "Highest";
  if (s === "high") return "High";
  if (s === "medium") return "Medium";
  if (s === "low") return "Low";
  return "Medium";
}

function mapEnvelopeToIssue(envelope: z.infer<typeof IssueEnvelopeSchema>): JiraIssue {
  const descriptionPlain = adfToPlainText(envelope.fields.description ?? null);
  const acceptanceCriteria = extractAcceptanceCriteria(
    envelope.fields.description ?? null,
    descriptionPlain,
  );

  return {
    key: envelope.key,
    summary: envelope.fields.summary,
    description: descriptionPlain,
    acceptanceCriteria,
    status: envelope.fields.status.name,
  };
}

const SEARCH_FIELDS = ["summary", "description", "status"].join(",");

class JiraApiClient {
  private readonly http: AxiosInstance;
  private readonly projectKey: string;

  constructor() {
    const baseURL = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
    const email = process.env.JIRA_EMAIL ?? "";
    const token = process.env.JIRA_API_TOKEN ?? "";
    const projectKey = process.env.JIRA_PROJECT_KEY ?? "";

    if (!baseURL || !email || !token || !projectKey) {
      throw new Error(
        "Missing Jira env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY",
      );
    }

    this.projectKey = projectKey;
    const auth = Buffer.from(`${email}:${token}`, "utf8").toString("base64");

    this.http = axios.create({
      baseURL,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    });
  }

  async fetchIssue(issueKey: string): Promise<JiraIssue> {
    const res = await this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Jira fetchIssue failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    const parsed = FetchIssueResponseSchema.safeParse(res.data);
    if (!parsed.success) {
      throw new Error(`Jira fetchIssue invalid payload: ${parsed.error.message}`);
    }
    return mapEnvelopeToIssue(parsed.data);
  }

  async fetchEpicStories(epicKey: string): Promise<JiraIssue[]> {
    const maxResults = 50;
    let startAt = 0;
    let total = Infinity;
    const agileOut: JiraIssue[] = [];

    while (startAt < total) {
      const agile = await this.http.get(
        `/rest/agile/1.0/epic/${encodeURIComponent(epicKey)}/issue`,
        { params: { startAt, maxResults, fields: SEARCH_FIELDS } },
      );
      if (agile.status < 200 || agile.status >= 300) break;

      const parsed = AgileIssuesResponseSchema.safeParse(agile.data);
      if (!parsed.success) break;

      total = parsed.data.total;
      if (parsed.data.issues.length === 0) break;

      for (const issue of parsed.data.issues) {
        const env = IssueEnvelopeSchema.safeParse(issue);
        if (env.success) agileOut.push(mapEnvelopeToIssue(env.data));
      }

      startAt += parsed.data.issues.length;
      if (parsed.data.issues.length < maxResults) break;
    }

    if (agileOut.length > 0) return agileOut;

    const jqlVariants = [`"Epic Link" = ${epicKey}`, `parent = ${epicKey}`];

    const collected: JiraIssue[] = [];
    for (const jql of jqlVariants) {
      let startAt = 0;
      const maxResults = 50;
      let total = Infinity;
      while (startAt < total) {
        const search = await this.http.post("/rest/api/3/search", {
          jql,
          startAt,
          maxResults,
          fields: ["summary", "description", "status"],
        });
        if (search.status < 200 || search.status >= 300) break;
        const parsed = SearchResponseSchema.safeParse(search.data);
        if (!parsed.success) break;
        total = parsed.data.total ?? parsed.data.issues.length;
        if (parsed.data.issues.length === 0) break;
        for (const issue of parsed.data.issues) {
          collected.push(mapEnvelopeToIssue(issue));
        }
        startAt += parsed.data.issues.length;
        if (parsed.data.issues.length < maxResults) break;
      }
      if (collected.length > 0) break;
    }

    return collected;
  }

  async uploadAttachment(
    issueKey: string,
    filePath: string,
    filename: string,
  ): Promise<void> {
    const form = new FormData();
    form.append("file", createReadStream(filePath), { filename });

    const res = await this.http.post(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          "X-Atlassian-Token": "no-check",
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      },
    );

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Jira uploadAttachment failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
  }

  async createBugReport(data: BugReport): Promise<string> {
    const body = {
      fields: {
        project: { key: this.projectKey },
        summary: data.title,
        description: bugReportToDescriptionAdf(data),
        issuetype: { name: "Bug" },
        priority: { name: severityToPriorityName(data.severity) },
      },
    };

    const res = await this.http.post("/rest/api/3/issue", body);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Jira createBugReport failed (${res.status}): ${JSON.stringify(res.data)}`);
    }

    const parsed = CreateIssueResponseSchema.safeParse(res.data);
    if (!parsed.success) {
      throw new Error(`Jira createBugReport invalid response: ${parsed.error.message}`);
    }

    const key = parsed.data.key;

    for (const path of data.screenshotPaths) {
      await this.uploadAttachment(key, path, filenameFromPath(path));
    }
    if (data.videoPath) {
      await this.uploadAttachment(key, data.videoPath, filenameFromPath(data.videoPath));
    }

    return key;
  }
}

function filenameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

let jiraSingleton: JiraApiClient | undefined;

/** Lazily constructed so `dotenv/config` can load before env is read. */
export const jiraClient: JiraApiClient = new Proxy({} as JiraApiClient, {
  get(_target, prop, receiver) {
    jiraSingleton ??= new JiraApiClient();
    const value = Reflect.get(jiraSingleton, prop, receiver);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(jiraSingleton) : value;
  },
});
