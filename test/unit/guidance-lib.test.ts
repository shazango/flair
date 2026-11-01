/**
 * guidance-lib.test.ts — the pure core of the guidance scan (slice 5b of the
 * outcome engine), the CLI renderers, and the tripwires: the scan only
 * proposes, lessons come only from shared memories, prompts never carry agent
 * ids, and the nightly hook runs only with admin credentials.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LESSON_MIN_REFINEMENTS,
  buildLessonPrompt,
  buildLinkPrompt,
  generateParsed,
  lessonCandidates,
  lessonDraftId,
  parseLessonOutput,
  parseLinkOutput,
} from "../../resources/guidance-lib";
import { formatDrafts, formatScan } from "../../src/commands/growth";

const AREA = "subsystem:auth";
function fixture(n: number, visibility = "shared") {
  const memories = new Map<string, any>();
  const rows: any[] = [];
  for (let i = 0; i < n; i++) {
    memories.set(`m${i}`, { id: `m${i}`, agentId: `author-${i}`, visibility, subject: AREA, content: `first ${i}` });
    memories.set(`r${i}`, { id: `r${i}`, agentId: `fixer-${i}`, visibility: "shared", content: `better ${i}` });
    rows.push({ agentId: `fixer-${i}`, memoryId: `m${i}`, kind: "refined", refinementMemoryId: `r${i}` });
  }
  return { memories, rows };
}

describe("lessonCandidates", () => {
  it("needs LESSON_MIN_REFINEMENTS shared refinements in an area with no skill", () => {
    const enough = fixture(LESSON_MIN_REFINEMENTS);
    const [c] = lessonCandidates(enough.rows, enough.memories, [], []);
    expect(c.area).toBe(AREA);
    expect(c.pairs).toHaveLength(LESSON_MIN_REFINEMENTS);
    expect(c.sourceMemoryIds).toContain("m0");
    expect(c.sourceMemoryIds).toContain("r0");

    const few = fixture(LESSON_MIN_REFINEMENTS - 1);
    expect(lessonCandidates(few.rows, few.memories, [], [])).toEqual([]);
    expect(lessonCandidates(enough.rows, enough.memories, [{ id: "s", subject: AREA }], [])).toEqual([]);
  });

  it("never drafts from private memories", () => {
    const priv = fixture(LESSON_MIN_REFINEMENTS + 2, "private");
    expect(lessonCandidates(priv.rows, priv.memories, [], [])).toEqual([]);
  });

  it("skips an area with an open draft; after a rejection, waits for more evidence", () => {
    const f = fixture(LESSON_MIN_REFINEMENTS);
    const n = LESSON_MIN_REFINEMENTS;
    expect(lessonCandidates(f.rows, f.memories, [], [{ kind: "lesson", area: AREA, status: "pending", refinementCount: n }])).toEqual([]);
    expect(lessonCandidates(f.rows, f.memories, [], [{ kind: "lesson", area: AREA, status: "rejected", refinementCount: n }])).toEqual([]);
    const more = fixture(n + 1);
    expect(lessonCandidates(more.rows, more.memories, [], [{ kind: "lesson", area: AREA, status: "rejected", refinementCount: n }])).toHaveLength(1);
    expect(lessonDraftId(AREA, n + 1)).not.toBe(lessonDraftId(AREA, n)); // the rejected draft is kept
  });
});

describe("prompts and parsing", () => {
  it("prompts carry content, never agent ids, and ask for growth not blame", () => {
    const f = fixture(LESSON_MIN_REFINEMENTS);
    const lesson = buildLessonPrompt(lessonCandidates(f.rows, f.memories, [], [])[0]);
    expect(lesson).toContain("first 0");
    expect(lesson).toContain("better 0");
    expect(lesson).not.toMatch(/author-|fixer-/);
    expect(lesson).toContain("do not name or blame anyone");
    expect(buildLinkPrompt("latest is 0.61", "latest is 0.62")).toContain('If unsure, answer "updates"');
  });

  it("parses only well-formed replies", () => {
    expect(parseLinkOutput('{"verdict":"corrects","reason":" missed a step "}')).toEqual({ verdict: "corrects", reason: "missed a step" });
    expect(parseLinkOutput('{"verdict":"wrong","reason":"x"}')).toBeNull();
    expect(parseLinkOutput("nope")).toBeNull();
    expect(parseLessonOutput('{"trigger":"When rotating keys","lesson":"Re-run init."}')).toEqual({ trigger: "When rotating keys", lesson: "Re-run init." });
    expect(parseLessonOutput('{"trigger":"","lesson":"x"}')).toBeNull();
  });

  it("generateParsed retries once in json mode and reports why it failed", async () => {
    const calls: any[] = [];
    const flaky = async (_p: string, o: any) => { calls.push(o.responseFormat); return { content: calls.length === 1 ? "junk" : '{"verdict":"updates","reason":"new version"}' }; };
    const ok = await generateParsed({ prompt: "p", schema: {}, parse: parseLinkOutput, maxTokens: 10, generate: flaky as any });
    expect(ok).toEqual({ ok: true, value: { verdict: "updates", reason: "new version" } });
    expect(calls[1]).toBe("json");
    const missing = async () => { const e = new Error("x"); e.name = "ModelBackendNotFoundError"; throw e; };
    const r = await generateParsed({ prompt: "p", schema: {}, parse: parseLinkOutput, maxTokens: 10, generate: missing as any });
    expect(r).toEqual({ ok: false, reason: "no_backend" });
  });
});

describe("renderers", () => {
  it("formatScan", () => {
    expect(formatScan({ skipped: "no_backend" })).toContain("no LLM backend");
    const text = formatScan({ linksProposed: 1, lessonsDrafted: 2, notCorrections: 3, failed: 0 });
    expect(text).toContain("Proposed 1 refinement link and 2 lessons.");
    expect(text).toContain("3 newer versions were updates, not corrections.");
    expect(text).toContain("flair guidance drafts");
  });

  it("formatDrafts shows what a reviewer needs", () => {
    const text = formatDrafts({ drafts: [
      { id: "lesson:a:3", kind: "lesson", status: "pending", area: "a", refinementCount: 3, trigger: "When x", content: "Do y." },
      { id: "link:r1", kind: "link", status: "pending", memoryId: "m1", refinementMemoryId: "r1", earlier: "old", later: "new", content: "missed a step" },
    ] });
    expect(text).toContain("trigger: When x");
    expect(text).toContain("earlier (m1): old");
    expect(text).toContain("why a correction: missed a step");
    expect(formatDrafts({ drafts: [] })).toBe("No drafts.");
  });
});

describe("proposes, never applies (source tripwires)", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "..", "..", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("the scan writes only drafts", () => {
    const scan = src("resources/GuidanceScan.ts");
    expect(scan).not.toMatch(/recordOutcome|Memory as any|Memory\.put|MemoryOutcome/);
    expect(scan.match(/\.put\(/g)).toHaveLength(1); // saveDraft
    expect(scan).toContain("GuidanceDraft.put(");
  });

  it("every guidance route is admin-only; review needs a rationale", () => {
    for (const f of ["GuidanceScan", "GuidanceDrafts", "GuidanceReview"]) {
      expect(src(`resources/${f}.ts`), f).toContain("allowAdmin(");
      expect(src(`resources/${f}.ts`), f).not.toContain("allowVerified(");
    }
    expect(src("resources/GuidanceReview.ts")).toContain('return json(400, { error: "rationale required" });');
  });

  it("the nightly hook runs only with admin credentials and outside dry runs", () => {
    expect(src("src/rem/runner.ts")).toMatch(/if \(!opts\.dryRun && !distillAborted && opts\.adminApiCall\) \{\n\s+try \{ await opts\.adminApiCall\("POST", "\/GuidanceScan", \{\}\);/);
  });

  it("the draft table has no REST surface and no agent grant", () => {
    expect(src("schemas/outcome.graphql").replace(/#.*$/gm, "")).not.toContain("@export");
    expect(src("src/lib/flair-agent-role.ts")).toMatch(/GuidanceDraft:\s+grant\(false, false, false, false\)/);
  });
});
