import { createClient } from "@libsql/client";
import path from "node:path";

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const LOCAL_DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "scrutinize.db");

export type DB = Awaited<ReturnType<typeof initDb>>;

export interface Job {
  id: number;
  deliveryId: string;
  eventType: string;
  installationId: number | null;
  payloadJson: string;
  attempts: number;
}

export async function initDb(dbPath?: string) {
  const isTurso = Boolean(TURSO_URL && !dbPath);

  let clientUrl = `file:${LOCAL_DB_PATH}`;
  if (dbPath === ":memory:") {
    clientUrl = ":memory:";
  } else if (dbPath) {
    clientUrl = `file:${dbPath}`;
  } else if (isTurso) {
    clientUrl = TURSO_URL!;
  }

  const client = createClient(
    isTurso && !dbPath
      ? { url: TURSO_URL!, authToken: TURSO_TOKEN }
      : { url: clientUrl }
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      author TEXT,
      is_ai_authored INTEGER DEFAULT 0,
      lines_changed INTEGER,
      files_changed INTEGER,
      opened_at TEXT,
      merged_at TEXT,
      UNIQUE(repo, pr_number)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pull_request_id INTEGER REFERENCES pull_requests(id),
      reviewer TEXT,
      submitted_at TEXT,
      comment_count INTEGER DEFAULT 0,
      state TEXT
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pull_request_id INTEGER REFERENCES pull_requests(id),
      flag TEXT NOT NULL,
      reasons_json TEXT,
      computed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL,
      installation_id INTEGER,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      claimed_at TEXT,
      processed_at TEXT
    );
  `);

  return {
    raw: client,

    async recordPullRequest(input: {
      repo: string;
      prNumber: number;
      author: string;
      isAiAuthored: boolean;
      linesChanged: number;
      filesChanged: number;
      openedAt: string;
      mergedAt: string | null;
    }): Promise<number> {
      const res = await client.execute({
        sql: `
          INSERT INTO pull_requests (repo, pr_number, author, is_ai_authored, lines_changed, files_changed, opened_at, merged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo, pr_number) DO UPDATE SET
            is_ai_authored = excluded.is_ai_authored,
            lines_changed = excluded.lines_changed,
            files_changed = excluded.files_changed,
            merged_at = excluded.merged_at
          RETURNING id
        `,
        args: [
          input.repo,
          input.prNumber,
          input.author,
          input.isAiAuthored ? 1 : 0,
          input.linesChanged,
          input.filesChanged,
          input.openedAt,
          input.mergedAt,
        ],
      });
      return Number(res.rows[0].id);
    },

    async recordScore(pullRequestId: number, flag: string, reasons: string[]): Promise<void> {
      await client.execute({
        sql: `INSERT INTO scores (pull_request_id, flag, reasons_json) VALUES (?, ?, ?)`,
        args: [pullRequestId, flag, JSON.stringify(reasons)],
      });
    },

    async enqueueJob(input: {
      deliveryId: string;
      eventType: string;
      installationId: number | null;
      payload: unknown;
    }): Promise<{ inserted: boolean; id: number | null }> {
      const res = await client.execute({
        sql: `
          INSERT INTO job_queue (delivery_id, event_type, installation_id, payload_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(delivery_id) DO NOTHING
          RETURNING id
        `,
        args: [
          input.deliveryId,
          input.eventType,
          input.installationId,
          JSON.stringify(input.payload),
        ],
      });

      if (res.rows.length > 0) {
        return { inserted: true, id: Number(res.rows[0].id) };
      }
      return { inserted: false, id: null };
    },

    async markJobDone(id: number): Promise<void> {
      await client.execute({
        sql: `UPDATE job_queue SET status = 'done', processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        args: [id],
      });
    },

    async markJobFailed(id: number, errorMessage: string): Promise<void> {
      await client.execute({
        sql: `UPDATE job_queue SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`,
        args: [errorMessage, id],
      });
    },

    async claimJob(id: number): Promise<boolean> {
      const res = await client.execute({
        sql: `
          UPDATE job_queue SET status = 'processing', claimed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('pending', 'failed')
        `,
        args: [id],
      });
      return res.rowsAffected > 0;
    },

    async getStaleJobs(staleAfterMinutes: number, maxAttempts: number, stuckAfterMinutes = 5): Promise<Job[]> {
      const res = await client.execute({
        sql: `
          SELECT id, delivery_id AS deliveryId, event_type AS eventType,
                 installation_id AS installationId, payload_json AS payloadJson, attempts
          FROM job_queue
          WHERE (status = 'pending' AND created_at <= datetime('now', ?))
             OR (status = 'processing' AND claimed_at <= datetime('now', ?))
             OR (status = 'failed' AND attempts < ?)
          ORDER BY created_at ASC
        `,
        args: [`-${staleAfterMinutes} minutes`, `-${stuckAfterMinutes} minutes`, maxAttempts],
      });

      return res.rows.map((row) => ({
        id: Number(row.id),
        deliveryId: String(row.deliveryId),
        eventType: String(row.eventType),
        installationId: row.installationId ? Number(row.installationId) : null,
        payloadJson: String(row.payloadJson),
        attempts: Number(row.attempts),
      }));
    },
  };
}
