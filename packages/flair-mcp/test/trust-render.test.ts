/**
 * trust-render.test.ts — trust evidence and abstention on the stdio adapter
 * (slice 2 of the outcome engine).
 *
 * memory_search / memory_get now advertise the flags native /mcp already had,
 * and render the server's evidence as one line per result. With no flags the
 * request and the reply are unchanged.
 */
import { describe, expect, test } from "bun:test";
import { STDIO_TOOL_HANDLERS } from "../src/adapter-tools.ts";
import { formatAbstention, formatTrustLine } from "../src/trust.ts";
import { STDIO_TOOL_DESCRIPTORS, toStdioMcpToolDef } from "../src/tool-descriptors/index.js";

const TRUST: any = {
  author: "agent-b", provenanceStatus: "verified", verifiedAuthor: "agent-b", verifiedAt: null,
  hasClaimedProvenance: false, usageCount: 3, validityStatus: "valid", validFrom: null, validTo: null,
  createdAt: null, updatedAt: null, ageDays: 12, staleDays: 2, supersedes: "m0", matchQuality: "strong",
};

function ctxWith(memory: Record<string, unknown>) {
  return { flair: { url: "http://flair.invalid", memory } as any, agentId: "agent-a", heartbeat: () => {}, rememberTask: () => {} };
}

describe("formatTrustLine", () => {
  test("renders the evidence in one line", () => {
    expect(formatTrustLine(TRUST)).toBe("trust: strong match · verified author agent-b · used 3× · 12d old, updated 2d ago · replaces m0");
  });
  test("handles a sparse block", () => {
    const sparse = { ...TRUST, provenanceStatus: "unattributed", verifiedAuthor: null, usageCount: null, ageDays: null, supersedes: null, matchQuality: null, validityStatus: "expired", validTo: "2026-09-01T00:00:00Z" };
    expect(formatTrustLine(sparse)).toBe("trust: author unattributed · no longer valid since 2026-09-01");
  });
});

describe("formatAbstention", () => {
  test("states the best score and the threshold", () => {
    expect(formatAbstention({ results: [], abstained: true, bestScore: 0.08, threshold: 0.15 }))
      .toBe("No memory covers this confidently (best match 0.08, below the 0.15 confidence threshold). Treat it as unknown rather than guessing.");
  });
});

describe("memory_search handler", () => {
  test("no flags: forwards neither and prints no trust line", async () => {
    let seen: any;
    const memory = { searchDetailed: async (_q: string, opts: any) => { seen = opts; return { results: [{ id: "m1", content: "hello", score: 1, trust: undefined }] }; } };
    const res = await STDIO_TOOL_HANDLERS.memory_search({ query: "q" }, ctxWith(memory) as any);
    expect(seen.includeTrust).toBeUndefined();
    expect(seen.abstain).toBeUndefined();
    expect(res.content[0].text).not.toContain("trust:");
  });

  test("includeTrust: each result gets its trust line", async () => {
    const memory = { searchDetailed: async () => ({ results: [{ id: "m1", content: "hello", score: 1, trust: TRUST }] }) };
    const res = await STDIO_TOOL_HANDLERS.memory_search({ query: "q", includeTrust: true }, ctxWith(memory) as any);
    expect(res.content[0].text).toContain(`1. hello (id:m1)\n   ${formatTrustLine(TRUST)}`);
  });

  test("abstain: an abstained search says so instead of 'No relevant memories found'", async () => {
    const memory = { searchDetailed: async () => ({ results: [], abstained: true, bestScore: 0.08, threshold: 0.15 }) };
    const res = await STDIO_TOOL_HANDLERS.memory_search({ query: "q", abstain: true }, ctxWith(memory) as any);
    expect(res.content[0].text).toStartWith("No memory covers this confidently");
  });
});

describe("memory_get handler", () => {
  test("includeTrust is forwarded and rendered; a plain get passes no flag", async () => {
    const calls: any[] = [];
    const memory = { get: async (_id: string, opts: any) => { calls.push(opts); return { content: "c", type: "fact", durability: "standard", createdAt: "t", ...(opts.includeTrust ? { trust: TRUST } : {}) }; } };
    const withTrust = await STDIO_TOOL_HANDLERS.memory_get({ id: "m1", includeTrust: true }, ctxWith(memory) as any);
    expect(withTrust.content[0].text).toEndWith(formatTrustLine(TRUST));
    const plain = await STDIO_TOOL_HANDLERS.memory_get({ id: "m1" }, ctxWith(memory) as any);
    expect(plain.content[0].text).not.toContain("trust:");
    expect(calls).toEqual([{ includeTrust: true }, {}]);
  });
});

describe("stdio schemas advertise the trust flags", () => {
  const props = (name: string) => toStdioMcpToolDef(STDIO_TOOL_DESCRIPTORS.find((d) => d.name === name)!).inputSchema.properties;
  test("memory_search: includeTrust and abstain (includeArchived stays native-only)", () => {
    expect(props("memory_search")).toHaveProperty("includeTrust");
    expect(props("memory_search")).toHaveProperty("abstain");
    expect(props("memory_search")).not.toHaveProperty("includeArchived");
  });
  test("memory_get: includeTrust (includeEmbedding stays native-only)", () => {
    expect(props("memory_get")).toHaveProperty("includeTrust");
    expect(props("memory_get")).not.toHaveProperty("includeEmbedding");
  });
});
