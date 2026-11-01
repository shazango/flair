/**
 * guidance-scan-e2e.test.ts — real-Harper coverage for the guidance scan and its
 * review queue (slice 5b of the outcome engine): POST /GuidanceScan,
 * POST /GuidanceDrafts, POST /GuidanceReview, with the stub generative backend.
 *
 * Proves: all three routes are operator-only; a scan proposes a refinement link
 * for a correcting successor and a lesson for a refined area, and applies
 * neither; a second scan does not repeat them; review needs a rationale;
 * promoting a lesson writes a shared skill that then counts as guidance;
 * promoting a link records the refinement; a rejected draft is kept.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const stubDir = mkdtempSync(join(tmpdir(), "flair-guidance-stub-"));
const responseFile = join(stubDir, "generate-response.json");
const stubBackendPath = resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs");

const AREA = "agent key rotation";
const agents = ["a1", "a2", "a3"].map((n) => mkAgent(`guidance-${n}-${randomUUID()}`));
const fixer = mkAgent(`guidance-fixer-${randomUUID()}`);
const ops = mkAgent(`guidance-ops-${randomUUID()}`);
const run = randomUUID();
const chains = [0, 1].map((i) => ({ earlier: `guidance-v1-${i}-${run}`, later: `guidance-v2-${i}-${run}` }));
let harper: HarperInstance;

const adminAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function request(agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: buildEd25519Auth(agent, method, path) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function admin(path: string, body: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: adminAuth() }, body: JSON.stringify(body) });
}

const adminJson = async (path: string, body: unknown) => {
  const res = await admin(path, body);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};

async function writeMemory(agent: TestAgent, id: string, fields: Record<string, unknown>): Promise<void> {
  const res = await request(agent, "PUT", `/Memory/${id}`, {
    id, agentId: agent.id, durability: "persistent", visibility: "shared", createdAt: new Date().toISOString(), ...fields,
  });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
}

describe("guidance scan and review (real Harper)", () => {
  beforeAll(async () => {
    writeFileSync(responseFile, JSON.stringify({
      verdict: "corrects", reason: "The earlier version left out a step.",
      trigger: "When rotating an agent key", lesson: "After rotating a key, re-run client wiring so MCP clients use the new key.",
    }));
    harper = await startHarper({
      appendRootConfigYaml: ["models:", "  generative:", "    default:", `      backend: ${stubBackendPath}`, `      responseFile: ${responseFile}`].join("\n"),
    });
    for (const a of [...agents, fixer, ops]) {
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
    for (const [i, a] of agents.entries()) {
      await writeMemory(a, `guidance-m${i}-${run}`, { content: `To rotate an agent key, run rotate-key (${i}).`, subject: AREA });
      await writeMemory(fixer, `guidance-r${i}-${run}`, { content: `After rotate-key, re-run flair init (${i}).` });
      const res = await request(fixer, "POST", "/RecordOutcome", { memoryId: `guidance-m${i}-${run}`, kind: "refined", refinementMemoryId: `guidance-r${i}-${run}` });
      expect(res.status).toBe(200);
    }
    for (const [i, c] of chains.entries()) {
      await writeMemory(agents[0], c.earlier, { content: `Backups run weekly (${i}).` });
      await writeMemory(agents[0], c.later, { content: `Backups run weekly and must be verified after each run (${i}).`, supersedes: c.earlier });
    }
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    rmSync(stubDir, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  test("every route is operator-only", async () => {
    for (const path of ["/GuidanceScan", "/GuidanceDrafts", "/GuidanceReview"]) {
      expect((await request(agents[0], "POST", path, {})).status, path).toBe(403);
    }
  });

  test("a scan proposes a link and a lesson, applies neither, and does not repeat", async () => {
    const before = await adminJson("/GuidanceAreas", {});
    expect(await adminJson("/GuidanceScan", {})).toEqual({ linksProposed: 2, notCorrections: 0, lessonsDrafted: 1, failed: 0 });
    expect(await adminJson("/GuidanceAreas", {})).toEqual({ ...before, computedAt: expect.any(String) });
    expect(await adminJson("/GuidanceScan", {})).toEqual({ linksProposed: 0, notCorrections: 0, lessonsDrafted: 0, failed: 0 });

    const { drafts } = await adminJson("/GuidanceDrafts", {});
    expect(drafts.map((d: any) => d.kind).sort()).toEqual(["lesson", "link", "link"]);
    const link = drafts.find((d: any) => d.id === `link:${chains[0].later}`);
    expect(link).toMatchObject({ status: "pending", memoryId: chains[0].earlier, earlier: "Backups run weekly (0)." });
    const lesson = drafts.find((d: any) => d.kind === "lesson");
    expect(lesson).toMatchObject({ area: AREA, refinementCount: 3, trigger: "When rotating an agent key" });
    for (const a of [...agents, fixer]) expect(JSON.stringify(drafts)).not.toContain(a.id);
  });

  test("review needs a rationale, and a lesson needs a publisher", async () => {
    const lessonId = `lesson:${AREA}:3`;
    expect((await admin("/GuidanceReview", { draftId: lessonId, decision: "promote" })).status).toBe(400);
    expect((await admin("/GuidanceReview", { draftId: lessonId, decision: "promote", rationale: "useful" })).status).toBe(400);
    expect((await admin("/GuidanceReview", { draftId: "lesson:nope", decision: "promote", rationale: "x" })).status).toBe(404);
  });

  test("promoting a lesson writes a shared skill that counts as guidance", async () => {
    const lessonId = `lesson:${AREA}:3`;
    const r = await adminJson("/GuidanceReview", { draftId: lessonId, decision: "promote", rationale: "matches the runbook", agentId: ops.id });
    expect(r.status).toBe("promoted");
    const skill = await (await request(agents[1], "GET", `/Memory/${r.memoryId}`)).json();
    expect(skill).toMatchObject({ agentId: ops.id, tags: ["skill"], trigger: "When rotating an agent key", subject: AREA, visibility: "shared" });
    const areas = await adminJson("/GuidanceAreas", {});
    expect(areas.areas.find((a: any) => a.area === AREA).guidance).toBe(1);
    expect((await admin("/GuidanceReview", { draftId: lessonId, decision: "promote", rationale: "again", agentId: ops.id })).status).toBe(409);
  });

  test("promoting a link records the refinement; rejecting keeps the draft", async () => {
    const before = (await adminJson("/GuidanceAreas", {})).unlabelled;
    expect((await adminJson("/GuidanceReview", { draftId: `link:${chains[0].later}`, decision: "promote", rationale: "it was missing verification" })).status).toBe("promoted");
    expect((await adminJson("/GuidanceAreas", {})).unlabelled).toBe(before + 1);

    expect((await adminJson("/GuidanceReview", { draftId: `link:${chains[1].later}`, decision: "reject", rationale: "just a schedule change" })).status).toBe("rejected");
    const { drafts } = await adminJson("/GuidanceDrafts", { status: "rejected" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: `link:${chains[1].later}`, reviewRationale: "just a schedule change" });
  });

  test("the draft table has no REST read", async () => {
    const res = await fetch(`${harper.httpURL}/GuidanceDraft/`, { headers: { Authorization: buildEd25519Auth(agents[0], "GET", "/GuidanceDraft/") } });
    expect(res.status).toBe(404);
  });
});
