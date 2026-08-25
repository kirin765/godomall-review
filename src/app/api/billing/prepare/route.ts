import { NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { createClientToken, PADDLE_PRICE_ID, PRICE } from '@/lib/paddle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Paddle.js 정기결제 준비.
 *  - 서버에서 client-side token을 발급(시크릿 API키는 브라우저에 안 보냄)
 *  - price_id + 몰 식별자(mallNo)를 반환 — checkout custom_data에 mallNo를 심어
 *    웹훅이 "어느 몰의 구독인지" 알게 한다.
 */
export async function GET() {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  let clientToken: string;
  try {
    clientToken = await createClientToken(`review-rider-${session.mallNo}`);
  } catch (e) {
    return NextResponse.json(
      { error: `결제 초기화 실패: ${(e as Error).message.slice(0, 160)}` },
      { status: 502 },
    );
  }

  if (!PADDLE_PRICE_ID)
    return NextResponse.json({ error: 'PADDLE_PRICE_ID not set' }, { status: 500 });

  return NextResponse.json({
    mallNo: session.mallNo,
    price: PRICE,
    clientToken,
    priceId: PADDLE_PRICE_ID,
    environment: process.env.PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
  });
}
