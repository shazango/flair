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
