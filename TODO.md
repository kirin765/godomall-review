# TODO

## Paid Version

- [x] Implement platform-aware API adapters for 고도몰 and 샵바이 before enabling paid access. (고도몰/워크스페이스 결제 연동 — `src/lib/payment.ts`, `entitlement.ts`)
- [x] Add `GET /app-installed/status` checks for the current platform and mall. (`fetchAppStatus` — ACTIVE/EXPIRED/DELETED, 캐시 + 무료 폴백)
- [x] Add `PUT /app-installed/extend` after an NHN app-store payment is completed. (`/api/payment/extend`, `/api/payment/webhook`)
- [x] Replace the hardcoded `paid = false` quota decision with app-installation expiry checks. (`checkQuota(mallNo, want, paid)`)
- [x] Add paid expiry, payment, expired, uninstall, reinstall, and refund handling to the UI and webhook flow. (관리 화면 플랜 카드, 웹훅 DELETED 시 토큰/캐시 정리)
- [x] Register the app as a NHN Commerce `판매앱` or convert the existing private app. (콘솔 작업 — 사용자)
- [x] Register the app as a NHN Commerce `판매앱` or convert the existing private app. (콘솔 작업 — 사용자)
- [x] Configure `판매정보`: payment type `무료 사용(체험) 기간 3일` (2026-09-02 확정 — 앱스토어에 가격·콜백 폼이 없어 결제 유형은 노출 문구로만 사용). **결제 수신은 수동 계좌이체**(토스뱅크 1002-5844-8101, 온누리문방구)로 확정 — `PAYMENT_INFO`로 관리 화면·챗봇에 안내.
- [x] Store platform, solution type, and app installation identity in the signed session. (몰 토큰은 app_tokens DB에 저장 중; 세션에 platform/solution 저장은 미완)
- [ ] Keep usage history after uninstall; do not reset the free quota on reinstall because NHN free trials are available only once. (현재 DELETED 시 usage 초기화 — 비즈니스 모델 확정 후 재검토)
- [x] Submit the 판매앱 review request with test access, supported platform details, payment instructions, screenshots, privacy policy, and support information. (승인됨 — 사용자)
- [ ] Verify both 고도몰 and 샵바이 flows after approval: launch, preview, payment, extension, paid import, expiry, uninstall, and reinstall. (샵바이는 미포팅)

### ✅ 결제 수신 방식 확정 (2026-09-02)
워크스페이스에는 결제 수신 API가 없다(server 스펙·콘솔 실측으로 확정). 따라서 **수동 계좌이체**(토스뱅크 1002-5844-8101, 온누리문방구, 월 9,900원 부가세 포함)로
몰이 입금 → 판매사가 `/api/payment/extend` 호출 → 무제한 전환한다. 세금계산서는 판매사가 몰에 직접 발행.
운영 반영: `PAYMENT_INFO`(payment.ts) + 관리 화면 PlanCard 계좌이체 안내 + 챗봇 지식 + 이용절차 문서.

**실측 (2026-09-01)**: 앱스토어 상세에 가격/결제 섹션이 전혀 안 보임 → 판매정보 관리에서
결제방식(인앱결제)·상품(리뷰이사 플러스 월 9,900원)·결제완료 콜백 URL 등록이 선행돼야 한다.
등록 전까지는 몰 설치가 EXPIRED(결제대기)로 떠도 결제 수단이 없어 영구 대기 상태다.
(우리 서버에서 직접 extend하면 수동으로 ACTIVE 전환은 가능 — 테스트 검증 완료)

References:

- https://workspace.godo.co.kr/guide/app/dev
- https://workspace.godo.co.kr/guide/app/dev/development
- https://workspace.godo.co.kr/guide/app/dev/evaluation
- https://server-docs.shopby.co.kr/?url.primaryName=workspace/ (workspace-server-public.yml — /app-installed/status, /app-installed/extend)
- https://shopby-help.nhn-commerce.com/guide/app/app-store.md (인앱 구매 유형: 무료 체험 / 일부 기능 무료 / 상담 후 가격 결정 / 최소 구매 금액)
