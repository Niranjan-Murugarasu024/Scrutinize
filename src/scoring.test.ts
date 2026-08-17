import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePullRequest, readingFloorSeconds } from "./scoring.js";

test("flags a classic rubber stamp: huge diff, instant approval, no comments", () => {
  const result = scorePullRequest({
    linesChanged: 612,
    openedAt: new Date("2026-01-01T00:00:00Z"),
    firstReviewAt: new Date("2026-01-01T00:00:47Z"),
    commentCount: 0,
    reviewerCount: 1,
    isAiAuthored: true,
    selfMerged: false,
  });
  assert.equal(result.flag, "likely_rubber_stamp");
  assert.match(result.reasons[0], /612 lines/);
});

test("does not flag a genuinely reviewed small PR", () => {
  const result = scorePullRequest({
    linesChanged: 40,
    openedAt: new Date("2026-01-01T00:00:00Z"),
    firstReviewAt: new Date("2026-01-01T00:15:00Z"),
    commentCount: 3,
    reviewerCount: 1,
    isAiAuthored: false,
    selfMerged: false,
  });
  assert.equal(result.flag, "clean");
});

test("flags self-merge with no review regardless of size", () => {
  const result = scorePullRequest({
    linesChanged: 20,
    openedAt: new Date(),
    firstReviewAt: null,
    commentCount: 0,
    reviewerCount: 0,
    isAiAuthored: false,
    selfMerged: true,
  });
  assert.equal(result.flag, "likely_rubber_stamp");
});

test("does not flag a PR that has no review yet", () => {
  const result = scorePullRequest({
    linesChanged: 900,
    openedAt: new Date(),
    firstReviewAt: null,
    commentCount: 0,
    reviewerCount: 0,
    isAiAuthored: false,
    selfMerged: false,
  });
  assert.equal(result.flag, "clean");
});

test("medium diff reviewed faster than the reading floor gets a soft flag", () => {
  const result = scorePullRequest({
    linesChanged: 150,
    openedAt: new Date("2026-01-01T00:00:00Z"),
    firstReviewAt: new Date("2026-01-01T00:00:10Z"), // 10s, floor is 60s
    commentCount: 0,
    reviewerCount: 2,
    isAiAuthored: false,
    selfMerged: false,
  });
  assert.equal(result.flag, "worth_a_look");
});

test("AI-authored PR with zero comments gets a soft flag even if not fast", () => {
  const result = scorePullRequest({
    linesChanged: 30,
    openedAt: new Date("2026-01-01T00:00:00Z"),
    firstReviewAt: new Date("2026-01-01T02:00:00Z"),
    commentCount: 0,
    reviewerCount: 1,
    isAiAuthored: true,
    selfMerged: false,
  });
  assert.equal(result.flag, "worth_a_look");
});

test("reading floor scales with diff size but has a 30s minimum", () => {
  assert.equal(readingFloorSeconds(10), 30);
  assert.ok(readingFloorSeconds(1000) > 30);
  assert.equal(readingFloorSeconds(1000), 400);
});
