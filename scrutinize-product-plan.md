# Scrutinize — Product & Technical Plan

*A review-process health auditor for GitHub. Free, self-hostable, deterministic — no AI model required to run it.*

---

## 1. The problem, with proof

- Developers using AI feel faster but aren't: LinearB's 2026 analysis of 8.1M pull requests across 4,800+ orgs found developers feel 20% faster while actually being 19% slower. PR review time is up 91%.
- Faros AI found 31% more PRs are merging with no review at all — teams are cutting corners to keep pace.
- A Carnegie Mellon synthesis of 3,100 practitioner documents found AI-authored PRs get *lower* review rates, faster merges, and less discussion — despite CodeRabbit's own data showing AI-coauthored PRs average 10.83 issues vs. 6.45 for human-only PRs.
- Sonar's 2026 survey (1,100+ developers): AI is 42% of committed code today, heading to 65% by 2027. 96% of developers don't fully trust it. Only 48% always verify before committing.

**The gap:** every existing tool (CodeRabbit, Qodo, Sonar, Copilot Review, Greptile) answers "what's wrong with this code." Nobody answers "did anyone actually look." That's Scrutinize's job.

## 2. What it does

Installs as a GitHub App. For every pull request, it computes objective, deterministic signals from data GitHub already exposes:

| Signal | Source |
|---|---|
| Diff size (lines changed, files touched) | PR API |
| Time from PR open → first review | Review events |
| Time from PR open → merge | PR API |
| Number of review comments (not just approvals) | Review API |
| Number of distinct reviewers | Review API |
| Self-merge (author merged own PR, no review) | PR + review API |
| AI-authored flag | Commit trailer parsing (`Co-authored-by: Claude`, `Co-authored-by: aider`, configurable list) |

### Scoring logic (v1, no ML — just rules)

```
reading_floor_seconds = max(30, lines_changed * 0.4)  # generous: ~2.5 lines/sec max plausible

flag = "likely rubber stamp" IF:
    lines_changed > 400
    AND time_to_first_review < 5 minutes
    AND comment_count == 0
    AND reviewer_count == 1

flag = "worth a second look" IF:
    lines_changed > 100
    AND time_to_first_review < reading_floor_seconds
```

Thresholds live in a `scrutinize.yml` config file per repo — every team's normal is different, and these are proxy signals, not proof. Frame it as a mirror, not a punishment. (One thing worth remembering going in: GitHub's API cannot tell you whether a human literally read every line — only timing, size, and comment density. That's a real ceiling on this approach, not a bug to fix later.)

### Output (v1)

A GitHub Check Run + PR comment, posted automatically, showing exactly which signals fired and why — fully transparent, no black box:

> ⚠️ **Scrutinize flag: worth a second look**
> 612 lines changed · approved in 47s · 0 comments · 1 reviewer
> This PR was also AI-authored (Claude Code).

## 3. Architecture

**Components:**
1. **Webhook receiver** — receives `pull_request`, `pull_request_review`, `issue_comment` events, verifies HMAC signature against the GitHub App's webhook secret.
2. **Score engine** — pure functions, no external calls, computes flags from stored event data.
3. **Database** — persists installations, PRs, reviews, computed scores, historical trend data.
4. **GitHub API client** — posts the Check Run / PR comment back using the App's installation token.
5. **Dashboard (phase 2, optional)** — reads aggregates from the DB, shows queue depth, pickup-time trend, % flagged.

**Recommended stack:**

| Layer | Choice | Why |
|---|---|---|
| Framework | [Probot](https://probot.github.io) (Node.js/TypeScript) | Purpose-built for GitHub Apps — handles webhook verification, event routing, and API auth for you |
| Database | SQLite for self-hosted default; Postgres (Supabase/Neon free tier) for hosted demo | Zero-config for self-host; scalable for the hosted version |
| Hosting (hosted demo) | Fly.io or Railway free tier | Needs a stable public URL for GitHub webhooks |
| Self-hosted path | Single `docker-compose up` | Real trust advantage — teams sensitive about review metadata can run it entirely on their own infra |
| Dashboard (later) | Next.js + GitHub OAuth | Only build once core scoring is validated |

### Data model (rough)

```
installations (id, github_installation_id, account_login, config_yaml)
pull_requests (id, installation_id, repo, pr_number, author, is_ai_authored,
               lines_changed, files_changed, opened_at, merged_at)
reviews (id, pull_request_id, reviewer, submitted_at, comment_count, state)
scores  (id, pull_request_id, flag_level, reasons_json, computed_at)
```

## 4. Build plan

**Phase 0 — Foundation (week 1–2)**
- Register the GitHub App (manifest flow), get webhook receiver live via Probot skeleton.
- Verify signature checking works; log raw events.
- Deploy skeleton to Fly.io/Railway free tier; confirm delivery on a real test repo.

**Phase 1 — Core scoring (week 2–4)**
- Implement the scoring rules above.
- Implement AI-authorship detection via commit trailer parsing.
- Post Check Run + PR comment with full reasoning shown.
- Backfill and test against ~200 real historical PRs from your own repos to sanity-check thresholds.

**Phase 2 — Config & polish (week 4–6)**
- `scrutinize.yml` for per-repo threshold tuning and path exemptions (e.g., exclude `/docs/`, generated files).
- Handle edge cases: bot accounts (Dependabot, Renovate), draft PRs, revert commits.

**Phase 3 — Dashboard (week 6–8, optional)**
- Queue depth, pickup-time trend, % flagged over time, per-repo breakdown.
- GitHub OAuth gated to installation members.

**Phase 4 — Launch**
- Open source the repo (aligns with "free," builds distribution and trust).
- List on GitHub Marketplace as a free app.
- Write a launch post using real before/after data from your own repos or willing beta testers.
- Post to Hacker News, r/programming, dev.to; submit to newsletter roundups (Console.dev, TLDR).

## 5. Honest risks going in

- **Proxy signals, not proof.** You're inferring "was this really reviewed" from timing and size — defensible, but not certain. Say so in the product itself.
- **The "culture, not tooling" objection is real.** At least one credible source argues rubber-stamp review is a leadership problem, not a software problem. Your answer: Scrutinize doesn't claim to fix culture — it makes the pattern visible so a team *can* fix it. Keep the tone diagnostic, never punitive.
- **AI-authorship detection is partial at launch.** Claude Code and Aider self-tag; Copilot and Cursor don't by default. You'll undercount AI PRs from those tools until you add a capture layer — say so, don't overclaim.
- **This is a workflow-integrity tool, not a code-quality tool.** Don't scope-creep into detecting code smells — that space is already won by well-funded incumbents. Stay in your lane.

## 6. Immediate next step

Scaffold the Probot app, register a test GitHub App against one of your own repos, and get a raw webhook event logging to console. Everything else builds on that working first.
