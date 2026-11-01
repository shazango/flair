/**
 * outcome.test.ts — the stdio `record_outcome` tool (slice 4 of the outcome
 * engine): what it sends to POST /RecordOutcome and what it says back.
 */
import { describe, expect, test } from "bun:test";
import { STDIO_TOOL_HANDLERS } from "../src/adapter-tools.ts";

function ctx(reply: unknown = { recorded: true }) {
  const calls: Array<[string, string, unknown]> = [];
  const flair = { url: "http://flair.invalid", agentId: "agent-a", request: async (m: string, p: string, b: unknown) => { calls.push([m, p, b]); return reply; } } as any;
  return { calls, c: { flair, agentId: "agent-a", heartbeat: () => {}, rememberTask: () => {} } as any };
}

describe("record_outcome (stdio)", () => {
  test("a confirmation sends only memoryId and kind", async () => {
    const { calls, c } = ctx();
    const res: any = await STDIO_TOOL_HANDLERS.record_outcome({ memoryId: "m1", kind: "confirmed", refinementMemoryId: "ignored" }, c);
    expect(calls).toEqual([["POST", "/RecordOutcome", { memoryId: "m1", kind: "confirmed" }]]);
    expect(res.content[0].text).toBe("Recorded that it held up.");
    expect(res.structuredContent).toEqual({ recorded: true });
  });

  test("a refinement forwards its refinementMemoryId", async () => {
    const { calls, c } = ctx();
    const res: any = await STDIO_TOOL_HANDLERS.record_outcome({ memoryId: "m1", kind: "refined", refinementMemoryId: "m2" }, c);
    expect(calls[0][2]).toEqual({ memoryId: "m1", kind: "refined", refinementMemoryId: "m2" });
    expect(res.content[0].text).toContain("alongside the original");
  });
});
