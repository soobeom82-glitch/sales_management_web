import { CookieJar } from "@/lib/cookie-jar";
import { config } from "@/lib/config";
import type { MonitorEvent, SourceCheckResult } from "@/lib/types";

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
  amount: number;
  isCanceled: boolean;
};

export async function checkEasyShopCancellations(): Promise<SourceCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    if (!config.easyShop.loginId || !config.easyShop.loginPassword) {
      throw new Error("EasyShop 로그인 환경변수가 설정되지 않았습니다.");
    }

    const jar = new CookieJar();
    const context = await loginAndLoadContext(jar);
    const records = await fetchTodaySales(jar, context);
    const events = records.filter((record) => record.isCanceled).map(toMonitorEvent);
    return {
      source: "easyshop",
      checkedAt,
      events,
      metadata: { scannedTransactions: records.length, matchedTransactions: events.length },
    };
  } catch (error) {
    return {
      source: "easyshop",
      checkedAt,
      events: [],
      error: error instanceof Error ? error.message : "EasyShop 조회 중 알 수 없는 오류",
    };
  }
}

async function loginAndLoadContext(jar: CookieJar): Promise<EasyShopContext> {
  const base = config.easyShop.baseUrl.replace(/\/$/, "");
  await jar.fetch(`${base}/smart_kicc/index.jsp`, { headers: htmlHeaders(`${base}/`) });

  const loginResponse = await jar.fetch(`${base}/login.do`, {
    method: "POST",
    headers: xmlHeaders(`${base}/smart_kicc/index.jsp`),
    body: buildLoginXml(config.easyShop.loginId, config.easyShop.loginPassword),
  });
  const loginXml = await loginResponse.text();
  if (!loginResponse.ok) throw new Error(`EasyShop 로그인 요청 실패 (${loginResponse.status})`);
  assertNoServiceError(loginXml, "EasyShop 로그인");

  const memberId = getColumn(loginXml, "mbr_id") || config.easyShop.memberId;
  if (!memberId) throw new Error("EasyShop 로그인 응답에서 mbr_id를 찾지 못했습니다.");

  const session = refreshSessionCookies(jar);
  // Android에서 검증된 화면 진입 순서를 서버 요청에도 적용한다.
  await preloadContext(jar, memberId, session);
  const authXml = await callService(jar, buildAuthContextXml(memberId, session));
  assertNoServiceError(authXml, "EasyShop 권한 확인");

  const autId = getColumn(authXml, "aut_id") || config.easyShop.autId;
  const bizrNo = getCodeValue(authXml, "BIZR_NO") || config.easyShop.bizrNo;
  const tid = getCodeValue(authXml, "TID") || config.easyShop.tid;
  return { memberId, autId, bizrNo, tid };
}

async function preloadContext(jar: CookieJar, memberId: string, session: SessionValues) {
  const loginId = config.easyShop.loginId;
  const calls = [
    buildSimpleServiceXml("TCMM100S05", memberId, session, { gubun: "0", login_id: loginId }),
    buildSimpleServiceXml("TPOE201S11", memberId, session, { func_cd: "0", login_id: loginId }),
    buildSimpleServiceXml("TCMM100S02", memberId, session, { gubun: "1", mbr_id: memberId, url_path: "SEO" }),
    buildSimpleServiceXml("TCMM100S03", memberId, session, {
      rowCnt: "1", func_cd: "1", mbr_id: memberId, pgm_id: "WESS102T01",
      fst_rgtr_id: memberId, lst_updr_id: memberId, url_path: "SEO",
    }),
  ];
  for (const xml of calls) {
    // 보조 컨텍스트 요청은 서버별 권한 차이가 있으므로 실패해도 본 조회에서 최종 판단한다.
    await callService(jar, xml).catch(() => undefined);
  }
}

async function fetchTodaySales(jar: CookieJar, context: EasyShopContext): Promise<EasyShopRecord[]> {
  const session = refreshSessionCookies(jar);
  const responseXml = await callService(jar, buildSalesXml(context, session));
  assertNoServiceError(responseXml, "EasyShop 오늘 매출 조회");
  return extractDatasetRows(responseXml, "data")
    .map((row, index) => parseSalesRecord(row, index))
    .filter((record): record is EasyShopRecord => record !== null);
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
  const signedAmount = signedNumber(rawAmount);
  const isCanceled = status.includes("취소") ||
    (cancelCode !== "" && !["0", "7"].includes(cancelCode)) ||
    signedAmount < 0 ||
    easyShopCancel.toUpperCase() === "Y" ||
    hasOriginalApprovalReference(originalApproval);

  return {
    transactionNo: fields[0] || `row-${index}`,
    terminalNo: fields[2] || "",
    status,
    occurredAt: compactDateToIso(rawDate),
    card: fields[6] || "",
    issuerName: fields[8] || "",
    approvalNo: fields[10] || "",
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
      card: record.card || null,
      product: record.issuerName || null,
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
    clientTimeOffset: "-540",
    latestTouch: String(now),
    sessionExpiry: String(expiry),
    remainTime: String(expiry - now),
  };
  for (const [key, value] of Object.entries(values)) jar.set(key, value);
  jar.set("LoginInfo", "");
  return values;
}

