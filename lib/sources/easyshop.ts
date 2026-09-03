import { CookieJar } from "@/lib/cookie-jar";
import { config } from "@/lib/config";
import type { MonitorEvent, SalesTransaction, SourceCheckResult } from "@/lib/types";

type EasyShopContext = {
  memberId: string;
  autId: string;
  bizrNo: string;
  tid: string;
};

type EasyShopRecord = {
  transactionNo: string;
  terminalNo: string;
  status: string;
  occurredAt: string | null;
  card: string;
  issuerName: string;
  approvalNo: string;
  originalApprovalNo: string;
  amount: number;
  isCanceled: boolean;
};

type SalesWindow = {
  date: string;
  fromTime: string;
  toTime: string;
};

const EASYSHOP_LOOKBACK_MINUTES = 15;

export async function checkEasyShopCancellations(): Promise<SourceCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    if (!config.easyShop.loginId || !config.easyShop.loginPassword) {
      throw new Error("EasyShop 로그인 환경변수가 설정되지 않았습니다.");
    }

    const jar = new CookieJar();
    const context = await loginAndLoadContext(jar);
    const records = await fetchRecentSales(jar, context);
    const events = records.filter((record) => record.isCanceled).map(toMonitorEvent);
    const sales = records.map(toSalesTransaction);
    return {
      source: "easyshop",
      checkedAt,
      events,
      sales,
      metadata: {
        scannedTransactions: records.length,
        matchedTransactions: events.length,
        lookbackMinutes: EASYSHOP_LOOKBACK_MINUTES,
      },
    };
  } catch (error) {
    return {
      source: "easyshop",
      checkedAt,
      events: [],
      sales: [],
      error: error instanceof Error ? error.message : "EasyShop 조회 중 알 수 없는 오류",
    };
  }
}

export async function syncEasyShopSalesForDate(businessDate: string): Promise<SalesTransaction[]> {
  if (!config.easyShop.loginId || !config.easyShop.loginPassword) {
    throw new Error("EasyShop 로그인 환경변수가 설정되지 않았습니다.");
  }
  const compactDate = normalizeCompactDate(businessDate);
  const jar = new CookieJar();
  const context = await loginAndLoadContext(jar);
  const records = await fetchSalesForWindows(jar, context, [{
    date: compactDate,
    fromTime: "00:00:00",
    toTime: "23:59:59",
  }]);
  return records.map(toSalesTransaction);
}

async function loginAndLoadContext(jar: CookieJar): Promise<EasyShopContext> {
  const base = config.easyShop.baseUrl.replace(/\/$/, "");
  await jar.fetch(`${base}/smart_kicc/index.jsp`, { headers: htmlHeaders(`${base}/`) });

  // Keep the login handshake in the same order as EasyShop's Nexacro client.
  await checkLoginStatus(jar);
  const loginSession = refreshSessionCookies(jar);

  const loginResponse = await jar.fetch(`${base}/login.do`, {
    method: "POST",
    headers: xmlHeaders(`${base}/smart_kicc/index.jsp`),
    body: buildLoginXml(config.easyShop.loginId, config.easyShop.loginPassword, loginSession),
  });
  const loginXml = await loginResponse.text();
  if (!loginResponse.ok) throw new Error(`EasyShop 로그인 요청 실패 (${loginResponse.status})`);
  assertNoServiceError(loginXml, "EasyShop 로그인");

  const memberId = getColumn(loginXml, "mbr_id") || config.easyShop.memberId;
  if (!memberId) throw new Error("EasyShop 로그인 응답에서 mbr_id를 찾지 못했습니다.");

  await bootstrapEasyShopContext(jar, memberId);
  const authXml = await callContextService(jar, memberId, "Login", "TCMM001S02", [
    field("login_id", config.easyShop.loginId),
    field("group_yn", "N"),
  ]);
  assertNoServiceError(authXml, "EasyShop 권한 확인");

  const autId = getColumn(authXml, "aut_id") || config.easyShop.autId;
  if (!autId) throw new Error("EasyShop 권한 확인 응답에서 aut_id를 찾지 못했습니다.");
  const bizrNo = getCodeValue(authXml, "BIZR_NO") || config.easyShop.bizrNo;
  const tid = getCodeValue(authXml, "TID") || config.easyShop.tid;
  await primeSalesAuthorization(jar, memberId, autId);
  return { memberId, autId, bizrNo, tid };
}

