import { createClient, type RedisClientType } from "redis";
import { config } from "@/lib/config";
import { VMMS_PRODUCT_MAPPING_SEED } from "@/lib/vmms-product-mapping";
import type {
  DailyReportRow,
  DailySalesMetric,
  DailySalesReport,
  DailySalesSnapshot,
  EventRow,
  MonitorEvent,
  ProductSalesMetric,
  RunRow,
  SalesTransaction,
  SourceCheckResult,
  SourceName,
} from "@/lib/types";

const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const DAILY_REPORT_TTL_SECONDS = 35 * 24 * 60 * 60;
const RECENT_EVENT_LIMIT = 50;
const RECENT_RUN_LIMIT = 50;

const EVENT_LIST_KEY = "sales-sentinel:events:recent";
const RUN_LIST_KEY = "sales-sentinel:runs:errors";

export type JobLock = {
  jobName: string;
  token: string;
};

type StoredDailyReport = DailyReportRow & {
  snapshot?: DailySalesSnapshot;
};

let client: RedisClientType | undefined;
let connecting: Promise<RedisClientType> | undefined;

async function redis(): Promise<RedisClientType> {
  if (!config.redisUrl) {
    throw new Error("REDIS_URL 환경변수가 설정되지 않았습니다.");
  }
  if (!client) {
    client = createClient({ url: config.redisUrl });
    client.on("error", (error) => console.error(`[redis] connection error=${readableError(error)}`));
  }
  if (client.isReady) return client;
  connecting ??= client.connect().then(() => client as RedisClientType).catch((error) => {
    connecting = undefined;
    throw error;
  });
  return connecting;
}

export async function vmmsProductMappings(): Promise<Map<string, string>> {
  // Product mapping is application configuration, not polling state. Keeping it
  // in the deployment avoids a Redis read for every five-minute VMMS request.
  return new Map(VMMS_PRODUCT_MAPPING_SEED.map((mapping) => [mapping.colNo, mapping.actualProduct]));
}

export async function tryAcquireJobLock(jobName: string, leaseSeconds: number): Promise<JobLock | null> {
  const token = crypto.randomUUID();
  const acquired = await (await redis()).set(lockKey(jobName), token, { NX: true, EX: leaseSeconds });
  return acquired ? { jobName, token } : null;
}

export async function releaseJobLock(lock: JobLock, error?: string) {
  if (error) {
    console.warn(`[lock] releasing failed job=${lock.jobName} error=${error}`);
  }
  // A token prevents an expired invocation from deleting a lock acquired by a
  // newer invocation of the same job.
  await (await redis()).eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
    { keys: [lockKey(lock.jobName)], arguments: [lock.token] },
  );
}

export async function reserveEventDelivery(event: MonitorEvent): Promise<string | null> {
  const store = await redis();
  const key = eventKey(event.fingerprint);
  const detectedAt = new Date().toISOString();
  const row: EventRow = {
    id: event.fingerprint,
    source: event.source,
    kind: event.kind,
    fingerprint: event.fingerprint,
    title: event.title,
    occurredAt: event.occurredAt,
    amount: event.amount,
    details: event.details,
    detectedAt,
    telegramStatus: "pending",
    telegramError: null,
  };

  const inserted = await store.set(key, JSON.stringify(row), { NX: true, EX: EVENT_TTL_SECONDS });
  if (inserted) {
    await store.lPush(EVENT_LIST_KEY, event.fingerprint);
    await store.lTrim(EVENT_LIST_KEY, 0, RECENT_EVENT_LIMIT - 1);
    await store.expire(EVENT_LIST_KEY, EVENT_TTL_SECONDS);
    return event.fingerprint;
  }

  // Failed Telegram deliveries should be retried on the next source poll,
  // while a delivered event remains deduplicated for the retention window.
  const existing = parseJson<EventRow>(await store.get(key));
  if (existing?.telegramStatus !== "failed") return null;
  await store.set(key, JSON.stringify({ ...existing, telegramStatus: "pending", telegramError: null }), { EX: EVENT_TTL_SECONDS });
  return event.fingerprint;
}

