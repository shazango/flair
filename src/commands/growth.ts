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

  program
    .command("guidance")
    .description("Guidance for agents, from refinements")
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
}
