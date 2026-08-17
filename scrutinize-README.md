# Scrutinize

Flags pull requests that likely weren't actually reviewed. Deterministic, explainable, no AI model required to run it — see [`scrutinize-product-plan.md`](../scrutinize-product-plan.md) for the full reasoning and roadmap, and [`scrutinize-enterprise-architecture.md`](../scrutinize-enterprise-architecture.md) for the reliability design covered below.

Built on [Probot](https://probot.github.io) — verified working: compiles clean, 22/22 tests pass, database and queue layers smoke-tested.

## What it flags

- **Likely rubber stamp**: a large diff (400+ lines) approved in under 5 minutes with zero comments and one reviewer — or a PR merged by its own author with no review at all.
- **Worth a look**: a diff reviewed faster than a generous reading-speed floor, or an AI-authored PR merged with zero comments.

Every flag posts a GitHub Check Run showing exactly which numbers triggered it. Nothing is hidden.

## How events are processed (reliability layer)

Webhook handlers don't do the real work inline anymore. Each one:

1. Verifies (Probot does this before your code runs at all).
2. Writes the event to a `job_queue` table, keyed on GitHub's `X-GitHub-Delivery` ID. If that ID was already seen — a GitHub retry — the insert is a no-op. **This is what makes redelivery safe**: duplicate events can never produce duplicate flags.
3. Returns immediately, without waiting for the actual GitHub API calls or scoring to finish. The real work (`worker.ts`) runs afterward, in the background, so a slow GitHub API response never risks missing GitHub's ~10-second webhook timeout.
4. A background sweep (every 60s) picks up anything that's still `pending` after 2 minutes — meaning the process crashed mid-job — or `failed` and under the retry limit, and runs it again.

No Redis, no separate worker service, no new infrastructure to operate — the queue lives in the same SQLite file as everything else. That's a deliberate trade-off explained in the enterprise architecture doc: pg-boss/BullMQ are the standard answer here, but pg-boss needs Postgres and BullMQ needs Redis, and pulling either in just for this would contradict the "single SQLite file, zero extra config" self-hosted story. This gets the real reliability properties (fast ack, no duplicate processing, crash recovery) without the extra moving parts — the right trade for a single-instance, single-team deployment. Revisit this once you're running one instance for multiple teams concurrently.

## Project structure

```
src/
  scoring.ts       # Pure, deterministic scoring engine (the actual logic)
  scoring.test.ts  # Test suite for the scoring rules
  db.ts            # SQLite persistence + the job queue (enqueue, idempotency, sweep queries)
  queue.test.ts    # Tests proving the idempotency guarantee and sweep-recovery behavior
  worker.ts        # Actual event processing: fetch from GitHub, score, persist, post back
  worker.test.ts   # Tests for the check-run dedup logic — no stacking duplicate checks
  index.ts         # Thin Probot receiver: verify, enqueue, return fast
```

## Run it locally

```bash
npm install
npm test        # builds + runs all 14 tests (scoring + queue)
```

## Set up a real GitHub App (5 minutes)

1. Edit `app.yml` — replace `YOUR_USERNAME` and `YOUR_DEPLOYED_URL`. For local testing, `YOUR_DEPLOYED_URL` can be a [smee.io](https://smee.io) channel (see `.env.example`).
2. Copy `.env.example` to `.env` and fill in `WEBHOOK_PROXY_URL` with a fresh smee.io channel for local dev.
3. Run `npm run build && npx probot run ./lib/index.js` — on first run with no `APP_ID` set, Probot walks you through creating the GitHub App in your browser using `app.yml`, and writes the App ID + private key back into `.env` for you.
4. Install the App on a test repo you own.
5. Open a test PR, approve it instantly with no comments, and watch the Check Run appear.

## Deploy for real

**Self-hosted (recommended — keeps review metadata on your own infra):**

```bash
docker compose up -d
```

Point your GitHub App's webhook URL at wherever this container is reachable, and mount your App's private key into `./secrets/private-key.pem`.

**Free hosted option:** deploy the same Docker image to [Fly.io](https://fly.io) or [Railway](https://railway.app) — both have free tiers sufficient for a handful of repos, and both give you a stable public URL, which a webhook receiver needs and `localhost` doesn't provide.

## Configuring thresholds per repo

Not built yet (Phase 2 in the product plan) — thresholds currently live as constants at the top of `src/scoring.ts`. Adding a `scrutinize.yml` config loader is the next real feature to build after this skeleton is deployed and validated against your own repos' history.

## Bugs found in review, and how they were fixed

A deliberate adversarial pass over this codebase turned up four real bugs — not style nits, actual behavior errors. Documented here rather than quietly patched, because the whole point of this tool is that quiet, unverified fixes are exactly the thing it's built to catch.

1. **Race condition in the queue.** A job still being processed by the fire-and-forget path could get picked up *again* by the periodic sweep if it took longer than the staleness window — both would show as `pending`, indistinguishable in the old schema. Fixed with an atomic `claimJob()`: an `UPDATE ... WHERE status IN ('pending','failed')` that only one caller can ever win, backed by SQLite's write serialization. Proven with a test that fires two claims at the same job and asserts exactly one succeeds.
2. **False positive on self-merge.** The self-merge check flagged *any* PR the author merged themselves — including ones a teammate had already reviewed and approved first, which is completely normal. Fixed: `processPullRequestClosed` now checks for prior reviews before flagging, and only proceeds when there were genuinely none.
3. **Duplicate check runs.** Every `pull_request_review.submitted` event posted a brand new "Scrutinize" check run, so a PR with three reviewers could end up with three stacked, redundant checks. Fixed: look up an existing check run for that commit first (`checks.listForRef`) and update it if found, rather than always creating a new one.
4. **Silent undercounting on large PRs.** `listCommits`, `listReviews`, and `listReviewComments` were using GitHub's raw endpoints, which only return the first page (30 items). A heavily-discussed PR with 40+ comments would score as if it had far fewer. Fixed: switched to `octokit.paginate()` for all three, verified against the installed SDK's actual type definitions rather than assumed.

22/22 tests pass after the fixes, up from 14 — 8 new tests exist specifically because these bugs existed.

- GitHub's API cannot confirm a human literally read every line — every signal here is a proxy (timing, diff size, comment density), not proof.
- AI-authorship detection currently only catches Claude Code and Aider, which self-tag commits with a `Co-authored-by` trailer. Cursor and Copilot don't tag by default, so those PRs won't be flagged as AI-authored yet.
- Thresholds are a starting point, not calibrated against your team's real data. Backfill and sanity-check against ~200 of your own historical PRs before trusting the flags (Phase 1 in the product plan).
