/**
 * recall-probes-e2e.test.ts — real-Harper coverage for POST /RecallProbes
 * (recall checks, slice 1 of the outcome engine).
 *
 * The deterministic stub generative backend (test/fixtures/stub-generative-
 * backend.mjs) answers every generate() call with a fixed file. Each test
 * writes a "model" response that cites EVERY seeded memory plus an id that
 * does not exist, so the response proves which memories the endpoint actually
 * offered the model: only rows in the caller's read scope that default search
 * could return (not archived, superseded, skill, too short, past validTo or
 * TTL-expired, nor another agent's private row).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

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

const stubDir = mkdtempSync(join(tmpdir(), "flair-recall-probes-stub-"));
const responseFile = join(stubDir, "generate-response.json");
const stubBackendPath = resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs");

const caller = mkAgent("recall-probe-caller");
const teammate = mkAgent("recall-probe-teammate");
const LONG = "a memory long enough to write a distinct test question about, with some detail";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// id → [owner, extra fields]. Only SHARED_OK and SUCCESSOR are eligible.
const ROWS: Record<string, [TestAgent, Record<string, unknown>]> = {
  "rp-shared-ok": [teammate, { visibility: "shared" }],
  "rp-teammate-private": [teammate, { visibility: "private" }],
  "rp-archived": [caller, { archived: true }],
  "rp-superseded": [caller, {}],
  "rp-successor": [caller, { supersedes: "rp-superseded" }],
  "rp-skill": [caller, { tags: ["skill"] }],
  "rp-too-short": [caller, { content: "too short" }],
  "rp-valid-to-past": [caller, { validTo: hoursAgo(1) }],
  "rp-expired": [caller, { expiresAt: hoursAgo(1) }],
};

function setModelResponse(body: string): void {
  writeFileSync(responseFile, body);
}

function citeEverything(decoys: string[]): string {
  const probes = [...Object.keys(ROWS), "rp-does-not-exist"].map((memoryId) => ({
    memoryId,
    question: `What does the team know about ${memoryId}?`,
  }));
  return JSON.stringify({ probes, decoys });
}

let harper: HarperInstance;

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64"),
    },
    body: JSON.stringify(op),
  });
}

async function probe(agent: TestAgent | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (agent) headers.Authorization = buildEd25519Auth(agent, "POST", "/RecallProbes");
  return fetch(`${harper.httpURL}/RecallProbes`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /RecallProbes (real Harper)", () => {
  beforeAll(async () => {
    setModelResponse(citeEverything([]));
    harper = await startHarper({
      appendRootConfigYaml: [
        "models:",
        "  generative:",
        "    default:",
        `      backend: ${stubBackendPath}`,
        `      responseFile: ${responseFile}`,
      ].join("\n"),
    });
    for (const a of [caller, teammate]) {
      const res = await adminOp({
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
      });
      expect(res.status).toBe(200);
    }
    const now = new Date().toISOString();
    const res = await adminOp({
      operation: "insert", database: "flair", table: "Memory",
      records: Object.entries(ROWS).map(([id, [owner, extra]]) => ({
        id, agentId: owner.id, content: LONG, durability: "persistent", createdAt: now, ...extra,
      })),
    });
    expect(res.status).toBe(200);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    rmSync(stubDir, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  test("anonymous callers are refused", async () => {
    const res = await probe(null, {});
    expect([401, 403]).toContain(res.status);
  });

  test("a non-admin cannot sample another agent's read scope", async () => {
    const res = await probe(caller, { agentId: teammate.id });
    expect(res.status).toBe(403);
  });

  test("only eligible memories in the caller's read scope reach the model", async () => {
    setModelResponse(citeEverything(["Which espresso machine is in the kitchen?", "Who runs payroll this month?", "Where is the offsite?"]));
    const res = await probe(caller, { count: 50, decoys: 2 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.probes.map((p: any) => p.memoryId).sort()).toEqual(["rp-shared-ok", "rp-successor"]);
    expect(body.eligible).toBe(2);
    expect(body.decoys).toHaveLength(2); // capped at the request's decoy count
  });

  test("excludeMemoryIds skips memories that already have a probe", async () => {
    setModelResponse(citeEverything([]));
    const res = await probe(caller, { count: 50, decoys: 0, excludeMemoryIds: ["rp-shared-ok"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.probes.map((p: any) => p.memoryId)).toEqual(["rp-successor"]);
    expect(body.eligible).toBe(1);
  });

  test("model output that never validates is a 502, and nothing is written", async () => {
    const countMemories = async () => (await (await adminOp({ operation: "sql", sql: "SELECT id FROM flair.Memory" })).json()).length;
    const before = await countMemories();
    setModelResponse("not json at all");
    const res = await probe(caller, { count: 50, decoys: 0 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("probe_generation_failed");
    expect(await countMemories()).toBe(before);
  });
});
