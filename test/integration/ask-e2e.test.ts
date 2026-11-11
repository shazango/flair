/**
 * ask-e2e.test.ts — real-Harper coverage for POST /Ask (`ask`, slice 3 of the
 * outcome engine).
 *
 * Memories are written through the production client (so they are embedded
 * like any real write); the deterministic stub generative backend
 * (test/fixtures/stub-generative-backend.mjs) answers every generate() call
 * with a fixed file. The "model" cites a source that exists and one that does
 * not, so the response proves the citation filter; the sources prove /Ask
 * searched with the caller's own read scope and attached the trust block.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import { getModelId } from "../../resources/embeddings-provider.ts";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function buildEd25519Auth(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

const stubDir = mkdtempSync(join(tmpdir(), "flair-ask-stub-"));
const responseFile = join(stubDir, "generate-response.json");
const stubBackendPath = resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs");
const setModelResponse = (body: string) => writeFileSync(responseFile, body);

const author = mkAgent(`ask-author-${randomUUID()}`);
const reader = mkAgent(`ask-reader-${randomUUID()}`);
const sharedId = `ask-shared-${randomUUID()}`;
const privateId = `ask-private-${randomUUID()}`;
const QUESTION = "how often is the staging database rotated?";
let harper: HarperInstance;

async function clientFor(agent: TestAgent): Promise<FlairClient> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    }),
  });
  expect(res.status).toBe(200);
  const keyPath = join(stubDir, `${agent.id}.key`);
  writeFileSync(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
  return new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
}

async function ask(agent: TestAgent | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (agent) headers.Authorization = buildEd25519Auth(agent, "POST", "/Ask");
  return fetch(`${harper.httpURL}/Ask`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /Ask (real Harper)", () => {
  beforeAll(async () => {
    setModelResponse("{}");
    harper = await startHarper({
      appendRootConfigYaml: [
        "models:",
        "  generative:",
        "    default:",
        `      backend: ${stubBackendPath}`,
        `      responseFile: ${responseFile}`,
      ].join("\n"),
    });
    const authorClient = await clientFor(author);
    await clientFor(reader);
    await authorClient.memory.write("The staging database is rotated every Sunday at 02:00 UTC by the ops runbook.", {
      id: sharedId, durability: "persistent", visibility: "shared",
    });
    await authorClient.memory.write("Private draft: the staging database rotation might move to Saturdays.", {
      id: privateId, durability: "persistent", visibility: "private",
    });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    rmSync(stubDir, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  test("anonymous callers are refused, and a question is required", async () => {
    expect([401, 403]).toContain((await ask(null, { q: QUESTION })).status);
    expect((await ask(reader, {})).status).toBe(400);
  });

  test("a non-admin cannot ask from another agent's read scope", async () => {
    expect((await ask(reader, { q: QUESTION, agentId: author.id })).status).toBe(403);
  });

  test("the answer cites only supplied sources, which carry trust and respect read scope", async () => {
    setModelResponse(JSON.stringify({ answer: "Every Sunday at 02:00 UTC [1], per a source that does not exist [9]." }));
    const res = await ask(reader, { q: QUESTION });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.abstained).toBe(false);
    const ids = body.sources.map((s: any) => s.id);
    expect(ids).toContain(sharedId);
    expect(ids).not.toContain(privateId);
    expect(body.sources[0].n).toBe(1);
    const shared = body.sources.find((s: any) => s.id === sharedId);
    expect(shared.trust?.verifiedAuthor).toBe(author.id);
    expect(body.answer).toBe("Every Sunday at 02:00 UTC [1], per a source that does not exist .");
    expect(body.citations).toEqual([1]);
  });

  test("model output that never validates still returns the sources", async () => {
    setModelResponse("not json at all");
    const res = await ask(reader, { q: QUESTION });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBeNull();
    expect(body.answerUnavailable).toBe("validation_failed");
    expect(body.sources.map((s: any) => s.id)).toContain(sharedId);
  });

  test("an abstaining search returns in-scope closest matches only when asked", async () => {
    // Seeded vectors, so abstention needs no embedding model: the query is orthogonal to both rows.
    const nearId = `ask-near-${randomUUID()}`;
    const nearPrivateId = `ask-near-private-${randomUUID()}`;
    const row = (id: string, visibility: string) => ({
      id, agentId: author.id, content: "A seeded note about descaling the kettle.", embedding: [1, 0, 0, 0],
      embeddingModel: getModelId(), durability: "standard", visibility, createdAt: new Date().toISOString(),
    });
    const seeded = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
      body: JSON.stringify({ operation: "insert", database: "flair", table: "Memory", records: [row(nearId, "shared"), row(nearPrivateId, "private")] }),
    });
    expect(seeded.status).toBe(200);

    const search = async (extra: object) => {
      const res = await fetch(`${harper.httpURL}/SemanticSearch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: buildEd25519Auth(reader, "POST", "/SemanticSearch") },
        body: JSON.stringify({ queryEmbedding: [0, 1, 0, 0], abstain: true, ...extra }),
      });
      expect(res.status).toBe(200);
      return res.json();
    };
    // The embedding-space guard answers "not yet verified" until its scan completes.
    let plain = await search({});
    for (let i = 0; i < 60 && !plain.abstained; i++) {
      await new Promise((r) => setTimeout(r, 500));
      plain = await search({});
    }
    expect(plain.abstained).toBe(true);
    expect(plain).not.toHaveProperty("closest");

    const withClosest = await search({ includeClosest: true });
    expect(withClosest.abstained).toBe(true);
    expect(withClosest.results).toEqual([]);
    const ids = withClosest.closest.map((m: any) => m.id);
    expect(ids).toContain(nearId);
    expect(ids).not.toContain(nearPrivateId);
    const near = withClosest.closest.find((m: any) => m.id === nearId);
    expect(near.trust.matchQuality).toBe("breadcrumb");
    expect(near).not.toHaveProperty("_semSimilarity");
    expect(near).not.toHaveProperty("embedding");
  }, 60_000);

  describe("GET /AdminAsk", () => {
    const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
    const page = (query: string, headers: Record<string, string> = { Authorization: basic() }) =>
      fetch(`${harper.httpURL}/AdminAsk${query ? `?${query}` : ""}`, { headers });
    const asReader = `q=${encodeURIComponent(QUESTION)}&agent=${encodeURIComponent(reader.id)}`;

    test("is admin-only", async () => {
      expect((await page("", {})).status).toBe(401);
      expect((await page("", { Authorization: buildEd25519Auth(reader, "GET", "/AdminAsk") })).status).toBe(403);
    });

    test("renders the form and runs nothing without a question", async () => {
      const res = await page("");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<option value="${reader.id}"`);
      expect(html).not.toContain("Sources");
    });

    test("answers from the chosen agent's read scope, escaping model and user text", async () => {
      setModelResponse(JSON.stringify({ answer: "Sundays [1] <img src=x onerror=alert(1)>" }));
      const res = await page(asReader);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sundays [1] &lt;img src=x");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain(sharedId);
      expect(html).not.toContain(privateId);
      expect(html).toContain(`verified author ${author.id}`);
      expect(html).toContain("cited");

      const reflected = await (await page(`q=${encodeURIComponent('"><script>alert(1)</script>')}&agent=${encodeURIComponent(reader.id)}`)).text();
      expect(reflected).not.toContain("<script>alert(1)");
    });

    test("needs a known agent, and a cross-site request runs nothing", async () => {
      setModelResponse("not json at all");
      expect(await (await page("q=hello&agent=nobody")).text()).toContain("Choose an agent");
      const crossSite = await (await page(asReader, { Authorization: basic(), "Sec-Fetch-Site": "cross-site" })).text();
      expect(crossSite).toContain("hasn't been run");
      expect(crossSite).not.toContain("No answer written");
      const sameOrigin = await (await page(asReader, { Authorization: basic(), "Sec-Fetch-Site": "same-origin" })).text();
      expect(sameOrigin).toContain("No answer written");
    });

    test("names neither a refinement's author nor the refined memory's", async () => {
      const refinementId = `ask-refinement-${randomUUID()}`;
      const readerClient = new FlairClient({ agentId: reader.id, url: harper.httpURL, keyPath: join(stubDir, `${reader.id}.key`) });
      await readerClient.memory.write("The staging database rotation also needs a cache flush afterwards.", {
        id: refinementId, durability: "persistent", visibility: "shared",
      });
      const recorded = await fetch(`${harper.httpURL}/RecordOutcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: buildEd25519Auth(reader, "POST", "/RecordOutcome") },
        body: JSON.stringify({ memoryId: sharedId, kind: "refined", refinementMemoryId: refinementId }),
      });
      expect(recorded.status).toBe(200);
      setModelResponse(JSON.stringify({ answer: "Sundays [1]." }));
      const html = await (await page(asReader)).text();
      expect(html).toContain(refinementId);
      expect(html).toContain("refined: see");
      expect(html).not.toContain(`verified author ${reader.id}`);
      expect(html).not.toContain(`verified author ${author.id}`);
    });
  });
});
