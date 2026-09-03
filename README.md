# Sales Sentinel

VMMS와 EasyShop의 오늘 거래를 감시하고, 아래 조건을 발견하면 텔레그램으로 한 번만 알리는 Vercel용 웹앱입니다. 정상·취소 거래는 판매 원장에도 저장하며, 전일 판매 리포트를 텔레그램으로 발송할 수 있습니다. 실제 작업은 Vercel Function에서 실행하고, Vercel Hobby 플랜의 Cron 제한을 피하기 위해 QStash는 scheduler로만 사용합니다.

| 대상 | 알림 조건 |
| --- | --- |
| VMMS | `VMMS_BULK_FIELD` 값이 `VMMS_BULK_VALUE`(기본 `99`)와 일치하거나 `일괄 구매`로 표기된 거래 |
| EasyShop | 취소 상태, 취소 코드, 원승인 참조, 음수 금액, `es_can_yn=Y` 중 하나에 해당하는 거래 |

중복 알림 방지를 위해 이벤트 고유 키와 전송 상태를 Postgres에 저장합니다.

## Batch Architecture

```text
QStash Schedule (every 5 minutes)
  -> POST /api/cron/batch on Vercel
  -> QStash signature verification
  -> Postgres distributed lock
  -> runBatchJob()
  -> VMMS / EasyShop checks and Telegram alerts

QStash Daily Schedule (09:00 KST)
  -> POST /api/cron/daily-report on Vercel
  -> refresh the full previous business day from both sources
  -> upsert sales ledger and generate Telegram daily report
```

`runBatchJob()`은 QStash 호출과 관리자 수동 실행이 함께 사용합니다. 잠금을 얻지 못한 실행은 `already_running`으로 성공 응답하며, 조회·DB·텔레그램 전송 실패는 HTTP 500으로 반환해 QStash 재시도가 가능하도록 합니다.

## Vercel 배포 준비

1. Vercel에서 이 GitHub 저장소를 Import합니다.
2. Storage 탭에서 Neon Postgres를 연결하거나, 별도 Postgres의 `DATABASE_URL`을 추가합니다.
3. `.env.example`에 적힌 환경변수를 Production 환경에 등록합니다.
4. QStash Console에서 production URL을 대상으로 Schedule을 한 번 생성합니다.
5. `main` 브랜치에 푸시하면 자동 배포됩니다.

비밀값은 GitHub, 소스 코드, 브라우저에 저장하지 않습니다. VMMS/EasyShop 계정과 텔레그램 토큰은 Vercel 환경변수에만 등록하세요.

### 필수 환경변수

```text
DATABASE_URL
MONITOR_ADMIN_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
VMMS_LOGIN_ID
VMMS_LOGIN_PASSWORD
EASYSHOP_LOGIN_ID
EASYSHOP_LOGIN_PASSWORD
```

`MONITOR_ADMIN_TOKEN`은 긴 난수로 생성합니다. QStash signing key 두 개는 QStash Console의 Keys 화면에서 가져옵니다. 일정은 Console에서 한 번만 등록하므로 `QSTASH_TOKEN`은 Vercel 런타임 환경변수에 넣을 필요가 없습니다.

EasyShop 로그인 응답 환경에 따라 아래 값을 보조값으로 넣을 수 있습니다. 기본적으로는 로그인 흐름에서 `mbr_id`와 권한 정보를 읽어오며, 조회 서버가 값을 요구할 때만 사용합니다.

```text
EASYSHOP_MEMBER_ID
EASYSHOP_AUT_ID
EASYSHOP_BIZR_NO
EASYSHOP_TID
```

## QStash 5분 Schedule

Vercel의 기존 Cron 설정은 제거했습니다. QStash Console에서 아래 설정으로 production 배포에 대해 한 번만 생성합니다.

| 항목 | 값 |
| --- | --- |
| Destination | `https://<production-domain>/api/cron/batch` |
| Method | `POST` |
| Schedule | `*/5 * * * *` |
| Retry | QStash 기본값 또는 운영 정책에 맞는 재시도 횟수 |

