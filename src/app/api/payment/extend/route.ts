import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { getToken, recordSubscription, saveToken, markEntitlement } from '@/lib/entitlement';
import { extendAppStatus, expiryAfterMonths, normalizePaymentType, parseWorkspaceDate, PAID_MONTHS, PAID_PRICE } from '@/lib/payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/payment/extend — 인앱결제 완료 시 앱 만료일 연장 + 구독 기록.
 *
 * 인증: (1) X-API-Key: GODO_PAYMENT_SECRET 헤더  또는  (2) 유효한 앱 세션 쿠키
 * body: {
 *   mallNo?        : 대상 몰 (세션이 있으면 생략 가능, 없으면 필수)
 *   orderNo?       : 앱스토어 주문번호 (있으면 기록)
 *   requestDateTime?: 새 만료일시 "yyyy-MM-dd HH:mm:ss" (없으면 now + GODO_PAID_MONTHS)
 *   paymentType?   : "TRIAL" | "PAID" (기본 PAID)
 *   price?         : 결제 금액 (기본 GODO_PAID_PRICE)
 * }
 *
 * 동작: 워크스페이스 PUT /app-installed/extend 호출 → app_subscriptions 기록 →
 *       app_entitlement를 ACTIVE로 선반영(다음 상태 조회까지의 짧은 공백 제거).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.GODO_PAYMENT_SECRET;
  const apiKey = req.headers.get('x-api-key');
  const session = await sessionMall();

  let mallNo = 0;
  let accessToken: string | null = null;

  if (session) {
    mallNo = session.mallNo;
    accessToken = session.accessToken;
  }
  if (apiKey && secret && apiKey === secret) {
    // 헤더 인증 경로 — mallNo는 body에서, 토큰은 DB(app_tokens)에서
  } else if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* body 없음 허용 (session 경로) */
  }

  const bodyMallNo = Number(body.mallNo ?? body.shopNo ?? 0);
  if (bodyMallNo > 0) {
    mallNo = bodyMallNo;
    if (!accessToken) accessToken = await getToken(mallNo);
  }
  if (!mallNo || !accessToken) {
    return NextResponse.json({ error: 'mallNo and token required' }, { status: 400 });
  }

  const paymentType = normalizePaymentType(body.paymentType);
  const price = Number(body.price) || PAID_PRICE;
  const requestDateTime = typeof body.requestDateTime === 'string' && body.requestDateTime
    ? body.requestDateTime
    : expiryAfterMonths(PAID_MONTHS);
  const orderNo = typeof body.orderNo === 'string' ? body.orderNo : undefined;
  const untilTs = parseWorkspaceDate(requestDateTime);
  if (!untilTs) {
    return NextResponse.json({ ok: false, error: `requestDateTime 형식 오류: ${requestDateTime}` }, { status: 400 });
  }

  try {
    await extendAppStatus(accessToken, { orderNo, requestDateTime, paymentType, price });
  } catch (e) {
    // workspace 연장 실패여도 구독 기록은 남긴다? — 아니오: workspace가 차단 상태면 paid로 오인될 수 있으므로 실패를 반환.
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  const recorded = await recordSubscription({ mallNo, orderNo, paymentType, price, untilTs });
  // DB 미설정(로컬·스모크)은 무시 — DB 없는 모드는 workspace ACTIVE가 곧 paid다.
  if (!recorded && process.env.DATABASE_URL) {
    // 구독 기록은 paid 판정의 근거다. workspace 연장이 성공해도 원장에 안 남으면 고객은 무료로 남는다.
    // 기록 실패를 ok:true로 삼키면 활성화한 줄 알고 넘어간다(cafe24-review 3708400과 같은 부류).
    console.error('payment/extend: 구독 기록 실패 — 활성화가 안 된 채 성공으로 보일 수 있음', {
      mallNo: String(mallNo),
      orderNo: orderNo ?? '',
    });
    return NextResponse.json({ ok: false, error: '구독 기록 실패 — DB 확인 후 재시도 필요' }, { status: 502 });
  }
  await markEntitlement(mallNo, 'ACTIVE', untilTs);
  if (accessToken && bodyMallNo <= 0) await saveToken(mallNo, accessToken);

  return NextResponse.json({ ok: true, recorded, expireAt: untilTs.toISOString(), price, paymentType });
}