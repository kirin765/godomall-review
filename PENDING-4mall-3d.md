# PENDING — 4개 몰 "3일, 20건 제한" 사용 부여

> 상태: **구독 없음(무료 20건 유지) — 각 몰 실행 후 TRIAL extend로 3일 실행창 열기 예정.**
> 사용자 지시: "give these mall 3days limited usage from now on" → 명확화: **"I mean, 3days, 20 limits"**
> → 무제한 아님. **무료 20건 제한을 유지한 채 3일간 앱 사용이 가능해야 함.**

## 대상 몰 (전부 아직 앱 미설치 → 토큰 없음)
| 몰명 | mallNo | 몰 URL | 도메인 |
|---|---|---|---|
| treemom | 505632 | treemom1.godomall.com | treemom.co.kr |
| photoclam1 | 557446 | photoclam11.godomall.com | photoclam.kr |
| bandi2012 | 783478 | bandi20121.godomall.com | cheru.co.kr |
| roseeb2017 | 1155665 | roseeb201713.godomall.com | roseeshop.com |

## 지금까지 한 것
- **무제한 구독 잘못 부여 → 삭제 완료** (op-*-3d 행 전부 제거, subs 조회로 확인).
- 임시 진단 라우트에 `extend-ws` 액션 추가 (TRIAL extend, **구독 기록 없음** — paid로 만들지 않음).

## 핵심 원리 (왜 TRIAL extend인가)
- 결제형(인앱) 앱은 설치 직후 워크스페이스가 **EXPIRED**로 시작 → 서버 API(SA0010 "설치한 앱이 만료되었습니다")가
  막혀 **무료 20건조차 사용 불가**.
- `PUT /app-installed/extend`를 **TRIAL**(무료 체험)로 호출하면 ACTIVE 상태가 되어 앱이 실행 가능해진다.
- 구독(app_subscriptions)을 기록하면 paid(무제한)가 되므로 **기록하지 않는다** → 20건 제한 유지.
  (getEntitlement: `!blocked && hasActiveSub` — hasActiveSub=false면 free)

## 남은 단계 (몰이 설치+실행 한 뒤 마다)
1. `GET /api/diag/mall?mallNo={mallNo}&action=status` — EXPIRED 확인
2. `GET /api/diag/mall?mallNo={mallNo}&action=extend-ws&days=3&paymentType=TRIAL&price=0`
   → 워크스페이스 ACTIVE(3일) + 구독 없음 → **무료 20건, 3일간 사용 가능**
3. 필요시 옮기기 동작(20건 한도) 확인

## 정리 (모든 몰 완료 후)
- 임시 진단 라우트 `src/app/api/diag/mall/route.ts` 제거
- Vercel env `DIAG_KEY` 삭제, `/tmp/diag-key.txt` 삭제
- 이 메모 삭제

## 키
- `x-diag-key` = DIAG_KEY (production env 등록됨, /tmp/diag-key.txt)
