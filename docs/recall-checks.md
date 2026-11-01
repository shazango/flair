# Recall checks

`flair check` measures how well search works **on your own data**. It answers two
questions:

1. When someone asks about something an agent knows, does search find the right memory?
2. When nobody knows the answer, does search say so ("no memory covers this")
   instead of offering weak matches?

It grades the instance's retrieval, never an agent. [`flair-bench`](../packages/flair-bench/README.md)
compares embedding models on a fixed test set; recall checks measure your live instance.

## Quick start

```bash
flair check init --agent mybot     # write test questions from mybot's memories
flair check run --agent mybot      # run them through search
flair check report --agent mybot   # trend + abstention-threshold sweep
```

`init` needs a generative backend, the same one REM uses (see
[docs/rem.md § Configuration](rem.md#configuration)). Without one it fails with
`No generative backend configured`. `run` and `report` don't need one.

## What each command does

- **`init`** asks `POST /RecallProbes` to:
  - sample up to `--count` memories (default 20, max 50) from the agent's read scope;
  - have the model write one paraphrased question per memory;
  - add `--decoys` questions (default 5, max 20) that none of the sampled memories
    answer.

  Run it again to add more; memories that already have a question are skipped.
  Memories that default search would never return are not sampled: archived,
  superseded, past `validTo`, TTL-expired, and skills (which are found by their
  trigger, not their content).
- **`run`** sends every question through `POST /SemanticSearch` with `abstain: true`,
  the same path agents use, and records:
  - where the question's memory ranked;
  - the best similarity score.

  A question whose memory has since been deleted or archived is retired.
- **`report`** shows recent runs, then replays the latest run at a range of
  abstention thresholds:

```
Abstention threshold sweep (latest run, replayed)
  threshold  recall@5  abstained on answerable  answered decoys
  0.10       85%       0%                       100%
  0.15       85%       5%                       80%   ← current
  0.20       80%       10%                      40%
```

Raising the threshold makes search refuse more decoys but also abstain on more real
questions. The sweep shows that trade-off on your data. It is a report only and never
changes the threshold.

## Metrics

| Metric | Meaning |
|---|---|
| recall@1 / recall@5 | Share of questions whose memory came back first / in the top 5 |
| MRR | Mean reciprocal rank: 1.0 means always first, and it falls as the memory ranks lower or is missed |
| abstained on answerable | Share of real questions where search said "nothing covers this" |
| answered decoys | Share of decoys where search returned results anyway |

## Where things are kept

Per agent, mode `0600`, on the machine that runs the command:

```
~/.flair/recall-check/<agent>/probes.json   the question set
~/.flair/recall-check/<agent>/runs.jsonl    one line per run (ids, ranks, scores)
```

Nothing is written to the instance. The question set contains paraphrases of the
sampled memories, so treat it like the memories themselves. Runs do count as ordinary
search hits (`retrievalCount`), which is display-only and does not affect ranking.

## Limits

- **Decoys are a best guess.** The model only sees the sampled memories, so a "decoy"
  may in fact be answered by another memory. A decoy that keeps getting strong matches
  is worth reading.
- **One right answer per question.** A question counts as found only if *its* memory
  comes back. A near-duplicate memory that answers just as well still counts as a
  miss.
- **Shared blind spots.** The questions are written by the same model family your
  backend runs, so they can share its blind spots.
