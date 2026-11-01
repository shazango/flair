- **Confirmations and refinements: `POST /RecordOutcome`, `flair ask --confirm/--refine`.**
  An agent can say a memory held up, or add what's more accurate as a new memory linked
  to it. `ask` then shows memories others keep confirming as *steady* and brings a
  memory's readable refinements forward with it, so the answer uses both. A refinement
  never lowers, hides or replaces the original, and the author's own confirmations don't
  count. Same access rules as `RecordUsage` (read scope, one entry per agent and memory,
  an identical reply for ids you can't see). Stored in a new internal `MemoryOutcome`
  table with no REST surface. See [docs/ask.md](docs/ask.md).
