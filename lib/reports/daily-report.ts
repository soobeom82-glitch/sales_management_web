import {
  buildDailySnapshot,
  dailySnapshotForDate,
  reserveDailyReport,
  saveDailyReportPayload,
  tryAcquireJobLock,
  releaseJobLock,
  updateDailyReportDelivery,
} from "@/lib/store";
import { syncEasyShopSalesForDate } from "@/lib/sources/easyshop";
import { reconcileVmmsForDate } from "@/lib/monitor";
import { sendTelegramDailyReport } from "@/lib/telegram";
import type {
  DailySalesSnapshot,
  DailySalesMetric,
  DailySalesReport,
  ProductMovement,
  ProductSalesMetric,
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
  const reportDate = normalizeReportDate(requestedDate ?? previousKstDate());
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

    // The daily run refreshes the full previous business day before reporting,
    // so a delayed 5-minute poll cannot leave the report with partial sales.
    const [vmmsReconciliation, easyShopSales] = await Promise.all([
      // This full-day pass also retries a bulk-purchase alert that a normal
      // five-minute newest-page poll may have missed.
      reconcileVmmsForDate(reportDate),
      syncEasyShopSalesForDate(reportDate),
    ]);
    const vmmsSales = vmmsReconciliation.check.sales;
    const snapshot = buildDailySnapshot(reportDate, [...vmmsSales, ...easyShopSales]);
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
  const previousDate = shiftDate(reportDate, -1);
  const previousWeekDate = shiftDate(reportDate, -7);
  const [storedCurrent, previousDay, previousWeek] = await Promise.all([
    currentSnapshot ? Promise.resolve(currentSnapshot) : dailySnapshotForDate(reportDate),
    dailySnapshotForDate(previousDate),
    dailySnapshotForDate(previousWeekDate),
  ]);
  const current = currentSnapshot ?? storedCurrent;
  if (!current) throw new Error(`${reportDate} 일일 집계를 찾지 못했습니다.`);

  const currentBySource = snapshotSourceMap(current);
  const previousDayBySource = snapshotSourceMap(previousDay);
  const previousWeekBySource = snapshotSourceMap(previousWeek);

  return {
    reportDate,
    generatedAt: new Date().toISOString(),
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

function previousKstDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return shiftDate(`${part("year")}-${part("month")}-${part("day")}`, -1);
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