async function checkLoginStatus(jar: CookieJar) {
  const base = config.easyShop.baseUrl.replace(/\/$/, "");
  const response = await jar.fetch(`${base}/checkLoginStatus.do`, {
    method: "POST",
    headers: xmlHeaders(`${base}/smart_kicc/index.jsp`),
    body: xmlRoot(`
      <Parameters><Parameter id="LoginInfo"/><Parameter id="arg_pgmId">Login</Parameter><Parameter id="nMbr_id">undefined</Parameter></Parameters>
      <Dataset id="dsInData"><ColumnInfo>
        <Column id="SvcId" type="STRING" size="256"/><Column id="gubun" type="STRING" size="2"/>
        <Column id="login_id" type="STRING" size="20"/><Column id="pswd" type="STRING" size="50"/>
      </ColumnInfo><Rows><Row><Col id="gubun">0</Col></Row></Rows></Dataset>
    `),
  });
  const xml = await response.text();
  if (!response.ok) throw new Error(`EasyShop 로그인 상태 확인 요청 실패 (${response.status})`);
  assertNoServiceError(xml, "EasyShop 로그인 상태 확인");
}

async function bootstrapEasyShopContext(jar: CookieJar, memberId: string) {
  const loginId = config.easyShop.loginId;
  const calls: Array<[string, string, ContextField[]]> = [
    ["Login", "TCMM100S05", [field("gubun", "0"), field("login_id", loginId), field("ctz_no", null)]],
    ["Login", "TPOE201S11", [field("func_cd", "0"), field("login_id", loginId)]],
    ["Login", "TCMM100S08", [field("mbr_id", memberId)]],
    ["MainFrameEs", "TESS501S01", [field("login_id", loginId), field("func_cd", "0", "BIGDECIMAL", "2")]],
    ["MainFrameEs", "TESS501S02", [field("login_id", loginId)]],
    ["MainFrameEs", "TESS501S03", [field("login_id", loginId)]],
    ["MainFrameEs", "TESS501S04", [field("message", null)]],
    ["MainFrameEs", "TESS100S01", [field("func_cd", "3", "BIGDECIMAL", "2")]],
    ["MainFrameEs", "TESS501S01", [field("login_id", loginId), field("func_cd", "1", "BIGDECIMAL", "2")]],
    ["MainFrameEs", "TESS501S01", [field("login_id", loginId), field("func_cd", "2", "BIGDECIMAL", "2")]],
    ["LeftFrame", "TCMM100S02", [field("gubun", "1", "STRING", "2"), field("mbr_id", memberId, "STRING", "200"), field("url_path", "SEO")]],
    ["MainFrameEs", "TESS100S01", [field("func_cd", "1", "BIGDECIMAL", "2")]],
    ["MDIFrame", "TMCM990S01", [field("login_id", memberId, "STRING", "10"), field("menu_id", "1000007726", "STRING", "20"), field("login_mthd_cd", "5", "STRING", "1")]],
  ];
  for (const [argPgmId, serviceId, fields] of calls) {
    const xml = await callContextService(jar, memberId, argPgmId, serviceId, fields);
    assertNoServiceError(xml, `EasyShop 화면 초기화(${serviceId})`);
  }
}

async function primeSalesAuthorization(jar: CookieJar, memberId: string, autId: string) {
  const calls: Array<[string, ContextField[]]> = [
    ["TCMM100S03", [
      field("rowCnt", "1", "INT"), field("func_cd", "1", "INT"), field("mbr_id", memberId),
      field("pgm_id", "WESS102T01"), field("grid_nm", null), field("grid_layout", null),
      field("fst_rgtr_id", memberId), field("lst_updr_id", memberId), field("gubun", null, "INT"), field("url_path", "SEO"),
    ]],
    ["TCMM001S10", [field("menu_id", "1000007727"), field("aut_id", autId)]],
    ["TCMM001S10", [field("menu_id", "1000008225"), field("aut_id", autId)]],
    ["TCMM001S03", [field("aut_id", autId)]],
    ["TCMM116S01", [field("key_value", "MCM_B00002"), field("gubun", "10")]],
  ];
  for (const [serviceId, fields] of calls) {
    const xml = await callContextService(jar, memberId, "div_Work", serviceId, fields);
    assertNoServiceError(xml, `EasyShop 매출 권한 초기화(${serviceId})`);
  }
}

