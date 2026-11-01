/**
 * recall-check.ts — scoring for `flair check` (recall checks, slice 1 of the
 * outcome engine; docs: docs/recall-checks.md).
 *
 * Pure: no I/O, no imports. The command (src/commands/check.ts) runs each
 * probe through POST /SemanticSearch with `abstain: true` and records two
 * numbers per probe: the 1-based rank of the probe's memory in the results
 * (null when absent or not applicable) and the `bestScore` the server reported.
 * Everything here is computed from those, so a stored run can be re-scored at
 * any abstention threshold without touching the server — that replay is the
 * threshold sweep.
 *
 * The replay mirrors resources/abstention.ts's evaluateAbstention exactly:
 * abstain iff bestScore is a number below the threshold; a null bestScore (no
 * semantic signal, e.g. keyword-only search) never abstains.
 */

export type ProbeKind = "answerable" | "decoy";

export interface StoredProbe {
  id: string;
  kind: ProbeKind;
  question: string;
  /** The memory the question is about. Absent on decoys. */
  memoryId?: string;
  createdAt: string;
  /** Set when the probe's memory is gone or archived; a retired probe is not run. */
  retiredAt?: string;
}

export interface ProbeFile {
  version: 1;
  agentId: string;
  probes: StoredProbe[];
}

export interface ProbeResult {
  probeId: string;
  kind: ProbeKind;
  /** 1-based rank of the probe's memory in the un-abstained results; null if absent. Always null for decoys. */
  rank: number | null;
  bestScore: number | null;
}

export interface RunRecord {
  at: string;
  agentId: string;
  /** The server's abstention threshold at run time (null if it reported none). */
  threshold: number | null;
  limit: number;
  results: ProbeResult[];
}

export interface RunMetrics {
  threshold: number | null;
  answerable: number;
  decoys: number;
  recallAt1: number | null;
  recallAt5: number | null;
  mrr: number | null;
  /** Share of answerable probes that abstained. */
  falseAbstainRate: number | null;
  /** Share of decoys that did NOT abstain. */
  falseAnswerRate: number | null;
}

export const SWEEP_THRESHOLDS: readonly number[] = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];

export function emptyProbeFile(agentId: string): ProbeFile {
  return { version: 1, agentId, probes: [] };
}

export function activeProbes(file: ProbeFile): StoredProbe[] {
  return file.probes.filter((p) => !p.retiredAt);
}

/** 1-based position of `memoryId` in `ids`, or null. */
export function rankOf(ids: readonly unknown[], memoryId: string): number | null {
  const i = ids.indexOf(memoryId);
  return i === -1 ? null : i + 1;
}

/** Same rule as resources/abstention.ts evaluateAbstention; null threshold = abstention off. */
export function abstainsAt(bestScore: number | null, threshold: number | null): boolean {
  return threshold !== null && bestScore !== null && bestScore < threshold;
}

function share(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

/** Score a run's results as if the server's abstention threshold were `threshold`. */
export function scoreAt(results: readonly ProbeResult[], threshold: number | null): RunMetrics {
  let answerable = 0, decoys = 0, hit1 = 0, hit5 = 0, rr = 0, falseAbstain = 0, falseAnswer = 0;
  for (const r of results) {
    const abstained = abstainsAt(r.bestScore, threshold);
    if (r.kind === "decoy") {
      decoys++;
      if (!abstained) falseAnswer++;
      continue;
    }
    answerable++;
    if (abstained) {
      falseAbstain++;
      continue;
    }
    if (r.rank !== null) {
      if (r.rank <= 1) hit1++;
      if (r.rank <= 5) hit5++;
      rr += 1 / r.rank;
    }
  }
  return {
    threshold,
    answerable,
    decoys,
    recallAt1: share(hit1, answerable),
    recallAt5: share(hit5, answerable),
    mrr: share(rr, answerable),
    falseAbstainRate: share(falseAbstain, answerable),
    falseAnswerRate: share(falseAnswer, decoys),
  };
}

export function scoreRun(run: RunRecord): RunMetrics {
  return scoreAt(run.results, run.threshold);
}

/** Replay one run at each threshold — the trade-off curve the abstention floor is tuned from. */
export function sweep(results: readonly ProbeResult[], thresholds: readonly number[] = SWEEP_THRESHOLDS): RunMetrics[] {
  return thresholds.map((t) => scoreAt(results, t));
}

/** Parse a runs.jsonl body, skipping blank or corrupt lines rather than failing the report. */
export function parseRuns(text: string): RunRecord[] {
  const runs: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.at === "string" && Array.isArray(r.results)) runs.push(r);
    } catch {
      // ponytail: a torn last line (crash mid-append) is skipped, not repaired
    }
  }
  return runs;
}

export function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}
