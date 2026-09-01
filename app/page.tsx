import { config, missingMonitorConfiguration } from "@/lib/config";
import { recentEvents, recentRuns } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const missing = missingMonitorConfiguration();
  const [events, runs] = await Promise.all([recentEvents(), recentRuns()]);
  const configuredSources = [
    { label: "VMMS", rule: `타입 ${config.vmms.bulkValue} / 일괄 구매 거래`, configured: Boolean(config.vmms.loginId && config.vmms.loginPassword) },
    { label: "EasyShop", rule: "취소 거래", configured: Boolean(config.easyShop.loginId && config.easyShop.loginPassword) },
  ];

  return (
    <main>
      <section className="hero">
        <p className="eyebrow">SALES SENTINEL</p>
        <h1>매출 이상 감시</h1>
        <p className="hero-copy">VMMS와 EasyShop의 거래를 주기적으로 확인하고, 필요한 순간에만 텔레그램으로 알려드립니다.</p>
        <div className="hero-meta">
          <span className="live-dot" />
          Vercel Cron · 5분 주기 설정
        </div>
      </section>

      {missing.length > 0 ? (
        <section className="setup-alert">
          <div>
            <p className="section-kicker">SETUP REQUIRED</p>
            <h2>배포 환경변수를 채우면 감시가 시작됩니다.</h2>
          </div>
          <code>{missing.join(" · ")}</code>
        </section>
      ) : null}

      <section className="rule-grid" aria-label="감시 규칙">
        {configuredSources.map((source) => (
          <article className="rule-card" key={source.label}>
            <div className="source-mark">{source.label.slice(0, 1)}</div>
            <div>
              <p className="section-kicker">{source.configured ? "READY" : "CREDENTIALS NEEDED"}</p>
              <h2>{source.label}</h2>
              <p>{source.rule}</p>
            </div>
            <span className={source.configured ? "status ready" : "status pending"}>
              {source.configured ? "감시 준비" : "설정 필요"}
            </span>
          </article>
        ))}
      </section>

      <section className="content-grid">
        <article className="panel events-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">ALERT LOG</p>
              <h2>최근 감지 내역</h2>
            </div>
            <span>{events.length}건</span>
          </div>
          {events.length === 0 ? (
            <p className="empty">아직 감지된 거래가 없습니다.</p>
          ) : (
            <div className="event-list">
              {events.map((event) => (
                <div className="event" key={event.id}>
                  <div className={`event-icon ${event.source}`}>{event.source === "vmms" ? "V" : "E"}</div>
                  <div className="event-copy">
                    <strong>{event.title}</strong>
                    <span>{formatDate(event.occurredAt ?? event.detectedAt)}</span>
                    <small>{formatDetails(event.details)}</small>
                  </div>
                  <div className="event-right">
                    <strong>{event.amount === null ? "-" : `${event.amount.toLocaleString("ko-KR")}원`}</strong>
                    <span className={`delivery ${event.telegramStatus}`}>{deliveryLabel(event.telegramStatus)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel run-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">POLLING</p>
              <h2>최근 실행</h2>
            </div>
            <span>{runs.length}회</span>
          </div>
          {runs.length === 0 ? (
            <p className="empty">아직 실행 이력이 없습니다.</p>
          ) : (
            <div className="run-list">
              {runs.map((run) => (
                <div className="run" key={run.id}>
                  <span className={run.ok ? "run-check good" : "run-check bad"}>{run.ok ? "OK" : "!"}</span>
                  <div>
                    <strong>{run.source === "vmms" ? "VMMS" : "EasyShop"}</strong>
                    <span>{formatDate(run.startedAt)}</span>
                    {run.error ? <small>{run.error}</small> : null}
                  </div>
                  <b>{run.eventCount}</b>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      <footer>
        <span>서버 API: <code>/api/health</code></span>
        <span>수동 실행: <code>POST /api/monitor/run</code></span>
      </footer>
    </main>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function formatDetails(details: Record<string, string | number | boolean | null>) {
  const fields = [details.terminalId ?? details.terminalNo, details.product ?? details.status, details.approvalNo]
    .filter((value): value is string | number | boolean => value !== null && value !== "");
  return fields.join(" · ") || "거래 상세 정보";
}

function deliveryLabel(status: "sent" | "failed" | "pending") {
  return status === "sent" ? "텔레그램 발송" : status === "failed" ? "발송 실패" : "발송 대기";
}

