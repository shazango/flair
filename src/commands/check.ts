/**
 * check.ts — `flair check init|run|report`: recall checks (slice 1 of the
 * outcome engine; docs: docs/recall-checks.md).
 *
 * Recall checks grade the instance's retrieval on its own data, never an
 * agent. `init` asks POST /RecallProbes to write questions from memories in
 * the agent's read scope (plus decoys nothing should answer) and keeps them
 * locally; `run` sends each one through POST /SemanticSearch — the same path
 * agents use — and appends the ranks and best scores to a local log; `report`
 * shows the trend and replays the latest run across abstention thresholds.
 *
 * Local files, per agent (read scope differs by agent), mode 0600:
 *   ~/.flair/recall-check/<agent>/probes.json   the question set
 *   ~/.flair/recall-check/<agent>/runs.jsonl    one line per run
 * Nothing is written to the instance. Runs do register as ordinary search
 * hits (`retrievalCount`), which is display-only since flair#683.
 *
 * Shared cli-locals are injected via bindCli() before register(); this module
 * never imports src/cli.ts (flair#1636 pattern).
 */
import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEd25519Auth, requestTarget, requestUrl, resolveKeyPath } from "../lib/auth-resolve.js";
import { resolveHome } from "../lib/home.js";
import { encodeRecordId } from "../lib/record-id-path.js";
import {
  activeProbes,
  emptyProbeFile,
  parseRuns,
  pct,
  rankOf,
  scoreRun,
  sweep,
  type ProbeFile,
  type ProbeResult,
  type RunMetrics,
  type RunRecord,
  type StoredProbe,
} from "../lib/recall-check.js";
import * as render from "../render.js";

export type CheckCli = {
  resolveBaseUrl: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
};

let cli: CheckCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: CheckCli): void {
  cli = fns;
}

const MAX_RATE_LIMIT_RETRIES = 5;

function checkDir(agentId: string): string {
  return join(resolveHome(), ".flair", "recall-check", encodeURIComponent(agentId));
}

function readProbeFile(agentId: string): ProbeFile {
  const path = join(checkDir(agentId), "probes.json");
  if (!existsSync(path)) return emptyProbeFile(agentId);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.probes)) {
    throw new Error(`${path} is not a recall-check probe file`);
  }
  return parsed;
}

function writeProbeFile(file: ProbeFile): void {
  mkdirSync(checkDir(file.agentId), { recursive: true, mode: 0o700 });
  writeFileSync(join(checkDir(file.agentId), "probes.json"), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

function readRuns(agentId: string): RunRecord[] {
  const path = join(checkDir(agentId), "runs.jsonl");
  return existsSync(path) ? parseRuns(readFileSync(path, "utf8")) : [];
}

function appendRun(run: RunRecord): void {
  mkdirSync(checkDir(run.agentId), { recursive: true, mode: 0o700 });
  appendFileSync(join(checkDir(run.agentId), "runs.jsonl"), JSON.stringify(run) + "\n", { mode: 0o600 });
}

/**
 * Signed request with 429 back-off. Re-signs each attempt: a signature carries
 * a one-time nonce, so a retried request must not reuse it.
 */
async function signedRequest(opts: any, agentId: string, method: string, path: string, body?: unknown): Promise<Response> {
  const url = requestUrl(cli.resolveBaseUrl(opts), path);
  const keyPath = opts.key || resolveKeyPath(agentId);
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (keyPath) headers["authorization"] = buildEd25519Auth(agentId, method, requestTarget(url), keyPath);
    const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;
    const waitSec = Number(res.headers.get("retry-after")) || 2;
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
}

async function postJson(opts: any, agentId: string, path: string, body: unknown): Promise<any> {
  const res = await signedRequest(opts, agentId, "POST", path, body);
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error ? `${j.error}${j.detail ? ` (${j.detail})` : ""}` : text;
    } catch { /* not JSON */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return text ? JSON.parse(text) : {};
}

/** True when the memory is gone or archived — its probe can no longer be answered. */
async function memoryIsGone(opts: any, agentId: string, memoryId: string): Promise<boolean> {
  const res = await signedRequest(opts, agentId, "GET", `/Memory/${encodeRecordId(memoryId)}`);
  if (res.status === 404) return true;
  if (!res.ok) return false; // unknown: keep the probe
  const row = await res.json().catch(() => null);
  return row?.archived === true;
}

function requireAgent(opts: any): string {
  const { agentId } = cli.resolveSigningAgentId(opts, "check");
  if (!agentId) {
    console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
    process.exit(2);
  }
  return agentId;
}

function positiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`error: ${name} must be a non-negative integer`);
    process.exit(2);
  }
  return n;
}

