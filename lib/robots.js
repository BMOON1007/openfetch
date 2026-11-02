function stripComment(line) {
  const mark = line.indexOf("#");
  return (mark === -1 ? line : line.slice(0, mark)).trim();
}

function groupsFrom(text) {
  const groups = [];
  let current = null;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    const split = line.indexOf(":");
    if (split === -1) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();

    if (field === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }

  return groups;
}

function pickGroup(groups, userAgent) {
  const ua = userAgent.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === "*") continue;
      if (ua.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  if (best) return best;
  return groups.find((group) => group.agents.includes("*")) || null;
}

export function robotsDecision(robotsText, path, userAgent) {
  const group = pickGroup(groupsFrom(robotsText), userAgent);
  if (!group) {
    return { allowed: true, line: "", detail: "robots.txt has no matching rule, so this path is allowed." };
  }

  let winner = null;
  for (const rule of group.rules) {
    if (!rule.path) continue;
    if (!path.startsWith(rule.path)) continue;
    if (!winner || rule.path.length > winner.path.length) winner = rule;
    else if (rule.path.length === winner.path.length && rule.allow && !winner.allow) winner = rule;
  }

  if (!winner) {
    return { allowed: true, line: "", detail: "No robots.txt rule covers this path, so it is allowed." };
  }
  if (winner.allow) {
    return { allowed: true, line: `Allow: ${winner.path}`, detail: "robots.txt allows this path." };
  }
  return {
    allowed: false,
    line: `Disallow: ${winner.path}`,
    detail: "robots.txt disallows this path, so the page was not fetched.",
  };
}
