/**
 * recall-check-scoring.test.ts — src/lib/recall-check.ts, the scoring behind
 * `flair check run|report`.
 *
 * The threshold replay must agree with the server's real abstention decision,
 * or the sweep would describe a curve the server never draws — so the parity
 * case below runs both against the same inputs.
 */
import { describe, it, expect } from "bun:test";
import { ABSTENTION_THRESHOLD, evaluateAbstention } from "../../resources/abstention.ts";
import {
  abstainsAt,
  activeProbes,
  parseRuns,
  pct,
  rankOf,
  scoreAt,
  sweep,
  type ProbeResult,
} from "../../src/lib/recall-check.ts";

const answer = (rank: number | null, bestScore: number | null): ProbeResult => ({ probeId: "p", kind: "answerable", rank, bestScore });
const decoy = (bestScore: number | null): ProbeResult => ({ probeId: "d", kind: "decoy", rank: null, bestScore });

describe("abstainsAt", () => {
  it("matches evaluateAbstention at the server's threshold", () => {
    for (const s of [null, 0, 0.05, ABSTENTION_THRESHOLD - 1e-9, ABSTENTION_THRESHOLD, 0.5, 1]) {
      expect(abstainsAt(s, ABSTENTION_THRESHOLD)).toBe(evaluateAbstention(s).abstained);
    }
  });
  it("never abstains when abstention was off", () => {
    expect(abstainsAt(0, null)).toBe(false);
  });
});

describe("rankOf", () => {
  it("is 1-based and null when absent", () => {
    expect(rankOf(["a", "b", "c"], "b")).toBe(2);
    expect(rankOf(["a"], "z")).toBeNull();
  });
});

describe("scoreAt", () => {
  const results = [answer(1, 0.8), answer(3, 0.4), answer(null, 0.3), answer(2, 0.1), decoy(0.05), decoy(0.6)];

  it("computes recall, MRR and abstention errors at a threshold", () => {
    const m = scoreAt(results, 0.15);
    expect(m.answerable).toBe(4);
    expect(m.decoys).toBe(2);
    expect(m.recallAt1).toBe(1 / 4);
    expect(m.recallAt5).toBe(2 / 4); // rank 2 abstained at 0.15, so it is not a hit
    expect(m.mrr).toBeCloseTo((1 + 1 / 3) / 4, 10);
    expect(m.falseAbstainRate).toBe(1 / 4);
    expect(m.falseAnswerRate).toBe(1 / 2);
  });
  it("returns null rates instead of dividing by zero", () => {
    const m = scoreAt([], 0.15);
    expect(m.recallAt5).toBeNull();
    expect(m.falseAnswerRate).toBeNull();
  });
});

describe("sweep", () => {
  it("trades recall for decoy rejection as the threshold rises", () => {
    const results = [answer(1, 0.8), answer(1, 0.3), decoy(0.2), decoy(0.4)];
    const [low, , high] = sweep(results, [0.1, 0.25, 0.5]);
    expect(low.recallAt5).toBe(1);
    expect(low.falseAnswerRate).toBe(1);
    expect(high.recallAt5).toBe(0.5);
    expect(high.falseAnswerRate).toBe(0);
  });
});

describe("parseRuns", () => {
  it("skips blank, torn and foreign lines", () => {
    const good = JSON.stringify({ at: "2026-10-30T00:00:00Z", agentId: "a", threshold: 0.15, limit: 10, results: [] });
    const runs = parseRuns(`${good}\n\n{"at":"2026-10-30T01:00\n${JSON.stringify({ hello: 1 })}\n`);
    expect(runs).toHaveLength(1);
  });
});

describe("activeProbes / pct", () => {
  it("drops retired probes", () => {
    const file = { version: 1 as const, agentId: "a", probes: [
      { id: "1", kind: "decoy" as const, question: "q", createdAt: "t" },
      { id: "2", kind: "decoy" as const, question: "q", createdAt: "t", retiredAt: "t" },
    ] };
    expect(activeProbes(file).map((p) => p.id)).toEqual(["1"]);
  });
  it("formats rates", () => {
    expect(pct(null)).toBe("—");
    expect(pct(0.256)).toBe("26%");
  });
});
