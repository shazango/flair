/**
 * Near misses for an abstaining search (`includeClosest`, used by `ask`).
 *
 * The rows come from the abstaining search's own candidate pool, so read scope
 * has already run. Same response tail as ordinary results (hit-stat overlay,
 * host-source projection, trust block), except that nothing is hit-tracked: an
 * abstaining recall does not count as having surfaced a memory.
 */
import { applyHitStats } from "./hit-tracking.js";
import { projectRowsThroughPointers } from "./memory-host-source.js";
import { attachConfirmations } from "./outcome-recording.js";
import { attachTrust } from "./trust-block.js";

const CLOSEST_LIMIT = 3;

export async function closestMatches(pool: any[], reader: string | undefined, ctx: unknown): Promise<any[]> {
  const rows = await Promise.all(pool.slice(0, CLOSEST_LIMIT).map((r) => applyHitStats(r, ctx as any)));
  const visible = reader ? await projectRowsThroughPointers(rows, reader) : rows;
  const trusted = visible.map((r: any) => attachTrust(r, true));
  await attachConfirmations(trusted);
  return trusted.map(({ _semSimilarity, ...r }: any) => r);
}
