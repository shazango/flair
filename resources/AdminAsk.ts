import { Resource, databases } from "harper";
import { layout, htmlResponse, esc } from "./admin-layout.js";
import { allowAdmin } from "./agent-auth.js";
import { Ask } from "./Ask.js";
import { ASK_UNAVAILABLE, formatAbstentionSummary, formatTrustSummary, withoutAuthor } from "../src/lib/trust-summary.js";

/**
 * GET /AdminAsk?q=...&agent=... — `ask` for operators (docs/ask.md).
 *
 * Runs POST /Ask from the chosen agent's read scope, so an operator sees what
 * that agent would be told. An agent is required: with no agentId an admin
 * search has no read scope, and every agent's private memories would go to the
 * model. Records nothing; confirming and refining stay with the agents.
 *
 * allowRead()=allowAdmin (defense-in-depth): see Admin.ts.
 */

function memoryCard(m: any, label: string, hideAuthor = false): string {
  const summary = m.trust ? formatTrustSummary(m.trust) : "no trust evidence";
  const meta = [
    m.createdAt ? String(m.createdAt).slice(0, 10) : "",
    hideAuthor ? withoutAuthor(summary) : summary,
  ].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="card">
      <p style="white-space:pre-wrap">${label}${esc(m.content)}</p>
      <p style="margin-top:8px"><small>${meta} · <a href="/AdminMemory?id=${esc(encodeURIComponent(m.id))}">${esc(m.id)}</a></small></p>
    </div>`;
}

function renderResult(result: any): string {
  if (result.abstained) {
    const closest: any[] = result.closest ?? [];
    return `
      <div class="card">${esc(formatAbstentionSummary(result))}</div>
      ${closest.length === 0 ? "" : `
        <h3 style="margin:24px 0 4px">Closest memories</h3>
        <p class="subtitle">Not an answer. These fell below the confidence threshold and may not be relevant.</p>
        ${closest.map((m) => memoryCard(m, "")).join("")}`}`;
  }
  const sources: any[] = result.sources ?? [];
  if (sources.length === 0) return `<div class="card">No memory covers this yet.</div>`;

  const cited = new Set<number>(result.citations ?? []);
  const refinements = new Set<number>(sources.flatMap((s) => s.refinedBy ?? []));
  const answer = typeof result.answer === "string"
    ? `<div class="card"><p style="white-space:pre-wrap">${esc(result.answer)}</p></div>`
    : `<div class="card">No answer written (${esc(ASK_UNAVAILABLE[result.answerUnavailable] ?? "no answer could be written")}).</div>`;
  const cards = sources.map((s) => {
    const label = [
      `<strong>[${Number(s.n)}]</strong>`,
      cited.has(s.n) ? `<span class="badge badge-blue">cited</span>` : "",
      s.refines ? `<span class="badge badge-green">refines [${Number(s.refines)}]</span>` : "",
      s.refinedBy?.length ? `<span class="badge badge-yellow">refined: see ${s.refinedBy.map((n: number) => `[${Number(n)}]`).join("")}</span>` : "",
    ].filter(Boolean).join(" ");
    return memoryCard(s, `${label} `, Boolean(s.refines || s.refinedBy?.length) || refinements.has(s.n));
  }).join("");
  return `${answer}<h3 style="margin:24px 0 8px">Sources</h3>${cards}`;
}

export class AdminAsk extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get() {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const url = new URL(request?.url ?? "http://localhost", "http://localhost");
    const q = url.searchParams.get("q")?.trim() ?? "";
    const agent = url.searchParams.get("agent") ?? "";

    const agents: string[] = [];
    try {
      for await (const a of (databases as any).flair.Agent.search()) agents.push(String(a.id));
    } catch { /* table may not exist */ }
    agents.sort();

    // Browsers attach Basic credentials to any request, so a link or image on
    // another site must not be able to spend the instance's LLM budget.
    const site = request?.headers?.get?.("sec-fetch-site");
    const crossSite = Boolean(site) && site !== "same-origin" && site !== "none";

    let output = "";
    if (q && !agents.includes(agent)) {
      output = `<div class="card">Choose an agent to ask as.</div>`;
    } else if (q && crossSite) {
      output = `<div class="card">This question came from a link on another site, so it hasn't been run. Press Ask to run it.</div>`;
    } else if (q) {
      const result: any = await new (Ask as any)(undefined, ctx).post({ q, agentId: agent });
      output = result instanceof Response
        ? `<div class="card">Ask failed (HTTP ${result.status}): ${esc(await result.text())}</div>`
        : renderResult(result);
    }

    const options = agents.map((id) => `<option value="${esc(id)}"${id === agent ? " selected" : ""}>${esc(id)}</option>`).join("");
    const field = "padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:0.95em";
    const form = agents.length === 0
      ? `<div class="empty">No agents registered yet.</div>`
      : `<form method="GET" action="/AdminAsk" style="display:flex;gap:8px;margin-bottom:20px">
          <input type="text" name="q" value="${esc(q)}" placeholder="Ask a question..." aria-label="Question" required style="flex:1;${field}">
          <select name="agent" aria-label="Agent to ask as" style="width:180px;${field}">${options}</select>
          <button type="submit" class="btn btn-primary">Ask</button>
        </form>`;

    const content = `
      <h1>Ask</h1>
      <p class="subtitle">Answers come only from memories this agent can read.</p>
      ${form}
      ${output}
    `;
    return htmlResponse(layout("Ask", content, "ask"));
  }
}
