/**
 * Scrutinize scoring engine.
 *
 * Deterministic, rule-based. No ML model, no external calls — pure functions
 * over data already available from the GitHub API. Every flag is explainable:
 * the reasons array says exactly which signals fired and why.
 */

export interface PRReviewData {
  linesChanged: number;
  openedAt: Date;
  firstReviewAt: Date | null;
  commentCount: number;
  reviewerCount: number;
  isAiAuthored: boolean;
  selfMerged: boolean;
}

export type Flag = "clean" | "worth_a_look" | "likely_rubber_stamp";

export interface ScoreResult {
  flag: Flag;
  reasons: string[];
}

// A deliberately generous floor: no reviewer can meaningfully read code
// faster than this. ~2.5 lines/second absolute ceiling, 30s minimum.
const SECONDS_PER_LINE_FLOOR = 0.4;
const MIN_FLOOR_SECONDS = 30;

// Thresholds for the high-confidence "likely rubber stamp" rule.
const BIG_DIFF_LINES = 400;
const VERY_FAST_SECONDS = 300; // 5 minutes

// Threshold for the softer "worth a look" rule.
const MEDIUM_DIFF_LINES = 100;

export function readingFloorSeconds(linesChanged: number): number {
  return Math.max(MIN_FLOOR_SECONDS, linesChanged * SECONDS_PER_LINE_FLOOR);
}

export function scorePullRequest(data: PRReviewData): ScoreResult {
  if (data.selfMerged) {
    return {
      flag: "likely_rubber_stamp",
      reasons: ["Merged by the author with no review at all"],
    };
  }

  if (!data.firstReviewAt) {
    return { flag: "clean", reasons: ["No review yet — nothing to score"] };
  }

  const timeToReviewSeconds =
    (data.firstReviewAt.getTime() - data.openedAt.getTime()) / 1000;
  const floor = readingFloorSeconds(data.linesChanged);

  const bigDiff = data.linesChanged > BIG_DIFF_LINES;
  const veryFast = timeToReviewSeconds < VERY_FAST_SECONDS;
  const noComments = data.commentCount === 0;
  const singleReviewer = data.reviewerCount <= 1;

  if (bigDiff && veryFast && noComments && singleReviewer) {
    return {
      flag: "likely_rubber_stamp",
      reasons: [
        `${data.linesChanged} lines changed, approved in ${Math.round(
          timeToReviewSeconds
        )}s, 0 comments, 1 reviewer`,
      ],
    };
  }

  const mediumDiff = data.linesChanged > MEDIUM_DIFF_LINES;
  const fasterThanFloor = timeToReviewSeconds < floor;

  if (mediumDiff && fasterThanFloor) {
    return {
      flag: "worth_a_look",
      reasons: [
        `${data.linesChanged} lines changed in ${Math.round(
          timeToReviewSeconds
        )}s — faster than a ${Math.round(floor)}s reading floor`,
      ],
    };
  }

  if (data.isAiAuthored && noComments) {
    return {
      flag: "worth_a_look",
      reasons: ["AI-authored PR merged with zero review comments"],
    };
  }

  return { flag: "clean", reasons: ["No rubber-stamp signals detected"] };
}
