import type { Probot } from "probot";
import { initDb, type DB, type Job } from "./db.js";
import { processReviewSubmitted, processPullRequestClosed } from "./worker.js";

const SWEEP_INTERVAL_MS = 60_000;
const STALE_AFTER_MINUTES = 2; // give the fire-and-forget path time to finish normally first
const MAX_ATTEMPTS = 5;

async function runJob(app: Probot, db: DB, job: Job): Promise<void> {
  // Whoever claims it first wins. If the sweep finds a job that the original
  // fire-and-forget call is still actively working on, this returns false
  // and we skip — that's the fix for the exact race a naive queue has: a
  // slow job (rate-limited GitHub API, a burst of PRs) getting picked up a
  // second time by the sweep while the first run hasn't finished yet.
  const claimed = await db.claimJob(job.id);
  if (!claimed) {
    app.log.info({ jobId: job.id }, "Job already claimed elsewhere, skipping");
    return;
  }

  try {
    const payload = JSON.parse(job.payloadJson);
    if (job.eventType === "pull_request_review.submitted") {
      await processReviewSubmitted(app, db, payload);
    } else if (job.eventType === "pull_request.closed") {
      await processPullRequestClosed(app, db, payload);
    } else {
      app.log.warn({ jobId: job.id, eventType: job.eventType }, "Unknown job type, skipping");
    }
    await db.markJobDone(job.id);
  } catch (err: any) {
    app.log.error(
      { jobId: job.id, eventType: job.eventType, error: err?.message ?? String(err) },
      "Job failed — will retry on next sweep if under the attempt limit"
    );
    await db.markJobFailed(job.id, err?.message ?? String(err));
  }
}

export default async (app: Probot) => {
  const db = await initDb();

  // Every handler below does the same thing: verify already happened
  // (Probot's job, before this code runs), enqueue durably, and return
  // immediately. Processing happens after the handler returns — that's
  // what keeps the webhook response fast regardless of how slow the actual
  // GitHub API calls end up being.
  async function enqueueAndRun(
    context: { id: string; payload: any },
    eventType: string
  ): Promise<void> {
    const { inserted, id } = await db.enqueueJob({
      deliveryId: context.id,
      eventType,
      installationId: context.payload.installation?.id ?? null,
      payload: context.payload,
    });

    if (!inserted) {
      app.log.info({ deliveryId: context.id, eventType }, "Duplicate delivery, skipping");
      return;
    }

    // Deliberately not awaited: the webhook handler returns as soon as this
    // line runs, while the actual work continues in the background. If the
    // process dies before this finishes, the row is still in job_queue as
    // 'pending' and the sweep below will pick it up.
    void runJob(app, db, {
      id: id!,
      deliveryId: context.id,
      eventType,
      installationId: context.payload.installation?.id ?? null,
      payloadJson: JSON.stringify(context.payload),
      attempts: 0,
    });
  }

  app.on("pull_request_review.submitted", (context) =>
    enqueueAndRun(context, "pull_request_review.submitted")
  );

  app.on("pull_request.closed", (context) =>
    enqueueAndRun(context, "pull_request.closed")
  );

  // Safety net: catches jobs that never got marked done or failed (a crash
  // mid-flight) and retries failed jobs that haven't hit the attempt limit.
  setInterval(async () => {
    const stale = await db.getStaleJobs(STALE_AFTER_MINUTES, MAX_ATTEMPTS);
    if (stale.length > 0) {
      app.log.info({ count: stale.length }, "Sweep picking up stale/failed jobs");
    }
    for (const job of stale) {
      void runJob(app, db, job);
    }
  }, SWEEP_INTERVAL_MS);
};
