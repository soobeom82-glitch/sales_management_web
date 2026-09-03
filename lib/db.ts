import { neon } from "@neondatabase/serverless";
import { config } from "@/lib/config";
import type {
  DailyReportRow,
  DailySalesMetric,
  DailySalesReport,
  EventRow,
  MonitorEvent,
  ProductSalesMetric,
  RunRow,
  SalesTransaction,
  SourceCheckResult,
  SourceName,
  SourceReportHealth,
} from "@/lib/types";

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
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )`;
      await sql`ALTER TABLE monitor_runs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`;
      await sql`CREATE TABLE IF NOT EXISTS sales_transactions (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ,
        business_date DATE NOT NULL,
        amount INTEGER NOT NULL,
        product_name TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        status TEXT,
        is_canceled BOOLEAN NOT NULL DEFAULT FALSE,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source, external_id)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS daily_reports (
        report_date DATE PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'processing',
        payload JSONB,
        generated_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        error TEXT
      )`;
      await sql`CREATE TABLE IF NOT EXISTS monitor_job_locks (
        job_name TEXT PRIMARY KEY,
        locked_until TIMESTAMPTZ NOT NULL,
        last_started_at TIMESTAMPTZ NOT NULL,
        last_finished_at TIMESTAMPTZ,
        last_error TEXT
      )`;
      await sql`CREATE INDEX IF NOT EXISTS monitor_events_detected_at_idx ON monitor_events (detected_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS monitor_runs_started_at_idx ON monitor_runs (started_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS sales_transactions_date_source_idx ON sales_transactions (business_date DESC, source)`;
      await sql`CREATE INDEX IF NOT EXISTS sales_transactions_date_product_idx ON sales_transactions (business_date DESC, product_name) WHERE NOT is_canceled`;
    })();
  }
  return schemaReady;
}

export async function reserveEventDelivery(event: MonitorEvent): Promise<number | null> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    INSERT INTO monitor_events (source, kind, fingerprint, title, occurred_at, amount, details)
    VALUES (
      ${event.source}, ${event.kind}, ${event.fingerprint}, ${event.title},
      ${event.occurredAt}, ${event.amount}, ${JSON.stringify(event.details)}::jsonb
    )
    ON CONFLICT (fingerprint) DO UPDATE
    SET telegram_status = 'pending', telegram_error = NULL
    WHERE monitor_events.telegram_status = 'failed'
    RETURNING id
  ` as unknown as { id: number }[];
  return rows[0]?.id ?? null;
}

export async function tryAcquireJobLock(jobName: string, leaseSeconds: number): Promise<boolean> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    INSERT INTO monitor_job_locks (job_name, locked_until, last_started_at, last_finished_at, last_error)
    VALUES (
      ${jobName},
      NOW() + (${leaseSeconds} * INTERVAL '1 second'),
      NOW(),
      NULL,
      NULL
    )
    ON CONFLICT (job_name) DO UPDATE
    SET
      locked_until = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
      last_started_at = NOW(),
      last_finished_at = NULL,
      last_error = NULL
    WHERE monitor_job_locks.locked_until <= NOW()
    RETURNING job_name
  ` as unknown as { job_name: string }[];
  return rows.length > 0;
}

export async function releaseJobLock(jobName: string, error?: string) {
  await ensureSchema();
  const sql = sqlClient();
  await sql`
    UPDATE monitor_job_locks
    SET locked_until = NOW(), last_finished_at = NOW(), last_error = ${error ?? null}
    WHERE job_name = ${jobName}
  `;
}

export async function recordRun(result: SourceCheckResult, startedAt: string, finishedAt: string) {
  await ensureSchema();
  const sql = sqlClient();
  await sql`
    INSERT INTO monitor_runs (source, started_at, finished_at, ok, event_count, error, metadata)
    VALUES (
      ${result.source}, ${startedAt}, ${finishedAt}, ${!result.error},
      ${result.events.length}, ${result.error ?? null}, ${JSON.stringify(result.metadata ?? {})}::jsonb
    )
  `;
}

export async function storeSalesTransactions(transactions: SalesTransaction[]) {
  if (transactions.length === 0) return;
  await ensureSchema();
  const sql = sqlClient();

  // Neon transactions keep a reconciliation-sized batch atomic without opening
  // hundreds of independent HTTP requests to the database.
  for (const batch of chunk(transactions, 100)) {
    const insertQueries = batch.map((transaction) => sql`
      INSERT INTO sales_transactions (
        source, external_id, occurred_at, business_date, amount, product_name,
        quantity, status, is_canceled, details
      ) VALUES (
        ${transaction.source}, ${transaction.externalId}, ${transaction.occurredAt},
        ${transaction.businessDate}::DATE, ${transaction.amount}, ${transaction.productName},
        ${transaction.quantity}, ${transaction.status}, ${transaction.isCanceled},
        ${JSON.stringify(transaction.details)}::jsonb
      )
      ON CONFLICT (source, external_id) DO UPDATE
      SET
        occurred_at = COALESCE(EXCLUDED.occurred_at, sales_transactions.occurred_at),
        business_date = EXCLUDED.business_date,
        amount = EXCLUDED.amount,
        product_name = COALESCE(EXCLUDED.product_name, sales_transactions.product_name),
        quantity = EXCLUDED.quantity,
        status = COALESCE(EXCLUDED.status, sales_transactions.status),
        is_canceled = sales_transactions.is_canceled OR EXCLUDED.is_canceled,
        details = EXCLUDED.details,
        last_seen_at = NOW()
    `);
    const cancellationLinkQueries = batch
      .filter((transaction) => transaction.source === "easyshop" && transaction.isCanceled && hasText(transaction.details.originalApprovalNo))
      .map((transaction) => sql`
        UPDATE sales_transactions
        SET is_canceled = TRUE, last_seen_at = NOW()
        WHERE source = 'easyshop'
          AND external_id <> ${transaction.externalId}
          AND details ->> 'approvalNo' = ${String(transaction.details.originalApprovalNo)}
      `);
    await sql.transaction([...insertQueries, ...cancellationLinkQueries]);
  }
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

export async function salesMetricsForDate(date: string): Promise<DailySalesMetric[]> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT
      source,
      COALESCE(SUM(amount) FILTER (WHERE NOT is_canceled), 0)::text AS "salesAmount",
      COUNT(*) FILTER (WHERE NOT is_canceled)::int AS "salesCount",
      COALESCE(SUM(amount) FILTER (WHERE is_canceled), 0)::text AS "canceledAmount",
      COUNT(*) FILTER (WHERE is_canceled)::int AS "canceledCount"
    FROM sales_transactions
    WHERE business_date = ${date}::DATE
    GROUP BY source
  ` as unknown as Array<DailySalesMetric & {
    salesAmount: string | number;
    canceledAmount: string | number;
  }>;
  return rows.map((row) => ({
    ...row,
    salesAmount: Number(row.salesAmount),
    canceledAmount: Number(row.canceledAmount),
  }));
}

