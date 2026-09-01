import { neon } from "@neondatabase/serverless";
import { config } from "@/lib/config";
import type { EventRow, MonitorEvent, RunRow, SourceCheckResult, SourceName } from "@/lib/types";

let schemaReady: Promise<void> | undefined;

function sqlClient() {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not configured");
  return neon(config.databaseUrl);
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = sqlClient();
      await sql`CREATE TABLE IF NOT EXISTS monitor_events (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        occurred_at TIMESTAMPTZ,
        amount INTEGER,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        telegram_status TEXT NOT NULL DEFAULT 'pending',
        telegram_sent_at TIMESTAMPTZ,
        telegram_error TEXT
      )`;
      await sql`CREATE TABLE IF NOT EXISTS monitor_runs (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,
        ok BOOLEAN NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      )`;
      await sql`CREATE INDEX IF NOT EXISTS monitor_events_detected_at_idx ON monitor_events (detected_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS monitor_runs_started_at_idx ON monitor_runs (started_at DESC)`;
    })();
  }
  return schemaReady;
}

export async function insertEvent(event: MonitorEvent): Promise<number | null> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    INSERT INTO monitor_events (source, kind, fingerprint, title, occurred_at, amount, details)
    VALUES (
      ${event.source}, ${event.kind}, ${event.fingerprint}, ${event.title},
      ${event.occurredAt}, ${event.amount}, ${JSON.stringify(event.details)}::jsonb
    )
    ON CONFLICT (fingerprint) DO NOTHING
    RETURNING id
  ` as unknown as { id: number }[];
  return rows[0]?.id ?? null;
}

export async function recordRun(result: SourceCheckResult, startedAt: string, finishedAt: string) {
  await ensureSchema();
  const sql = sqlClient();
  await sql`
    INSERT INTO monitor_runs (source, started_at, finished_at, ok, event_count, error)
    VALUES (
      ${result.source}, ${startedAt}, ${finishedAt}, ${!result.error},
      ${result.events.length}, ${result.error ?? null}
    )
  `;
}

export async function updateTelegramDelivery(id: number, status: "sent" | "failed", error?: string) {
  await ensureSchema();
  const sql = sqlClient();
  await sql`
    UPDATE monitor_events
    SET telegram_status = ${status},
        telegram_sent_at = CASE WHEN ${status} = 'sent' THEN NOW() ELSE telegram_sent_at END,
        telegram_error = ${error ?? null}
    WHERE id = ${id}
  `;
}

export async function recentEvents(limit = 20): Promise<EventRow[]> {
  if (!config.databaseUrl) return [];
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT
      id, source, kind, fingerprint, title, occurred_at AS "occurredAt", amount,
      details, detected_at AS "detectedAt", telegram_status AS "telegramStatus",
      telegram_error AS "telegramError"
    FROM monitor_events
    ORDER BY detected_at DESC
    LIMIT ${limit}
  ` as unknown as EventRow[];
  return rows;
}

export async function recentRuns(limit = 12): Promise<RunRow[]> {
  if (!config.databaseUrl) return [];
  await ensureSchema();
  const sql = sqlClient();
  return await sql`
    SELECT
      id, source, started_at AS "startedAt", finished_at AS "finishedAt", ok,
      event_count AS "eventCount", error
    FROM monitor_runs
    ORDER BY started_at DESC
    LIMIT ${limit}
  ` as unknown as RunRow[];
}

export async function sourceEventCount(source: SourceName): Promise<number> {
  if (!config.databaseUrl) return 0;
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT COUNT(*)::text AS count FROM monitor_events WHERE source = ${source}
  ` as unknown as { count: string }[];
  return Number(rows[0]?.count ?? 0);
}
