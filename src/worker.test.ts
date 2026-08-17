import { test } from "node:test";
import assert from "node:assert/strict";
import { findExistingCheckRun } from "./worker.js";

test("finds an existing Scrutinize check run among several", () => {
  const checkRuns = [
    { id: 1, name: "ci/build" },
    { id: 2, name: "Scrutinize" },
    { id: 3, name: "codecov" },
  ];
  assert.equal(findExistingCheckRun(checkRuns), 2);
});

test("returns null when no Scrutinize check run exists yet", () => {
  const checkRuns = [
    { id: 1, name: "ci/build" },
    { id: 3, name: "codecov" },
  ];
  assert.equal(findExistingCheckRun(checkRuns), null);
});

test("does not false-match a similarly named check", () => {
  const checkRuns = [{ id: 5, name: "Scrutinize (legacy)" }];
  assert.equal(findExistingCheckRun(checkRuns), null);
});

test("returns null on an empty list", () => {
  assert.equal(findExistingCheckRun([]), null);
});
