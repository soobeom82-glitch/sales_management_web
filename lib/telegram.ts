import { config } from "@/lib/config";
import type { DailySalesMetric, DailySalesReport, MonitorEvent, ProductMovement, ProductSalesMetric } from "@/lib/types";

export async function sendTelegramAlert(event: MonitorEvent): Promise<void> {
  await sendTelegramText(formatTelegramMessage(event));
}

export async function sendTelegramDailyReport(report: DailySalesReport): Promise<void> {
  await sendTelegramText(formatDailyReportMessage(report));
}

async function sendTelegramText(text: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error("Telegram configuration is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    },
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 240);
    throw new Error(`Telegram API ${response.status}: ${body}`);
  }
}

function formatTelegramMessage(event: MonitorEvent): string {
  const amount = event.amount === null ? "-" : `${event.amount.toLocaleString("ko-KR")}원`;
  const occurred = event.occurredAt ? formatKoreanDate(event.occurredAt) : "시각 확인 불가";
  const lines = [
    event.source === "vmms" ? "[VMMS 알림]" : "[EasyShop 알림]",
    event.title,
    `시각: ${occurred}`,
    `금액: ${amount}`,
  ];
  for (const [key, value] of Object.entries(event.details)) {
    if (value === null || value === "") continue;
    lines.push(`${labelFor(key)}: ${value}`);
  }
  return lines.join("\n");
}

function formatDailyReportMessage(report: DailySalesReport): string {
  const lines = [
    `[${formatReportDate(report.reportDate)} 일일 판매 리포트]`,
    "정상 거래 기준 · 취소 거래 별도 표기",
  ];

  for (const source of report.sources) {
    lines.push("", source.source === "vmms" ? "[VMMS]" : "[EasyShop]");
    lines.push(`매출 ${money(source.salesAmount)} · ${source.salesCount}건 · 객단가 ${money(averageTicket(source))}`);
    lines.push(`전일 대비 ${formatSalesChange(source.salesAmount, source.previousDay)}`);
    lines.push(`지난주 동요일 대비 ${formatSalesChange(source.salesAmount, source.previousWeek)}`);
    if (source.canceledCount > 0) {
      lines.push(`취소 ${source.canceledCount}건 · ${money(source.canceledAmount)}`);
    }
    if (source.peakHour !== null) {
      lines.push(`피크 시간 ${formatHour(source.peakHour)} · ${money(source.peakHourAmount)}`);
    }
    if (source.topProducts.length > 0) {
      lines.push("판매 TOP 3");
      source.topProducts.slice(0, 3).forEach((product, index) => {
        lines.push(`${index + 1}. ${formatProduct(product)}`);
      });
    }
    appendMovements(lines, "증가 상품", source.increasingProducts, true);
    appendMovements(lines, "감소 상품", source.decreasingProducts, false);
  }

  const healthSummary = report.health
    .map((health) => `${health.source === "vmms" ? "VMMS" : "EasyShop"} ${health.failureCount > 0 ? `오류 ${health.failureCount}/${health.runCount}` : `${health.runCount}회 정상`}`)
    .join(" · ");
  if (healthSummary) {
    lines.push("", `[수집 상태] ${healthSummary}`);
  }
  return lines.join("\n");
}

function appendMovements(lines: string[], label: string, products: ProductMovement[], increasing: boolean) {
  if (products.length === 0) return;
  lines.push(label);
  products.slice(0, 2).forEach((product) => {
    const delta = Math.abs(product.quantityDelta);
    const prefix = product.previousQuantity === 0 && increasing ? "신규" : `${increasing ? "+" : "-"}${delta}개`;
    lines.push(`- ${product.productName} ${prefix}`);
  });
}

function averageTicket(metric: DailySalesMetric) {
  return metric.salesCount > 0 ? Math.round(metric.salesAmount / metric.salesCount) : 0;
}

function formatSalesChange(amount: number, comparison: DailySalesMetric) {
  if (comparison.salesCount === 0 && comparison.canceledCount === 0) return "비교 데이터 수집 중";
  const difference = amount - comparison.salesAmount;
  const sign = difference > 0 ? "+" : difference < 0 ? "-" : "±";
  const percentage = comparison.salesAmount > 0
    ? ` (${Math.abs((difference / comparison.salesAmount) * 100).toFixed(1)}%)`
    : "";
  return `${sign}${money(Math.abs(difference))}${percentage}`;
}

function formatProduct(product: ProductSalesMetric) {
  return `${product.productName} ${product.quantity}개 · ${money(product.amount)}`;
}

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00~${String((hour + 1) % 24).padStart(2, "0")}:00`;
}

function formatReportDate(value: string) {
  const date = new Date(`${value}T12:00:00+09:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short",
  }).format(date);
}

function money(amount: number) {
  return `${amount.toLocaleString("ko-KR")}원`;
}

function formatKoreanDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function labelFor(key: string) {
  const labels: Record<string, string> = {
    transactionNo: "거래번호",
    terminalId: "단말기",
    terminalNo: "단말기",
    transactionType: "거래 유형",
    status: "상태",
    product: "상품",
    approvalNo: "승인번호",
    card: "카드",
  };
  return labels[key] ?? key;
}
