import {
  buildDailySnapshot,
  dailySnapshotForDate,
  reserveDailyReport,
  saveDailyReportPayload,
  tryAcquireJobLock,
  releaseJobLock,
  updateDailyReportDelivery,
} from "@/lib/store";
import { syncEasyShopSalesForRange } from "@/lib/sources/easyshop";
import { reconcileVmmsForDate } from "@/lib/monitor";
import { sendTelegramDailyReport } from "@/lib/telegram";
import type {
  DailySalesSnapshot,
  DailySalesMetric,
  DailySalesReport,
  ProductMovement,
  ProductSalesMetric,
  SalesTransaction,
  SourceName,
} from "@/lib/types";

const SOURCES: SourceName[] = ["vmms", "easyshop"];
const DAILY_REPORT_LOCK_SECONDS = 10 * 60;

export type DailyReportJobResult = {
  reportDate: string;
  skipped: boolean;
  reason?: "already_running" | "already_sent";
  processedCount: number;
  report?: DailySalesReport;
};

type DailyReportRunOptions = {
  force?: boolean;
};

export async function runDailyReportJob(
  requestedDate?: string,
  { force = false }: DailyReportRunOptions = {},
): Promise<DailyReportJobResult> {
  const reportDate = normalizeReportDate(requestedDate ?? currentKstDate());
  const window = closingWindow(reportDate);
  const jobName = `daily-sales-report:${reportDate}`;
  let lock: Awaited<ReturnType<typeof tryAcquireJobLock>> = null;
  let reportReserved = false;
  let failureMessage: string | undefined;

  try {
    lock = await tryAcquireJobLock(jobName, DAILY_REPORT_LOCK_SECONDS);
    if (!lock) {
      return { reportDate, skipped: true, reason: "already_running", processedCount: 0 };
    }

    reportReserved = await reserveDailyReport(reportDate, force);
    if (!reportReserved) {
      return { reportDate, skipped: true, reason: "already_sent", processedCount: 0 };
    }

    // VMMS only accepts a calendar-day filter, so read the two overlapping
    // dates and trim them to the cafe's exact 18:00-to-18:00 business window.
    // The whole-day VMMS passes also retain the missed bulk-purchase recovery.
    const [previousVmms, currentVmms, easyShopWindowSales] = await Promise.all([
      reconcileVmmsForDate(window.startDate),
      reconcileVmmsForDate(reportDate),
      syncEasyShopSalesForRange(window.start, window.end),
    ]);
    const vmmsSales = transactionsInWindow(
      [...previousVmms.check.sales, ...currentVmms.check.sales],
      window.start,
      window.end,
    );
    const easyShopSales = transactionsInWindow(easyShopWindowSales, window.start, window.end);
    const snapshot = buildDailySnapshot(
      reportDate,
      [...vmmsSales, ...easyShopSales],
      window.start.toISOString(),
      window.end.toISOString(),
    );
    const report = await buildDailySalesReport(reportDate, snapshot);
    await saveDailyReportPayload(report, snapshot);
    await sendTelegramDailyReport(report);
    await updateDailyReportDelivery(reportDate, "sent");

    return {
      reportDate,
      skipped: false,
      processedCount: vmmsSales.length + easyShopSales.length,
      report,
    };
  } catch (error) {
    failureMessage = readableError(error);
    if (reportReserved) await updateDailyReportDelivery(reportDate, "failed", failureMessage);
    throw error;
  } finally {
    if (lock) {
      await releaseJobLock(lock, failureMessage).catch((error) => {
        console.error(`[daily-report] lock release failed error=${readableError(error)}`);
      });
    }
  }
}

