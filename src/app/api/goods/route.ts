import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { listGoods } from '@/lib/godomall';
import { checkQuota, DAILY_LIMIT } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 상품 선택 드롭다운용. 세션이 없으면 401. */
export async function GET(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const page = Number(req.nextUrl.searchParams.get('page') || '1');
  const data = await listGoods(session.accessToken, Number.isFinite(page) && page > 0 ? page : 1);

  let quota;
  try {
    quota = await checkQuota(session.accessToken, session.mallNo, 0);
  } catch (e) {
    quota = {
      allowed: 0,
      paid: false,
      used: 0,
      limit: DAILY_LIMIT,
      day: '',
      status: 'EXPIRED' as const,
      expiresAt: null,
      error: (e as Error).message.slice(0, 120),
    };
  }

  return NextResponse.json({
    mallNo: session.mallNo,
    quota,
    products: data.contents.map((g) => ({ no: g.sno, name: g.name })),
  });
}
