import { test } from "node:test";
import assert from "node:assert/strict";
import { initDb } from "./db.js";

async function freshDb() {
  // ":memory:" — a real SQLite engine, isolated per test, gone when it closes.
  return await initDb(":memory:");
}

test("enqueueJob accepts a new delivery", async () => {
  const db = await freshDb();
  const result = await db.enqueueJob({
    deliveryId: "delivery-1",
    eventType: "pull_request_review.submitted",
    installationId: 123,
    payload: { hello: "world" },
  });
  assert.equal(result.inserted, true);
  assert.ok(result.id);
});

test("enqueueJob rejects a redelivered event — this is the idempotency guarantee", async () => {
  const db = await freshDb();
  const first = await db.enqueueJob({
    deliveryId: "delivery-2",
    eventType: "pull_request_review.submitted",
    installationId: 123,
    payload: { attempt: 1 },
  });
  const redelivery = await db.enqueueJob({
    deliveryId: "delivery-2", // GitHub retried with the SAME delivery ID
    eventType: "pull_request_review.submitted",
    installationId: 123,
    payload: { attempt: 2 },
  });

  assert.equal(first.inserted, true);
  assert.equal(redelivery.inserted, false);
  assert.equal(redelivery.id, null);
});

test("two different deliveries are both accepted", async () => {
  const db = await freshDb();
  const a = await db.enqueueJob({
    deliveryId: "delivery-a",
    eventType: "pull_request.closed",
    installationId: 1,
    payload: {},
  });
  const b = await db.enqueueJob({
    deliveryId: "delivery-b",
    eventType: "pull_request.closed",
    installationId: 1,
    payload: {},
  });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true);
  assert.notEqual(a.id, b.id);
});

test("a freshly enqueued job is NOT picked up as stale yet", async () => {
  const db = await freshDb();
  await db.enqueueJob({
    deliveryId: "delivery-fresh",
    eventType: "pull_request.closed",
    installationId: 1,
    payload: {},
  });
  const stale = await db.getStaleJobs(2, 5); // 2-minute staleness window
  assert.equal(stale.length, 0);
});

test("a job marked done is never picked up by the sweep again", async () => {
  const db = await freshDb();
  const { id } = await db.enqueueJob({
    deliveryId: "delivery-done",
    eventType: "pull_request.closed",
    installationId: 1,
    payload: {},
  });
  await db.markJobDone(id!);
  // Even with a 0-minute staleness window (i.e. "everything counts as old"),
  // a done job must not resurface.
  const stale = await db.getStaleJobs(0, 5);
  assert.equal(stale.find((j) => j.id === id), undefined);
});

test("a failed job under the attempt limit is retried by the sweep", async () => {
  const db = await freshDb();
  const { id } = await db.enqueueJob({
    deliveryId: "delivery-failed",
    eventType: "pull_request.closed",
    installationId: 1,
    payload: {},
  });
  await db.markJobFailed(id!, "GitHub API timed out");
  const stale = await db.getStaleJobs(999, 5); // staleness window irrelevant for failed jobs
  assert.ok(stale.find((j) => j.id === id));
});

test("a failed job that hit the attempt limit is NOT retried again", async () => {
  const db = await freshDb();
  const { id } = await db.enqueueJob({
    deliveryId: "delivery-exhausted",
    eventType: "pull_request.closed",
    installationId: 1,
    payload: {},
  });
  for (let i = 0; i < 5; i++) {
    await db.markJobFailed(id!, "still broken");
  }
  const stale = await db.getStaleJobs(999, 5); // max 5 attempts, already used 5
  assert.equal(stale.find((j) => j.id === id), undefined);
});

test("claimJob succeeds exactly once when two callers race for the same job — this is the actual bug fix", async () => {
  const db = await freshDb();
  const { id } = await db.enqueueJob({
    deliveryId: "delivery-race",
    eventType: "pull_request_review.submitted",
    installationId: 1,
    payload: {},
  });

  // Simulates the real scenario found in review: the fire-and-forget path
  // and a sweep tick both find the same still-pending job and both try to
  // claim it. Only one may win.
  const firstClaim = await db.claimJob(id!);
  const secondClaim = await db.claimJob(id!);

  assert.equal(firstClaim, true);
  assert.equal(secondClaim, false);
});

test("a job that is claimed (processing) does not show up as a fresh pending job", async () => {
  const db = await freshDb();
  const { id } = await db.enqueueJob({
    deliveryId: "delivery-inflight",
    eventType: "pull_request_review.submitted",
    installationId: 1,
    payload: {},
  });
  await db.claimJob(id!);
  // With a generous staleness window, a job that was *just* claimed must
  // not be treated as abandoned — only genuinely stuck jobs (claimed a long
  // time ago, never finished) should resurface.
  const stale = await db.getStaleJobs(2, 5, 5);
  assert.equal(stale.find((j) => j.id === id), undefined);
});

test("a job claimed but never finished (crash mid-processing) is picked up once stuck long enough", async () => {
  const db = await freshDb();
  const { id } = await db.enqueueJob({
    deliveryId: "delivery-crashed",
    eventType: "pull_request_review.submitted",
    installationId: 1,
    payload: {},
  });
  await db.claimJob(id!);
  // Force claimed_at into the past to simulate "claimed 10 minutes ago and
  // never came back" — a real process crash mid-job.
  await db.raw.execute({
    sql: "UPDATE job_queue SET claimed_at = datetime('now', '-10 minutes') WHERE id = ?",
    args: [id!],
  });

  const stale = await db.getStaleJobs(2, 5, 5); // stuckAfterMinutes = 5
  assert.ok(stale.find((j) => j.id === id));
});

test("after claimJob, a second claim succeeds again once the job is marked failed (retry eligibility)", async () => {
  const db = await freshDb();
  const { id } = await db.enqueueJob({
    deliveryId: "delivery-retry",
    eventType: "pull_request.closed",
    installationId: 1,
    payload: {},
  });
  assert.equal(await db.claimJob(id!), true);
  await db.markJobFailed(id!, "GitHub API timed out");
  // Failed jobs go back to being claimable — that's what makes retry work.
  assert.equal(await db.claimJob(id!), true);
});
