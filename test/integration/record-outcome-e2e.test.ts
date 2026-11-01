/**
 * record-outcome-e2e.test.ts — real-Harper coverage for POST /RecordOutcome and
 * the outcomes /Ask shows (slice 4 of the outcome engine).
 *
 * Proves: validation; a refinement must be the reporter's own memory; an id
 * outside the reporter's read scope, or one that does not exist, gets the same
 * answer as a real one; the author's own confirmation and repeats do not
 * count; a refinement comes forward in /Ask only for readers who can read it;
 * and the ledger has no REST surface.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";

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

const stubDir = mkdtempSync(join(tmpdir(), "flair-outcome-stub-"));
const responseFile = join(stubDir, "generate-response.json");
const stubBackendPath = resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs");

const author = mkAgent(`outcome-author-${randomUUID()}`);
const reader = mkAgent(`outcome-reader-${randomUUID()}`);
const peer = mkAgent(`outcome-peer-${randomUUID()}`);
const memoryId = `outcome-m-${randomUUID()}`;
const authorPrivateId = `outcome-private-${randomUUID()}`;
const peerRefinementId = `outcome-ref-${randomUUID()}`;
const readerPrivateRefinementId = `outcome-ref-private-${randomUUID()}`;
const QUESTION = "how do we rotate an agent key?";
let harper: HarperInstance;
const clients = new Map<string, FlairClient>();

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

async function post(agent: TestAgent | null, path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (agent) headers.Authorization = buildEd25519Auth(agent, "POST", path);
  return fetch(`${harper.httpURL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const outcome = (agent: TestAgent, body: unknown) => post(agent, "/RecordOutcome", body);

async function askSourceFor(agent: TestAgent, id: string): Promise<{ source: any; sources: any[] }> {
  const res = await post(agent, "/Ask", { q: QUESTION, limit: 10 });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.abstained).toBe(false);
  return { source: body.sources.find((s: any) => s.id === id), sources: body.sources };
}

describe("POST /RecordOutcome (real Harper)", () => {
  beforeAll(async () => {
    writeFileSync(responseFile, JSON.stringify({ answer: "Use rotate-key [1]." }));
    harper = await startHarper({
      appendRootConfigYaml: [
        "models:",
        "  generative:",
        "    default:",
        `      backend: ${stubBackendPath}`,
        `      responseFile: ${responseFile}`,
      ].join("\n"),
    });
    for (const a of [author, reader, peer]) clients.set(a.id, await clientFor(a));
    const write = (a: TestAgent, id: string, content: string, visibility: "shared" | "private") =>
      clients.get(a.id)!.memory.write(content, { id, durability: "persistent", visibility });
    await write(author, memoryId, "To rotate an agent key, run flair agent rotate-key with the admin password.", "shared");
    await write(author, authorPrivateId, "Private: maybe rotate agent keys monthly.", "private");
    await write(peer, peerRefinementId, "After rotating an agent key, re-run flair init so MCP clients pick up the new key.", "shared");
    await write(reader, readerPrivateRefinementId, "My private note: rotating keys also needs the backup refreshed.", "private");
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    rmSync(stubDir, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  test("validates the request", async () => {
    expect([401, 403]).toContain((await post(null, "/RecordOutcome", { memoryId, kind: "confirmed" })).status);
    expect((await outcome(reader, { kind: "confirmed" })).status).toBe(400);
    expect((await outcome(reader, { memoryId, kind: "wrong" })).status).toBe(400);
    expect((await outcome(reader, { memoryId, kind: "refined" })).status).toBe(400);
  });

  test("a refinement must be another memory the reporter wrote", async () => {
    expect((await outcome(reader, { memoryId, kind: "refined", refinementMemoryId: peerRefinementId })).status).toBe(400);
    expect((await outcome(reader, { memoryId, kind: "refined", refinementMemoryId: "no-such-memory" })).status).toBe(400);
    expect((await outcome(author, { memoryId, kind: "refined", refinementMemoryId: memoryId })).status).toBe(400);
  });

  test("an id outside the reader's scope, or one that does not exist, looks like any other", async () => {
    for (const id of [authorPrivateId, "no-such-memory", memoryId]) {
      const res = await outcome(reader, { memoryId: id, kind: "confirmed" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true });
    }
  });

  test("confirmations count other agents once each, never the author", async () => {
    await outcome(author, { memoryId, kind: "confirmed" });
    await outcome(peer, { memoryId, kind: "confirmed" });
    await outcome(peer, { memoryId, kind: "confirmed" });
    const { source } = await askSourceFor(reader, memoryId);
    expect(source, "ask must return the memory").toBeTruthy();
    expect(source.confirmedBy).toBe(2); // reader (previous test) + peer
  });

  test("a refinement comes forward only for readers who can read it", async () => {
    expect((await outcome(peer, { memoryId, kind: "refined", refinementMemoryId: peerRefinementId })).status).toBe(200);
    expect((await outcome(reader, { memoryId, kind: "refined", refinementMemoryId: readerPrivateRefinementId })).status).toBe(200);

    const asReader = await askSourceFor(reader, memoryId);
    const nOf = (sources: any[], id: string) => sources.find((s) => s.id === id)?.n;
    expect(asReader.source.refinedBy).toEqual([nOf(asReader.sources, peerRefinementId), nOf(asReader.sources, readerPrivateRefinementId)]);

    const asPeer = await askSourceFor(peer, memoryId);
    expect(asPeer.source.refinedBy).toEqual([nOf(asPeer.sources, peerRefinementId)]);
    expect(asPeer.sources.map((s: any) => s.id)).not.toContain(readerPrivateRefinementId);
    // The refined memory keeps its standing: still returned, still confirmed.
    expect(asPeer.source.confirmedBy).toBe(2);
  });

  test("the ledger has no REST read", async () => {
    const res = await fetch(`${harper.httpURL}/MemoryOutcome/`, { headers: { Authorization: buildEd25519Auth(reader, "GET", "/MemoryOutcome/") } });
    expect(res.status).toBe(404);
  });
});
