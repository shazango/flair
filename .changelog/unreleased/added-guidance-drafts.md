- **Guidance drafts: `flair guidance scan|drafts|promote|reject`.** Refinements now turn
  into proposals an operator reviews. When an area has been refined 3 times (global) and
  has no skill, the LLM drafts a short lesson and trigger from the shared memories'
  content, naming nobody; promoting it writes a shared skill through the normal write path
  (SkillScan included). When a newer version (`supersedes`) corrects rather than updates
  the older memory, a refinement link is proposed; promoting it records the refinement.
  Nothing applies without review, review needs a rationale, and rejected drafts are kept.
  The REM nightly run scans when it has admin credentials. New admin routes
  `POST /GuidanceScan`, `/GuidanceDrafts`, `/GuidanceReview`, and an internal
  `GuidanceDraft` table. See [docs/growth.md](docs/growth.md#guidance-drafts-refinements-become-shared-lessons).
