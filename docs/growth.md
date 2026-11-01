# Growth and guidance areas

Confirmations and refinements ([docs/ask.md](ask.md)) are signals about *situations*, not
grades for agents. Two read-only views turn them into something to act on. Neither ranks
agents.

## `flair growth`: an agent's own record of improvement

```bash
flair growth --agent mybot
```
```
Growth for mybot

Steady: others confirmed 4 of your memories (6× in all).
  2026-09  ▪▪ 2
  2026-10  ▪▪▪▪ 4

Areas you have been refining:
  agent key rotation  2× · guidance: skill-7f3a…
  subsystem:backup  1× · no guidance yet

You have refined 3 memories by others. Thank you.
```

- **Steady** counts other agents' confirmations of this agent's memories, by month. Its
  own confirmations don't count.
- **Areas you have been refining** are the areas (below) where this agent's memories
  have had something more accurate added, and any skills about each area it can read.
- It never says who confirmed or refined anything.
- Only the agent itself and operators can see it (`POST /Growth` refuses another agent's id
  with 403).

## `flair guidance areas`: where better guidance is needed

```bash
flair guidance areas        # admin credentials (FLAIR_ADMIN_PASS or the local admin-pass file)
```
```
Areas drawing refinements (by area, never by agent):

  agent key rotation  5× over 3 memories · 1 skill
  subsystem:backup  2× over 2 memories · needs guidance
  (no subject or entities)  4×
```

An operator's to-do list: areas that keep being refined and have no skill yet are where a
skill would help most. The response carries no agent ids at all.

## Areas

An area is what a memory is about: its `subject` and its `entities`
([docs/entity-vocabulary.md](entity-vocabulary.md)). `agent:` and `person:` labels are
left out, so an area is never a person. A refined memory with neither is counted as
"no subject or entities"; give memories a `subject` to make them count toward an area.

Guidance is a skill (a memory tagged `skill`) whose `subject` or `entities` name the area.

## HTTP

| Route | Who | Body | Returns |
|---|---|---|---|
| `POST /Growth` | the agent itself, or an operator | `{ agentId? }` | `{ agentId, steady: { confirmations, memoriesConfirmed, byMonth }, refinedAreas: [{ area, refinements, guidance }], unlabelledRefinements, refinementsGiven }` |
| `POST /GuidanceAreas` | operators | `{}` | `{ areas: [{ area, refinements, memoriesRefined, guidance }], unlabelled, computedAt }` |

Both are computed from the `MemoryOutcome` ledger on each request, write nothing, and
feed nothing back into ranking or read scope.

## Guidance drafts: refinements become shared lessons

The guidance scan turns refinements into proposals. Nothing it proposes is live until an
operator reviews it.

```bash
flair guidance scan                    # admin credentials; the nightly REM run does this when it has them
flair guidance drafts                  # what is waiting (--status rejected|promoted|not_a_correction|all)
flair guidance promote lesson:agent\ key\ rotation:3 --rationale "matches the runbook" --as ops-bot
flair guidance reject link:mem-9c1e --rationale "just a schedule change"
```

It proposes two kinds of draft:

- **Lessons.** When an area has had 3 refinements (a global number, never per agent) and
  no skill exists for it, the LLM drafts one short lesson for any agent working there,
  plus a trigger ("When rotating an agent key…"). It is written from the memories'
  content only: it says what to do, names nobody and blames nobody. Only refinements where
  both memories are shared feed a lesson, because a lesson is shared org-wide.
  Promoting it writes a shared, persistent skill (tags `skill`, subject = the area) under
  the agent you name with `--as`, through the normal memory write path (SkillScan
  included). The area then shows guidance in `flair guidance areas`. A rejected lesson is
  kept, and the area is drafted again only once it has more refinements than before.
- **Refinement links.** When a newer version of a memory replaces an older one
  (`supersedes`), the LLM judges whether it *corrects* the older one or only *updates* it
  (the facts changed: "latest is 0.62" replacing "latest is 0.61"). If unsure, it says
  update. A correction is proposed as a link; promoting it records the refinement, reported
  by the newer memory's author, so `ask` brings it forward. An update is kept as
  `not_a_correction` and is not judged again.

Each scan judges at most 5 successors and drafts at most 2 lessons, so nightly runs work
through a backlog. Without an LLM backend the scan is skipped.

| Route | Who | Body | Returns |
|---|---|---|---|
| `POST /GuidanceScan` | operators | `{}` | `{ linksProposed, notCorrections, lessonsDrafted, failed, skipped? }` |
| `POST /GuidanceDrafts` | operators | `{ status? }` | `{ drafts }` (link drafts include both memories' content) |
| `POST /GuidanceReview` | operators | `{ draftId, decision: "promote" \| "reject", rationale, agentId? }` | `{ draftId, status, memoryId? }` |

Drafts live in an internal `GuidanceDraft` table with no REST surface.
