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

export type SourceCheckResult = {
  source: SourceName;
  checkedAt: string;
  events: MonitorEvent[];
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

