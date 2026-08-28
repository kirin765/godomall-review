import { NextRequest, NextResponse } from 'next/server';
import { getToken, recordSubscription, markEntitlement } from '@/lib/entitlement';
import { extendAppStatus, expiryAfterMonths, PAID_MONTHS, PAID_PRICE } from '@/lib/payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/payment/webhook — 앱스토어 인앱결제 완료 콜백(판매사 쪽 수신).
 *
 * ⚠️ 앱스토어(워크스페이스)가 결제 완료 시 판매사로 보내는 콜백 형식은 콘솔마다 다르다.
 *    판매정보 관리에서 이 URL을 결제 완료 콜백/웹훅으로 등록하고, payload의 몰 식별 필드
 *    (mallNo / shopNo / appInstalledNo…)에 맞춰 아래 매핑을 조정한다.
 *    워크스페이스가 콜백을 지원하지 않으면 /api/payment/extend(관리자 세션)로 동일 처리가 가능하다.
 *
 * 인증: X-API-Key: GODO_PAYMENT_SECRET (필수)
 * body: {
 *   mallNo / shopNo   : 대상 몰 (필수)
 *   orderNo?          : 앱스토어 주문번호
 *   requestDateTime?  : 새 만료일시 (없으면 now + GODO_PAID_MONTHS)
 *   paymentType?      : "TRIAL" | "PAID"
 *   price?            : 결제 금액
 * }
 */
export async function POST(req: NextRequest) {
  const secret = process.env.GODO_PAYMENT_SECRET;
  const apiKey = req.headers.get('x-api-key');
  if (!secret || !apiKey || apiKey !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const mallNo = Number(body.mallNo ?? body.shopNo ?? 0);
  if (!mallNo) return NextResponse.json({ error: 'mallNo required' }, { status: 400 });

  const accessToken = await getToken(mallNo);
  if (!accessToken) {
    // 몰이 한 번도 앱을 실행하지 않아 토큰이 없다 — 무료 폴백(결제 처리 불가)을 안내.
    return NextResponse.json({ error: 'no token for mall; run the app once first' }, { status: 409 });
  }

  const paymentType = body.paymentType === 'TRIAL' ? 'TRIAL' : 'PAID';
  const price = Number(body.price) || PAID_PRICE;
  const requestDateTime = typeof body.requestDateTime === 'string' && body.requestDateTime
    ? body.requestDateTime
    : expiryAfterMonths(PAID_MONTHS);
  const orderNo = typeof body.orderNo === 'string' ? body.orderNo : undefined;
  const untilTs = new Date(requestDateTime.replace(' ', 'T') + '+09:00');

  try {
    await extendAppStatus(accessToken, { orderNo, requestDateTime, paymentType, price });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }

  await recordSubscription({ mallNo, orderNo, paymentType, price, untilTs });
  await markEntitlement(mallNo, 'ACTIVE', untilTs);
  return NextResponse.json({ ok: true, expireAt: untilTs.toISOString(), price, paymentType });
}