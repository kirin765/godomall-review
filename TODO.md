# TODO

## Paid Version (2026-08-25 구현분 — Paddle 정기결제)

> 과금은 **Paddle**(머천트 오브 레코드)로 월 9,900원을 정기결제 징수하고, godomall은
> 인앱결제를 대신 처리하지 않으므로 Paddle 결제 확인 시 `PUT /app-installed/extend(CHARGE)`로
> godomall 만료일을 연장한다. godomall 토큰은 DB(`godo_install`)에 저장해 서버 웹훅이 사용한다.

### 완료 — 코드
- [x] godomall `/app-installed/status`·`/app-installed/extend` 연동 (`src/lib/godomall.ts`)
- [x] godomall 장기 토큰 DB 저장 (`src/lib/install.ts` + `api/auth/launch`에서 saveInstall)
- [x] 초기 설치 시 TRIAL 3일 extend (best-effort, `api/auth/launch`)
- [x] 하루 20건 제한 (KST 일별, `src/lib/quota.ts` + `godo_usage` 테이블)
- [x] 구독 원장 `godo_subscription` (Paddle 구독 id·status·paid_until, `src/lib/subscription.ts`)
- [x] Paddle 클라이언트 (`src/lib/paddle.ts` — 클라이언트 토큰 발급, price, 웹훅 검증)
- [x] 결제 준비 (`/api/billing/prepare` — client token + priceId) + Paddle.js checkout (`/pay`)
- [x] Paddle 웹훅 (`/api/billing/webhook` — 서명검증 → 구독 활성 시 godomall extend + 원장 갱신)
- [x] 관리자 화면: 오늘 남은 건수·만료일·유료 전환 버튼 (`admin/page.tsx`)
- [x] 앱 삭제 웹훅 시 구독·설치토큰 폐기 (`api/webhook/app` + `resetUsage`)

### 남은 것 — Paddle 세팅 + godomall 판매앱 전환
- [ ] Paddle 대시보드: 카탈로그 product + 월 9,900원 subscription price 생성 → `PADDLE_PRICE_ID`
- [ ] Paddle 대시보드: 알림 대상(웹훅 URL=`https://<app>.vercel.app/api/billing/webhook`) 생성 → `PADDLE_WEBHOOK_SECRET`
- [ ] Paddle API 키(test/live) + `PADDLE_ENVIRONMENT` 설정
- [ ] godomall 앱 판매앱 전환 (판매정보: 인앱결제, 가격, 트라이얼, 환불/고지)
- [ ] `PADDLE_PRICE_ID`·`PADDLE_WEBHOOK_SECRET`·`DATABASE_URL` 등 환경변수 배포

## 알려진 리스크/확인 필요
- [ ] godomall 웹훅 서명 검증 수단 (판매앱 전환 전 NHN에 문의 — 현재 문서에 없음)
- [ ] godomall 수수료·정산 (미문서화 — NHN 커머스에 문의)
- [ ] Paddle KRW 결제 지원·프라이싱 확인 (Paddle이 한국 화폐/결제수단 지원 여부)
- [ ] `GODO_APP_API_BASE` — `/app-installed/*`가 `server-api.godomall.com`에서 열리는지 (아니면 `server-api.e-ncp.com`)

References:

- https://developer.paddle.com/
- https://developer.paddle.com/webhooks/signature-verification
- https://workspace.godo.co.kr/guide/app/dev
- https://workspace.godo.co.kr/guide/app/dev/development
- https://workspace.godo.co.kr/guide/app/dev/evaluation
- https://server-docs.shopby.co.kr/?url.primaryName=workspace/
- https://shopby-help.nhn-commerce.com/guide/app/app-store.md
