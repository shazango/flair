/**
 * search-trust-client-e2e.test.ts — trust evidence and abstention through the
 * production client over real HTTP (slice 2 of the outcome engine).
 *
 * Native /mcp reaches SemanticSearch and Memory.get in-process; the client,
 * the stdio adapter and the CLI reach them over HTTP, where `includeTrust` on
 * a by-id read travels as a query-string flag. This proves both HTTP shapes
 * against a real Harper: a teammate's search and by-id read carry the server's
 * trust block, a plain read carries none, and the abstention verdict is the
 * server's own (consistent with its reported bestScore and threshold).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarperInstance, startHarper, stopHarper, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

let harper: HarperInstance;
let keyDir: string;

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
  const keyPath = join(keyDir, `${agent.id}.key`);
  await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
  return new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
}

describe("trust evidence and abstention through the client (real Harper)", () => {
  const author = mkAgent(`trust-author-${randomUUID()}`);
  const reader = mkAgent(`trust-reader-${randomUUID()}`);
  const id = `trust-e2e-${randomUUID()}`;
  let authorClient: FlairClient;
  let readerClient: FlairClient;

  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-trust-e2e-keys-"));
    authorClient = await clientFor(author);
    readerClient = await clientFor(reader);
    await authorClient.memory.write("The staging database is rotated every Sunday at 02:00 UTC by the ops runbook.", {
      id, durability: "persistent",
    });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  }, HARPER_STOP_BUDGET_MS);

  test("a teammate's search carries the server's trust block when asked", async () => {
    const res = await readerClient.memory.searchDetailed("staging database rotation schedule", { includeTrust: true, limit: 10 });
    const hit = res.results.find((r) => r.id === id);
    expect(hit, `search must return ${id}`).toBeTruthy();
    expect(hit!.trust?.author).toBe(author.id);
    expect(hit!.trust?.provenanceStatus).toBe("verified");
    expect(hit!.trust?.verifiedAuthor).toBe(author.id);
    expect(hit!.trust?.validityStatus).toBe("valid");
  });

  test("a plain search carries no trust block and no verdict", async () => {
    const res = await readerClient.memory.searchDetailed("staging database rotation schedule", { limit: 10 });
    const hit = res.results.find((r) => r.id === id);
    expect(hit).toBeTruthy();
    expect(hit).not.toHaveProperty("trust");
    expect(res).not.toHaveProperty("abstained");
  });

  test("the abstention verdict is the server's, consistent with its own score and threshold", async () => {
    for (const q of ["staging database rotation schedule", "favourite sourdough hydration for a rye loaf"]) {
      const res = await readerClient.memory.searchDetailed(q, { abstain: true, limit: 10 });
      expect(typeof res.abstained).toBe("boolean");
      expect(typeof res.threshold).toBe("number");
      const expected = typeof res.bestScore === "number" && res.bestScore < res.threshold!;
      expect(res.abstained).toBe(expected);
      if (res.abstained) expect(res.results).toEqual([]);
    }
  });

  test("a by-id read carries trust only with includeTrust (query-string flag over HTTP)", async () => {
    const withTrust = await readerClient.memory.get(id, { includeTrust: true });
    expect(withTrust?.trust?.author).toBe(author.id);
    expect(withTrust?.trust?.matchQuality).toBeNull(); // no query, so no match band
    const plain = await readerClient.memory.get(id);
    expect(plain).toBeTruthy();
    expect(plain).not.toHaveProperty("trust");
  });
});
