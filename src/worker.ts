import type { Probot } from "probot";
import type { DB } from "./db.js";
import { scorePullRequest, type PRReviewData, type Flag } from "./scoring.js";

const AI_COAUTHOR_PATTERNS = [
  /co-authored-by:\s*claude/i,
  /co-authored-by:\s*aider/i,
];

function detectAiAuthored(commitMessages: string[]): boolean {
  return commitMessages.some((msg) =>
    AI_COAUTHOR_PATTERNS.some((pattern) => pattern.test(msg))
  );
}

const CHECK_NAME = "Scrutinize";

/**
 * Finds an existing Scrutinize check run by name among a list of check runs.
 * Pulled out as a pure function so the "don't stack duplicate check runs"
 * logic is testable without mocking the GitHub API.
 */
export function findExistingCheckRun(
  checkRuns: { id: number; name: string }[],
  name: string = CHECK_NAME
): number | null {
  const match = checkRuns.find((c) => c.name === name);
  return match ? match.id : null;
}

async function postCheck(
  octokit: any,
  owner: string,
  repo: string,
  headSha: string,
  flag: Exclude<Flag, "clean">,
  reasons: string[]
) {
  const output = {
    title:
      flag === "likely_rubber_stamp"
        ? "\u26a0\ufe0f Likely rubber-stamp review"
        : "\ud83d\udc40 Worth a second look",
    summary: reasons.join("\n"),
  };
  const conclusion = flag === "likely_rubber_stamp" ? "action_required" : "neutral";

  // A PR can generate multiple pull_request_review.submitted events (each
  // new reviewer, or the same reviewer re-reviewing). Without this check,
  // every one of those posts a brand new "Scrutinize" check run, and the PR
  // ends up with five stacked, redundant checks instead of one that reflects
  // the current state. Look for an existing one on this exact commit first.
  const { data: existing } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: CHECK_NAME,
  });

  const existingId = findExistingCheckRun(existing.check_runs, CHECK_NAME);

  if (existingId) {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: existingId,
      conclusion,
      output,
    });
  } else {
    await octokit.rest.checks.create({
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output,
    });
  }
}

/**
 * Processes a pull_request_review.submitted event. Takes the raw payload
 * rather than a Probot Context, deliberately \u2014 that's what lets this run
 * both immediately (fire-and-forget from index.ts) and later, from the
 * sweep, using a freshly re-authenticated client instead of a context
 * object that may no longer exist.
 */
export async function processReviewSubmitted(
  app: Probot,
  db: DB,
  payload: any
): Promise<void> {
  const installationId = payload.installation?.id;
  const octokit = await app.auth(installationId);

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pull_number = payload.pull_request.number;
  const repoFullName = payload.repository.full_name;

  // octokit.paginate, not the raw .list*() calls \u2014 the raw calls return only
  // the first page (30 items by default). A well-discussed PR with 40+
  // review comments, or a long-lived PR with 30+ commits, would silently
  // undercount without this, which biases the score toward false positives
  // (looks less-reviewed than it actually was).
  const [fullPrResponse, commits, reviews, reviewComments] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number }),
    octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number }),
    octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number }),
  ]);
  const fullPr = fullPrResponse.data;

  const isAiAuthored = detectAiAuthored(commits.map((c: any) => c.commit.message));
  const sortedReviews = reviews
    .filter((r: any) => r.submitted_at)
    .sort(
      (a: any, b: any) =>
        new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()
    );
  const firstReview = sortedReviews[0];
  const distinctReviewers = new Set(reviews.map((r: any) => r.user?.login)).size;

  const data: PRReviewData = {
    linesChanged: (fullPr.additions || 0) + (fullPr.deletions || 0),
    openedAt: new Date(fullPr.created_at),
    firstReviewAt: firstReview ? new Date(firstReview.submitted_at!) : null,
    commentCount: reviewComments.length,
    reviewerCount: distinctReviewers,
    isAiAuthored,
    selfMerged: false,
  };

  const result = scorePullRequest(data);

  const prId = await db.recordPullRequest({
    repo: repoFullName,
    prNumber: pull_number,
    author: fullPr.user?.login ?? "unknown",
    isAiAuthored,
    linesChanged: data.linesChanged,
    filesChanged: fullPr.changed_files ?? 0,
    openedAt: fullPr.created_at,
    mergedAt: fullPr.merged_at ?? null,
  });
  await db.recordScore(prId, result.flag, result.reasons);

  if (result.flag !== "clean") {
    await postCheck(octokit, owner, repo, fullPr.head.sha, result.flag, result.reasons);
  }

  app.log.info({ repo: repoFullName, pr: pull_number, flag: result.flag }, "Scored PR review");
}

/**
 * Processes a pull_request.closed event, catching self-merges with
 * genuinely no review. A self-merge where someone else reviewed and
 * approved first is completely normal \u2014 only flag it when there was no
 * review at all before the author merged their own PR.
 */
export async function processPullRequestClosed(
  app: Probot,
  db: DB,
  payload: any
): Promise<void> {
  const pr = payload.pull_request;
  if (!pr.merged) return;
  if (pr.merged_by?.login !== pr.user?.login) return;

  const installationId = payload.installation?.id;
  const octokit = await app.auth(installationId);
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const repoFullName = payload.repository.full_name;

  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pr.number,
  });

  if (reviews.length > 0) {
    // The author clicked "merge," but somebody reviewed it first. Not a
    // rubber stamp \u2014 don't record anything new here; if the review was
    // worth flagging, pull_request_review.submitted already handled it.
    app.log.info(
      { repo: repoFullName, pr: pr.number },
      "Self-merge, but had a prior review \u2014 not flagging"
    );
    return;
  }

  const result = scorePullRequest({
    linesChanged: (pr.additions || 0) + (pr.deletions || 0),
    openedAt: new Date(pr.created_at),
    firstReviewAt: null,
    commentCount: 0,
    reviewerCount: 0,
    isAiAuthored: false,
    selfMerged: true,
  });

  const prId = await db.recordPullRequest({
    repo: repoFullName,
    prNumber: pr.number,
    author: pr.user?.login ?? "unknown",
    isAiAuthored: false,
    linesChanged: (pr.additions || 0) + (pr.deletions || 0),
    filesChanged: pr.changed_files ?? 0,
    openedAt: pr.created_at,
    mergedAt: pr.merged_at,
  });
  await db.recordScore(prId, result.flag, result.reasons);

  if (result.flag !== "clean") {
    await postCheck(octokit, owner, repo, pr.head.sha, result.flag, result.reasons);
  }

  app.log.info(
    { repo: repoFullName, pr: pr.number, flag: result.flag },
    "Scored self-merge"
  );
}
