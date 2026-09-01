import { config } from "@/lib/config";
import type { MonitorEvent } from "@/lib/types";

export async function sendTelegramAlert(event: MonitorEvent): Promise<void> {
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
        text: formatTelegramMessage(event),
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

