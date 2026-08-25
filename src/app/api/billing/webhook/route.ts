import { NextRequest, NextResponse } from 'next/server';
import { getPaddle, PADDLE_WEBHOOK_SECRET, PADDLE_PRICE_ID } from '@/lib/paddle';
import { upsertFromPaddle, cancelFromPaddle } from '@/lib/subscription';
import { getInstallToken } from '@/lib/install';
import { extendAppInstall } from '@/lib/godomall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Paddle 결제 웹훅.
 *  - 서명 검증(@paddle/paddle-node-sdk unmarshal — ts+rawBody HMAC-SHA256 자동 처리)
 *  - 유료 구독(activated/updated/created/completed) → godomall /app-installed/extend(CHARGE)로 만료일 연장
 *  - 해지/만료(canceled/past_due) → 로컬 원장 비활성(godomall 만료일은 자연 경과)
 *
 * custom_data에 { mallNo }를 심어 "어느 몰의 구독인지"를 판별한다.
 * 항상 200을 돌려 재전송 스톰을 막는다. 로그만 남기고 실패해도 재전송에 맡긴다.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text(); // 서명 검증은 반드시 원문 — 파싱 금지
  const signature = req.headers.get('paddle-signature') || '';

  if (!PADDLE_WEBHOOK_SECRET) {
    console.error('[paddle] webhook secret not set');
    return NextResponse.json({ ok: true });
  }

  let event;
  try {
    event = await getPaddle().webhooks.unmarshal(rawBody, PADDLE_WEBHOOK_SECRET, signature);
  } catch (e) {
    console.error(`[paddle] webhook verify failed: ${(e as Error).message}`);
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  const data = (event.data ?? {}) as {
    id?: string;
    status?: string;
    custom_data?: { mallNo?: string | number; mall_no?: string | number; shopNo?: string | number };
    current_billing_period?: { ends_at?: string };
    ends_at?: string;
    items?: Array<{ price?: { id?: string } }>;
  };
  const eventType = event.eventType;
  const mallNo = data.custom_data?.mallNo ?? data.custom_data?.mall_no ?? data.custom_data?.shopNo ?? null;

  console.log(`[paddle] event=${eventType} mallNo=${mallNo}`);

  // 결제/구독 활성계열 — 유료 → godomall extend + 로컬 원장 활성
  const activates = ['subscription.created', 'subscription.activated', 'subscription.updated', 'transaction.completed'];
  if (activates.includes(eventType) && mallNo) {
    // transaction.completed는 구독이 아닌 단건일 수도 있으니 구독 활성만 처리
    if (eventType === 'transaction.completed' && !(data.items ?? []).some((i) => i?.price?.id === PADDLE_PRICE_ID)) {
      return NextResponse.json({ ok: true });
    }
    await grantPaid(mallNo, eventType, data);
  }

  // 해지/만료 계열 — 로컬 판정 비활성
  if (['subscription.canceled'].includes(eventType) && mallNo) {
    await cancelFromPaddle(mallNo);
  }

  return NextResponse.json({ ok: true });
}

async function grantPaid(mallNo: string | number, eventType: string, data: {
  id?: string;
  status?: string;
  current_billing_period?: { ends_at?: string };
  ends_at?: string;
}) {
  // paid_until = Paddle billing period 종료일 (있으면 우선, 없으면 +1개월)
  const endsAt: string | undefined = data.current_billing_period?.ends_at ?? data.ends_at;
  const paidUntil = endsAt ? new Date(endsAt) : new Date(Date.now() + 30 * 86400e3);
  if (Number.isNaN(paidUntil.getTime())) {
    await upsertFromPaddle(mallNo, new Date(Date.now() + 30 * 86400e3), String(data.id ?? ''), String(data.status ?? 'active'));
    return;
  }
  await upsertFromPaddle(mallNo, paidUntil, String(data.id ?? ''), String(data.status ?? 'active'));

  // godomall 측 만료일을 같은 시각으로 연장 (DB 토큰 사용)
  const token = await getInstallToken(mallNo);
  if (!token) {
    console.warn(`[paddle] no godomall token for mall ${mallNo}, skipping extend`);
    return;
  }
  // godomall requestDateTime은 KST 벽시계("YYYY-MM-DD hh:mm:ss") — UTC ISO를 KST로 보정
  const requestDateTime = new Date(paidUntil.getTime() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  try {
    await extendAppInstall(token, {
      orderNo: `paddle_${data.id ?? 'sub'}_${Date.now()}`,
      requestDateTime,
      paymentType: 'CHARGE',
      price: 9900,
    });
  } catch (e) {
    console.error(`[paddle] extend failed mall=${mallNo}: ${(e as Error).message.slice(0, 200)}`);
  }
}
