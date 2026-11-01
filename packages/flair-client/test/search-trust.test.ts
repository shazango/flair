import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Slice 2 of the outcome engine: trust evidence and abstention on the client.
// Both flags must be forwarded only when true, so a plain search sends the
// same body as before. Unit-level (mocked fetch).

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;
const CLIENT_ENV = ["FLAIR_URL", "FLAIR_AGENT_ID", "FLAIR_CLIENT", "FLAIR_ADMIN_USER", "FLAIR_ADMIN_PASSWORD"];
const savedEnv: Record<string, string | undefined> = {};

function respond(body: unknown) {
  mockFetch.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })));
}

beforeEach(() => {
  for (const key of CLIENT_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CLIENT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const { FlairClient } = await import("../src/client.js");
const lastCall = () => (mockFetch as any).mock.calls.at(-1);
const lastBody = () => JSON.parse(lastCall()[1].body);

const TRUST = {
  author: "agent-b", provenanceStatus: "verified", verifiedAuthor: "agent-b", verifiedAt: null,
  hasClaimedProvenance: false, usageCount: 2, validityStatus: "valid", validFrom: null, validTo: null,
  createdAt: null, updatedAt: null, ageDays: 3, staleDays: 3, supersedes: null, matchQuality: "strong",
};

describe("memory.search / searchDetailed", () => {
  test("a plain search sends neither includeTrust nor abstain", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    respond({ results: [] });
    await client.memory.search("q");
    const body = lastBody();
    expect(body).not.toHaveProperty("includeTrust");
    expect(body).not.toHaveProperty("abstain");
  });

  test("includeTrust and abstain are forwarded when true, and trust rides on each result", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    respond({ results: [{ id: "m1", content: "c", _score: 0.9, trust: TRUST }], abstained: false, bestScore: 0.7, threshold: 0.15 });
    const res = await client.memory.searchDetailed("q", { includeTrust: true, abstain: true });
    expect(lastBody()).toMatchObject({ includeTrust: true, abstain: true });
    expect(res.results[0].trust).toEqual(TRUST);
    expect(res).toMatchObject({ abstained: false, bestScore: 0.7, threshold: 0.15 });
  });

  test("an abstained search reports the verdict with no results", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    respond({ abstained: true, reason: "no memory above confidence threshold", bestScore: 0.08, threshold: 0.15, results: [] });
    const res = await client.memory.searchDetailed("q", { abstain: true });
    expect(res).toEqual({ results: [], abstained: true, bestScore: 0.08, threshold: 0.15 });
  });

  test("search() still returns a plain array and leaves trust off results that lack it", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    respond({ results: [{ id: "m1", content: "c", _score: 0.5 }] });
    const results = await client.memory.search("q");
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]).not.toHaveProperty("trust");
  });
});

describe("memory.get", () => {
  test("includeTrust adds the query flag; a plain get does not", async () => {
    const client = new FlairClient({ agentId: "agent-a" });
    respond({ id: "m1", content: "c", trust: TRUST });
    const mem = await client.memory.get("m1", { includeTrust: true });
    expect(String(lastCall()[0])).toEndWith("/Memory/m1?includeTrust=true");
    expect(mem?.trust).toEqual(TRUST);

    respond({ id: "m1", content: "c" });
    await client.memory.get("m1");
    expect(String(lastCall()[0])).toEndWith("/Memory/m1");
  });
});