export async function productMetricsForDate(date: string, source: SourceName): Promise<ProductSalesMetric[]> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT
      product_name AS "productName",
      COALESCE(SUM(amount), 0)::text AS amount,
      COALESCE(SUM(quantity), 0)::int AS quantity
    FROM sales_transactions
    WHERE source = ${source}
      AND business_date = ${date}::DATE
      AND NOT is_canceled
      AND NULLIF(BTRIM(product_name), '') IS NOT NULL
    GROUP BY product_name
    ORDER BY SUM(amount) DESC, SUM(quantity) DESC, product_name ASC
  ` as unknown as Array<ProductSalesMetric & { amount: string | number }>;
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

export async function peakHourForDate(date: string, source: SourceName): Promise<{ hour: number | null; amount: number }> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT
      EXTRACT(HOUR FROM occurred_at AT TIME ZONE 'Asia/Seoul')::int AS hour,
      COALESCE(SUM(amount), 0)::text AS amount
    FROM sales_transactions
    WHERE source = ${source}
      AND business_date = ${date}::DATE
      AND NOT is_canceled
      AND occurred_at IS NOT NULL
    GROUP BY hour
    ORDER BY SUM(amount) DESC, hour ASC
    LIMIT 1
  ` as unknown as Array<{ hour: number; amount: string | number }>;
  return rows[0] ? { hour: Number(rows[0].hour), amount: Number(rows[0].amount) } : { hour: null, amount: 0 };
}

export async function sourceHealthForDate(date: string): Promise<SourceReportHealth[]> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT
      source,
      COUNT(*)::int AS "runCount",
      COUNT(*) FILTER (WHERE NOT ok)::int AS "failureCount"
    FROM monitor_runs
    WHERE (started_at AT TIME ZONE 'Asia/Seoul')::DATE = ${date}::DATE
    GROUP BY source
  ` as unknown as SourceReportHealth[];
  return rows;
}

export async function reserveDailyReport(reportDate: string): Promise<boolean> {
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    INSERT INTO daily_reports (report_date, status, generated_at, error)
    VALUES (${reportDate}::DATE, 'processing', NOW(), NULL)
    ON CONFLICT (report_date) DO UPDATE
    SET status = 'processing', generated_at = NOW(), error = NULL
    WHERE daily_reports.status = 'failed'
       OR (daily_reports.status IN ('processing', 'pending')
           AND daily_reports.generated_at < NOW() - INTERVAL '15 minutes')
    RETURNING report_date
  ` as unknown as { report_date: string }[];
  return rows.length > 0;
}

export async function saveDailyReportPayload(report: DailySalesReport) {
  await ensureSchema();
  const sql = sqlClient();
  await sql`
    UPDATE daily_reports
    SET status = 'pending', payload = ${JSON.stringify(report)}::jsonb, generated_at = NOW(), error = NULL
    WHERE report_date = ${report.reportDate}::DATE
  `;
}

export async function updateDailyReportDelivery(reportDate: string, status: "sent" | "failed", error?: string) {
  await ensureSchema();
  const sql = sqlClient();
  await sql`
    UPDATE daily_reports
    SET status = ${status},
        sent_at = CASE WHEN ${status} = 'sent' THEN NOW() ELSE sent_at END,
        error = ${error ?? null}
    WHERE report_date = ${reportDate}::DATE
  `;
}

export async function latestDailyReport(): Promise<DailyReportRow | null> {
  if (!config.databaseUrl) return null;
  await ensureSchema();
  const sql = sqlClient();
  const rows = await sql`
    SELECT
      report_date::text AS "reportDate", status, payload,
      generated_at AS "generatedAt", sent_at AS "sentAt", error
    FROM daily_reports
    ORDER BY report_date DESC
    LIMIT 1
  ` as unknown as DailyReportRow[];
  return rows[0] ?? null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function hasText(value: string | number | boolean | null | undefined) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}
