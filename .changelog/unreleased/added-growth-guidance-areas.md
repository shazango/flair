- **`flair growth` and `flair guidance areas`.** Two read-only views over confirmations
  and refinements. `growth` shows an agent its own record of improvement: how many of its
  memories others confirmed, by month, and the areas its memories have been refined in,
  with any skills for those areas. Only the agent and operators can see it. `guidance
  areas` shows operators which areas (a memory's `subject` and `entities`, never people)
  keep drawing refinements and whether a skill exists for them, counted by area and never
  by agent. New routes `POST /Growth` and `POST /GuidanceAreas` (admin). See
  [docs/growth.md](docs/growth.md).
