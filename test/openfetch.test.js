import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { inspect, isPrivateAddress } from "../lib/inspect.js";
import { redactProxy, sendRequest } from "../lib/request.js";
import { robotsDecision } from "../lib/robots.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("a longer robots rule wins, and a named agent beats *", () => {
  const text = [
    "User-agent: *",
    "Disallow: /private",
    "Allow: /private/public",
    "",
    "User-agent: OpenFetch",
    "Disallow: /",
  ].join("\n");

  assert.equal(robotsDecision(text, "/blog", "SomeBot/1.0").allowed, true);
  assert.equal(robotsDecision(text, "/private/notes", "SomeBot/1.0").allowed, false);
  assert.equal(robotsDecision(text, "/private/public", "SomeBot/1.0").allowed, true);
  const named = robotsDecision(text, "/blog", "OpenFetch/0.1");
  assert.equal(named.allowed, false);
  assert.equal(named.line, "Disallow: /");
});

test("private and local targets are refused", async () => {
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  await assert.rejects(() => inspect({ url: "http://127.0.0.1/" }), /private network|Local addresses/);
  await assert.rejects(() => inspect({ url: "http://localhost/admin" }), /Local addresses/);
  await assert.rejects(() => inspect({ url: "file:///etc/passwd" }), /Only http and https/);
});

test("a disallow stops the page fetch, and the proxy password stays out of the report", async () => {
  const calls = [];
  const report = await inspect({
    url: "https://example.com/secret",
    proxy: "http://user:s3cret@proxy.example:8888",
  }, {
    lookup: async () => ["93.184.216.34"],
    request: async (url) => {
      calls.push(url);
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("User-agent: *\nDisallow: /secret\n"),
      };
    },
  });

  assert.deepEqual(calls, ["https://example.com/robots.txt"]);
  assert.equal(report.robots.allowed, false);
  assert.equal(report.response, null);
  assert.equal(report.proxy, "proxy.example:8888");
  assert.equal(JSON.stringify(report).includes("s3cret"), false);
  assert.equal(redactProxy("http://user:s3cret@proxy.example:8888"), "proxy.example:8888");
});

test("an allowed page is fetched once and a block page is named, not bypassed", async () => {
  const report = await inspect({ url: "https://example.com/" }, {
    lookup: async () => ["93.184.216.34"],
    request: async (url) => {
      if (url.endsWith("/robots.txt")) {
        return { status: 404, headers: {}, body: Buffer.from("") };
      }
      return {
        status: 403,
        headers: { "content-type": "text/html", server: "cloudflare" },
        body: Buffer.from("<html><title>Just a moment</title><body>Attention required</body></html>"),
      };
    },
  });

  assert.equal(report.response.status, 403);
  assert.equal(report.response.title, "Just a moment");
  assert.match(report.response.note, /does not try to get past it/);
});

test("an http proxy is used for a plain request and its password is not required on the origin", async () => {
  const origin = http.createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(`origin saw ${req.url}`);
  });
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.headers["proxy-authorization"] ? "auth" : "no-auth");
    const target = new URL(req.url);
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
    }, (up) => {
      res.writeHead(up.statusCode || 502);
      up.pipe(res);
    });
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    upstream.end();
  });

  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  try {
    const res = await sendRequest(`http://127.0.0.1:${originPort}/hello`, {
      proxy: `http://ada:secret@127.0.0.1:${proxyPort}`,
      headers: { "User-Agent": "OpenFetch/0.1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), "origin saw /hello");
    assert.deepEqual(seen, ["auth"]);
  } finally {
    origin.close();
    proxy.close();
  }
});
