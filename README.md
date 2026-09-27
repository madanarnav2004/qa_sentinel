# Sentinel

A browser QA experiment that turns Jira requirements into test plans, runs them with Gemini and Playwright, and collects screenshots and bug reports.

The application lives in [`sentinel/`](sentinel/). Start there for the [full setup and architecture guide](sentinel/README.md).

## The flow

```text
Jira requirement → test plan → browser actions → visual checks → HTML report
```

Live runs can file bugs in Jira and optionally trigger Cursor Cloud Agents. Demo mode skips those writes; dry-run mode keeps reports local.

## Start with the UI demo

```sh
cd sentinel
npm ci
npm run demo:ui
```

Open **http://127.0.0.1:4173/**. This is a browser-only demo of the interface, separate from running the AI/browser pipeline.

For the pipeline, follow the [environment setup](sentinel/README.md#setup), install Playwright’s Chromium browser, and run `npm start -- --demo` from `sentinel/`. The pipeline requires a Gemini API key even in demo mode.

## Where to look

| Path | Purpose |
| :--- | :--- |
| [`sentinel/src/orchestrator/`](sentinel/src/orchestrator/) | Coordinates test runs and the optional auto-fix integration |
| [`sentinel/src/reasoning/`](sentinel/src/reasoning/) | Breaks requirements into test steps |
| [`sentinel/src/driver/`](sentinel/src/driver/) | Vision-guided browser actions |
| [`sentinel/src/reporter/`](sentinel/src/reporter/) | Bug analysis and reporting |
| [`sentinel/demo-ui/`](sentinel/demo-ui/) | Static screens and the browser-only demo |

**Stack:** TypeScript · Gemini · Playwright · Jira
