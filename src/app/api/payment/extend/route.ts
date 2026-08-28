import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { getToken, recordSubscription, saveToken, markEntitlement } from '@/lib/entitlement';
import { extendAppStatus, expiryAfterMonths, PAID_MONTHS, PAID_PRICE } from '@/lib/payment';

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

  const paymentType = body.paymentType === 'TRIAL' ? 'TRIAL' : 'PAID';
  const price = Number(body.price) || PAID_PRICE;
  const requestDateTime = typeof body.requestDateTime === 'string' && body.requestDateTime
    ? body.requestDateTime
    : expiryAfterMonths(PAID_MONTHS);
  const orderNo = typeof body.orderNo === 'string' ? body.orderNo : undefined;
  const untilTs = new Date(requestDateTime.replace(' ', 'T') + (requestDateTime.includes('Z') ? '' : '+09:00'));

  try {
    await extendAppStatus(accessToken, { orderNo, requestDateTime, paymentType, price });
  } catch (e) {
    // workspace 연장 실패여도 구독 기록은 남긴다? — 아니오: workspace가 차단 상태면 paid로 오인될 수 있으므로 실패를 반환.
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  const recorded = await recordSubscription({ mallNo, orderNo, paymentType, price, untilTs });
  await markEntitlement(mallNo, 'ACTIVE', untilTs);
  if (accessToken && bodyMallNo <= 0) await saveToken(mallNo, accessToken);

  return NextResponse.json({ ok: true, recorded, expireAt: untilTs.toISOString(), price, paymentType });
}