function metricsLine(m: RunMetrics): string {
  return [
    `recall@1 ${pct(m.recallAt1)}`,
    `recall@5 ${pct(m.recallAt5)}`,
    `MRR ${m.mrr === null ? "—" : m.mrr.toFixed(2)}`,
    `abstained on answerable ${pct(m.falseAbstainRate)}`,
    `answered decoys ${pct(m.falseAnswerRate)}`,
  ].join(" · ");
}

function withConnectionOptions(cmd: Command): Command {
  return cmd
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env)")
    .option("--key <path>", "Ed25519 private key path")
    .option("--port <port>", "Harper HTTP port")
    .option("--url <url>", "Flair base URL (overrides --port)")
    .option("--target <url>", "Remote Flair URL (env: FLAIR_TARGET; alias for --url)")
    .option("--json", "Output raw JSON");
}

export function register(program: Command): void {
  const check = program
    .command("check")
    .description("Recall checks: measure how well search finds this agent's memories, and whether it abstains when nothing answers");

  withConnectionOptions(
    check
      .command("init")
      .description("Write test questions from memories in the agent's read scope (adds to an existing set). Needs a generative backend")
      .option("--count <n>", "Memories to write questions for (default 20, max 50)")
      .option("--decoys <n>", "Questions nothing should answer (default 5, max 20)"),
  ).action(async (opts) => {
    try {
      const agentId = requireAgent(opts);
      const file = readProbeFile(agentId);
      const body: Record<string, unknown> = {
        agentId,
        excludeMemoryIds: activeProbes(file).flatMap((p) => (p.memoryId ? [p.memoryId] : [])),
      };
      const count = positiveInt(opts.count, "--count");
      const decoys = positiveInt(opts.decoys, "--decoys");
      if (count !== undefined) body.count = count;
      if (decoys !== undefined) body.decoys = decoys;

      const result = await postJson(opts, agentId, "/RecallProbes", body);
      const now = new Date().toISOString();
      const added: StoredProbe[] = [
        ...(result.probes ?? []).map((p: any) => ({
          id: randomUUID(), kind: "answerable" as const, question: p.question, memoryId: p.memoryId, createdAt: now,
        })),
        ...(result.decoys ?? []).map((q: string) => ({ id: randomUUID(), kind: "decoy" as const, question: q, createdAt: now })),
      ];
      file.probes.push(...added);
      writeProbeFile(file);

      if (render.resolveOutputMode(opts) === "json") {
        console.log(render.asJSON({ added: added.length, active: activeProbes(file).length, eligible: result.eligible, model: result.model }));
        return;
      }
      const decoyCount = added.filter((p) => p.kind === "decoy").length;
      console.log(`${render.icons.ok} Added ${added.length - decoyCount} questions and ${decoyCount} decoys ${render.wrap(render.c.dim, `(model: ${result.model})`)}`);
      console.log(render.wrap(render.c.dim, `Active questions: ${activeProbes(file).length} · memories eligible: ${result.eligible} · next: flair check run`));
    } catch (err: any) {
      console.error(`${render.icons.error} Recall check init failed: ${err.message}`);
      process.exit(1);
    }
  });

  withConnectionOptions(
    check
      .command("run")
      .description("Run the question set through search and log the result")
      .option("--limit <n>", "Results per search (default 10)"),
  ).action(async (opts) => {
    try {
      const agentId = requireAgent(opts);
      const file = readProbeFile(agentId);
      const probes = activeProbes(file);
      if (probes.length === 0) {
        console.error("error: no questions yet. Run: flair check init");
        process.exit(2);
      }
      const limit = positiveInt(opts.limit, "--limit") || 10;
      const results: ProbeResult[] = [];
      let threshold: number | null = null;
      let retired = 0;

      for (const probe of probes) {
        const search = { agentId, q: probe.question, limit };
        const first = await postJson(opts, agentId, "/SemanticSearch", { ...search, abstain: true });
        if (typeof first.threshold === "number") threshold = first.threshold;
        const bestScore = typeof first.bestScore === "number" ? first.bestScore : null;
        if (probe.kind === "decoy") {
          results.push({ probeId: probe.id, kind: "decoy", rank: null, bestScore });
          continue;
        }
        // An abstained search returns no results; ask again without abstention
        // so the rank is known for every threshold the sweep replays.
        const shown = first.abstained ? await postJson(opts, agentId, "/SemanticSearch", search) : first;
        const rank = rankOf((shown.results ?? []).map((r: any) => r.id), probe.memoryId!);
        if (rank === null && (await memoryIsGone(opts, agentId, probe.memoryId!))) {
          probe.retiredAt = new Date().toISOString();
          retired++;
          continue;
        }
        results.push({ probeId: probe.id, kind: "answerable", rank, bestScore });
      }

      if (retired > 0) writeProbeFile(file);
      const run: RunRecord = { at: new Date().toISOString(), agentId, threshold, limit, results };
      appendRun(run);
      const m = scoreRun(run);

      if (render.resolveOutputMode(opts) === "json") {
        console.log(render.asJSON({ ...m, retired }));
        return;
      }
      console.log(`${render.icons.ok} Ran ${m.answerable} questions and ${m.decoys} decoys`);
      console.log(`  ${metricsLine(m)}`);
      if (retired > 0) console.log(render.wrap(render.c.dim, `  Retired ${retired} question(s) whose memory is gone or archived. Add more: flair check init`));
      console.log(render.wrap(render.c.dim, "  Trend and threshold sweep: flair check report"));
    } catch (err: any) {
      console.error(`${render.icons.error} Recall check run failed: ${err.message}`);
      process.exit(1);
    }
  });

  withConnectionOptions(
    check
      .command("report")
      .description("Trend across runs, and the latest run replayed across abstention thresholds")
      .option("--last <n>", "Runs to show (default 10)"),
  ).action(async (opts) => {
    try {
      const agentId = requireAgent(opts);
      const runs = readRuns(agentId);
      if (runs.length === 0) {
        console.error("error: no runs yet. Run: flair check run");
        process.exit(2);
      }
      const last = positiveInt(opts.last, "--last") || 10;
      const shown = runs.slice(-last);
      const latest = runs[runs.length - 1];
      const curve = sweep(latest.results);

      if (render.resolveOutputMode(opts) === "json") {
        console.log(render.asJSON({ runs: shown.map((r) => ({ at: r.at, ...scoreRun(r) })), sweep: curve }));
        return;
      }
      console.log(render.wrap(render.c.bold, "Runs"));
      for (const r of shown) {
        console.log(`  ${r.at.slice(0, 16).replace("T", " ")}  ${metricsLine(scoreRun(r))}`);
      }
      console.log();
      console.log(`${render.wrap(render.c.bold, "Abstention threshold sweep")} ${render.wrap(render.c.dim, "(latest run, replayed)")}`);
      console.log(render.wrap(render.c.dim, "  threshold  recall@5  abstained on answerable  answered decoys"));
      for (const s of curve) {
        const mark = latest.threshold !== null && Math.abs(s.threshold! - latest.threshold) < 1e-9 ? "  ← current" : "";
        console.log(`  ${s.threshold!.toFixed(2).padEnd(9)}  ${pct(s.recallAt5).padEnd(8)}  ${pct(s.falseAbstainRate).padEnd(23)}  ${pct(s.falseAnswerRate)}${mark}`);
      }
      console.log(render.wrap(render.c.dim, "  A report only: it never changes the threshold."));
    } catch (err: any) {
      console.error(`${render.icons.error} Recall check report failed: ${err.message}`);
      process.exit(1);
    }
  });
}
