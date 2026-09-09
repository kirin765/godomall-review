import { NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { listGoods, APP_NO, type Goods } from '@/lib/godomall';
import { checkQuota } from '@/lib/quota';
import { getEntitlement } from '@/lib/entitlement';
import { PAID_PRICE, PAYMENT_INFO } from '@/lib/payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 고도몰 앱스토어의 이 앱 상세 페이지 (구매/인앱결제는 여기서). APP_NO 미설정이면 null. */
function appStoreUrl(): string | null {
  return APP_NO > 0 ? `https://apps.godo.co.kr/apps/${APP_NO}` : null;
}

// pageSize는 스펙상 최대 1000. 상품이 1000개를 넘는 몰은 목록이 잘리므로 페이지를 나눠 전부 가져온다
// (카페24판 e72f13e 교훈 — 순차 호출은 관리 화면이 느려 보이고, 병렬+부분 실패 허용으로 열리게 한다).
const GOODS_PAGE_SIZE = 1000;
const GOODS_CONCURRENCY = 5;
const GOODS_CAP = 10000; // 드롭다운 한계 — 이 이상이면 앞부분까지만

/** 상품 전체를 병렬 페이지 조회로 모은다. 한 페이지 실패는 무시하고, 전부 실패했을 때만 던진다. */
async function fetchAllGoods(token: string): Promise<{ no: number; name: string }[]> {
  const first = await listGoods(token, 1, GOODS_PAGE_SIZE);
  const goods: Goods[] = [...(first.contents ?? [])];
  const total = Number(first.totalCount ?? goods.length);
  const pages = Math.min(Math.max(1, Math.ceil(total / GOODS_PAGE_SIZE)), Math.ceil(GOODS_CAP / GOODS_PAGE_SIZE));
  let anyError = false;
  if (pages > 1) {
    let next = 2;
    const worker = async () => {
      while (true) {
        const p = next++;
        if (p > pages) return;
        try {
          const d = await listGoods(token, p, GOODS_PAGE_SIZE);
          goods.push(...(d.contents ?? []));
        } catch {
          anyError = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(GOODS_CONCURRENCY, pages - 1) }, worker));
  }
  if (!goods.length && anyError) throw new Error('goods unavailable');
  goods.sort((a, b) => a.sno - b.sno);
  return goods.map((g) => ({ no: g.sno, name: g.name }));
}

/** 상품 선택 드롭다운용. 세션이 없으면 401. 함께 plan(유료/무료) 상태를 내려 관리 화면이 렌더링한다. */
export async function GET() {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  // 로컬 개발 전용: 개발 모드에서는 워크스페이스/고도몰 호출 없이 관리 화면이 렌더링되게 목 데이터를 내려준다.
  // NODE_ENV='production' 빌드에는 이 분기가 들어가지 않는다 — 심사·운영 영향 없음.
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.json({
      mallNo: session.mallNo,
      quota: { used: 3, limit: 20, paid: false },
      plan: {
        mode: 'free',
        status: 'ACTIVE',
        expireAt: null,
        price: PAID_PRICE,
        blockedBy: null,
        storeUrl: appStoreUrl(),
        payment: PAYMENT_INFO,
      },
      products: [
        { no: 1001, name: '[온누리문방구] 스프링 노트 A5 5권 세트' },
        { no: 1002, name: '[온누리문방구] 제브라 볼펜 0.5mm 10입' },
        { no: 1003, name: '[온누리문방구] 3M 포스트잇 656 12팩' },
      ],
    });
  }

  const ent = await getEntitlement(session.mallNo, session.accessToken);
  const quota = await checkQuota(session.mallNo, 0, ent.paid);

  // 만료(EXPIRED)/삭제(DELETED) 상태에서는 godomall server API가 상품 목록을 SA0010
  // ("설치한 앱이 만료되었습니다")으로 거부한다. 그때도 plan(만료 안내+결제 링크)은
  // 렌더링돼야 하므로 상품 조회 실패를 응답에 담아 넘긴다 (화면 공백 방지).
  let products: { no: number; name: string }[] = [];
  let goodsError: string | null = null;
  try {
    products = await fetchAllGoods(session.accessToken);
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
      /** 수동 계좌이체 결제 안내 — 관리 화면이 이 정보로 계좌·금액·연락처를 보여준다 */
      payment: PAYMENT_INFO,
    },
    products,
    goodsError,
  });
}
