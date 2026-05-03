/**
 * Serves ./demo-ui on PORT (default 4173). Zero dependencies.
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "demo-ui");
const port = Number(process.env.PORT) || 4173;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url ?? "/", `http://127.0.0.1`).pathname);
    if (pathname === "/") pathname = "/index.html";

    const rel = pathname.replace(/^\/+/, "");
    if (rel.includes("..")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(path.join(root, rel));
    if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const data = await fs.readFile(resolvedFile);
    const ext = path.extname(resolvedFile).toLowerCase();
    res.writeHead(200, { "Content-Type": mime[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sentinel demo UI → http://127.0.0.1:${port}/`);
});
