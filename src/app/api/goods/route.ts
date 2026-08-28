import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { listGoods } from '@/lib/godomall';
import { checkQuota } from '@/lib/quota';
import { getEntitlement } from '@/lib/entitlement';
import { PAID_PRICE } from '@/lib/payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 상품 선택 드롭다운용. 세션이 없으면 401. 함께 plan(유료/무료) 상태를 내려 관리 화면이 렌더링한다. */
export async function GET(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const page = Number(req.nextUrl.searchParams.get('page') || '1');
  const data = await listGoods(session.accessToken, Number.isFinite(page) && page > 0 ? page : 1);
  const ent = await getEntitlement(session.mallNo, session.accessToken);
  const quota = await checkQuota(session.mallNo, 0, ent.paid);

  return NextResponse.json({
    mallNo: session.mallNo,
    quota,
    plan: {
      mode: ent.mode,
      status: ent.status,
      expireAt: ent.expireAt,
      price: PAID_PRICE,
      blockedBy: ent.status === 'EXPIRED' ? 'expired' : ent.status === 'DELETED' ? 'deleted' : null,
    },
    products: data.contents.map((g) => ({ no: g.sno, name: g.name })),
  });
}
