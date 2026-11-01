# Ask

`flair ask` answers a question from your agents' memories. The answer is written only
from memories search returned, cites them by number, and each citation shows the trust
evidence behind it: who wrote it, how strong the match is, how often it has been used,
and how old it is.

```bash
flair ask "how often is the staging database rotated?" --agent mybot
```
```
Every Sunday at 02:00 UTC [1].

[1] The staging database is rotated every Sunday at 02:00 UTC by the ops runbook.
    2026-09-14 · strong match · verified author ops-bot · used 3× · 47d old · mem-7f3a…
```

Answers need a generative backend, the same one REM uses (see
[docs/rem.md § Configuration](rem.md#configuration)).

## What it does

1. Searches with the agent's own read scope, with trust evidence and abstention on.
   This is the same `POST /SemanticSearch` an agent's `search` makes, so it sees the same
   memories and counts as an ordinary search.
2. **Abstains** when nothing clears the global confidence threshold. It says
   "No memory covers this confidently" and doesn't call the model.
3. Otherwise asks the model to answer **only** from the numbered memories, to cite every
   claim, to say plainly when the memories don't cover the question, and to show both
   views when memories disagree.
4. Drops any citation that doesn't match a memory it was given.

The CLI lists only the memories the answer cites. `--json` prints the whole response,
including every source.

## Without a model

If no generative backend is configured, or the model's reply isn't usable, `ask` still
returns the ranked memories with their trust evidence and says why there's no answer:

```
No answer written (no LLM backend is configured). The closest memories:

[1] The staging database is rotated every Sunday at 02:00 UTC by the ops runbook.
    2026-09-14 · strong match · verified author ops-bot · 47d old · mem-7f3a…
```

## What it never does

- **It writes nothing.** `ask` never records usage from the model's citations. A model
  citing a memory isn't evidence that the memory held up, and counting it would feed
  ranking with its own output (#623). Confirming an answer will be an explicit step.
- **It never widens read scope.** A non-admin can only ask from its own scope, the same
  rule as search.

## HTTP

`POST /Ask` with `{ q, agentId?, limit? }` (`limit` defaults to 5, max 10). It returns:

| Field | Meaning |
|---|---|
| `abstained` | search found nothing above the threshold (`bestScore`, `threshold` say why) |
| `answer` | the answer with `[n]` citations, or `null` |
| `citations` | the `n` the answer cites |
| `sources` | `[{ n, id, content, createdAt, trust }]`, numbered as in the answer |
| `answerUnavailable` | why `answer` is `null` despite sources: `no_backend`, `generate_failed`, `validation_failed`, `incomplete_generation` |
| `model` | the configured model name, or `null` for the default |
