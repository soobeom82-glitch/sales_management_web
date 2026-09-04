import {
  peakHourForDate,
  productMetricsForDate,
  reserveDailyReport,
  salesMetricsForDate,
  saveDailyReportPayload,
  sourceHealthForDate,
  storeSalesTransactions,
  tryAcquireJobLock,
  releaseJobLock,
  updateDailyReportDelivery,
} from "@/lib/db";
import { syncEasyShopSalesForDate } from "@/lib/sources/easyshop";
import { syncVmmsSalesForDate } from "@/lib/sources/vmms";
import { sendTelegramDailyReport } from "@/lib/telegram";
import type {
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
  let lockAcquired = false;
  let reportReserved = false;
  let failureMessage: string | undefined;

  try {
    lockAcquired = await tryAcquireJobLock(jobName, DAILY_REPORT_LOCK_SECONDS);
    if (!lockAcquired) {
      return { reportDate, skipped: true, reason: "already_running", processedCount: 0 };
    }

    reportReserved = await reserveDailyReport(reportDate, force);
    if (!reportReserved) {
      return { reportDate, skipped: true, reason: "already_sent", processedCount: 0 };
    }

    // The daily run refreshes the full previous business day before reporting,
    // so a delayed 5-minute poll cannot leave the report with partial sales.
    const [vmmsSales, easyShopSales] = await Promise.all([
      syncVmmsSalesForDate(reportDate),
      syncEasyShopSalesForDate(reportDate),
    ]);
    await Promise.all([
      storeSalesTransactions(vmmsSales),
      storeSalesTransactions(easyShopSales),
    ]);

    const report = await buildDailySalesReport(reportDate);
    await saveDailyReportPayload(report);
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
    if (lockAcquired) {
      await releaseJobLock(jobName, failureMessage).catch((error) => {
        console.error(`[daily-report] lock release failed error=${readableError(error)}`);
      });
    }
  }
}

export async function buildDailySalesReport(reportDate: string): Promise<DailySalesReport> {
  const previousDate = shiftDate(reportDate, -1);
  const previousWeekDate = shiftDate(reportDate, -7);
  const [current, previousDay, previousWeek, currentProducts, previousWeekProducts, peaks, health] = await Promise.all([
    salesMetricsForDate(reportDate),
    salesMetricsForDate(previousDate),
    salesMetricsForDate(previousWeekDate),
    productMetricsForDate(reportDate, "vmms"),
    productMetricsForDate(previousWeekDate, "vmms"),
    Promise.all(SOURCES.map((source) => peakHourForDate(reportDate, source))),
    sourceHealthForDate(reportDate),
  ]);

  const currentBySource = metricMap(current);
  const previousDayBySource = metricMap(previousDay);
  const previousWeekBySource = metricMap(previousWeek);
  const productMovements = compareProducts(currentProducts, previousWeekProducts);

  return {
    reportDate,
    generatedAt: new Date().toISOString(),
    sources: SOURCES.map((source, index) => ({
      ...metricFor(currentBySource, source),
      previousDay: metricFor(previousDayBySource, source),
      previousWeek: metricFor(previousWeekBySource, source),
      topProducts: source === "vmms" ? currentProducts.slice(0, 5) : [],
      increasingProducts: source === "vmms" ? productMovements.increasing : [],
      decreasingProducts: source === "vmms" ? productMovements.decreasing : [],
      peakHour: peaks[index].hour,
      peakHourAmount: peaks[index].amount,
    })),
    health,
  };
}

function metricMap(metrics: DailySalesMetric[]) {
  return new Map(metrics.map((metric) => [metric.source, metric]));
}

function metricFor(metrics: Map<SourceName, DailySalesMetric>, source: SourceName): DailySalesMetric {
  return metrics.get(source) ?? {
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
