/**
 * recall-check-lib.test.ts — resources/recall-check-lib.ts, the pure core of
 * POST /RecallProbes (recall checks, slice 1 of the outcome engine).
 *
 * The resource is thin glue over these functions (scope check, scan, call);
 * its read scope and HTTP behaviour are covered against real Harper in
 * test/integration/recall-probes-e2e.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PROBE_COUNT,
  PROBE_MIN_CONTENT_LENGTH,
  buildProbePrompt,
  clampCount,
  generateProbes,
  isProbeEligible,
  parseProbeOutput,
  sampleUpTo,
} from "../../resources/recall-check-lib.ts";

const NOW = new Date("2026-10-30T12:00:00Z");
const LONG = "x".repeat(PROBE_MIN_CONTENT_LENGTH);
const base = { id: "m1", content: LONG };

describe("isProbeEligible", () => {
  it("accepts a plain readable memory", () => {
    expect(isProbeEligible(base, NOW)).toBe(true);
  });
  it("rejects rows default search would never return", () => {
    expect(isProbeEligible({ ...base, archived: true }, NOW)).toBe(false);
    expect(isProbeEligible({ ...base, expiresAt: "2026-10-30T11:00:00Z" }, NOW)).toBe(false);
    expect(isProbeEligible({ ...base, validTo: "2026-10-30T11:00:00Z" }, NOW)).toBe(false);
  });
  it("keeps rows whose expiry or validTo is still ahead", () => {
    expect(isProbeEligible({ ...base, expiresAt: "2026-10-31T00:00:00Z", validTo: "2026-11-01T00:00:00Z" }, NOW)).toBe(true);
  });
  it("rejects skills, thin content and malformed ids", () => {
    expect(isProbeEligible({ ...base, tags: ["skill"] }, NOW)).toBe(false);
    expect(isProbeEligible({ ...base, content: "short" }, NOW)).toBe(false);
    expect(isProbeEligible({ ...base, id: "" }, NOW)).toBe(false);
    expect(isProbeEligible({ content: LONG }, NOW)).toBe(false);
  });
});

describe("sampleUpTo", () => {
  it("returns n distinct items without touching the input", () => {
    const items = [1, 2, 3, 4, 5];
    const picked = sampleUpTo(items, 3, () => 0.5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
  it("caps at the input size and handles zero", () => {
    expect(sampleUpTo([1, 2], 10)).toHaveLength(2);
    expect(sampleUpTo([1, 2], 0)).toEqual([]);
  });
});

describe("clampCount", () => {
  it("defaults non-numbers and clamps into [0, max]", () => {
    expect(clampCount(undefined, 20, MAX_PROBE_COUNT)).toBe(20);
    expect(clampCount("7", 20, MAX_PROBE_COUNT)).toBe(20);
    expect(clampCount(1e6, 20, MAX_PROBE_COUNT)).toBe(MAX_PROBE_COUNT);
    expect(clampCount(-3, 20, MAX_PROBE_COUNT)).toBe(0);
    expect(clampCount(4.9, 20, MAX_PROBE_COUNT)).toBe(4);
  });
});

describe("buildProbePrompt", () => {
  it("lists every memory by id and asks for the decoy count", () => {
    const prompt = buildProbePrompt([{ id: "a1", content: "alpha" }, { id: "b2", content: "beta" }], 3);
    expect(prompt).toContain("[a1]\nalpha");
    expect(prompt).toContain("[b2]\nbeta");
    expect(prompt).toContain("write 3 decoy question(s)");
  });
});

describe("parseProbeOutput", () => {
  const allowed = new Set(["a", "b"]);
  const q = (s: string) => `What do we know about ${s}?`;

  it("keeps valid probes and decoys", () => {
    const out = parseProbeOutput(JSON.stringify({ probes: [{ memoryId: "a", question: q("a") }], decoys: [q("lunch")] }), allowed, 5);
    expect(out).toEqual({ probes: [{ memoryId: "a", question: q("a") }], decoys: [q("lunch")] });
  });
  it("drops ids the model was not shown, duplicates and malformed questions", () => {
    const out = parseProbeOutput(JSON.stringify({
      probes: [
        { memoryId: "zz", question: q("zz") },
        { memoryId: "a", question: q("a") },
        { memoryId: "a", question: q("again") },
        { memoryId: "b", question: "short" },
        { memoryId: "b", question: 42 },
      ],
      decoys: [],
    }), allowed, 5);
    expect(out?.probes).toEqual([{ memoryId: "a", question: q("a") }]);
  });
  it("caps decoys and removes duplicates", () => {
    const out = parseProbeOutput(JSON.stringify({ probes: [], decoys: [q("1"), q("1"), q("2"), q("3")] }), allowed, 2);
    expect(out?.decoys).toEqual([q("1"), q("2")]);
  });
  it("fails on unparseable output, wrong shape, or nothing usable", () => {
    expect(parseProbeOutput("not json", allowed, 5)).toBeNull();
    expect(parseProbeOutput(JSON.stringify({ probes: {} , decoys: [] }), allowed, 5)).toBeNull();
    expect(parseProbeOutput(JSON.stringify({ probes: [{ memoryId: "zz", question: q("zz") }], decoys: [] }), allowed, 5)).toBeNull();
  });
});

describe("generateProbes", () => {
  const allowed = new Set(["a"]);
  const good = JSON.stringify({ probes: [{ memoryId: "a", question: "What do we know about a?" }], decoys: [] });

  it("succeeds on the first schema-mode call", async () => {
    const formats: unknown[] = [];
    const out = await generateProbes({
      prompt: "p", allowedIds: allowed, maxDecoys: 0,
      generate: async (_i, o) => { formats.push(o.responseFormat); return { content: good }; },
    });
    expect(out.ok).toBe(true);
    expect(formats).toHaveLength(1);
    expect(typeof formats[0]).toBe("object");
  });
  it("retries once in json mode after invalid output", async () => {
    const replies = ["garbage", good];
    const formats: unknown[] = [];
    const out = await generateProbes({
      prompt: "p", allowedIds: allowed, maxDecoys: 0,
      generate: async (_i, o) => { formats.push(o.responseFormat); return { content: replies.shift()! }; },
    });
    expect(out.ok).toBe(true);
    expect(formats).toEqual([expect.any(Object), "json"]);
  });
  it("reports incomplete generations and validation failures after the retry", async () => {
    const cut = await generateProbes({
      prompt: "p", allowedIds: allowed, maxDecoys: 0,
      generate: async () => ({ content: good, finishReason: "length" }),
    });
    expect(cut).toEqual({ ok: false, reason: "incomplete_generation" });
    const bad = await generateProbes({ prompt: "p", allowedIds: allowed, maxDecoys: 0, generate: async () => ({ content: "x" }) });
    expect(bad).toEqual({ ok: false, reason: "validation_failed" });
  });
  it("tells a missing backend apart from a failed call", async () => {
    const missing = await generateProbes({
      prompt: "p", allowedIds: allowed, maxDecoys: 0,
      generate: async () => { const e = new Error("none"); e.name = "ModelBackendNotFoundError"; throw e; },
    });
    expect(missing).toEqual({ ok: false, reason: "no_backend" });
    const failed = await generateProbes({ prompt: "p", allowedIds: allowed, maxDecoys: 0, generate: async () => { throw new Error("boom"); } });
    expect(failed).toEqual({ ok: false, reason: "generate_failed" });
  });
});

describe("RecallProbes stays read-only (supplementary source tripwire)", () => {
  it("never calls a table write method", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "resources", "RecallProbes.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const verb of [".put(", ".patch(", ".delete(", ".create(", ".update("]) {
      expect(src.includes(verb)).toBe(false);
    }
  });
});
