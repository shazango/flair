- **`record_outcome` MCP tool, and *steady* in trust evidence.** Agents can confirm a memory
  held up or point it to a more accurate one they wrote, from native `/mcp` and the stdio
  server (same rules as `POST /RecordOutcome`). Search with `includeTrust` now carries
  `trust.confirmedBy` (other agents' confirmations, read from the outcome ledger in the
  response tail), shown as *steady (confirmed by N)* by `flair search --trust`, the stdio
  `memory_search`/`memory_get` trust line and `flair ask`.
