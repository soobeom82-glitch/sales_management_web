import { CookieJar } from "@/lib/cookie-jar";
import { config } from "@/lib/config";
import type { MonitorEvent, SalesTransaction, SourceCheckResult } from "@/lib/types";

type VmmsRow = Record<string, unknown>;

const VMMS_PAGE_SIZE = 100;

export async function checkVmmsBulkPurchases(): Promise<SourceCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    if (!config.vmms.loginId || !config.vmms.loginPassword) {
      throw new Error("VMMS 로그인 환경변수가 설정되지 않았습니다.");
    }

    const jar = new CookieJar();
    await login(jar);
    const reconcile = isVmmsDailyReconciliationTime();
    // The VMMS endpoint has no time-range parameter. Normal polls inspect the
    // newest page only; the final poll of the day reconciles every page.
    const date = todayCompact();
    const rows = reconcile ? await fetchAllRowsForDate(jar, date) : await fetchRecentRows(jar, date);
    const events = rows
      .filter(isBulkPurchase)
      .map(toMonitorEvent);
    const sales = rows.map((row) => toSalesTransaction(row, date));
    return {
      source: "vmms",
      checkedAt,
      events,
      sales,
      metadata: {
        scannedTransactions: rows.length,
        matchedTransactions: events.length,
        reconciliation: reconcile,
      },
    };
  } catch (error) {
    return {
      source: "vmms",
      checkedAt,
      events: [],
      sales: [],
      error: error instanceof Error ? error.message : "VMMS 조회 중 알 수 없는 오류",
    };
  }
}

export async function syncVmmsSalesForDate(businessDate: string): Promise<SalesTransaction[]> {
  if (!config.vmms.loginId || !config.vmms.loginPassword) {
    throw new Error("VMMS 로그인 환경변수가 설정되지 않았습니다.");
  }
  const compactDate = normalizeCompactDate(businessDate);
  const jar = new CookieJar();
  await login(jar);
  return deduplicateSales((await fetchAllRowsForDate(jar, compactDate))
    .map((row) => toSalesTransaction(row, compactDate)));
}

async function login(jar: CookieJar) {
  const base = config.vmms.baseUrl.replace(/\/$/, "");
  await jar.fetch(`${base}/login`, { headers: browserHeaders(`${base}/`) });
  const url = new URL(`${base}/user/login`);
  url.searchParams.set("id", config.vmms.loginId);
  url.searchParams.set("pass", config.vmms.loginPassword);
  const response = await jar.fetch(url, {
    headers: {
      ...browserHeaders(`${base}/login`),
      origin: base,
    },
  });
  if (!response.ok && response.status !== 302) {
    throw new Error(`VMMS 로그인 요청 실패 (${response.status})`);
  }
}

async function fetchAllRowsForDate(jar: CookieJar, date: string): Promise<VmmsRow[]> {
  const first = await fetchPage(jar, 1, date);
  // VMMS returns `total`, not `totalPages`. Without this calculation only the
  // first 100 transactions were checked, which could hide an earlier item.
  const totalPages = Math.max(1, Math.ceil(toNumber(first.total, first.rows.length) / VMMS_PAGE_SIZE));
  const rows = [...first.rows];
  for (let page = 2; page <= totalPages; page += 1) {
    const result = await fetchPage(jar, page, date);
    rows.push(...result.rows);
  }
  return rows;
}

async function fetchRecentRows(jar: CookieJar, date: string): Promise<VmmsRow[]> {
  return (await fetchPage(jar, 1, date)).rows;
}

