/**
 * growth.ts — `flair growth` (an agent's own record of improvement) and
 * `flair guidance areas` (operators: which areas need better guidance). Slice 5a
 * of the outcome engine; docs: docs/growth.md. The server
 * does the work (POST /Growth, POST /GuidanceAreas; resources/guidance-views.ts).
 * Shared cli-locals are injected via bindCli() before register(); this module
 * never imports src/cli.ts (flair#1636 pattern).
 */
import { Command } from "commander";
import * as render from "../render.js";

export type GrowthCli = {
  api: (...args: any[]) => any;
  resolveSigningAgentId: (...args: any[]) => any;
};

let cli: GrowthCli;

/** Bind the cli-locals this module depends on. */
export function bindCli(fns: GrowthCli): void {
  cli = fns;
}

/** Plain-text rendering of a POST /Growth result (exported for tests). */
export function formatGrowth(g: any): string {
  const steady = g?.steady ?? {};
  const lines: string[] = [`Growth for ${g?.agentId}`, ""];
  if (steady.confirmations > 0) {
    lines.push(`Steady: others confirmed ${steady.memoriesConfirmed} of your memories (${steady.confirmations}× in all).`);
    for (const m of steady.byMonth ?? []) lines.push(`  ${m.month}  ${"▪".repeat(Math.min(m.confirmations, 40))} ${m.confirmations}`);
  } else {
    lines.push("Steady: no confirmations from others yet.");
  }
  const areas: any[] = g?.refinedAreas ?? [];
  lines.push("");
  if (areas.length > 0 || g?.unlabelledRefinements > 0) {
    lines.push("Areas you have been refining:");
    for (const a of areas) {
      const guide = a.guidance?.length ? `guidance: ${a.guidance.join(", ")}` : "no guidance yet";
      lines.push(`  ${a.area}  ${a.refinements}× · ${guide}`);
    }
    if (g?.unlabelledRefinements > 0) lines.push(`  (no subject or entities)  ${g.unlabelledRefinements}×`);
  } else {
    lines.push("No refinements to your memories yet.");
  }
  if (g?.refinementsGiven > 0) lines.push("", `You have refined ${g.refinementsGiven} ${g.refinementsGiven === 1 ? "memory" : "memories"} by others. Thank you.`);
  return lines.join("\n");
}

/** Plain-text rendering of a POST /GuidanceAreas result (exported for tests). */
export function formatGuidanceAreas(r: any): string {
  const areas: any[] = r?.areas ?? [];
  if (areas.length === 0 && !(r?.unlabelled > 0)) return "No refinements yet, so no areas need guidance.";
  const lines = ["Areas drawing refinements (by area, never by agent):", ""];
  for (const a of areas) {
    lines.push(`  ${a.area}  ${a.refinements}× over ${a.memoriesRefined} ${a.memoriesRefined === 1 ? "memory" : "memories"} · ${a.guidance > 0 ? `${a.guidance} skill${a.guidance === 1 ? "" : "s"}` : "needs guidance"}`);
  }
  if (r?.unlabelled > 0) lines.push(`  (no subject or entities)  ${r.unlabelled}×`);
  return lines.join("\n");
}

