export type SourceName = "vmms" | "easyshop";

export type AlertKind = "vmms_bulk_purchase" | "easyshop_cancellation";

export type MonitorEvent = {
  source: SourceName;
  kind: AlertKind;
  fingerprint: string;
  title: string;
  occurredAt: string | null;
  amount: number | null;
  details: Record<string, string | number | boolean | null>;
};

export type SalesTransaction = {
  source: SourceName;
  externalId: string;
  occurredAt: string | null;
  businessDate: string;
  amount: number;
  productName: string | null;
  quantity: number;
  status: string | null;
  isCanceled: boolean;
  details: Record<string, string | number | boolean | null>;
};

export type SourceCheckResult = {
  source: SourceName;
  checkedAt: string;
  events: MonitorEvent[];
  sales: SalesTransaction[];
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type MonitorRunResult = {
  startedAt: string;
  finishedAt: string;
  sources: SourceCheckResult[];
  insertedEvents: number;
  telegramSent: number;
};

export type EventRow = {
  id: number;
  source: SourceName;
  kind: AlertKind;
  fingerprint: string;
  title: string;
  occurredAt: string | null;
  amount: number | null;
  details: Record<string, string | number | boolean | null>;
  detectedAt: string;
  telegramStatus: "sent" | "failed" | "pending";
  telegramError: string | null;
};

export type RunRow = {
  id: number;
  source: SourceName;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  eventCount: number;
  error: string | null;
};

export type DailySalesMetric = {
  source: SourceName;
  salesAmount: number;
  salesCount: number;
  canceledAmount: number;
  canceledCount: number;
};

export type ProductSalesMetric = {
  productName: string;
  amount: number;
  quantity: number;
};

export type ProductMovement = ProductSalesMetric & {
  previousQuantity: number;
  quantityDelta: number;
};

export type SourceReportHealth = {
  source: SourceName;
  runCount: number;
  failureCount: number;
};

export type DailySalesReport = {
  reportDate: string;
  generatedAt: string;
  sources: Array<DailySalesMetric & {
    previousDay: DailySalesMetric;
    previousWeek: DailySalesMetric;
    topProducts: ProductSalesMetric[];
    increasingProducts: ProductMovement[];
    decreasingProducts: ProductMovement[];
    peakHour: number | null;
    peakHourAmount: number;
  }>;
  health: SourceReportHealth[];
};

export type DailyReportRow = {
  reportDate: string;
  status: "processing" | "pending" | "sent" | "failed";
  payload: DailySalesReport | null;
  generatedAt: string | null;
  sentAt: string | null;
  error: string | null;
};
