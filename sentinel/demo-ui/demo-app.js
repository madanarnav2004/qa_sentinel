const STITCH_PROJECT = {
  id: "8604015484175847747",
  title: "Sentinel Autonomous QA",
};

const MANIFEST_PATH = "./stitch-manifest.json";

function $(id) {
  return document.getElementById(id);
}

function ts() {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

async function loadManifest() {
  try {
    const r = await fetch(MANIFEST_PATH, { cache: "no-store" });
    if (!r.ok) return { screens: [] };
    return await r.json();
  } catch {
    return { screens: [] };
  }
}

function wireReferenceImages(manifest) {
  const pngMap = Object.fromEntries((manifest.screens ?? []).map((s) => [s.slug, s.png]));
  const htmlMap = Object.fromEntries((manifest.screens ?? []).map((s) => [s.slug, s.html]));
  const binds = [
    ["img-run", "ref-run", "run-panel"],
    ["img-log", "ref-log", "agent-log"],
    ["img-bugs", "ref-bugs", "bug-feed"],
  ];
  for (const [imgId, wrapId, slug] of binds) {
    const rel = pngMap[slug];
    if (!rel) continue;
    const img = $(imgId);
    const wrap = $(wrapId);
    img.onload = () => wrap.classList.remove("hidden");
    img.onerror = () => wrap.classList.add("hidden");
    img.src = `./${rel}?t=${Date.now()}`;

    const htmlRel = htmlMap[slug];
    const label = wrap.querySelector(".ref-label");
    if (label && htmlRel) {
      const pretty = slug.replace(/-/g, " ");
      label.replaceChildren();
      label.append(`Stitch reference · ${pretty} · `);
      const a = document.createElement("a");
      a.href = `./${htmlRel}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "HTML export";
      label.append(a);
    }
  }
}

function wireTabs() {
  const tabs = document.querySelectorAll("#tabs button");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tab;
      tabs.forEach((b) => b.classList.toggle("active", b === btn));
      panels.forEach((p) => {
        const match =
          (id === "run" && p.id === "panel-run") ||
          (id === "log" && p.id === "panel-log") ||
          (id === "bugs" && p.id === "panel-bugs");
        p.classList.toggle("active", match);
      });
    });
  });
}

const logEl = $("agent-log");
const bugFeedEl = $("bug-feed");

function logLine(msg) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<span class="ts">${ts()}</span>${escapeHtml(msg)}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let demoRunning = false;

async function runDemo() {
  if (demoRunning) return;
  demoRunning = true;
  const key = $("jira-key").value.trim() || "DEMO-42";
  const status = $("run-status");
  status.textContent = "Running";
  status.className = "status-pill run";

  logEl.innerHTML = "";
  bugFeedEl.innerHTML = "";

  logLine(`[Sentinel] Stitch project: ${STITCH_PROJECT.title} (${STITCH_PROJECT.id})`);
  logLine(`[Sentinel] Loaded Jira issue ${key} (simulated)`);
  $("m-steps").textContent = "—";
  $("m-pass").textContent = "—";
  $("m-bugs").textContent = "—";

  await sleep(400);
  logLine(`[Sentinel] 12 steps (7 happy, 5 edge) — decomposePRD (simulated)`);
  $("m-steps").textContent = "12";

  await sleep(350);
  logLine(`[Sentinel] visionAgent.init() · Chromium 1280×800`);

  const steps = [
    { id: "step-001", action: "navigate", target: "Login page" },
    { id: "step-002", action: "type", target: "Email field", fail: false },
    { id: "step-003", action: "click", target: "Sign in", fail: true },
    { id: "step-004", action: "assert", target: "Dashboard heading", fail: false },
  ];

  let verified = 0;
  let bugs = 0;

  for (const step of steps) {
    logLine(`[Step ${step.id}] ${step.action}: ${step.target}`);
    await sleep(280);
    logLine(`  → Gemini vision: {"action":"${step.action}","reasoning":"…"}`);
    await sleep(220);
    if (step.fail) {
      logLine(`  ✗ verifyExpectation failed: expected dashboard visible`);
      bugs++;
      logLine(`  → bugReporter.analyzeFailure · createJiraBug`);
      const fakeKey = `SNT-${100 + bugs}`;
      logLine(`  [FAIL] Bug filed: ${fakeKey}`);
      appendBugCard(fakeKey, "High", "Auth redirect stuck after sign-in (demo)");
    } else {
      logLine(`  ✓ verifyExpectation satisfied`);
      verified++;
    }
    await sleep(200);
  }

  logLine(`[Sentinel] bugReporter.generateTestReport → reports/<stamp>/report.html`);
  logLine(`[Sentinel] visionAgent.close()`);

  $("m-pass").textContent = String(verified);
  $("m-bugs").textContent = String(bugs);

  status.textContent = bugs > 0 ? "Completed · failures" : "Completed";
  status.className = bugs > 0 ? "status-pill fail" : "status-pill run";
  demoRunning = false;
}

function appendBugCard(key, severity, title) {
  const el = document.createElement("article");
  el.className = "bug-card";
  el.innerHTML = `
    <header>
      <span class="key">${escapeHtml(key)}</span>
      <span class="sev ${severity.toLowerCase()}">${escapeHtml(severity)}</span>
    </header>
    <p>${escapeHtml(title)}</p>
  `;
  bugFeedEl.prepend(el);
}

function resetDemo() {
  logEl.innerHTML = "";
  bugFeedEl.innerHTML = "";
  $("run-status").textContent = "Idle";
  $("run-status").className = "status-pill";
  $("m-steps").textContent = "—";
  $("m-pass").textContent = "—";
  $("m-bugs").textContent = "—";
}

async function boot() {
  wireTabs();
  const manifest = await loadManifest();
  wireReferenceImages(manifest);

  $("btn-run").addEventListener("click", () => runDemo().catch(console.error));
  $("btn-reset").addEventListener("click", resetDemo);

  logLine("Demo UI ready. Stitch refs loaded from stitch-manifest.json when present.");
}

boot();
