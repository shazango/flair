/**
 * ask.ts — `flair ask "<question>"`: an answer written only from your memories,
 * citing them by number, each citation carrying the server's trust evidence
 * (slice 3 of the outcome engine; docs: docs/ask.md).
 *
 * The server does the work (POST /Ask, resources/Ask.ts); this module signs the
 * request and renders the result. Feedback (slice 4) goes to POST /RecordOutcome:
 * `--confirm` says cited memories held up; `--refine` writes the more accurate
 * version as a new shared memory and links it to the one it improves. Shared cli-locals are injected via bindCli()
 * before register(); this module never imports src/cli.ts (flair#1636 pattern).
 */
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { buildEd25519Auth, requestTarget, requestUrl, resolveKeyPath } from "../lib/auth-resolve.js";
import { encodeRecordId } from "../lib/record-id-path.js";
import * as render from "../render.js";
import { formatAbstentionSummary, formatTrustSummary } from "../lib/trust-summary.js";

export type AskCli = {
  resolveBaseUrl: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
};

let cli: AskCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: AskCli): void {
  cli = fns;
}

const UNAVAILABLE: Record<string, string> = {
  no_backend: "no LLM backend is configured",
  generate_failed: "the LLM call failed",
  validation_failed: "the LLM's reply was not usable",
  incomplete_generation: "the LLM's reply was cut off",
};
const SNIPPET_CHARS = 160;

/** Plain-text rendering of a POST /Ask result (exported for tests). */
export function formatAskResult(result: any): string {
  if (result?.abstained) return `${formatAbstentionSummary(result)} Nothing to answer from yet.`;
  const sources: any[] = Array.isArray(result?.sources) ? result.sources : [];
  if (sources.length === 0) return "No memory covers this yet.";

  const lines: string[] = [];
  const cited = new Set<number>(Array.isArray(result?.citations) ? result.citations : []);
  let shown = sources;
  if (typeof result?.answer === "string") {
    lines.push(result.answer, "");
    if (cited.size > 0) {
      const keep = new Set(cited);
      for (const s of sources) if (cited.has(s.n)) for (const n of s.refinedBy ?? []) keep.add(n);
      shown = sources.filter((s) => keep.has(s.n));
    }
  } else {
    const why = UNAVAILABLE[result?.answerUnavailable] ?? "no answer could be written";
    lines.push(`No answer written (${why}). The closest memories:`, "");
  }
  for (const s of shown) {
    const text = String(s.content ?? "").replace(/\s+/g, " ");
    lines.push(`[${s.n}] ${text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text}`);
    const date = s.createdAt ? `${String(s.createdAt).slice(0, 10)} · ` : "";
    lines.push(`    ${date}${s.trust ? formatTrustSummary(s.trust) : "no trust evidence"} · ${s.id}`);
    if (s.refines) lines.push(`    ↻ refines [${s.refines}]`);
    const refined = (Array.isArray(s.refinedBy) ? s.refinedBy : []).filter((n: number) => !shown.some((x) => x.n === n));
    if (refined.length > 0) lines.push(`    ↻ refined: see ${refined.map((n: number) => `[${n}]`).join("")}`);
  }
  if (typeof result?.answer === "string") {
    const ids = shown.map((s) => s.id).join(",");
    lines.push("", `Held up?  flair ask --confirm ${ids}`, `Better?   flair ask --refine <memory-id> "what is more accurate…"`);
  }
  return lines.join("\n");
}

/** One signed JSON request; throws with the server's error text on failure. */
async function signed(opts: any, agentId: string, method: string, path: string, body: unknown): Promise<any> {
  const url = requestUrl(cli.resolveBaseUrl(opts), path);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const keyPath = opts.key || resolveKeyPath(agentId);
  if (keyPath) headers["authorization"] = buildEd25519Auth(agentId, method, requestTarget(url), keyPath);
  const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  return text ? JSON.parse(text) : {};
}

export function register(program: Command): void {
  program
    .command("ask [question]")
    .description("Answer a question from memory, citing the memories it used with their trust evidence")
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
    .option("--limit <n>", "Memories to answer from (max 10)", "5")
    .option("--confirm <ids>", "Say these memories held up (comma-separated ids, as printed after an answer)")
    .option("--refine <id>", "Write the more accurate version (the question argument) as a new shared memory that refines <id>")
    .option("--port <port>", "Harper HTTP port")
    .option("--url <url>", "Flair base URL (overrides --port)")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
    .option("--key <path>", "Ed25519 private key path")
    .option("--json", "Output the raw /Ask response")
    .action(async (question, opts) => {
      try {
        const { agentId } = cli.resolveSigningAgentId(opts, "ask");
        if (!agentId) {
          console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
          process.exit(2);
        }
        if (opts.confirm) {
          const ids = [...new Set(String(opts.confirm).split(",").map((x) => x.trim()).filter(Boolean))];
          for (const memoryId of ids) await signed(opts, agentId, "POST", "/RecordOutcome", { memoryId, kind: "confirmed" });
          console.log(`${render.icons.ok} Recorded that ${ids.length === 1 ? "it" : `these ${ids.length}`} held up. Thanks.`);
          return;
        }
        if (opts.refine) {
          if (!question || !question.trim()) {
            console.error('error: --refine needs the more accurate information: flair ask --refine <id> "…"');
            process.exit(2);
          }
          const id = randomUUID();
          await signed(opts, agentId, "PUT", `/Memory/${encodeRecordId(id)}`, {
            id, agentId, content: question.trim(), durability: "persistent", visibility: "shared", createdAt: new Date().toISOString(),
          });
          await signed(opts, agentId, "POST", "/RecordOutcome", { memoryId: opts.refine, kind: "refined", refinementMemoryId: id });
          console.log(`${render.icons.ok} Saved as ${id}; it now comes up alongside ${opts.refine}.`);
          return;
        }
        if (!question) {
          console.error("error: a question is required (or --confirm / --refine)");
          process.exit(2);
        }
        const result = await signed(opts, agentId, "POST", "/Ask", { agentId, q: question, limit: Number.parseInt(opts.limit, 10) || 5 });
        if (render.resolveOutputMode(opts) === "json") {
          console.log(render.asJSON(result));
          return;
        }
        console.log(formatAskResult(result));
      } catch (err: any) {
        console.error(`${render.icons.error} Ask failed: ${err.message}`);
        process.exit(1);
      }
    });
}