async function fetchPage(jar: CookieJar, pageNo: number, date: string): Promise<{ rows: VmmsRow[]; total: unknown }> {
  const base = config.vmms.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/sales/RealTime/list.do`);
  const query: Record<string, string> = {
    searchType: "01",
    startdate: date,
    enddate: date,
    searchCompany: config.vmms.company,
    searchPlace: "0",
    searchOrgan: config.vmms.organ,
    searchPayType: "01,02,07,10,11,80",
    searchPayStep: "01,02,03,06,81,A1,21,22,28,29,99",
    searchField: "",
    searchValue: "",
    type: "A",
    pageType: "realTime",
    pageNo: String(pageNo),
    pageSize: String(VMMS_PAGE_SIZE),
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await jar.fetch(url, {
    headers: {
      ...browserHeaders(`${base}/sales/SalesRealTime`),
      accept: "application/json, text/plain, */*",
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`VMMS 거래조회 실패 (${response.status})`);
  if (body.trimStart().startsWith("<") || /<title[^>]*>.*login/i.test(body)) {
    throw new Error("VMMS 세션이 유지되지 않았습니다.");
  }
  let parsed: { data?: unknown; total?: unknown };
  try {
    parsed = JSON.parse(body) as { data?: unknown; total?: unknown };
  } catch {
    throw new Error("VMMS 거래조회 응답 형식이 JSON이 아닙니다.");
  }
  return {
    rows: Array.isArray(parsed.data) ? parsed.data.filter(isRecord) : [],
    total: parsed.total,
  };
}

function isBulkPurchase(row: VmmsRow) {
  const configuredValue = config.vmms.bulkValue;
  const fieldValue = asText(row[config.vmms.bulkField]);
  const knownTypeFields = ["input_type", "type", "transaction_type", "pay_type"]
    .map((field) => asText(row[field]));
  const textFields = [
    ...knownTypeFields,
    asText(row.pay_step),
    asText(row.product),
    asText(row.item_name),
  ].join(" ");

  return fieldValue === configuredValue ||
    knownTypeFields.some((value) => value === configuredValue) ||
    /일괄\s*구매/.test(textFields);
}

function toMonitorEvent(row: VmmsRow): MonitorEvent {
  const transactionNo = asText(row.transaction_no) || asText(row.terminal_trans_seq);
  const terminalId = asText(row.terminal_id);
  const rawTime = asText(row.transaction_date);
  const amount = toNumber(row.amount, 0);
  const typeValue = asText(row[config.vmms.bulkField]) || asText(row.input_type) || asText(row.type);
  return {
    source: "vmms",
    kind: "vmms_bulk_purchase",
    fingerprint: `vmms:bulk:${transactionNo || `${terminalId}:${rawTime}:${amount}`}`,
    title: "일괄 구매 거래가 감지되었습니다.",
    occurredAt: vmmsDateToIso(rawTime),
    amount,
    details: {
      transactionNo: transactionNo || null,
      terminalId: terminalId || null,
      transactionType: typeValue || config.vmms.bulkValue,
      product: asText(row.product) || null,
      status: asText(row.pay_step) || null,
    },
  };
}

function toSalesTransaction(row: VmmsRow, fallbackCompactDate: string): SalesTransaction {
  const transactionNo = asText(row.transaction_no) || asText(row.terminal_trans_seq);
  const terminalId = asText(row.terminal_id);
  const rawTime = asText(row.transaction_date);
  const amount = Math.abs(toNumber(row.amount, 0));
  const productName = asText(row.product) || null;
  const externalId = transactionNo || [terminalId, rawTime, amount, productName ?? ""].join(":");
  const status = asText(row.pay_step) || null;
  return {
    source: "vmms",
    externalId,
    occurredAt: vmmsDateToIso(rawTime),
    businessDate: businessDateFromVmms(rawTime, fallbackCompactDate),
    amount,
    productName,
    quantity: Math.max(1, toNumber(row.item_count, 1)),
    status,
    isCanceled: isVmmsCancellation(row),
    details: {
      transactionNo: transactionNo || null,
      terminalId: terminalId || null,
      machineCode: asText(row.vm_code) || null,
      columnNo: asText(row.col_no) || null,
      paymentType: asText(row.pay_type) || null,
      transactionType: asText(row.input_type) || null,
      product: productName,
      status,
    },
  };
}

function isVmmsCancellation(row: VmmsRow) {
  const status = asText(row.pay_step);
  const cancellationDate = asText(row.cancel_date);
  return status === "99" || /취소/.test(status) || hasMeaningfulValue(cancellationDate);
}

function businessDateFromVmms(raw: string, fallbackCompactDate: string) {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : compactDateToDashed(fallbackCompactDate);
}

function todayCompact() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

function normalizeCompactDate(value: string) {
  const compact = value.replace(/\D/g, "");
  if (!/^\d{8}$/.test(compact)) throw new Error("VMMS 조회일은 YYYY-MM-DD 형식이어야 합니다.");
  return compact;
}

function compactDateToDashed(value: string) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function isVmmsDailyReconciliationTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  return part("hour") === 23 && part("minute") >= 55;
}

function vmmsDateToIso(raw: string): string | null {
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/);
  return match ? `${match[1]}T${match[2]}+09:00` : null;
}

function browserHeaders(referer: string): HeadersInit {
  return {
    "user-agent": "Mozilla/5.0 (compatible; SalesManagementMonitor/1.0)",
    "accept-language": "ko-KR,ko;q=0.9",
    referer,
  };
}

function asText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function hasMeaningfulValue(value: string) {
  return value !== "" && value !== "0" && value.toLowerCase() !== "null" && value !== "-";
}

function toNumber(value: unknown, fallback: number): number {
  const digits = asText(value).replace(/[^0-9-]/g, "");
  return Number.isFinite(Number(digits)) ? Number(digits) : fallback;
}

function isRecord(value: unknown): value is VmmsRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deduplicateSales(transactions: SalesTransaction[]) {
  const seen = new Set<string>();
  return transactions.filter((transaction) => {
    const key = `${transaction.source}:${transaction.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