export async function updateTelegramDelivery(id: string, status: "sent" | "failed", error?: string) {
  const store = await redis();
  const key = eventKey(id);
  const existing = parseJson<EventRow>(await store.get(key));
  if (!existing) return;
  await store.set(key, JSON.stringify({
    ...existing,
    telegramStatus: status,
    telegramError: error ?? null,
  }), { EX: EVENT_TTL_SECONDS });
}

export async function recentEvents(limit = 20): Promise<EventRow[]> {
  if (!config.redisUrl) return [];
  const store = await redis();
  const ids = await store.lRange(EVENT_LIST_KEY, 0, Math.max(0, limit - 1));
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map(async (id) => parseJson<EventRow>(await store.get(eventKey(id)))));
  return rows.filter((row): row is EventRow => row !== null);
}

// Successful five-minute polls intentionally leave no durable row. Only errors
// are retained briefly so operators can inspect failures without creating a
// transaction-sized monitoring ledger.
export async function recordRun(result: SourceCheckResult, startedAt: string, finishedAt: string) {
  if (!result.error) return;
  const row: RunRow = {
    id: `${result.source}:${startedAt}`,
    source: result.source,
    startedAt,
    finishedAt,
    ok: false,
    eventCount: result.events.length,
    error: result.error,
    metadata: result.metadata ?? {},
  };
  const store = await redis();
  await store.lPush(RUN_LIST_KEY, JSON.stringify(row));
  await store.lTrim(RUN_LIST_KEY, 0, RECENT_RUN_LIMIT - 1);
  await store.expire(RUN_LIST_KEY, EVENT_TTL_SECONDS);
}

export async function recentRuns(limit = 12): Promise<RunRow[]> {
  if (!config.redisUrl) return [];
  const rows = await (await redis()).lRange(RUN_LIST_KEY, 0, Math.max(0, limit - 1));
  return rows.flatMap((row) => {
    const parsed = parseJson<RunRow>(row);
    return parsed ? [parsed] : [];
  });
}

export function buildDailySnapshot(
  reportDate: string,
  transactions: SalesTransaction[],
  periodStart: string,
  periodEnd: string,
): DailySalesSnapshot {
  return {
    reportDate,
    capturedAt: new Date().toISOString(),
    periodStart,
    periodEnd,
    sources: (["vmms", "easyshop"] as SourceName[]).map((source) => {
      const sourceTransactions = transactions.filter((transaction) => transaction.source === source);
      const completed = sourceTransactions.filter((transaction) => !transaction.isCanceled);
      const canceled = sourceTransactions.filter((transaction) => transaction.isCanceled);
      const products = productMetrics(completed);
      const peak = peakHour(completed);
      return {
        source,
        metrics: {
          source,
          salesAmount: sumAmounts(completed),
          salesCount: completed.length,
          canceledAmount: sumAmounts(canceled),
          canceledCount: canceled.length,
        },
        // EasyShop does not provide item information; preserving an empty
        // array keeps the snapshot compact and makes that limitation explicit.
        products: source === "vmms" ? products : [],
        peakHour: peak.hour,
        peakHourAmount: peak.amount,
      };
    }),
  };
}

export async function reserveDailyReport(reportDate: string, force = false): Promise<boolean> {
  const store = await redis();
  const key = dailyReportKey(reportDate);
  const existing = parseJson<StoredDailyReport>(await store.get(key));
  const isStaleProcessing = existing?.status === "processing" &&
    new Date(existing.generatedAt ?? 0).getTime() < Date.now() - 15 * 60 * 1000;

  if (existing?.status === "sent" && !force) return false;
  if (existing?.status === "processing" && !isStaleProcessing && !force) return false;

  const next: StoredDailyReport = {
    reportDate,
    status: "processing",
    payload: existing?.payload ?? null,
    generatedAt: new Date().toISOString(),
    sentAt: existing?.sentAt ?? null,
    error: null,
    snapshot: existing?.snapshot,
  };
  await store.set(key, JSON.stringify(next), { EX: DAILY_REPORT_TTL_SECONDS });
  return true;
}

