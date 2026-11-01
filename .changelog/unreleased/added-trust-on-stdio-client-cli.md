- **Trust evidence and abstention beyond native `/mcp`.** The stdio `flair-mcp`
  `memory_search` tool now accepts `includeTrust` and `abstain`, and `memory_get`
  accepts `includeTrust`. Results show one line of evidence (match strength, author
  verification, usage, age, validity, what the memory replaces), and an abstained
  search says "no memory covers this confidently" instead of "no relevant memories".
  `@tpsdev-ai/flair-client` adds `memory.searchDetailed()`, which returns the results
  plus the abstention verdict, and `memory.get(id, { includeTrust })`. `flair search`
  adds `--trust` and `--abstain`. With no flag set, every surface sends the same
  request and prints the same output as before.
