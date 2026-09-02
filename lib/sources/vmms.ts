import { CookieJar } from "@/lib/cookie-jar";
import { config } from "@/lib/config";
import type { MonitorEvent, SourceCheckResult } from "@/lib/types";

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
    const rows = await fetchAllTodayRows(jar);
    const events = rows
      .filter(isBulkPurchase)
      .map(toMonitorEvent);
    return {
      source: "vmms",
      checkedAt,
      events,
      metadata: { scannedTransactions: rows.length, matchedTransactions: events.length },
    };
  } catch (error) {
    return {
      source: "vmms",
      checkedAt,
      events: [],
      error: error instanceof Error ? error.message : "VMMS 조회 중 알 수 없는 오류",
    };
  }
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

async function fetchAllTodayRows(jar: CookieJar): Promise<VmmsRow[]> {
  const first = await fetchPage(jar, 1);
  // VMMS returns `total`, not `totalPages`. Without this calculation only the
  // first 100 transactions were checked, which could hide an earlier item.
  const totalPages = Math.max(1, Math.ceil(toNumber(first.total, first.rows.length) / VMMS_PAGE_SIZE));
  const rows = [...first.rows];
  for (let page = 2; page <= totalPages; page += 1) {
    const result = await fetchPage(jar, page);
    rows.push(...result.rows);
  }
  return rows;
}

async function fetchPage(jar: CookieJar, pageNo: number): Promise<{ rows: VmmsRow[]; total: unknown }> {
  const base = config.vmms.baseUrl.replace(/\/$/, "");
  const date = todayCompact();
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

function toNumber(value: unknown, fallback: number): number {
  const digits = asText(value).replace(/[^0-9-]/g, "");
  return Number.isFinite(Number(digits)) ? Number(digits) : fallback;
}

function isRecord(value: unknown): value is VmmsRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