function buildLoginXml(loginId: string, password: string) {
  return xmlRoot(`
    <Dataset id="dsInData">
      <ColumnInfo>
        <Column id="SvcId" type="STRING" size="256"/>
        <Column id="gubun" type="STRING" size="2"/>
        <Column id="login_id" type="STRING" size="20"/>
        <Column id="pswd" type="STRING" size="50"/>
      </ColumnInfo>
      <Rows><Row>
        <Col id="SvcId">TCMM100S01</Col>
        <Col id="gubun">0</Col>
        <Col id="login_id">${xmlEscape(loginId)}</Col>
        <Col id="pswd">${xmlEscape(password)}</Col>
      </Row></Rows>
    </Dataset>
  `);
}

function buildAuthContextXml(memberId: string, session: SessionValues) {
  return xmlRoot(`
    ${commonParameters("div_Work", memberId, session)}
    <Dataset id="dsInData">
      <ColumnInfo>
        <Column id="SvcId" type="STRING" size="256"/>
        <Column id="login_id" type="STRING" size="256"/>
        <Column id="group_yn" type="STRING" size="256"/>
      </ColumnInfo>
      <Rows><Row>
        <Col id="SvcId">TCMM001S02</Col>
        <Col id="login_id">${xmlEscape(config.easyShop.loginId)}</Col>
        <Col id="group_yn">N</Col>
      </Row></Rows>
    </Dataset>
  `);
}

function buildSimpleServiceXml(
  serviceId: string,
  memberId: string,
  session: SessionValues,
  values: Record<string, string>,
) {
  const columns = ["SvcId", ...Object.keys(values)]
    .map((name) => `<Column id="${name}" type="STRING" size="256"/>`).join("");
  const row = Object.entries({ SvcId: serviceId, ...values })
    .map(([name, value]) => `<Col id="${name}">${xmlEscape(value)}</Col>`).join("");
  return xmlRoot(`${commonParameters("div_Work", memberId, session)}
    <Dataset id="dsInData"><ColumnInfo>${columns}</ColumnInfo><Rows><Row>${row}</Row></Rows></Dataset>`);
}

function buildSalesXml(context: EasyShopContext, session: SessionValues) {
  const today = compactToday();
  const valueRows: Record<string, string> = {
    SvcId: "TESS103S01",
    user_id: config.easyShop.loginId,
    aut_id: context.autId,
    func_cd: "3",
    gubun: "0",
    retrv_dt01: today,
    retrv_dt02: today,
    bizr_no: context.bizrNo,
    tid: context.tid,
    trx_resp_cd: "0000",
    fromPageNo: "0",
    endPageNo: "1000",
    cardno2: "",
    sql_con: SQL_CON,
    sql_alias: SQL_ALIAS,
    excp_yn: "0",
    aply_yn: "0",
    rowCnt: "0",
    rowCnt02: "0",
  };
  const columns = Object.keys(valueRows)
    .map((name) => `<Column id="${name}" type="STRING" size="256"/>`).join("");
  const row = Object.entries(valueRows)
    .map(([name, value]) => `<Col id="${name}">${xmlEscape(value)}</Col>`).join("");
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

function compactToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}${part("month")}${part("day")}`;
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

const USER_AGENT = "Mozilla/5.0 (compatible; SalesManagementMonitor/1.0)";

// The application uses EasyShop's TESS103S01 dataset shape from the verified Android request.
const SQL_CON = "NVL(trx_natr_no,' ') as trx_natr_no,NVL(trx_can_cl_cd,' ') as trx_can_cl_cd,NVL(slip_no,' ') as slip_no,NVL(ifm_typ_cd,' ') as ifm_typ_cd,NVL(trx_dt||trx_tm,' ') as trx_dtm,NVL(tid,' ') as tid,NVL(cardno,' ') as cardno,NVL(card_typ_flag,' ') as card_typ_cd,NVL(iss_fm_nm,' ') as iss_fm_nm,NVL(purch_fm_cd,' ') as purch_fm_nm,NVL(jo_shop_no,' ') as jo_shop_no,NVL(tot_trx_amt,0) as tot_trx_amt,NVL(alot_months_cnt,' ') as alot_months_cnt,NVL(aprv_no,' ') as aprv_no,NVL(trx_mthd_cd,' ') as trx_mthd_cd,NVL(orgnl_aprv_dt,' ') as orgnl_aprv_dt,NVL(pay_plan_dt,' ') as pay_plan_dt,NVL(trx_resp_cd,' ') as trx_resp_cd,NVL(sign_yn,' ') as sign_yn,NVL(req_fee,0) as req_fee,NVL(req_inv_yn,' ') as req_inv_yn,NVL(req_ret_yn,' ') as req_ret_yn,NVL(req_pay_plan_amt,0) as req_pay_plan_amt,NVL(req_pur_yn,' ') as req_pur_yn,NVL(es_can_yn,' ') as es_can_yn,NVL(can_dt,' ') as can_dt";
const SQL_ALIAS = "trx_natr_no||'@@'||trx_can_cl_cd||'@@'||slip_no||'@@'||ifm_typ_cd||'@@'||trx_dtm||'@@'||tid||'@@'||cardno||'@@'||card_typ_cd||'@@'||iss_fm_nm||'@@'||purch_fm_nm||'@@'||jo_shop_no||'@@'||tot_trx_amt||'@@'||alot_months_cnt||'@@'||aprv_no||'@@'||trx_mthd_cd||'@@'||orgnl_aprv_dt||'@@'||pay_plan_dt||'@@'||trx_resp_cd||'@@'||sign_yn||'@@'||req_fee||'@@'||req_inv_yn||'@@'||req_ret_yn||'@@'||req_pay_plan_amt||'@@'||req_pur_yn||'@@'||es_can_yn||'@@'||can_dt";
