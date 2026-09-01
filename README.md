# Sales Sentinel

VMMS와 EasyShop의 오늘 거래를 감시하고, 아래 조건을 발견하면 텔레그램으로 한 번만 알리는 Vercel용 웹앱입니다.

| 대상 | 알림 조건 |
| --- | --- |
| VMMS | `VMMS_BULK_FIELD` 값이 `VMMS_BULK_VALUE`(기본 `99`)와 일치하거나 `일괄 구매`로 표기된 거래 |
| EasyShop | 취소 상태, 취소 코드, 원승인 참조, 음수 금액, `es_can_yn=Y` 중 하나에 해당하는 거래 |

중복 알림 방지를 위해 이벤트 고유 키와 전송 상태를 Postgres에 저장합니다.

## Vercel 배포 준비

1. Vercel에서 이 GitHub 저장소를 Import합니다.
2. Storage 탭에서 Neon Postgres를 연결하거나, 별도 Postgres의 `DATABASE_URL`을 추가합니다.
3. `.env.example`에 적힌 환경변수를 Production 환경에 등록합니다.
4. `main` 브랜치에 푸시하면 자동 배포됩니다.

비밀값은 GitHub, 소스 코드, 브라우저에 저장하지 않습니다. VMMS/EasyShop 계정과 텔레그램 토큰은 Vercel 환경변수에만 등록하세요.

### 필수 환경변수

```text
DATABASE_URL
CRON_SECRET
MONITOR_ADMIN_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
VMMS_LOGIN_ID
VMMS_LOGIN_PASSWORD
EASYSHOP_LOGIN_ID
EASYSHOP_LOGIN_PASSWORD
```

`CRON_SECRET`, `MONITOR_ADMIN_TOKEN`은 서로 다른 긴 난수로 생성해야 합니다.

EasyShop 로그인 응답 환경에 따라 아래 값을 보조값으로 넣을 수 있습니다. 기본적으로는 로그인 흐름에서 `mbr_id`와 권한 정보를 읽어오며, 조회 서버가 값을 요구할 때만 사용합니다.

```text
EASYSHOP_MEMBER_ID
EASYSHOP_AUT_ID
EASYSHOP_BIZR_NO
EASYSHOP_TID
```

## 실행 주기

`vercel.json`은 `/api/cron/poll`을 5분마다 호출하도록 설정돼 있습니다. Vercel Pro 이상에서 사용할 수 있습니다. Hobby 플랜은 Cron 최소 주기가 하루 1회이므로, 5분 감시가 필요하면 Pro로 올리거나 외부 스케줄러가 같은 API를 호출해야 합니다.

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

## 로컬 실행

Node.js 20 이상에서 실행합니다.

```bash
cp .env.example .env.local
npm install
npm run dev
```

`/` 대시보드에서 최근 알림과 실행 이력을 확인할 수 있습니다.

