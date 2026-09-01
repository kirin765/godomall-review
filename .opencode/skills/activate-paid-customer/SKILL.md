---
name: activate-paid-customer
description: 수동 실행 전용 스킬 — 새 유료 고객(몰)을 무제한(plus)으로 활성화하는 수동 워크플로우. 수동 계좌이체(토스뱅크) 입금 확인 후 /api/payment/extend 호출로 앱 만료일 연장 + 구독 기록 + ACTIVE 선반영을 수행한다. Use ONLY when explicitly invoked by name (activate-paid-customer) or when the user explicitly asks to run the paid-customer activation workflow. NEVER auto-trigger on payment/입금/결제/유료 keywords alone.
---

# 새 유료 고객 활성화 (수동 계좌이체 전환)

리뷰이사는 인앱결제 API가 없어 **수동 계좌이체**(토스뱅크 1002-5844-8101, 온누리문방구, 월 9,900원 부가세 포함)로
결제를 수신한다. 몰이 입금하면 판매사(우리)가 `/api/payment/extend`를 호출해 그 몰을 무제한(plus)으로 전환한다.

이 스킬은 입금 확인 → 활성화 호출 → 결과 확인까지의 수동 작업을 대신 수행한다.

## 필요한 입력

사용자로부터 다음을 확인한다:

- **mallNo** (필수) — 활성화할 몰 번호. 모르면 물어본다. (몰 이름 → mallNo 매핑 자료는 `/api/diag/mall` 또는 관리 화면 참고)
- **orderNo** (선택) — 앱스토어 주문번호 있으면 기록. 없으면 빈 값.
- **개월 수 / 만료일시** (선택) — 기본 `GODO_PAID_MONTHS`(=1개월). 다르면 사용자에게 확인.

## 활성화 실행

운영 서버(`https://cafe24-review-gamma.vercel.app`)의 `/api/payment/extend`에 POST한다.

```bash
curl -sS -X POST 'https://cafe24-review-gamma.vercel.app/api/payment/extend' \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: '"$GODO_PAYMENT_SECRET" \
  -d '{"mallNo": <MALLNO>, "orderNo": "<ORDERNO>", "paymentType": "CHARGE", "price": 9900}'
```

- 인증 헤더는 `X-API-Key: <GODO_PAYMENT_SECRET>` (환경변수 `GODO_PAYMENT_SECRET`).
  - 로컬 셸에서 실행하기 전에 해당 변수가 설정돼 있는지 확인한다. 없으면 Vercel에서 조회(`vercel env pull`)하거나 사용자에게 물어본다.
  - **비밀값을 로그·채팅·파일에 절대 출력하지 않는다.** curl에 `"$GODO_PAYMENT_SECRET"`를 직접 넣어 변수로만 참조하고, `-v`/에코로 노출하지 않는다.
- `price`는 `PAID_PRICE`(기본 9,900원)와 일치시킨다.
- 세션 쿠키 경로(몰 쪽 브라우저 세션)도 가능하지만, 판매사 쪽에서의 활성화는 **X-API-Key 경로가 정석**이다.

## 결과 확인

응답이 정상이면 `{ ok: true, expireAt, price, paymentType }`이 온다.

- `ok: true` → 활성화 완료. `expireAt`(만료일시)을 사용자에게 알려준다.
- `ok: false` / 401 → 인증 실패. `GODO_PAYMENT_SECRET`이 맞는지 확인.
- 400 (`mallNo and token required`) → 토큰이 없다. 해당 몰이 앱을 한 번도 실행하지 않은 상태. 사용자에게 "몰이 앱을 먼저 한 번 실행해야 한다"고 안내.
- 502 (extend 실패) → 워크스페이스 연장 실패. error 메시지를 보여주고 사용자에게 문의.

## 주의

- 이 스킬은 **실제 결제 전환(쓰기)** 이므로 영향(무료 → 무제한 전환)을 사용자에게 한 번 확인받고 실행한다. 활성화할 mallNo와 금액·기간이 맞는지 짧게 되묻는다.
- 재설치 몰은 NHN 체험이 1회라 EXPIRED에서 시작한다 — 결제 기간만큼만 연장하므로 이 흐름과 무관하게 정상 동작한다.
- DELETE/재설치로 사용량이 리셋되지 않는 정책과 달리, 결제 활성화는 구독 기록(`app_subscriptions`)으로 판정되므로 과거 기록이 있어도 문제없다.