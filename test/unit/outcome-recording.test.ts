/**
 * outcome-recording.test.ts — the pure summary behind confirmations and
 * refinements (slice 4 of the outcome engine), plus source tripwires for the
 * growth-not-blame rules. The ledger writes and reads are covered against real
 * Harper in test/integration/record-outcome-e2e.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeOutcomes } from "../../resources/outcome-recording";

describe("summarizeOutcomes", () => {
  it("counts distinct confirmers other than the author", () => {
    const rows = [
      { agentId: "author", memoryId: "m", kind: "confirmed" },
      { agentId: "b", memoryId: "m", kind: "confirmed" },
      { agentId: "c", memoryId: "m", kind: "confirmed" },
      { agentId: "c", memoryId: "m", kind: "confirmed" },
    ];
    expect(summarizeOutcomes(rows, "author").confirmedBy).toBe(2);
  });

  it("lists each refinement once, in report order; a refinement does not reduce confirmations", () => {
    const rows = [
      { agentId: "b", memoryId: "m", kind: "refined", refinementMemoryId: "r1" },
      { agentId: "c", memoryId: "m", kind: "confirmed" },
      { agentId: "d", memoryId: "m", kind: "refined", refinementMemoryId: "r2" },
      { agentId: "e", memoryId: "m", kind: "refined", refinementMemoryId: "r1" },
    ];
    expect(summarizeOutcomes(rows, "author")).toEqual({ confirmedBy: 1, refinementIds: ["r1", "r2"] });
  });
});

describe("growth, not blame (source tripwires)", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "..", "..", f), "utf8");

  it("outcomes never feed scoring, read scope or authority", () => {
    for (const f of ["resources/scoring.ts", "resources/memory-read-scope.ts", "resources/agent-auth.ts", "resources/trust-block.ts", "resources/SemanticSearch.ts"]) {
      expect(src(f), f).not.toMatch(/outcome-recording|MemoryOutcome/);
    }
  });

  it("the ledger has no REST surface and no agent grant", () => {
    expect(src("schemas/outcome.graphql").replace(/#.*$/gm, "")).not.toContain("@export");
    expect(src("src/lib/flair-agent-role.ts")).toMatch(/MemoryOutcome:\s+grant\(false, false, false, false\)/);
  });
});
