const form = document.querySelector("#form");
const message = document.querySelector("#message");
const report = document.querySelector("#report");
const button = form.querySelector("button");

function line(label, value) {
  const row = document.createElement("p");
  const name = document.createElement("strong");
  name.textContent = `${label} `;
  row.append(name, document.createTextNode(value || ""));
  return row;
}

function showReport(data) {
  report.replaceChildren();
  report.hidden = false;
  report.append(line("Proxy", data.proxy));
  report.append(line("User-Agent", data.userAgent));
  report.append(line("Robots", data.robots.detail));
  if (data.robots.line) report.append(line("Matched rule", data.robots.line));

  if (!data.response) return;

  const response = data.response;
  report.append(line("Final URL", data.finalUrl));
  report.append(line("Status", `${response.status} in ${response.ms} ms`));
  if (response.contentType) report.append(line("Type", response.contentType));
  if (response.server) report.append(line("Server", response.server));
  if (response.title) report.append(line("Title", response.title));
  if (response.note) {
    const note = document.createElement("p");
    note.className = "warn";
    note.textContent = response.note;
    report.append(note);
  }
  if (response.excerpt) {
    const pre = document.createElement("pre");
    pre.textContent = response.excerpt;
    report.append(pre);
  }
}

async function runCheck(url, proxy) {
  button.disabled = true;
  message.textContent = "Checking…";
  report.hidden = true;
  try {
    const res = await fetch("/api/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, proxy }),
    });
    const data = await res.json();
    if (!res.ok) {
      message.textContent = data.error || "The check failed";
      return;
    }
    message.textContent = data.robots.allowed
      ? "Fetched once."
      : "Stopped before the page fetch.";
    showReport(data);
  } catch {
    message.textContent = "The local server did not answer.";
  } finally {
    button.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runCheck(form.url.value, form.proxy.value);
});

runCheck(form.url.value, "");
