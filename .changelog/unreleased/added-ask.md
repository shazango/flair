- **`flair ask` and `POST /Ask`.** Answer a question from memory. `ask` searches with
  the agent's own read scope (trust evidence and abstention on), abstains when nothing
  clears the global confidence threshold, and otherwise has the configured generative
  backend answer only from the numbered results. Citations that name no supplied memory
  are dropped, and each cited memory is shown with its trust evidence. Without a backend,
  or when the reply isn't usable, the ranked memories are returned instead. `ask` writes
  nothing and never records usage from the model's citations. See [docs/ask.md](docs/ask.md).
