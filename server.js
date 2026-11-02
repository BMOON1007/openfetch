import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "./lib/inspect.js";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const rootNorm = normalize(root).replace(/[\\/]+$/, "") + sep;
  const file = normalize(join(root, rel));
  if (file !== rootNorm.slice(0, -1) && !file.startsWith(rootNorm)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/inspect") {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8000) {
        sendJson(res, 400, { error: "Request is too large" });
        return;
      }
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "Send JSON with a url field" });
      return;
    }
    if (!body || typeof body.url !== "string") {
      sendJson(res, 400, { error: "Send JSON with a url field" });
      return;
    }
    try {
      const report = await inspect({
        url: body.url,
        proxy: typeof body.proxy === "string" ? body.proxy : "",
      });
      sendJson(res, 200, report);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "The check failed" });
    }
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

const port = Number(process.env.PORT) || 4180;
server.listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}`);
});