QStash는 호출마다 `Upstash-Signature`를 추가하며, `/api/cron/batch`는 `QSTASH_CURRENT_SIGNING_KEY`와 `QSTASH_NEXT_SIGNING_KEY`로 이를 검증합니다. 따라서 production endpoint는 QStash 서명 없이는 배치를 실행하지 않습니다.

Schedule을 수정하거나 삭제할 때는 QStash Console의 Schedules 메뉴에서 같은 항목을 편집합니다. 배포 과정에서 Schedule을 자동 생성하지 않으므로 중복 Schedule이 생기지 않습니다.

## 일일 판매 리포트

일일 리포트는 전날의 정상 거래를 기준으로 VMMS와 EasyShop을 **합산하지 않고 출처별로** 표시합니다. 두 출처에 같은 결제 데이터가 포함될 수 있어 단순 합산은 중복 집계 위험이 있기 때문입니다.

- 매출, 거래 건수, 객단가
- 전일 및 지난주 같은 요일 대비 매출 증감
- 취소 건수와 취소 금액
- VMMS 상품별 판매금액 TOP 3 및 지난주 같은 요일 대비 판매수량 증감
- 시간대별 피크 매출
- 5분 감시 실행의 오류 여부

EasyShop 응답에는 상품명이 포함되지 않으므로, 상품별 분석은 VMMS에만 표시됩니다. 첫 7일 동안은 지난주 같은 요일 데이터가 부족해 상품 증감 대신 `비교 데이터 수집 중`으로 표시될 수 있습니다.

QStash Console에 아래 Schedule을 추가하면 매일 오전 9시(KST)에 전날 리포트를 보냅니다.

| 항목 | 값 |
| --- | --- |
| Destination | `https://<production-domain>/api/cron/daily-report` |
| Method | `POST` |
| Schedule | `0 9 * * *` |
| Timezone | `Asia/Seoul` |

리포트 기준일마다 Postgres에 발송 상태를 저장하므로, QStash 재시도나 중복 호출에도 이미 성공한 리포트는 다시 보내지 않습니다.

## 확인 및 수동 실행

배포 후 아래 주소로 설정 누락 여부를 확인합니다.

```text
GET /api/health
```

수동 감시는 관리자 토큰을 포함한 서버 호출만 허용합니다.

```bash
curl -X POST https://<your-domain>/api/monitor/run \
  -H "Authorization: Bearer <MONITOR_ADMIN_TOKEN>"
```

전일 리포트는 다음과 같이 수동 실행할 수 있습니다. 특정 기준일을 시험할 때는 `date`를 추가합니다.

```bash
curl -X POST "https://<your-domain>/api/reports/daily/run?date=2026-09-02" \
  -H "Authorization: Bearer <MONITOR_ADMIN_TOKEN>"
```

수동 실행도 QStash와 같은 `runBatchJob()` 및 Postgres 잠금을 사용합니다. 다른 작업이 실행 중이면 오류 대신 아래와 같이 안전하게 건너뜁니다.

```json
{ "ok": true, "skipped": true, "reason": "already_running" }
```

## 로컬 실행

Node.js 20 이상에서 실행합니다.

```bash
cp .env.example .env.local
npm install
npm run dev
```

개발 서버에서만 QStash 서명 검증을 우회하므로 로컬에서 배치 흐름을 다음처럼 확인할 수 있습니다. Production에서는 같은 요청이 반드시 401을 반환합니다.

```bash
curl -i -X POST http://localhost:3000/api/cron/batch
```

배포 환경의 `batch started`, `batch completed`, `batch failed` 로그는 Vercel Project의 Runtime Logs에서 `/api/cron/batch` 요청과 함께 확인할 수 있습니다.

`/` 대시보드에서 최근 알림과 실행 이력을 확인할 수 있습니다.