export async function buildDailySalesReport(
  reportDate: string,
  currentSnapshot?: DailySalesSnapshot,
): Promise<DailySalesReport> {
  const currentWindow = closingWindow(reportDate);
  const previousDate = shiftDate(reportDate, -1);
  const previousWeekDate = shiftDate(reportDate, -7);
  const [storedCurrent, previousDay, previousWeek] = await Promise.all([
    currentSnapshot ? Promise.resolve(currentSnapshot) : dailySnapshotForDate(reportDate),
    dailySnapshotForDate(previousDate),
    dailySnapshotForDate(previousWeekDate),
  ]);
  const current = currentSnapshot ?? storedCurrent;
  if (!current) throw new Error(`${reportDate} 일일 집계를 찾지 못했습니다.`);
  if (!isClosingSnapshot(current, reportDate)) {
    throw new Error(`${reportDate} 마감 기준(전날 18:00~당일 18:00) 집계를 찾지 못했습니다.`);
  }

  // Old midnight-based snapshots cannot be compared with the 18:00 cafe
  // closing window. They are ignored until a matching snapshot is collected.
  const comparablePreviousDay = isClosingSnapshot(previousDay, previousDate) ? previousDay : null;
  const comparablePreviousWeek = isClosingSnapshot(previousWeek, previousWeekDate) ? previousWeek : null;

  const currentBySource = snapshotSourceMap(current);
  const previousDayBySource = snapshotSourceMap(comparablePreviousDay);
  const previousWeekBySource = snapshotSourceMap(comparablePreviousWeek);

  return {
    reportDate,
    generatedAt: new Date().toISOString(),
    periodStart: currentWindow.start.toISOString(),
    periodEnd: currentWindow.end.toISOString(),
    sources: SOURCES.map((source) => {
      const currentSource = sourceFor(currentBySource, source);
      const previousWeekSource = sourceFor(previousWeekBySource, source);
      const productMovements = source === "vmms"
        ? compareProducts(currentSource.products, previousWeekSource.products)
        : { increasing: [], decreasing: [] };
      return {
      ...currentSource.metrics,
      previousDay: metricFor(previousDayBySource, source),
      previousWeek: metricFor(previousWeekBySource, source),
      topProducts: source === "vmms" ? currentSource.products.slice(0, 5) : [],
      increasingProducts: productMovements.increasing,
      decreasingProducts: productMovements.decreasing,
      peakHour: currentSource.peakHour,
      peakHourAmount: currentSource.peakHourAmount,
    };
    }),
    // Normal five-minute polls are intentionally not stored. Source health in
    // this report therefore reflects the full-day collection, which succeeded
    // before this report was assembled.
    health: [],
  };
}

function snapshotSourceMap(snapshot: DailySalesSnapshot | null) {
  return new Map((snapshot?.sources ?? []).map((source) => [source.source, source]));
}

function sourceFor(
  sources: Map<SourceName, DailySalesSnapshot["sources"][number]>,
  source: SourceName,
) {
  return sources.get(source) ?? {
    source,
    metrics: emptyMetric(source),
    products: [],
    peakHour: null,
    peakHourAmount: 0,
  };
}

function metricFor(
  sources: Map<SourceName, DailySalesSnapshot["sources"][number]>,
  source: SourceName,
): DailySalesMetric {
  return sources.get(source)?.metrics ?? emptyMetric(source);
}

function emptyMetric(source: SourceName): DailySalesMetric {
  return {
    source,
    salesAmount: 0,
    salesCount: 0,
    canceledAmount: 0,
    canceledCount: 0,
  };
}

function compareProducts(current: ProductSalesMetric[], previous: ProductSalesMetric[]) {
  const currentByName = new Map(current.map((product) => [product.productName, product]));
  const previousByName = new Map(previous.map((product) => [product.productName, product]));
  const movements: ProductMovement[] = [...new Set([...currentByName.keys(), ...previousByName.keys()])]
    .map((productName) => {
      const present = currentByName.get(productName) ?? { productName, amount: 0, quantity: 0 };
      const prior = previousByName.get(productName);
      return {
        ...present,
        previousQuantity: prior?.quantity ?? 0,
        quantityDelta: present.quantity - (prior?.quantity ?? 0),
      };
    })
    .filter((product) => product.quantityDelta !== 0);

  return {
    increasing: movements
      .filter((product) => product.quantityDelta > 0)
      .sort((left, right) => right.quantityDelta - left.quantityDelta || right.amount - left.amount)
      .slice(0, 3),
    decreasing: movements
      .filter((product) => product.quantityDelta < 0)
      .sort((left, right) => left.quantityDelta - right.quantityDelta || left.amount - right.amount)
      .slice(0, 3),
  };
}

function currentKstDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function closingWindow(reportDate: string) {
  const startDate = shiftDate(reportDate, -1);
  return {
    startDate,
    start: new Date(`${startDate}T18:00:00+09:00`),
    end: new Date(`${reportDate}T18:00:00+09:00`),
  };
}

function transactionsInWindow(transactions: SalesTransaction[], start: Date, end: Date) {
  const seen = new Set<string>();
  return transactions.filter((transaction) => {
    if (seen.has(`${transaction.source}:${transaction.externalId}`)) return false;
    seen.add(`${transaction.source}:${transaction.externalId}`);
    if (!transaction.occurredAt) return false;
    const occurredAt = new Date(transaction.occurredAt);
    return !Number.isNaN(occurredAt.getTime()) && occurredAt >= start && occurredAt < end;
  });
}

function isClosingSnapshot(snapshot: DailySalesSnapshot | null, reportDate: string): snapshot is DailySalesSnapshot {
  if (!snapshot) return false;
  const window = closingWindow(reportDate);
  return snapshot.periodStart === window.start.toISOString() && snapshot.periodEnd === window.end.toISOString();
}

function normalizeReportDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T12:00:00Z`).getTime())) {
    throw new Error("리포트 기준일은 YYYY-MM-DD 형식이어야 합니다.");
  }
  return value;
}

function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}
