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
});
