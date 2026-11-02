import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";

const MAX_BYTES = 256 * 1024;

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]/g, "");
}

function proxyAuth(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return {};
  const token = Buffer.from(
    `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
  ).toString("base64");
  return { "Proxy-Authorization": `Basic ${token}` };
}

function readLimited(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err && size === 0) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    stream.on("data", (chunk) => {
      const room = maxBytes - size;
      if (room <= 0) {
        stream.destroy();
        return;
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(Buffer.from(slice));
      size += slice.length;
      if (size >= maxBytes) stream.destroy();
    });
    stream.on("end", () => finish());
    stream.on("close", () => finish());
    stream.on("error", (err) => finish(size > 0 ? null : err));
  });
}

function nodeRequest(lib, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = lib.request(options, async (res) => {
      try {
        const body = await readLimited(res, MAX_BYTES);
        resolve({ status: res.statusCode || 0, headers: res.headers, body });
      } catch (err) {
        reject(err);
      }
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("The request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function tunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, ...proxyAuth(proxyUrl) },
      timeout: timeoutMs,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy refused the connection (${res.statusCode})`));
        return;
      }
      resolve(socket);
    });
    req.on("timeout", () => req.destroy(new Error("The proxy timed out")));
    req.on("error", reject);
    req.end();
  });
}

function requestOverSocket(socket, target, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers,
      servername: target.hostname,
      agent: false,
      createConnection: () => socket,
    }, async (res) => {
      try {
        const body = await readLimited(res, MAX_BYTES);
        resolve({ status: res.statusCode || 0, headers: res.headers, body });
      } catch (err) {
        reject(err);
      }
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("The request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export function parseProxy(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Proxy URL is not valid. Use http://host:port");
  }
  if (url.protocol !== "http:") throw new Error("Only an http:// proxy is supported");
  if (!url.hostname || !url.port) throw new Error("Proxy URL needs a host and a port");
  return url;
}

export function redactProxy(value) {
  const url = parseProxy(value);
  if (!url) return "direct";
  return `${url.hostname}:${url.port}`;
}

export async function sendRequest(targetHref, { proxy = "", headers = {}, timeoutMs = 10000 } = {}) {
  const target = new URL(targetHref);
  const proxyUrl = parseProxy(proxy);
  const sent = {};
  for (const [key, value] of Object.entries(headers)) sent[key] = sanitizeHeader(value);
  sent.Host = target.host;
  sent.Connection = "close";

  if (!proxyUrl && target.protocol === "http:") {
    return nodeRequest(http, {
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: sent,
    }, timeoutMs);
  }

  if (!proxyUrl && target.protocol === "https:") {
    return nodeRequest(https, {
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: sent,
      servername: target.hostname,
    }, timeoutMs);
  }

  if (target.protocol === "http:") {
    return nodeRequest(http, {
      hostname: proxyUrl.hostname,
      port: proxyUrl.port,
      path: target.href,
      method: "GET",
      headers: { ...sent, ...proxyAuth(proxyUrl) },
    }, timeoutMs);
  }

  const socket = await tunnel(proxyUrl, target.hostname, target.port || 443, timeoutMs);
  const secure = tls.connect({ socket, servername: target.hostname });
  await new Promise((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  return requestOverSocket(secure, target, sent, timeoutMs);
}
