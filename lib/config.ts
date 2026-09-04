const nonBlank = (value: string | undefined) => value?.trim() || "";

export const config = {
  databaseUrl: nonBlank(process.env.DATABASE_URL),
  monitorAdminToken: nonBlank(process.env.MONITOR_ADMIN_TOKEN),
  cronSecret: nonBlank(process.env.CRON_SECRET),
  qstashCurrentSigningKey: nonBlank(process.env.QSTASH_CURRENT_SIGNING_KEY),
  qstashNextSigningKey: nonBlank(process.env.QSTASH_NEXT_SIGNING_KEY),
  telegramBotToken: nonBlank(process.env.TELEGRAM_BOT_TOKEN),
  telegramChatId: nonBlank(process.env.TELEGRAM_CHAT_ID),
  vmms: {
    baseUrl: nonBlank(process.env.VMMS_BASE_URL) || "https://vmms.ubcn.co.kr",
    loginId: nonBlank(process.env.VMMS_LOGIN_ID),
    loginPassword: nonBlank(process.env.VMMS_LOGIN_PASSWORD),
    company: nonBlank(process.env.VMMS_COMPANY) || "806",
    organ: nonBlank(process.env.VMMS_ORGAN) || "207368",
    bulkField: nonBlank(process.env.VMMS_BULK_FIELD) || "input_type",
    bulkValue: nonBlank(process.env.VMMS_BULK_VALUE) || "99",
  },
  easyShop: {
    baseUrl: nonBlank(process.env.EASYSHOP_BASE_URL) || "https://smarteasyshop.kicc.co.kr",
    loginId: nonBlank(process.env.EASYSHOP_LOGIN_ID),
    loginPassword: nonBlank(process.env.EASYSHOP_LOGIN_PASSWORD),
    memberId: nonBlank(process.env.EASYSHOP_MEMBER_ID),
    autId: nonBlank(process.env.EASYSHOP_AUT_ID),
    bizrNo: nonBlank(process.env.EASYSHOP_BIZR_NO) || "*",
    tid: nonBlank(process.env.EASYSHOP_TID) || "*",
  },
};

export function missingMonitorConfiguration(): string[] {
  const entries: Array<[string, string]> = [
    ["DATABASE_URL", config.databaseUrl],
    ["QSTASH_CURRENT_SIGNING_KEY", config.qstashCurrentSigningKey],
    ["QSTASH_NEXT_SIGNING_KEY", config.qstashNextSigningKey],
    ["CRON_SECRET", config.cronSecret],
    ["TELEGRAM_BOT_TOKEN", config.telegramBotToken],
    ["TELEGRAM_CHAT_ID", config.telegramChatId],
    ["VMMS_LOGIN_ID", config.vmms.loginId],
    ["VMMS_LOGIN_PASSWORD", config.vmms.loginPassword],
    ["EASYSHOP_LOGIN_ID", config.easyShop.loginId],
    ["EASYSHOP_LOGIN_PASSWORD", config.easyShop.loginPassword],
  ];
  return entries.filter(([, value]) => !value).map(([key]) => key);
}