export function register(program: Command): void {
  program
    .command("growth")
    .description("Your own record of improvement: memories others confirmed, and the areas you have been refining")
    .option("--agent <id>", "Agent ID (or set FLAIR_AGENT_ID env); operators may name any agent")
    .option("--json", "Output the raw /Growth response")
    .action(async (opts) => {
      try {
        const { agentId, source } = cli.resolveSigningAgentId(opts, "growth");
        if (!agentId) {
          console.error("error: --agent <id> required (or set FLAIR_AGENT_ID)");
          process.exit(2);
        }
        const result = await cli.api("POST", "/Growth", { agentId }, { agentId, agentIdSource: source });
        console.log(render.resolveOutputMode(opts) === "json" ? render.asJSON(result) : formatGrowth(result));
      } catch (err: any) {
        console.error(`${render.icons.error} Growth failed: ${err.message}`);
        process.exit(1);
      }
    });

  const guidance = program
    .command("guidance")
    .description("Guidance for agents, from refinements");

  guidance
    .command("areas")
    .description("Operators: which areas draw refinements and whether guidance exists for them (admin credentials)")
    .option("--json", "Output the raw /GuidanceAreas response")
    .action(async (opts) => {
      try {
        const result = await cli.api("POST", "/GuidanceAreas", {}, { agentId: null });
        console.log(render.resolveOutputMode(opts) === "json" ? render.asJSON(result) : formatGuidanceAreas(result));
      } catch (err: any) {
        console.error(`${render.icons.error} Guidance areas failed: ${err.message}`);
        process.exit(1);
      }
    });

  guidance
    .command("scan")
    .description("Operators: propose refinement links and lesson drafts for review (admin credentials; the nightly REM run does this when it has them)")
    .option("--json", "Output the raw /GuidanceScan response")
    .action(async (opts) => {
      await adminCall("Guidance scan", "/GuidanceScan", {}, opts, formatScan);
    });

  guidance
    .command("drafts")
    .description("Operators: list guidance drafts waiting for review (admin credentials)")
    .option("--status <s>", "pending | promoted | rejected | not_a_correction | all", "pending")
    .option("--json", "Output the raw /GuidanceDrafts response")
    .action(async (opts) => {
      await adminCall("Guidance drafts", "/GuidanceDrafts", { status: opts.status }, opts, formatDrafts);
    });

  const review = (decision: "promote" | "reject") => async (draftId: string, opts: any) => {
    await adminCall(`Guidance ${decision}`, "/GuidanceReview", { draftId, decision, rationale: opts.rationale, ...(opts.as ? { agentId: opts.as } : {}) }, opts,
      (r: any) => `${render.icons.ok} ${draftId}: ${r.status}${r.memoryId ? ` (skill ${r.memoryId})` : ""}`);
  };

  guidance
    .command("promote <draft-id>")
    .description("Operators: make a draft live: a lesson becomes a shared skill, a link becomes a recorded refinement (admin credentials)")
    .requiredOption("--rationale <text>", "Why it is being promoted (required, no rubber-stamp)")
    .option("--as <agent-id>", "Lessons: the agent the skill is published under")
    .option("--json", "Output the raw /GuidanceReview response")
    .action(review("promote"));

  guidance
    .command("reject <draft-id>")
    .description("Operators: reject a draft; it is kept, marked rejected (admin credentials)")
    .requiredOption("--rationale <text>", "Why it is being rejected (required, no rubber-stamp)")
    .option("--json", "Output the raw /GuidanceReview response")
    .action(review("reject"));
}

async function adminCall(label: string, path: string, body: unknown, opts: any, format: (r: any) => string): Promise<void> {
  try {
    const result = await cli.api("POST", path, body, { agentId: null });
    if (result?.error) throw new Error(result.error);
    console.log(render.resolveOutputMode(opts) === "json" ? render.asJSON(result) : format(result));
  } catch (err: any) {
    console.error(`${render.icons.error} ${label} failed: ${err.message}`);
    process.exit(1);
  }
}

/** Plain-text rendering of a POST /GuidanceScan result (exported for tests). */
export function formatScan(r: any): string {
  if (r?.skipped === "no_backend") return "Guidance scan skipped: no LLM backend is configured.";
  const lines = [
    `Proposed ${r.linksProposed} refinement link${r.linksProposed === 1 ? "" : "s"} and ${r.lessonsDrafted} lesson${r.lessonsDrafted === 1 ? "" : "s"}.`,
  ];
  if (r.notCorrections > 0) lines.push(`${r.notCorrections} newer version${r.notCorrections === 1 ? " was an update" : "s were updates"}, not corrections.`);
  if (r.failed > 0) lines.push(`${r.failed} could not be judged (the LLM reply was not usable); the next scan retries them.`);
  if (r.linksProposed + r.lessonsDrafted > 0) lines.push("Review: flair guidance drafts");
  return lines.join("\n");
}

/** Plain-text rendering of a POST /GuidanceDrafts result (exported for tests). */
export function formatDrafts(r: any): string {
  const drafts: any[] = r?.drafts ?? [];
  if (drafts.length === 0) return "No drafts.";
  const lines: string[] = [];
  for (const d of drafts) {
    lines.push(`${d.id}  [${d.kind}, ${d.status}]`);
    if (d.kind === "lesson") {
      lines.push(`  area: ${d.area} (from ${d.refinementCount} refinements)`, `  trigger: ${d.trigger}`, `  lesson: ${d.content}`);
    } else {
      lines.push(`  earlier (${d.memoryId}): ${d.earlier ?? "(gone)"}`, `  later (${d.refinementMemoryId}): ${d.later ?? "(gone)"}`, `  why a correction: ${d.content}`);
    }
    if (d.reviewRationale) lines.push(`  decided by ${d.reviewerId}: ${d.reviewRationale}`);
    lines.push("");
  }
  lines.push('Decide: flair guidance promote <id> --rationale "…" [--as <agent>]   |   flair guidance reject <id> --rationale "…"');
  return lines.join("\n");
}
