# Sentinel

Sentinel is an autonomous QA harness that pulls requirements from Jira, turns them into executable UI test plans with Gemini, drives a real browser with multimodal vision, and files structured bugs back to Jira when expectations fail. It is meant for smoke and regression passes against web apps where selectors are brittle and visual verification matters.

The pipeline keeps a multi-turn Gemini chat for the browser agent so each step builds on prior context without resending the whole history every time.

Reports land under `reports/<timestamp>/report.html` with inline screenshots and optional links to filed issues.

## Architecture

```
Jira issue ──► Gemini 2.5 Pro (test decomposition / JSON plan)
                    │
                    ▼
              Gemini 2.0 Flash Vision + Playwright (per-step actions + verify)
                    │
                    ▼
              Gemini 2.0 Flash (bug analysis from screenshots)
                    │
                    ▼
              Jira (bugs + attachments) · optional Cursor Cloud Agents (auto-fix PR)
```

## Setup

```bash
npm install
cp .env.example .env
# Fill GEMINI_API_KEY, JIRA_* (optional for demo fallback), TARGET_APP_URL, etc.

npx playwright install chromium
```

## Run

```bash
npx ts-node src/orchestrator/index.ts PROJ-123
# or
npm start -- PROJ-123
```

If Jira is unreachable, Sentinel **automatically** falls back to the built-in demo issue and `TARGET_APP_URL=https://the-internet.herokuapp.com/login`.

## Demo

End-to-end trial without Jira (mock story + public login page):

```bash
npx ts-node src/orchestrator/index.ts --demo
# or
npm start -- --demo
```

Demo mode skips creating real Jira bugs and Cursor agent triggers; it still exercises Gemini reasoning, vision, and HTML reporting.

## Why Gemini

- **Native multimodal**: Screenshots go in as image parts alongside DOM summaries—no extra vision pipeline.
- **Long context**: Large chat histories for long test runs without trimming everything each step.
- **Model split**: **2.5 Pro** for structured PRD decomposition; **2.0 Flash** for fast vision loops and cheaper failure analysis. If Pro fails after retries, reasoning **falls back** to **2.0 Flash**.

## Cursor Cloud Agents

When a bug is filed (non-demo runs), Sentinel can call the Cursor Cloud Agents API (`triggerCursorAutoFix`): an agent is spawned against `REPO_URL` with `autoCreatePR`, polled until completion, and a short comment is posted on the Jira issue pointing at the PR or branch when available. Requires `CURSOR_API_KEY` and `REPO_URL` in `.env`.

## UI demo (Stitch exports)

Static Stitch screens and a browser-only demo runner:

```bash
npm run demo:ui
```

Open http://127.0.0.1:4173/
