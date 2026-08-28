# TODO

## Paid Version

- [x] Implement platform-aware API adapters for 고도몰 and 샵바이 before enabling paid access. (고도몰/워크스페이스 결제 연동 — `src/lib/payment.ts`, `entitlement.ts`)
- [x] Add `GET /app-installed/status` checks for the current platform and mall. (`fetchAppStatus` — ACTIVE/EXPIRED/DELETED, 캐시 + 무료 폴백)
- [x] Add `PUT /app-installed/extend` after an NHN app-store payment is completed. (`/api/payment/extend`, `/api/payment/webhook`)
- [x] Replace the hardcoded `paid = false` quota decision with app-installation expiry checks. (`checkQuota(mallNo, want, paid)`)
- [x] Add paid expiry, payment, expired, uninstall, reinstall, and refund handling to the UI and webhook flow. (관리 화면 플랜 카드, 웹훅 DELETED 시 토큰/캐시 정리)
- [ ] Register the app as a NHN Commerce `판매앱` or convert the existing private app. (콘솔 작업 — 사용자)
- [ ] Configure `판매정보`: payment type `인앱결제`, price, billing period, free trial/free features, refund policy, product information disclosure, support contact, and manual. (폼 작성 — 아래 초안 참고)
- [ ] Store platform, solution type, and app installation identity in the signed session. (몰 토큰은 app_tokens DB에 저장 중; 세션에 platform/solution 저장은 미완)
- [ ] Keep usage history after uninstall; do not reset the free quota on reinstall because NHN free trials are available only once. (현재 DELETED 시 usage 초기화 — 비즈니스 모델 확정 후 재검토)
- [ ] Submit the 판매앱 review request with test access, supported platform details, payment instructions, screenshots, privacy policy, and support information.
- [ ] Verify both 고도몰 and 샵바이 flows after approval: launch, preview, payment, extension, paid import, expiry, uninstall, and reinstall. (샵바이는 미포팅)

### ⚠️ 결제 콜백 수신 방식 확인 필요 (심사 전)
워크스페이스가 결제 완료를 판매사에 알리는 정확한 경로(콜백 URL 등록 위치·payload 형식)는
판매정보 관리/결제 설정 화면에서 확인해야 한다. `/api/payment/webhook`(X-API-Key)과
`/api/payment/extend`(관리자 세션) 두 경로를 만들어 두었으니, 실제 콘솔에서 결제 완료 시그널을
확인한 뒤 payload 매핑(mallNo/shopNo/orderNo)만 맞추면 된다.

References:

- https://workspace.godo.co.kr/guide/app/dev
- https://workspace.godo.co.kr/guide/app/dev/development
- https://workspace.godo.co.kr/guide/app/dev/evaluation
- https://server-docs.shopby.co.kr/?url.primaryName=workspace/ (workspace-server-public.yml — /app-installed/status, /app-installed/extend)
- https://shopby-help.nhn-commerce.com/guide/app/app-store.md (인앱 구매 유형: 무료 체험 / 일부 기능 무료 / 상담 후 가격 결정 / 최소 구매 금액)
