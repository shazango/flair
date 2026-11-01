/**
 * ask-lib.test.ts — resources/ask-lib.ts (the pure core of POST /Ask) and the
 * CLI's rendering of an /Ask result (`ask`, slice 3 of the outcome engine).
 *
 * The resource is thin glue (search, then one generate call); its scope and
 * HTTP behaviour are covered against real Harper in
 * test/integration/ask-e2e.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASK_CONTENT_CHARS, buildAskPrompt, generateAnswer, parseAnswerOutput } from "../../resources/ask-lib";
import { formatAskResult } from "../../src/commands/ask";

describe("buildAskPrompt", () => {
  it("numbers the memories, dates them, caps their length and states the rules", () => {
    const p = buildAskPrompt("how do we rotate keys?", [
      { content: "rotate with flair agent rotate-key", createdAt: "2026-09-14T10:00:00Z" },
      { content: "x".repeat(ASK_CONTENT_CHARS + 50) },
    ]);
    expect(p).toContain("Question: how do we rotate keys?");
    expect(p).toContain("[1] (2026-09-14) rotate with flair agent rotate-key");
    expect(p).toContain(`[2] ${"x".repeat(ASK_CONTENT_CHARS)}\n`);
    expect(p).not.toContain("x".repeat(ASK_CONTENT_CHARS + 1));
    expect(p).toContain("ONLY the numbered memories");
    expect(p).toContain("present both views");
  });
});

describe("parseAnswerOutput", () => {
  it("keeps valid citations and strips ones that name no supplied memory", () => {
    const out = parseAnswerOutput(JSON.stringify({ answer: "Run rotate-key [2] and back it up [1][7]. Also [0]." }), 2);
    expect(out).toEqual({ answer: "Run rotate-key [2] and back it up [1]. Also .", citations: [1, 2] });
  });

  it("rejects output that is not a usable answer", () => {
    expect(parseAnswerOutput("not json", 2)).toBeNull();
    expect(parseAnswerOutput(JSON.stringify({ text: "hi" }), 2)).toBeNull();
    expect(parseAnswerOutput(JSON.stringify({ answer: " [9] " }), 2)).toBeNull();
  });

  it("an answer that cites nothing is still an answer", () => {
    expect(parseAnswerOutput(JSON.stringify({ answer: "The memories do not cover this." }), 3))
      .toEqual({ answer: "The memories do not cover this.", citations: [] });
  });
});

describe("generateAnswer", () => {
  it("retries once in json mode, then reports why it failed", async () => {
    const formats: unknown[] = [];
    const out = await generateAnswer({
      prompt: "p", sourceCount: 1,
      generate: async (_p, opts) => { formats.push(opts.responseFormat); return { content: "nope" }; },
    });
    expect(out).toEqual({ ok: false, reason: "validation_failed" });
    expect(formats).toHaveLength(2);
    expect(formats[1]).toBe("json");
  });

  it("maps a missing backend and a thrown call to their own reasons", async () => {
    const missing = await generateAnswer({
      prompt: "p", sourceCount: 1,
      generate: async () => { const e = new Error("none"); e.name = "ModelBackendNotFoundError"; throw e; },
    });
    expect(missing).toEqual({ ok: false, reason: "no_backend" });
    const failed = await generateAnswer({ prompt: "p", sourceCount: 1, generate: async () => { throw new Error("boom"); } });
    expect(failed).toEqual({ ok: false, reason: "generate_failed" });
  });

  it("returns the parsed answer", async () => {
    const out = await generateAnswer({
      prompt: "p", sourceCount: 2, generate: async () => ({ content: JSON.stringify({ answer: "Yes [2]." }) }),
    });
    expect(out).toEqual({ ok: true, answer: "Yes [2].", citations: [2] });
  });
});

describe("formatAskResult", () => {
  const sources = [
    { n: 1, id: "m-1", content: "Rotate with flair agent rotate-key.", createdAt: "2026-09-14T00:00:00Z", trust: { matchQuality: "strong", provenanceStatus: "verified", verifiedAuthor: "ops", ageDays: 3 } },
    { n: 2, id: "m-2", content: "Unrelated note.", createdAt: null, trust: null },
  ];

  it("shows the answer and only the sources it cites", () => {
    const text = formatAskResult({ abstained: false, answer: "Use rotate-key [1].", citations: [1], sources });
    expect(text).toBe([
      "Use rotate-key [1].",
      "",
      "[1] Rotate with flair agent rotate-key.",
      "    2026-09-14 · strong match · verified author ops · 3d old · m-1",
    ].join("\n"));
  });

  it("falls back to the ranked sources when no answer could be written", () => {
    const text = formatAskResult({ abstained: false, answer: null, citations: [], sources, answerUnavailable: "no_backend" });
    expect(text.split("\n")[0]).toBe("No answer written (no LLM backend is configured). The closest memories:");
    expect(text).toContain("[2] Unrelated note.\n    no trust evidence · m-2");
  });

  it("says so when search abstained or found nothing", () => {
    expect(formatAskResult({ abstained: true, bestScore: 0.08, threshold: 0.15, sources: [] }))
      .toBe("No memory covers this confidently (best match 0.08, below the 0.15 confidence threshold). Nothing to answer from yet.");
    expect(formatAskResult({ abstained: false, answer: null, sources: [] })).toBe("No memory covers this yet.");
  });
});

describe("Ask stays read-only (supplementary source tripwire)", () => {
  it("never writes, and never records usage from the model's citations", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "resources", "Ask.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.(put|patch|delete|update|insert)\s*\(/);
    expect(src).not.toMatch(/RecordUsage|MemoryUsage/);
  });
});
