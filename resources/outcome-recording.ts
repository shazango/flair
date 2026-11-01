/**
 * outcome-recording.ts — the MemoryOutcome ledger (schemas/outcome.graphql):
 * confirmations and refinements (slice 4 of the outcome engine; docs:
 * docs/ask.md).
 *
 * Growth, not blame: a refinement is a pointer from a memory to something more
 * accurate, never a mark against the memory or its author. Nothing here lowers
 * a memory's standing, hides it, or counts corrections per agent.
 *
 * WRITE (recordOutcome, for POST /RecordOutcome). Same access model as
 * RecordUsage: any verified agent, for a memory in its READ SCOPE, no ownership
 * needed. A memory that does not exist and one outside the scope take the same
 * silent no-op, so the endpoint cannot be used to probe ids. A refinement must
 * name a memory the reporter wrote: you cannot refine without supplying the
 * improvement.
 *
 * READ, in-process only; there is no REST read of the ledger.
 * attachConfirmations (SemanticSearch with includeTrust) adds trust.confirmedBy;
 * refinementsFor (POST /Ask) brings refinements forward. A confirmation from the memory's own author is stored but not
 * counted: standing comes from others relying on a memory. A refinement is
 * shown only if the reader can read the refinement memory itself.
 *
 * NO COUNT ON MEMORY, deliberately. A stored counter is only as trustworthy as
 * every path that can write the Memory row. The ledger has one writer, POST
 * /RecordOutcome, so readers summarise it instead:
 * one indexed query for the memories they show (attachConfirmations, ledgerRows).
 */
import { databases } from "harper";
import { withOwnedTransaction } from "./request-transaction.js";
import { resolveReadScope } from "./memory-read-scope.js";
import type { ScopableRecord } from "./memory-read-scope.js";

export type OutcomeKind = "confirmed" | "refined";
export const OUTCOME_KINDS: readonly OutcomeKind[] = ["confirmed", "refined"];

export interface OutcomeRow {
  agentId: string;
  memoryId: string;
  kind: string;
  refinementMemoryId?: string | null;
}

export interface OutcomeSummary {
  /** Distinct agents other than the author who confirmed the memory. */
  confirmedBy: number;
  /** Ids of refinements, oldest report first, before the reader's scope check. */
  refinementIds: string[];
}

/** Pure: summarise one memory's ledger rows. */
export function summarizeOutcomes(rows: readonly OutcomeRow[], authorId: string | undefined): OutcomeSummary {
  const confirmers = new Set<string>();
  const refinementIds: string[] = [];
  for (const row of rows) {
    if (row.kind === "confirmed" && row.agentId !== authorId) confirmers.add(row.agentId);
    if (row.kind === "refined" && typeof row.refinementMemoryId === "string" && !refinementIds.includes(row.refinementMemoryId)) {
      refinementIds.push(row.refinementMemoryId);
    }
  }
  return { confirmedBy: confirmers.size, refinementIds };
}

export type RecordOutcomeResult = "recorded" | "bad_refinement";

/**
 * Record one outcome. "recorded" covers a fresh row, a repeat (no-op) and a
 * memory that is absent or outside the reporter's read scope (no-op): the
 * caller cannot tell them apart. "bad_refinement" means refinementMemoryId does
 * not name a memory the reporter wrote (or names the memory itself); it is
 * checked first and says nothing about memoryId.
 */
export async function recordOutcome(
  ctx: any,
  agentId: string,
  input: { memoryId: string; kind: OutcomeKind; refinementMemoryId?: string },
  now: string,
): Promise<RecordOutcomeResult> {
  const { memoryId, kind, refinementMemoryId } = input;
  let scope: { isAllowed: (r: ScopableRecord) => boolean };
  try {
    scope = await resolveReadScope(agentId);
  } catch (err) {
    // Fail closed: nothing is recorded if the scope cannot be resolved.
    console.error("[outcome-recording] read scope unavailable; outcome not recorded", { err });
    return "recorded";
  }
  return withOwnedTransaction(ctx, async (owned) => {
    if (kind === "refined") {
      const refinement = refinementMemoryId ? await (databases as any).flair.Memory.get(refinementMemoryId, owned).catch(() => null) : null;
      if (!refinement || refinement.agentId !== agentId || refinement.id === memoryId) return "bad_refinement";
    }
    const memory = await (databases as any).flair.Memory.get(memoryId, owned).catch(() => null);
    if (!memory || !scope.isAllowed(memory)) return "recorded";
    const id = `${agentId}:${memoryId}:${kind}`;
    // ponytail: get-then-put without a key lock. A race writes the same
    // deterministic id twice; the only loss is which createdAt (or which of two
    // refinements by the same reporter) survives.
    if (await (databases as any).flair.MemoryOutcome.get(id, owned)) return "recorded";
    await (databases as any).flair.MemoryOutcome.put(
      { id, agentId, memoryId, kind, ...(kind === "refined" ? { refinementMemoryId } : {}), createdAt: now },
      owned,
    );
    return "recorded";
  });
}

/** All ledger rows for these memory ids, grouped by memory id: ONE indexed query. */
async function ledgerRows(ids: readonly string[]): Promise<Map<string, OutcomeRow[]>> {
  const rows = new Map<string, OutcomeRow[]>();
  if (ids.length === 0) return rows;
  // Harper refuses an `or` with fewer than two conditions.
  const query = ids.length === 1
    ? { conditions: [{ attribute: "memoryId", comparator: "equals", value: ids[0] }] }
    : { operator: "or", conditions: ids.map((value) => ({ attribute: "memoryId", comparator: "equals", value })) };
  for await (const row of (databases as any).flair.MemoryOutcome.search(query)) {
    if (!rows.has(row.memoryId)) rows.set(row.memoryId, []);
    rows.get(row.memoryId)!.push(row);
  }
  return rows;
}

/**
 * The readable refinements of each memory a reader is shown, keyed by memory
 * id, as raw Memory records. Refinements the reader cannot read are dropped.
 */
export async function refinementsFor(readerAgentId: string | undefined, ids: readonly string[]): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  if (ids.length === 0) return out;
  const rows = await ledgerRows(ids);
  const scope = readerAgentId ? await resolveReadScope(readerAgentId) : null;
  for (const id of ids) {
    const refinements: any[] = [];
    for (const refId of summarizeOutcomes(rows.get(id) ?? [], undefined).refinementIds) {
      const ref = await (databases as any).flair.Memory.get(refId).catch(() => null);
      if (ref && !ref.archived && (!scope || scope.isAllowed(ref))) refinements.push(ref);
    }
    out.set(id, refinements);
  }
  return out;
}

/**
 * Add `confirmedBy` (others' confirmations; the steady signal) to the trust
 * block of each result, IN PLACE. Called by SemanticSearch in its response
 * tail, only when includeTrust is on, after read scope and ranking are done:
 * it decorates the response and feeds nothing back. A ledger failure leaves
 * the trust blocks without it. Results must carry `agentId` and a `trust` object.
 */
export async function attachConfirmations(results: readonly any[]): Promise<void> {
  const withTrust = results.filter((r) => r && typeof r.id === "string" && r.trust && typeof r.trust === "object");
  if (withTrust.length === 0) return;
  try {
    const rows = await ledgerRows([...new Set(withTrust.map((r) => r.id))]);
    for (const r of withTrust) r.trust.confirmedBy = summarizeOutcomes(rows.get(r.id) ?? [], r.agentId ?? r.trust.author).confirmedBy;
  } catch (err) {
    console.error("[outcome-recording] confirmation lookup failed; trust blocks left without confirmedBy", { err });
  }
}
