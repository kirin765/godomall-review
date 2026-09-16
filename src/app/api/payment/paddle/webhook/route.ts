import { NextRequest, NextResponse } from 'next/server';
import { activatePaid } from '@/lib/activate';
import { PAID_MONTHS, PAID_PRICE, parseWorkspaceDate } from '@/lib/payment';
import { fetchPaddleSubscription, mallNoFromCustomData, PADDLE_ENV, verifyPaddleSignature } from '@/lib/paddle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/payment/paddle/webhook — Paddle Billing 결제/구독 이벤트 수신.
 *
 * 인증: `Paddle-Signature` 헤더(HMAC-SHA256, raw body 기준) — 실패 시 401.
 * 동작: custom_data.mallNo로 몰을 식별 → 만료일(구독 기간 종료일) 계산 → activatePaid로
 *       workspace 연장 + app_subscriptions 원장 기록 + entitlement ACTIVE 선반영.
 *
 * 멱등성: orderNo에 이벤트 고유 키(거래 ID 또는 `구독ID@기간종료일`)를 넣어 재전송·중복 이벤트를
 *         건너뛴다. 처리 실패(원장 기록 실패)는 500으로 돌려 Paddle이 재시도하게 한다.
 *
 * Paddle 대시보드 > Developer tools > Notifications에서 이 URL을 destination으로 등록하고,
 * 구독 이벤트(subscription.created/activated/updated/canceled) + transaction.completed를 구독한다.
 */
type PaddleItem = { price?: { unit_price?: string | null } | null };
type PaddleEventData = {
  id?: string;
  status?: string;
  subscription_id?: string | null;
  custom_data?: Record<string, unknown> | null;
  current_billing_period?: { ends_at?: string | null } | null;
  items?: PaddleItem[];
  details?: { totals?: { grand_total?: string | null; total?: string | null } | null } | null;
};
type PaddleWebhookEvent = { event_id?: string; event_type?: string; data?: PaddleEventData };

/** 이벤트에서 결제 금액(최소 단위 문자열)을 뽑는다. 없으면 PAID_PRICE. */
function priceFromEvent(data: PaddleEventData): number {
  const totals = data.details?.totals;
  const raw = totals?.grand_total ?? totals?.total ?? data.items?.[0]?.price?.unit_price;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : PAID_PRICE;
}

/** 구독 이벤트에서 기간 종료일을 Date로. 없으면 null. */
function periodEnd(data: PaddleEventData): Date | null {
  return parseWorkspaceDate(data.current_billing_period?.ends_at ?? undefined);
}

/** 기간 정보를 못 얻었을 때의 폴백 만료일 — now + GODO_PAID_MONTHS. */
function defaultUntil(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + PAID_MONTHS);
  return d;
}

async function activate(
  mallNo: number,
  orderNo: string,
  untilTs: Date,
  price: number,
): Promise<NextResponse> {
  const res = await activatePaid({ mallNo, orderNo, untilTs, price, paymentType: 'CHARGE' });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    duplicate: res.duplicate,
    recorded: res.recorded,
    workspace: res.workspace,
    mallNo,
    expireAt: untilTs.toISOString(),
  });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyPaddleSignature(raw, req.headers.get('paddle-signature'))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let event: PaddleWebhookEvent;
  try {
    event = JSON.parse(raw) as PaddleWebhookEvent;
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const type = String(event.event_type ?? '');
  const data = event.data ?? {};
  const mallNo = mallNoFromCustomData(data.custom_data);

  // 구독 취소/일시정지 — 이미 부여한 기간(만료일)까지는 이용 가능하므로 추가 처리 없음.
  if (type === 'subscription.canceled' || type === 'subscription.paused') {
    console.log('paddle webhook: 구독 중단(기간 만료까지 이용)', { type, subscription: data.id ?? '', mallNo });
    return NextResponse.json({ ok: true, ignored: type });
  }

  if (type === 'transaction.completed') {
    if (!mallNo) {
      console.warn('paddle webhook: custom_data.mallNo 없음 — 건너뜀', { id: data.id ?? '' });
      return NextResponse.json({ ok: true, ignored: 'no mallNo' });
    }
    // 구독 결제면 구독의 기간 종료일을, 단건 결제면 now + 개월 수를 만료일로 삼는다.
    let untilTs: Date | null = null;
    let orderNo = String(data.id ?? '');
    if (data.subscription_id) {
      const sub = await fetchPaddleSubscription(String(data.subscription_id));
      untilTs = parseWorkspaceDate(sub?.current_billing_period?.ends_at ?? undefined);
      // 구독 이벤트와 같은 키로 맞춰 중복 기록을 막는다.
      if (untilTs) orderNo = `${data.subscription_id}@${untilTs.toISOString()}`;
    }
    if (!untilTs) untilTs = defaultUntil();
    if (!orderNo) orderNo = `txn@${untilTs.toISOString()}`;
    return activate(mallNo, orderNo, untilTs, priceFromEvent(data));
  }

  if (type.startsWith('subscription.')) {
    if (!mallNo) {
      console.warn('paddle webhook: custom_data.mallNo 없음 — 건너뜀', { type, id: data.id ?? '' });
      return NextResponse.json({ ok: true, ignored: 'no mallNo' });
    }
    const untilTs = periodEnd(data) ?? defaultUntil();
    const orderNo = `${data.id ?? 'sub'}@${untilTs.toISOString()}`;
    return activate(mallNo, orderNo, untilTs, priceFromEvent(data));
  }

  console.log('paddle webhook: 미처리 이벤트', { type, env: PADDLE_ENV });
  return NextResponse.json({ ok: true, ignored: type });
}
