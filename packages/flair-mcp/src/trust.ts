/**
 * Trust evidence as text for the stdio adapter (slice 2 of the outcome engine;
 * docs: docs/ask.md).
 *
 * memory_search / memory_get reply in prose for the model, so the server's
 * trust block (resources/trust-block.ts) and abstention verdict
 * (resources/abstention.ts) are rendered as one short line each. Evidence to
 * weigh, never a verdict: nothing here hides or reorders a result.
 */
import type { SearchResponse, TrustBlock } from "@tpsdev-ai/flair-client";

export function formatTrustLine(t: TrustBlock): string {
  const parts: string[] = [];
  if (t.matchQuality) parts.push(`${t.matchQuality} match`);
  parts.push(t.provenanceStatus === "verified" && t.verifiedAuthor ? `verified author ${t.verifiedAuthor}` : "author unattributed");
  if (typeof t.usageCount === "number" && t.usageCount > 0) parts.push(`used ${t.usageCount}×`);
  if (typeof t.confirmedBy === "number" && t.confirmedBy > 0) parts.push(`steady (confirmed by ${t.confirmedBy})`);
  if (typeof t.ageDays === "number") {
    const updated = typeof t.staleDays === "number" && t.staleDays < t.ageDays ? `, updated ${t.staleDays}d ago` : "";
    parts.push(`${t.ageDays}d old${updated}`);
  }
  if (t.validityStatus === "expired") parts.push(`no longer valid since ${(t.validTo ?? "").slice(0, 10)}`);
  if (t.validityStatus === "future") parts.push(`not valid until ${(t.validFrom ?? "").slice(0, 10)}`);
  if (t.supersedes) parts.push(`replaces ${t.supersedes}`);
  return `trust: ${parts.join(" · ")}`;
}

export function formatAbstention(res: SearchResponse): string {
  const best = typeof res.bestScore === "number" ? `best match ${res.bestScore.toFixed(2)}` : "no semantic match";
  const floor = typeof res.threshold === "number" ? `, below the ${res.threshold} confidence threshold` : "";
  return `No memory covers this confidently (${best}${floor}). Treat it as unknown rather than guessing.`;
}