async function fetchRecentSales(jar: CookieJar, context: EasyShopContext): Promise<EasyShopRecord[]> {
  return fetchSalesForWindows(jar, context, recentSalesWindows());
}

async function fetchSalesForWindows(
  jar: CookieJar,
  context: EasyShopContext,
  windows: SalesWindow[],
): Promise<EasyShopRecord[]> {
  const records: EasyShopRecord[] = [];
  for (const window of windows) {
    const session = refreshSessionCookies(jar);
    const responseXml = await callService(jar, buildSalesXml(context, session, window));
    assertNoServiceError(responseXml, "EasyShop 최근 매출 조회");
    records.push(...extractDatasetRows(responseXml, "data")
      .map((row, index) => parseSalesRecord(row, index))
      .filter((record): record is EasyShopRecord => record !== null));
  }
  return uniqueRecords(records);
}

async function callService(jar: CookieJar, body: string): Promise<string> {
  const base = config.easyShop.baseUrl.replace(/\/$/, "");
  const response = await jar.fetch(`${base}/CallService.do`, {
    method: "POST",
    headers: xmlHeaders(`${base}/smart_kicc/index.jsp`),
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`EasyShop CallService 요청 실패 (${response.status})`);
  return text;
}

function parseSalesRecord(rowXml: string, index: number): EasyShopRecord | null {
  const raw = getColumn(rowXml, "data_set");
  if (!raw) return null;
  const fields = raw.split("@@").map((value) => decodeXml(value).trim());
  const cancelCode = fields[1] ?? "";
  const status = fields[3] ?? "";
  const rawDate = fields[4] ?? "";
  const rawAmount = fields[11] ?? "0";
  const originalApproval = fields[15] ?? "";
  const easyShopCancel = fields[24] ?? "";
  const ifmType = fields[3] ?? "";
  const signedAmount = signedNumber(rawAmount);
  const isCanceled = status.includes("취소") || ifmType === "0200" ||
    (cancelCode !== "" && !["0", "7"].includes(cancelCode)) ||
    signedAmount < 0 ||
    easyShopCancel.toUpperCase() === "Y" ||
    hasOriginalApprovalReference(originalApproval);

  return {
    transactionNo: fields[0] || `row-${index}`,
    terminalNo: fields[2] || "",
    status: status || (ifmType === "0200" ? "취소" : ifmType),
    occurredAt: compactDateToIso(rawDate),
    card: fields[6] || "",
    issuerName: fields[8] || "",
    approvalNo: fields[10] || "",
    originalApprovalNo: hasOriginalApprovalReference(originalApproval) ? originalApproval : "",
    amount: Math.abs(signedAmount),
    isCanceled,
  };
}

function toMonitorEvent(record: EasyShopRecord): MonitorEvent {
  const unique = [record.transactionNo, record.terminalNo, record.approvalNo, record.occurredAt, record.amount]
    .join(":");
  return {
    source: "easyshop",
    kind: "easyshop_cancellation",
    fingerprint: `easyshop:cancel:${unique}`,
    title: "취소 거래가 감지되었습니다.",
    occurredAt: record.occurredAt,
    amount: record.amount,
    details: {
      transactionNo: record.transactionNo || null,
      terminalNo: record.terminalNo || null,
      status: record.status || "취소",
      approvalNo: record.approvalNo || null,
      originalApprovalNo: record.originalApprovalNo || null,
      card: record.card || null,
      product: record.issuerName || null,
    },
  };
}

function toSalesTransaction(record: EasyShopRecord): SalesTransaction {
  const occurredAt = record.occurredAt;
  const businessDate = occurredAt ? occurredAt.slice(0, 10) : compactDateToDashed(compactKstDate(new Date()));
  const externalId = record.transactionNo || [record.terminalNo, record.approvalNo, occurredAt ?? "", record.amount].join(":");
  return {
    source: "easyshop",
    externalId,
    occurredAt,
    businessDate,
    amount: record.amount,
    productName: null,
    quantity: 1,
    status: record.status || null,
    isCanceled: record.isCanceled,
    details: {
      transactionNo: record.transactionNo || null,
      terminalNo: record.terminalNo || null,
      approvalNo: record.approvalNo || null,
      originalApprovalNo: record.originalApprovalNo || null,
      card: record.card || null,
      issuerName: record.issuerName || null,
      status: record.status || null,
    },
  };
}

type SessionValues = {
  clientTimeOffset: string;
  latestTouch: string;
  sessionExpiry: string;
  remainTime: string;
};

function refreshSessionCookies(jar: CookieJar): SessionValues {
  const now = Date.now();
  const expiry = now + 2 * 60 * 60 * 1000;
  const values = {
    // EasyShop's Nexacro client supplies this session offset during login.
    clientTimeOffset: "66",
    latestTouch: String(now),
    sessionExpiry: String(expiry),
    remainTime: String(expiry - now),
  };
  for (const [key, value] of Object.entries(values)) jar.set(key, value);
  jar.set("LoginInfo", "");
  return values;
}

function buildLoginXml(loginId: string, password: string, session: SessionValues) {
  return xmlRoot(`
    ${commonParameters("Login", "undefined", session)}
    <Dataset id="dsInData">
      <ColumnInfo>
        <Column id="SvcId" type="STRING" size="256"  />
        <Column id="gubun" type="STRING" size="2"  />
        <Column id="login_id" type="STRING" size="20"  />
        <Column id="pswd" type="STRING" size="50"  />
        <Column id="ctz_no" type="STRING" size="13"  />
        <Column id="ip_addr" type="STRING" size="23"  />
        <Column id="cert_dn" type="STRING" size="408"  />
        <Column id="otp_login_cd" type="STRING" size="1"  />
        <Column id="otpYn" type="STRING" size="256"  />
        <Column id="txtID" type="STRING" size="256"  />
        <Column id="txtOtp" type="STRING" size="256"  />
      </ColumnInfo>
      <Rows><Row>
        <Col id="SvcId">TCMM100S01</Col>
        <Col id="gubun">3</Col>
        <Col id="login_id">${xmlEscape(loginId)}</Col>
        <Col id="pswd">${xmlEscape(password)}</Col>
        <Col id="ctz_no" />
        <Col id="ip_addr" />
        <Col id="cert_dn" />
        <Col id="otp_login_cd" />
      </Row></Rows>
    </Dataset>
  `);
}

type ContextField = {
  id: string;
  value: string | null;
  type?: string;
  size?: string;
};

function field(id: string, value: string | null, type = "STRING", size = "256"): ContextField {
  return { id, value, type, size };
}

async function callContextService(
  jar: CookieJar,
  memberId: string,
  argPgmId: string,
  serviceId: string,
  fields: ContextField[],
) {
  const session = refreshSessionCookies(jar);
  return callService(jar, buildContextServiceXml(memberId, argPgmId, serviceId, session, fields));
}

function buildContextServiceXml(
  memberId: string,
  argPgmId: string,
  serviceId: string,
  session: SessionValues,
  fields: ContextField[],
) {
  const columns = [field("SvcId", serviceId), ...fields]
    .map(({ id, type, size }) => `<Column id="${id}" type="${type}" size="${size}"  />`).join("");
  const rows = [field("SvcId", serviceId), ...fields]
    .map(({ id, value }) => value === null ? `<Col id="${id}" />` : `<Col id="${id}">${xmlEscape(value)}</Col>`).join("");
  return xmlRoot(`${commonParameters(argPgmId, memberId, session)}
    <Dataset id="dsInData"><ColumnInfo>${columns}</ColumnInfo><Rows><Row>${rows}</Row></Rows></Dataset>`);
}

function buildSalesXml(context: EasyShopContext, session: SessionValues, window: SalesWindow) {
  // EasyShop validates this dynamic-query dataset shape server-side. Keep the
  // columns and populated fields aligned with the browser request exactly.
  const valueRows: Record<string, string | null> = {
    SvcId: "TESS103S01",
    func_cd: "3",
    gubun: "0",
    retrv_dt01: window.date,
    retrv_dt02: window.date,
    trx_tm: window.fromTime,
    trx_tm2: window.toTime,
    bizr_no: context.bizrNo,
    tid: context.tid,
    trx_resp_cd: "0000",
    fromPageNo: "0",
    endPageNo: "1000",
    cardno2: null,
    sql_con: SQL_CON,
    sql_alias: SQL_ALIAS,
    excp_yn: "0",
    aply_yn: "0",
    rowCnt: "0",
    rowCnt02: "0",
  };
  const columns = EASYSHOP_SALES_COLUMNS
    .map(({ id, type, size }) => `<Column id="${id}" type="${type}" size="${size}"  />`).join("");
  const row = Object.entries(valueRows)
    .map(([name, value]) => value === null
      ? `<Col id="${name}" />`
      : `<Col id="${name}">${xmlEscape(value)}</Col>`)
    .join("");
  return xmlRoot(`
    ${commonParameters("div_Work", context.memberId, session)}
    <Dataset id="dsInData"><ColumnInfo>${columns}</ColumnInfo><Rows><Row>${row}</Row></Rows></Dataset>
    <Dataset id="purch"><ColumnInfo><Column id="purch_fm_cd" type="STRING" size="6"/></ColumnInfo><Rows/></Dataset>
    <Dataset id="cardTyp"><ColumnInfo><Column id="card_typ" type="STRING" size="1"/></ColumnInfo><Rows/></Dataset>
  `);
}

function commonParameters(argPgmId: string, memberId: string, session: SessionValues) {
  return `<Parameters>
    <Parameter id="LoginInfo"/>
    <Parameter id="clientTimeOffset">${xmlEscape(session.clientTimeOffset)}</Parameter>
    <Parameter id="remainTime">${xmlEscape(session.remainTime)}</Parameter>
    <Parameter id="latestTouch">${xmlEscape(session.latestTouch)}</Parameter>
    <Parameter id="sessionExpiry">${xmlEscape(session.sessionExpiry)}</Parameter>
    <Parameter id="arg_pgmId">${xmlEscape(argPgmId)}</Parameter>
    <Parameter id="nMbr_id">${xmlEscape(memberId)}</Parameter>
  </Parameters>`;
}

function xmlRoot(content: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Root xmlns="http://www.nexacroplatform.com/platform/dataset">${content}</Root>`;
}

function extractDatasetRows(xml: string, datasetId: string): string[] {
  const dataSet = new RegExp(`<Dataset\\s+id="${datasetId}"[^>]*>([\\s\\S]*?)<\\/Dataset>`, "i").exec(xml)?.[1] ?? "";
  return [...dataSet.matchAll(/<Row>([\s\S]*?)<\/Row>/gi)].map((match) => match[1]);
}

function getColumn(xml: string, id: string): string {
  return decodeXml(new RegExp(`<Col\\s+id="${id}"\\s*>([\\s\\S]*?)<\\/Col>`, "i").exec(xml)?.[1] ?? "").trim();
}

function getCodeValue(xml: string, code: string) {
  return extractDatasetRows(xml, "subData")
    .map((row) => ({ key: getColumn(row, "com_cd_id").toUpperCase(), value: getColumn(row, "com_cd_val") }))
    .find((row) => row.key === code)?.value ?? "";
}

function assertNoServiceError(xml: string, label: string) {
  const errorCode = getParameter(xml, "ErrorCode");
  if (errorCode && errorCode !== "0") {
    throw new Error(`${label} 오류(ErrorCode=${errorCode}${getParameter(xml, "ErrorMsg") ? `, ${getParameter(xml, "ErrorMsg")}` : ""})`);
  }
}

function getParameter(xml: string, id: string) {
  return decodeXml(new RegExp(`<Parameter\\s+id="${id}"[^>]*>([\\s\\S]*?)<\\/Parameter>`, "i").exec(xml)?.[1] ?? "").trim();
}

function recentSalesWindows(): SalesWindow[] {
  const now = new Date();
  const from = new Date(now.getTime() - EASYSHOP_LOOKBACK_MINUTES * 60 * 1000);
  const fromDate = compactKstDate(from);
  const toDate = compactKstDate(now);
  if (fromDate === toDate) {
    return [{ date: toDate, fromTime: compactKstTime(from), toTime: compactKstTime(now) }];
  }
  return [
    { date: fromDate, fromTime: compactKstTime(from), toTime: "23:59:59" },
    { date: toDate, fromTime: "00:00:00", toTime: compactKstTime(now) },
  ];
}

function uniqueRecords(records: EasyShopRecord[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = [record.transactionNo, record.terminalNo, record.approvalNo, record.occurredAt, record.amount].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactKstDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}${part("month")}${part("day")}`;
}

function compactKstTime(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "00";
  return `${part("hour")}:${part("minute")}:${part("second")}`;
}

function normalizeCompactDate(value: string) {
  const compact = value.replace(/\D/g, "");
  if (!/^\d{8}$/.test(compact)) throw new Error("EasyShop 조회일은 YYYY-MM-DD 형식이어야 합니다.");
  return compact;
}

function compactDateToDashed(value: string) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function compactDateToIso(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 14) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}+09:00`;
}

function signedNumber(value: string) {
  const cleaned = value.replace(/,/g, "").trim();
  const number = Number(cleaned.replace(/[^0-9-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function hasOriginalApprovalReference(value: string) {
  return !["", "20", "000000", "00000000", "20000000"].includes(value.trim());
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function decodeXml(value: string) {
  return value
    .replace(/&#32;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"");
}

function htmlHeaders(referer: string): HeadersInit {
  return { "user-agent": USER_AGENT, "accept-language": "ko-KR,ko;q=0.9", referer };
}

function xmlHeaders(referer: string): HeadersInit {
  return {
    ...htmlHeaders(referer),
    accept: "application/xml, text/xml, */*",
    "content-type": "text/xml; charset=UTF-8",
    "cache-control": "no-cache, no-store",
    pragma: "no-cache",
    expires: "-1",
    "if-modified-since": "Thu, 01 Jun 1970 00:00:00 GMT",
    origin: config.easyShop.baseUrl,
    "x-requested-with": "XMLHttpRequest",
  };
}

// Match the supported browser client used by EasyShop's Nexacro application.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const EASYSHOP_SALES_COLUMNS = [
  "SvcId", "user_id", "aut_id", "func_cd", "gubun", "retrv_dt01", "retrv_dt02", "bizr_no", "tid",
  "aprv_no", "cardno", "iss_fm_nm", "purch_fm_nm", "fin_org_cd", "jo_shop_no", "tot_trx_amt",
  "tot_trx_amt2", "s_alot_months_cnt", "s_alot_months_cnt2", "trx_tm", "trx_tm2", "trx_can_cl_cd",
  "trx_resp_cd", "oil", "fromPageNo", "endPageNo", "remk", "remk2", "remk_1", "remk_2", "trx_typ",
  "cardno2", "max_no", "itm_tit2", "itm_sz", "itm_fmt", "itm_mode", "itm_align", "sql_con", "sql_alias",
  "gid", "card_typ_flag", "excp_yn", "trx_dt", "aply_yn",
].map((id) => ({ id, type: "STRING", size: "256" })).concat([
  { id: "rowCnt", type: "BIGDECIMAL", size: "12" },
  { id: "rowCnt02", type: "BIGDECIMAL", size: "12" },
]);

// The browser sends a server-approved dynamic select expression for TESS103S01.
// Its exact field order is required by EasyShop's anti-tampering validation.
const SQL_CON = "NVL(trx_natr_no,' ') as trx_natr_no, NVL(trx_can_cl_cd,' ') as trx_can_cl_cd, NVL(slip_no,' ') as slip_no, NVL(case when trx_resp_cd='0000' and trx_can_cl_cd not in ('0', '7') then '통신취소' when ifm_typ_cd='0100' and trx_resp_cd='0000' and trx_can_yn='C' then '승인원거래' when ifm_typ_cd='0200' and trx_resp_cd='0000' and trx_can_yn='C' then '취소원거래' when m_gd_cd='LC' then '조회' when trx_resp_cd!='0000' then '거절' when ifm_typ_cd='0100' then '승인' when ifm_typ_cd='0200' and trx_resp_cd='0000' and trx_cl_cd='TI' then '전화취소' when ifm_typ_cd='0200' and trx_resp_cd='0000' and trx_dt<>orgnl_aprv_dt then '취소' when ifm_typ_cd='0200' then '취소' when ifm_typ_cd is null then ' ' end,' ') as ifm_typ_cd, NVL(trx_dt||trx_tm,' ') as trx_dtm, NVL(nvl(tid, ' '),' ') as tid, NVL(cardno,' ') as cardno, NVL(decode(nvl(card_typ_flag,'N'), 'Y', '체크','G','기프트','신용'),' ') as card_typ_cd, NVL(iss_fm_nm,' ') as iss_fm_nm, NVL(GET_FIN_ORG_NM('F01', purch_fm_cd),' ') as purch_fm_nm, NVL(jo_shop_no,' ') as jo_shop_no, case when ifm_typ_cd='0200' and trx_resp_cd='0000' and aut_yn = 'Y' then nvl(-tot_trx_amt,0) else nvl(tot_trx_amt,0) end as tot_trx_amt, NVL(case when alot_months_cnt='0' then '일시불' when to_char(alot_months_cnt) <> '0' then alot_months_cnt||'개월' else to_char(alot_months_cnt) end,' ') as alot_months_cnt, NVL(aprv_no,' ') as aprv_no, NVL(decode(trx_mthd_cd, '2', 'Y', 'K', 'Y', 'N'),' ') as trx_mthd_cd, NVL(decode(trim(orgnl_aprv_dt), '20', '', '', '', '000000', '', '00000000', '', '20000000', '', decode(substr(orgnl_aprv_dt, 7, 1), '', '20'||orgnl_aprv_dt, orgnl_aprv_dt)),' ') as orgnl_aprv_dt, NVL(DECODE(HNDL_ST_DTL_CD,'60',PAY_PLAN_DT,'63',PAY_PLAN_DT,'66',PAY_PLAN_DT,'67',PAY_PLAN_DT,NULL),' ') as pay_plan_dt, NVL(get_com_cd_nm('TRN_C00002', trx_resp_cd),' ') as trx_resp_cd, NVL(decode(btr_sign_chk_2(mkr_cd, etc_sign_flag, purch_fm_cd, trx_resp_cd, tat_ddc_flag, tat_edc_flag, tat_dcc_rgst_cd), 0, 'Y', DECODE (trm_typ_cd, 'MS', 'Y','N')),' ') as sign_yn, decode(bizr_no,'1168119948','0',req_fee) as req_fee, NVL(req_inv_yn,' ') as req_inv_yn, NVL(req_ret_yn,' ') as req_ret_yn, decode(bizr_no,'1168119948','0',req_pay_plan_amt) as req_pay_plan_amt, NVL(req_pur_yn,' ') as req_pur_yn, NVL(es_can_yn,' ') as es_can_yn, NVL(can_dt,' ') as can_dt, NVL(GET_COM_CD_NM('TRN_C00226',CL),' ') as simp_pay_cl_nm";
const SQL_ALIAS = "trx_natr_no||'@@'||trx_can_cl_cd||'@@'||slip_no||'@@'||ifm_typ_cd||'@@'||trx_dtm||'@@'||tid||'@@'||cardno||'@@'||card_typ_cd||'@@'||iss_fm_nm||'@@'||purch_fm_nm||'@@'||jo_shop_no||'@@'||tot_trx_amt||'@@'||alot_months_cnt||'@@'||aprv_no||'@@'||trx_mthd_cd||'@@'||orgnl_aprv_dt||'@@'||pay_plan_dt||'@@'||trx_resp_cd||'@@'||sign_yn||'@@'||req_fee||'@@'||req_inv_yn||'@@'||req_ret_yn||'@@'||req_pay_plan_amt||'@@'||req_pur_yn||'@@'||es_can_yn||'@@'||can_dt||'@@'||simp_pay_cl_nm";
