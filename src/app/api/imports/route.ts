import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { deleteBoardArticle } from '@/lib/godomall';
import { listImports, removeImports, listArticleNos, reconcileImports } from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 삭제는 1건씩 고도몰을 호출하므로 한 요청당 양을 제한해 Hobby 상한(60초) 안에 끝낸다.
export const maxDuration = 60;

// 상품 후기 게시판. 옮기기(POST /api/reviews·/api/reviews/batch)가 외부 리뷰로 쓴 글도 이 게시판에 들어간다.
const GOODSREVIEW_BOARD = 'goodsreview';

// 한 요청당 삭제할 글 수 상한. 고도몰 삭제는 1건씩 호출하는데, 8천 건을 한 요청에
// 넣으면 서버리스 시간 제한(60초)을 넘겨 중간에 죽는다 (2026-09 고객 문의).
// 이 값을 넘는 글은 클라이언트가 나눠 보내거나(all=false) 서버가 hasMore로 계속한다(all=true).
const MAX_DELETE = 50;

/**
 * 리뷰이사가 옮긴 리뷰 관리. 목록·삭제 모두 원장(godo_review_imported)만 기준으로 동작한다.
 * 원장은 옮기기 성공 시 배치 단위로 실시간 기록되므로, 새로 옮긴 글은 여기서 보인다.
 * (과거에 옮겨 원장에 기록이 없는 글은 식별 수단이 없어 이 화면에서 관리할 수 없다.)
 *
 * GET    : 이 몰이 옮긴 리뷰 목록 (product_no 필터 + 페이지네이션). 글 번호가 아직 없는 행은
 *          고도몰 게시판과 대조해 채운 뒤 내려준다 (등록 직후엔 목록에 안 잡힐 수 있어 지연 보정).
 * DELETE : 선택한 article_sno를 고도몰 상품 후기 게시판에서 실제 삭제하고 원장을 정리한다.
 *          - article_snos로 보내면 최대 MAX_DELETE건만 처리한다.
 *          - all=true로 보내면 해당 필터의 원장을 최대 MAX_DELETE건씩 순회하며 삭제한다.
 */
export async function GET(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const productNo = Number(sp.get('product_no')) || undefined;
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(sp.get('page_size')) || 50));
  try {
    // 글 번호 대조(보정)는 최선 노력 — 고도몰 조회가 실패해도 목록 자체는 내려줘야 한다.
    // (실패하면 원장의 article_sno가 빈 채로 남을 뿐, 다음 목록 조회 때 다시 시도한다.)
    await reconcileImports(session.accessToken, session.mallNo).catch((e) =>
      console.error('[imports] reconcile failed', (e as Error).message),
    );
    const pageData = await listImports(session.mallNo, { productNo, page, pageSize });
    if (!pageData)
      return NextResponse.json(
        { error: '저장소가 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.' },
        { status: 500 },
      );
    return NextResponse.json({
      reviews: pageData.rows,
      total: pageData.total,
      page,
      pageSize,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    article_snos?: number[];
    all?: boolean;
    product_no?: number;
  };

  let snos: number[] = [];
  let hasMore = false;
  if (body.all) {
    // 전체 삭제: 원장에서 MAX_DELETE+1건을 가져와 초과분이 있으면 계속 이어받게 한다.
    const productNo = Number(body.product_no) || undefined;
    const picked = (await listArticleNos(session.mallNo, productNo, MAX_DELETE + 1)) ?? [];
    hasMore = picked.length > MAX_DELETE;
    snos = picked.slice(0, MAX_DELETE);
  } else {
    snos = [...new Set((body.article_snos ?? []).map(Number).filter((n) => n > 0))].slice(0, MAX_DELETE);
  }
  if (!snos.length) return NextResponse.json({ deleted: [], failed: [], hasMore: false });

  const deleted: number[] = [];
  const failed: { article_sno: number; error: string }[] = [];
  for (const sno of snos) {
    try {
      await deleteBoardArticle(session.accessToken, GOODSREVIEW_BOARD, sno);
      deleted.push(sno);
    } catch (e) {
      failed.push({ article_sno: sno, error: (e as Error).message.slice(0, 200) });
    }
  }
  try {
    await removeImports(session.mallNo, deleted);
  } catch (e) {
    console.error('[imports] ledger cleanup failed', (e as Error).message);
  }
  // 전체 삭제에서 아무것도 못 지웠으면 계속 순회하면 같은 글을 다시 시도해 무한 루프가 된다.
  // 이번 턴에서 한 건도 삭제되지 않았다면 중단한다.
  const more = hasMore && deleted.length > 0;
  return NextResponse.json({ deleted, failed, hasMore: more });
}