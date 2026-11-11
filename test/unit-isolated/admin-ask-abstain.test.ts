/**
 * The abstaining path through /AdminAsk and POST /Ask, with search mocked:
 * a real abstention needs a live embedding model (ask-e2e covers the search side).
 */
import { describe, expect, it, mock } from "bun:test";

class FakeResource {
  constructor(_id: unknown, private ctx: unknown) {}
  getContext() { return this.ctx; }
}
let generated = 0;
mock.module("harper", () => ({
  Resource: FakeResource,
  databases: { flair: { Agent: { search: async function* () { yield { id: "bot" }; } } } },
}));
mock.module("../../resources/agent-auth.js", () => ({
  resolveAgentAuth: async () => ({ kind: "agent", agentId: "admin", isAdmin: true }),
  allowVerified: () => true,
  allowAdmin: () => true,
}));
mock.module("../../resources/rate-limiter.js", () => ({ checkRateLimit: () => ({ allowed: true }), rateLimitResponse: () => null }));
mock.module("../../resources/memory-reflect-models.js", () => ({ reflectModelsGenerate: async () => { generated++; return null; } }));
mock.module("../../resources/outcome-recording.js", () => ({ attachConfirmations: async () => {}, refinementsFor: async () => new Map() }));
mock.module("../../resources/SemanticSearch.js", () => ({
  SemanticSearch: class {
    async post(body: any) {
      expect(body.includeClosest).toBe(true);
      return {
        abstained: true, bestScore: 0.08, threshold: 0.15, results: [],
        closest: [{ id: "m/1", content: "Near <b>miss</b>", createdAt: "2026-01-02T00:00:00Z", trust: { matchQuality: "breadcrumb" }, embedding: [1] }],
      };
    }
  },
}));

const { AdminAsk } = await import("../../resources/AdminAsk.ts");

describe("AdminAsk when ask abstains", () => {
  it("shows the closest memories apart from any answer, without calling the model", async () => {
    const ctx = { request: { url: "/AdminAsk?q=anything&agent=bot", headers: { get: () => null } } };
    const res: Response = await new (AdminAsk as any)(undefined, ctx).get();
    const html = await res.text();
    expect(html).toContain("No memory covers this confidently (best match 0.08, below the 0.15 confidence threshold).");
    expect(html).toContain("Closest memories");
    expect(html).toContain("Not an answer.");
    expect(html).toContain("Near &lt;b&gt;miss&lt;/b&gt;");
    expect(html).toContain("breadcrumb match");
    expect(html).toContain('href="/AdminMemory?id=m%2F1"');
    expect(html).not.toContain("Sources");
    expect(generated).toBe(0);
  });
});
