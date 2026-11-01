- **Recall checks: `flair check init|run|report`.** Measure how well search finds an
  agent's memories on your own data, and whether it abstains when nothing answers.
  `init` has the configured generative backend write paraphrased questions from
  memories in the agent's read scope, plus decoys nothing should answer, through the
  new read-only `POST /RecallProbes`. `run` sends each question through
  `/SemanticSearch` and records recall@1/@5, MRR and abstention accuracy. `report`
  shows the trend and replays the latest run across abstention thresholds; it never
  changes the threshold. Questions and runs stay in `~/.flair/recall-check/<agent>/`
  and nothing is written to the instance. See [docs/recall-checks.md](docs/recall-checks.md).
