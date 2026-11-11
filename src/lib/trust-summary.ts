/**
 * trust-summary.ts — one-line rendering of the server's trust block
 * (resources/trust-block.ts) for `flair search --trust`.
 *
 * ponytail: mirrors packages/flair-mcp/src/trust.ts; the CLI takes no
 * dependency on the client/MCP packages, so the ~15 lines are copied rather
 * than shared. Extract to a shared package if a third surface needs it.
 */

export function formatTrustSummary(t: any): string {
  const parts: string[] = [];
  if (t?.matchQuality) parts.push(`${t.matchQuality} match`);
  parts.push(t?.provenanceStatus === "verified" && t?.verifiedAuthor ? `verified author ${t.verifiedAuthor}` : "author unattributed");
  if (typeof t?.usageCount === "number" && t.usageCount > 0) parts.push(`used ${t.usageCount}×`);
  if (typeof t?.confirmedBy === "number" && t.confirmedBy > 0) parts.push(`steady (confirmed by ${t.confirmedBy})`);
  if (typeof t?.ageDays === "number") {
    const updated = typeof t.staleDays === "number" && t.staleDays < t.ageDays ? `, updated ${t.staleDays}d ago` : "";
    parts.push(`${t.ageDays}d old${updated}`);
  }
  if (t?.validityStatus === "expired") parts.push(`no longer valid since ${String(t.validTo ?? "").slice(0, 10)}`);
  if (t?.validityStatus === "future") parts.push(`not valid until ${String(t.validFrom ?? "").slice(0, 10)}`);
  if (t?.supersedes) parts.push(`replaces ${t.supersedes}`);
  return parts.join(" · ");
}

/** Why POST /Ask returned sources but no answer (its `answerUnavailable`). */
export const ASK_UNAVAILABLE: Record<string, string> = {
  no_backend: "no LLM backend is configured",
  generate_failed: "the LLM call failed",
  validation_failed: "the LLM's reply was not usable",
  incomplete_generation: "the LLM's reply was cut off",
};

/** Growth, not blame: wherever a refinement is shown, its author and the refined memory's go unnamed. */
export function withoutAuthor(summary: string): string {
  return summary.split(" · ").filter((p) => !p.startsWith("verified author") && p !== "author unattributed").join(" · ");
}

export function formatAbstentionSummary(result: any): string {
  const best = typeof result?.bestScore === "number" ? `best match ${result.bestScore.toFixed(2)}` : "no semantic match";
  const floor = typeof result?.threshold === "number" ? `, below the ${result.threshold} confidence threshold` : "";
  return `No memory covers this confidently (${best}${floor}).`;
}
