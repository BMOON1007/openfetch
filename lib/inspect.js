import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { robotsDecision } from "./robots.js";
import { parseProxy, redactProxy, sendRequest } from "./request.js";

export const USER_AGENT = "OpenFetch/0.1 (+https://github.com/BMOON1007/openfetch)";

const block = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
]) {
  block.addSubnet(net, prefix, "ipv4");
}
block.addAddress("255.255.255.255", "ipv4");
block.addAddress("::1", "ipv6");
block.addSubnet("fc00::", 7, "ipv6");
block.addSubnet("fe80::", 10, "ipv6");

const BLOCKED_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

export function isPrivateAddress(ip) {
  const mapped = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : "";
  if (mapped && isIP(mapped) === 4) return block.check(mapped, "ipv4");
  const kind = isIP(ip);
  if (kind === 4) return block.check(ip, "ipv4");
  if (kind === 6) return block.check(ip, "ipv6");
  return true;
}

async function defaultLookup(hostname) {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function assertPublicUrl(input, lookupHost = defaultLookup) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error("Enter a full URL, including https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be checked");
  }
  if (url.username || url.password) {
    throw new Error("Remove the username and password from the page URL");
  }
  const host = url.hostname.replace(/\[|\]/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || BLOCKED_NAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Local addresses are not fetched");
  }
  let ips = [];
  try {
    ips = await lookupHost(host);
  } catch {
    throw new Error("Could not resolve that host");
  }
  if (!ips.length || ips.some((ip) => isPrivateAddress(ip))) {
    throw new Error("That host points at a private network, so it was not fetched");
  }
  return url;
}

function excerptFrom(body, contentType) {
  let text = body.toString("utf8");
  let title = "";
  if (/html/i.test(contentType || "")) {
    const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = match ? decodeEntities(match[1].replace(/\s+/g, " ").trim()) : "";
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    text = decodeEntities(text).replace(/\s+/g, " ").trim();
  } else {
    text = text.replace(/\s+/g, " ").trim();
  }
  return { title: title.slice(0, 180), excerpt: text.slice(0, 420) };
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

export function challengeNote(status, headers, excerpt) {
  const joined = `${headers.server || ""} ${excerpt}`.toLowerCase();
  if (headers["cf-mitigated"] || joined.includes("cf-mitigated")) {
    return "A bot check answered this request. OpenFetch does not try to get past it.";
  }
  if (status === 429) {
    return "The site returned 429. Wait before trying again. OpenFetch will not keep retrying.";
  }
  if ([401, 403, 503].includes(status) && /captcha|just a moment|attention required|access denied|bot detection|datadome/.test(joined)) {
    return "A bot check refused this request. OpenFetch does not try to get past it.";
  }
  return "";
}

function cleanError(err, proxy) {
  let message = err && err.message ? err.message : "The request failed";
  if (proxy) message = message.split(proxy).join(redactProxy(proxy));
  return message.slice(0, 300);
}

async function fetchUrl(url, options, deps, hops = 0) {
  if (hops > 3) throw new Error("Stopped after too many redirects");
  const checked = await assertPublicUrl(url, deps.lookup);
  const started = Date.now();
  const res = await deps.request(checked.href, options);
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.location;
    if (!location) return { url: checked.href, res, ms: Date.now() - started };
    const next = new URL(location, checked).href;
    return fetchUrl(next, options, deps, hops + 1);
  }
  return { url: checked.href, res, ms: Date.now() - started };
}

export async function inspect(input, deps = {}) {
  const lookupHost = deps.lookup || defaultLookup;
  const request = deps.request || sendRequest;
  const proxy = String(input.proxy || "").trim();
  if (proxy) parseProxy(proxy);

  const page = await assertPublicUrl(input.url, lookupHost);
  const userAgent = String(input.userAgent || USER_AGENT).replace(/[\r\n]/g, "").slice(0, 200) || USER_AGENT;
  const options = {
    proxy,
    timeoutMs: 10000,
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
  };
  const used = { lookup: lookupHost, request };

  let robots;
  try {
    const robotsFetch = await fetchUrl(new URL("/robots.txt", page.origin).href, options, used);
    if (robotsFetch.res.status === 404) {
      robots = { allowed: true, line: "", detail: "No robots.txt was found, so this path is allowed." };
    } else if (robotsFetch.res.status >= 200 && robotsFetch.res.status < 300) {
      robots = robotsDecision(robotsFetch.res.body.toString("utf8"), page.pathname || "/", userAgent);
    } else {
      robots = {
        allowed: false,
        line: "",
        detail: `Could not read robots.txt (HTTP ${robotsFetch.res.status}), so the page was not fetched.`,
      };
    }
  } catch (err) {
    throw new Error(cleanError(err, proxy));
  }

  const report = {
    requestedUrl: page.href,
    finalUrl: page.href,
    proxy: redactProxy(proxy),
    userAgent,
    robots,
    response: null,
  };
  if (!robots.allowed) return report;

  try {
    const pageFetch = await fetchUrl(page.href, options, used);
    const contentType = String(pageFetch.res.headers["content-type"] || "");
    const { title, excerpt } = excerptFrom(pageFetch.res.body, contentType);
    const headers = pageFetch.res.headers;
    report.finalUrl = pageFetch.url;
    report.response = {
      status: pageFetch.res.status,
      contentType: contentType.split(";")[0],
      server: String(headers.server || ""),
      title,
      excerpt,
      bytes: pageFetch.res.body.length,
      ms: pageFetch.ms,
      note: challengeNote(pageFetch.res.status, headers, excerpt),
    };
    return report;
  } catch (err) {
    throw new Error(cleanError(err, proxy));
  }
}
