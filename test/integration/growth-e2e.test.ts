/**
 * growth-e2e.test.ts — real-Harper coverage for POST /Growth and
 * POST /GuidanceAreas (slice 5a of the outcome engine).
 *
 * Proves: auth (anonymous refused, growth is self-or-operator, areas are
 * operator-only); growth counts others' confirmations and the areas the agent's
 * memories were refined in, with readable guidance; the operator view counts by
 * area and names no agent; neither route has a REST read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

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

const author = mkAgent(`growth-author-${randomUUID()}`);
const peer = mkAgent(`growth-peer-${randomUUID()}`);
const reader = mkAgent(`growth-reader-${randomUUID()}`);
const memoryId = `growth-m-${randomUUID()}`;
const refinementId = `growth-ref-${randomUUID()}`;
const skillId = `growth-skill-${randomUUID()}`;
const AREA = "agent key rotation";
let harper: HarperInstance;

const adminAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function request(agent: TestAgent | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (agent) headers.Authorization = buildEd25519Auth(agent, method, path);
  return fetch(`${harper.httpURL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function admin(path: string, body: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: adminAuth() }, body: JSON.stringify(body) });
}

async function writeMemory(agent: TestAgent, id: string, fields: Record<string, unknown>): Promise<void> {
  const res = await request(agent, "PUT", `/Memory/${id}`, {
    id, agentId: agent.id, durability: "persistent", visibility: "shared", createdAt: new Date().toISOString(), ...fields,
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
}

describe("POST /Growth and POST /GuidanceAreas (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    for (const a of [author, peer, reader]) {
      const res = await fetch(harper.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: adminAuth() },
        body: JSON.stringify({
          operation: "insert", database: "flair", table: "Agent",
          records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
        }),
      });
      expect(res.status).toBe(200);
    }
    await writeMemory(author, memoryId, { content: "To rotate an agent key, run flair agent rotate-key.", subject: AREA });
    await writeMemory(peer, refinementId, { content: "After rotating a key, re-run flair init so MCP clients pick it up." });
    await writeMemory(peer, skillId, {
      content: "When rotating an agent key, also re-run client wiring; the old key is pinned in MCP config.",
      trigger: "when rotating an agent key", tags: ["skill"], subject: AREA,
    });
    expect((await request(peer, "POST", "/RecordOutcome", { memoryId, kind: "refined", refinementMemoryId: refinementId })).status).toBe(200);
    expect((await request(reader, "POST", "/RecordOutcome", { memoryId, kind: "confirmed" })).status).toBe(200);
    expect((await request(author, "POST", "/RecordOutcome", { memoryId, kind: "confirmed" })).status).toBe(200);
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, HARPER_STOP_BUDGET_MS);

  test("auth: anonymous refused, growth is self or operator, areas are operator-only", async () => {
    expect([401, 403]).toContain((await request(null, "POST", "/Growth", {})).status);
    expect((await request(reader, "POST", "/Growth", { agentId: author.id })).status).toBe(403);
    expect([401, 403]).toContain((await request(null, "POST", "/GuidanceAreas", {})).status);
    expect((await request(author, "POST", "/GuidanceAreas", {})).status).toBe(403);
  });

  test("growth counts others' confirmations and refined areas with guidance", async () => {
    const res = await request(author, "POST", "/Growth", {});
    expect(res.status).toBe(200);
    const g = await res.json();
    expect(g.agentId).toBe(author.id);
    expect(g.steady.confirmations).toBe(1); // reader; the author's own does not count
    expect(g.steady.memoriesConfirmed).toBe(1);
    expect(g.refinedAreas).toEqual([{ area: AREA, refinements: 1, guidance: [skillId] }]);
    expect(JSON.stringify(g)).not.toContain(peer.id);
    expect(JSON.stringify(g)).not.toContain(reader.id);

    const asPeer = await (await request(peer, "POST", "/Growth", {})).json();
    expect(asPeer.refinementsGiven).toBe(1);
  });

  test("an operator can read any agent's growth", async () => {
    const res = await admin("/Growth", { agentId: author.id });
    expect(res.status).toBe(200);
    expect((await res.json()).steady.confirmations).toBe(1);
  });

  test("the operator view counts by area and names no agent", async () => {
    const res = await admin("/GuidanceAreas", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.areas).toEqual([{ area: AREA, refinements: 1, memoriesRefined: 1, guidance: 1 }]);
    for (const a of [author, peer, reader]) expect(JSON.stringify(body)).not.toContain(a.id);
  });

  test("neither route has a REST read", async () => {
    for (const path of ["/Growth/", "/GuidanceAreas/"]) {
      const res = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: buildEd25519Auth(reader, "GET", path) } });
      expect(res.status, path).toBe(404);
    }
  });
});
