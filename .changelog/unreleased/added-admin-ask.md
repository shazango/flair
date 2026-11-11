- **Ask page in the web admin, and closest matches when `ask` abstains.** `/AdminAsk` asks
  from a chosen agent's read scope and shows the answer, its sources and their trust
  evidence. When nothing clears the confidence threshold, `flair ask`, `POST /Ask` and the
  page list up to three of the closest memories, labelled as possibly irrelevant. They
  never reach the model and don't count as search hits. `flair ask` no longer names the
author of a refinement or of the memory it refines. See [docs/ask.md](docs/ask.md).