export async function dailySnapshotForDate(reportDate: string): Promise<DailySalesSnapshot | null> {
  const row = parseJson<StoredDailyReport>(await (await redis()).get(dailyReportKey(reportDate)));
  return row?.snapshot ?? null;
}

// Comparison snapshots may be collected before their own report is sent. They
// share the daily-report key so a later report can reuse the compact aggregate.
export async function saveDailySnapshot(snapshot: DailySalesSnapshot) {
  const store = await redis();
  const key = dailyReportKey(snapshot.reportDate);
  const existing = parseJson<StoredDailyReport>(await store.get(key));
  const next: StoredDailyReport = {
    reportDate: snapshot.reportDate,
    status: existing?.status ?? "pending",
    payload: existing?.payload ?? null,
    generatedAt: existing?.generatedAt ?? null,
    sentAt: existing?.sentAt ?? null,
    error: existing?.error ?? null,
    snapshot,
  };
  await store.set(key, JSON.stringify(next), { EX: DAILY_REPORT_TTL_SECONDS });
}

export async function saveDailyReportPayload(report: DailySalesReport, snapshot: DailySalesSnapshot) {
  const store = await redis();
  const key = dailyReportKey(report.reportDate);
  const existing = parseJson<StoredDailyReport>(await store.get(key));
  const next: StoredDailyReport = {
    reportDate: report.reportDate,
    status: "pending",
    payload: report,
    generatedAt: report.generatedAt,
    sentAt: existing?.sentAt ?? null,
    error: null,
    snapshot,
  };
  await store.set(key, JSON.stringify(next), { EX: DAILY_REPORT_TTL_SECONDS });
}

export async function updateDailyReportDelivery(reportDate: string, status: "sent" | "failed", error?: string) {
  const store = await redis();
  const key = dailyReportKey(reportDate);
  const existing = parseJson<StoredDailyReport>(await store.get(key));
  if (!existing) return;
  await store.set(key, JSON.stringify({
    ...existing,
    status,
    sentAt: status === "sent" ? new Date().toISOString() : existing.sentAt,
    error: error ?? null,
  }), { EX: DAILY_REPORT_TTL_SECONDS });
}

function productMetrics(transactions: SalesTransaction[]): ProductSalesMetric[] {
  const metrics = new Map<string, ProductSalesMetric>();
  for (const transaction of transactions) {
    const productName = transaction.productName?.trim();
    if (!productName) continue;
    const current = metrics.get(productName) ?? { productName, amount: 0, quantity: 0 };
    current.amount += transaction.amount;
    current.quantity += transaction.quantity;
    metrics.set(productName, current);
  }
  return [...metrics.values()].sort((left, right) =>
    right.amount - left.amount || right.quantity - left.quantity || left.productName.localeCompare(right.productName, "ko-KR"),
  );
}

function peakHour(transactions: SalesTransaction[]) {
  const amounts = new Map<number, number>();
  for (const transaction of transactions) {
    if (!transaction.occurredAt) continue;
    const hour = hourInKst(transaction.occurredAt);
    if (hour === null) continue;
    amounts.set(hour, (amounts.get(hour) ?? 0) + transaction.amount);
  }
  const values = [...amounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  return values[0] ? { hour: values[0][0], amount: values[0][1] } : { hour: null, amount: 0 };
}

function hourInKst(value: string): number | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const part = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date).find((entry) => entry.type === "hour")?.value;
  return part === undefined ? null : Number(part);
}

function sumAmounts(transactions: SalesTransaction[]) {
  return transactions.reduce((sum, transaction) => sum + transaction.amount, 0);
}

function lockKey(jobName: string) {
  return `sales-sentinel:lock:${jobName}`;
}

function eventKey(fingerprint: string) {
  return `sales-sentinel:event:${fingerprint}`;
}

function dailyReportKey(reportDate: string) {
  return `sales-sentinel:daily-report:${reportDate}`;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}
