import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { listGoods, APP_NO } from '@/lib/godomall';
import { checkQuota } from '@/lib/quota';
import { getEntitlement } from '@/lib/entitlement';
import { PAID_PRICE } from '@/lib/payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 고도몰 앱스토어의 이 앱 상세 페이지 (구매/인앱결제는 여기서). APP_NO 미설정이면 null. */
function appStoreUrl(): string | null {
  return APP_NO > 0 ? `https://apps.godo.co.kr/apps/${APP_NO}` : null;
}

/** 상품 선택 드롭다운용. 세션이 없으면 401. 함께 plan(유료/무료) 상태를 내려 관리 화면이 렌더링한다. */
export async function GET(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const page = Number(req.nextUrl.searchParams.get('page') || '1');
  const ent = await getEntitlement(session.mallNo, session.accessToken);
  const quota = await checkQuota(session.mallNo, 0, ent.paid);

  // 만료(EXPIRED)/삭제(DELETED) 상태에서는 godomall server API가 상품 목록을 SA0010
  // ("설치한 앱이 만료되었습니다")으로 거부한다. 그때도 plan(만료 안내+결제 링크)은
  // 렌더링돼야 하므로 상품 조회 실패를 응답에 담아 넘긴다 (화면 공백 방지).
  let products: { no: number; name: string }[] = [];
  let goodsError: string | null = null;
  try {
    const data = await listGoods(session.accessToken, Number.isFinite(page) && page > 0 ? page : 1);
    products = data.contents.map((g) => ({ no: g.sno, name: g.name }));
  } catch (e) {
    goodsError = (e as Error).message.slice(0, 200);
  }

  return NextResponse.json({
    mallNo: session.mallNo,
    quota,
    plan: {
      mode: ent.mode,
      status: ent.status,
      expireAt: ent.expireAt,
      price: PAID_PRICE,
      blockedBy: ent.status === 'EXPIRED' ? 'expired' : ent.status === 'DELETED' ? 'deleted' : null,
      /** 앱스토어 구매 페이지 — 관리 화면의 "결제 안내" 문구에 링크로 연결한다 */
      storeUrl: appStoreUrl(),
    },
    products,
    goodsError,
  });
}
