import { NextRequest, NextResponse } from 'next/server';
import { getToken, recordSubscription, markEntitlement, clearEntitlement } from '@/lib/entitlement';
import { fetchAppStatus, extendAppStatus, expiryAfterMonths, PAID_MONTHS, PAID_PRICE } from '@/lib/payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const key = process.env.DIAG_KEY;
  if (!key || req.headers.get('x-diag-key') !== key) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const mallNo = Number(req.nextUrl.searchParams.get('mallNo') || 0);
  const action = req.nextUrl.searchParams.get('action') || 'status';
  if (!mallNo) return NextResponse.json({ error: 'mallNo required' }, { status: 400 });

  const token = await getToken(mallNo);
  const info = { mallNo, tokenPresent: !!token, db: !!process.env.DATABASE_URL };

  if (action === 'tokens') {
    const db = process.env.DATABASE_URL ? require('postgres') : null;
    const sql = db(process.env.DATABASE_URL, { max: 1 });
    const rows = await sql`select mall_id, updated_at from app_tokens order by updated_at desc limit 50`.catch((e: Error) => [{ error: e.message.slice(0, 200) }]);
    await sql.end().catch(() => {});
    return NextResponse.json({ action, rows });
  }

  if (action === 'ssub') {
    const days = Number(req.nextUrl.searchParams.get('days') || 0);
    const price = Number(req.nextUrl.searchParams.get('price') || 0);
    const orderNo = req.nextUrl.searchParams.get('orderNo') || `op-ssub-${Date.now()}`;
    const untilTs = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const recorded = await recordSubscription({ mallNo, orderNo, paymentType: 'CHARGE', price, untilTs });
    await markEntitlement(mallNo, 'ACTIVE', untilTs);
    return NextResponse.json({ ...info, action, recorded, orderNo, untilTs: untilTs.toISOString(), days });
  }

  if (action === 'subs') {
    const db = process.env.DATABASE_URL ? require('postgres') : null;
    const sql = db(process.env.DATABASE_URL, { max: 1 });
    const rows = await sql`select mall_id, order_no, payment_type, price, until_ts from app_subscriptions where mall_id = ${String(mallNo)} order by until_ts desc`.catch((e: Error) => [{ error: e.message.slice(0, 200) }]);
    await sql.end().catch(() => {});
    return NextResponse.json({ action, rows });
  }

  if (action === 'del-sub') {
    const orderNo = req.nextUrl.searchParams.get('orderNo') || '';
    const db = process.env.DATABASE_URL ? require('postgres') : null;
    const sql = db(process.env.DATABASE_URL, { max: 1 });
    const rows = await sql`delete from app_subscriptions where mall_id = ${String(mallNo)} and order_no = ${orderNo} returning order_no`.catch((e: Error) => [{ error: e.message.slice(0, 200) }]);
    await sql.end().catch(() => {});
    return NextResponse.json({ action, rows });
  }

  if (!token) return NextResponse.json({ ...info, error: 'no token — 앱을 1회 실행해 토큰을 저장해야 합니다' });

  if (action === 'extend-ws') {
    // workspace extend만 호출하고 구독은 기록하지 않는다 — ACTIVE지만 paid(무제한)는 아님.
    // 목적: 무료 20건 제한을 유지한 채 3일간 앱을 실행 가능하게 (paid-type 앱은 설치 직후 EXPIRED라
    // 서버 API(SA0010)가 막히므로, TRIAL extend로 실행창을 열어준다).
    const paymentType = req.nextUrl.searchParams.get('paymentType') === 'CHARGE' ? 'CHARGE' : 'TRIAL';
    const price = Number(req.nextUrl.searchParams.get('price') || 0);
    const orderNo = req.nextUrl.searchParams.get('orderNo') || `op-ws-${Date.now()}`;
    const days = Number(req.nextUrl.searchParams.get('days') || 0);
    let requestDateTime: string;
    if (days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      requestDateTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    } else {
      requestDateTime = expiryAfterMonths(PAID_MONTHS);
    }
    try {
      await extendAppStatus(token, { orderNo, requestDateTime, paymentType, price });
    } catch (e) {
      return NextResponse.json({ ...info, action, ok: false, error: (e as Error).message.slice(0, 300) }, { status: 502 });
    }
    return NextResponse.json({ ...info, action, ok: true, paymentType, price, orderNo, requestDateTime });
  }

  if (action === 'extend') {
    const paymentType = req.nextUrl.searchParams.get('paymentType') === 'CHARGE' ? 'CHARGE' : 'TRIAL';
    const price = Number(req.nextUrl.searchParams.get('price') || (paymentType === 'CHARGE' ? PAID_PRICE : 0));
    const orderNo = req.nextUrl.searchParams.get('orderNo') || `op-${Date.now()}`;
    const months = Number(req.nextUrl.searchParams.get('months') || PAID_MONTHS);
    const days = Number(req.nextUrl.searchParams.get('days') || 0);
    let requestDateTime: string;
    if (days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      requestDateTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    } else {
      requestDateTime = expiryAfterMonths(months);
    }
    try {
      await extendAppStatus(token, { orderNo, requestDateTime, paymentType, price });
    } catch (e) {
      return NextResponse.json({ ...info, action, ok: false, error: (e as Error).message.slice(0, 300) }, { status: 502 });
    }
    const untilTs = new Date(requestDateTime.replace(' ', 'T') + '+09:00');
    const recorded = await recordSubscription({ mallNo, orderNo, paymentType, price, untilTs });
    await markEntitlement(mallNo, 'ACTIVE', untilTs);
    return NextResponse.json({ ...info, action, ok: true, recorded, paymentType, price, orderNo, requestDateTime });
  }

  const st = await fetchAppStatus(token);
  return NextResponse.json({ ...info, action, status: st });
}
