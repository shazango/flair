/**
 * trust-summary.test.ts — src/lib/trust-summary.ts, the `flair search --trust`
 * line. It is a copy of the stdio adapter's formatter (the CLI takes no
 * dependency on that package), so the parity case pins the two together.
 */
import { describe, it, expect } from "bun:test";
import { formatAbstentionSummary, formatTrustSummary } from "../../src/lib/trust-summary.ts";
import { formatTrustLine } from "../../packages/flair-mcp/src/trust.ts";

const BASE: any = {
  author: "agent-b", provenanceStatus: "verified", verifiedAuthor: "agent-b", verifiedAt: null,
  hasClaimedProvenance: false, usageCount: 3, validityStatus: "valid", validFrom: null, validTo: null,
  createdAt: null, updatedAt: null, ageDays: 12, staleDays: 2, supersedes: "m0", matchQuality: "strong",
};

const CASES: any[] = [
  BASE,
  { ...BASE, provenanceStatus: "unattributed", verifiedAuthor: null, usageCount: null, matchQuality: null },
  { ...BASE, validityStatus: "expired", validTo: "2026-09-01T00:00:00Z", supersedes: null, staleDays: 12 },
  { ...BASE, validityStatus: "future", validFrom: "2027-01-01T00:00:00Z", ageDays: null },
  { ...BASE, usageCount: 0 },
];

describe("formatTrustSummary", () => {
  it("renders the full block", () => {
    expect(formatTrustSummary(BASE)).toBe("strong match · verified author agent-b · used 3× · 12d old, updated 2d ago · replaces m0");
  });
  it("matches the stdio adapter's line for every case", () => {
    for (const t of CASES) expect(`trust: ${formatTrustSummary(t)}`).toBe(formatTrustLine(t));
  });
  it("never throws on a missing block", () => {
    expect(formatTrustSummary(undefined)).toBe("author unattributed");
  });
});

describe("formatAbstentionSummary", () => {
  it("states the best score and the threshold", () => {
    expect(formatAbstentionSummary({ bestScore: 0.08, threshold: 0.15 }))
      .toBe("No memory covers this confidently (best match 0.08, below the 0.15 confidence threshold).");
  });
});
