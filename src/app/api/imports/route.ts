import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { deleteBoardArticle } from '@/lib/godomall';
import { listImports, removeImports, reconcileImports } from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 상품 후기 게시판. 옮기기(POST /api/reviews)가 외부 리뷰로 쓴 글도 이 게시판에 들어간다.
const GOODSREVIEW_BOARD = 'goodsreview';

/**
 * 리뷰이사가 옮긴 리뷰 관리.
 * GET    : 이 몰이 옮긴 리뷰 목록 (product_no 필터 가능). 글 번호가 아직 없는 행은
 *          고도몰 게시판과 대조해 채운 뒤 내려준다 (등록 직후엔 목록에 안 잡힐 수 있어 지연 보정).
 * DELETE : 선택한 article_sno를 고도몰 상품 후기 게시판에서 실제 삭제하고 원장을 정리한다.
 */
export async function GET(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });
  const productNo = Number(req.nextUrl.searchParams.get('product_no')) || undefined;
  try {
    await reconcileImports(session.accessToken, session.mallNo);
    const reviews = await listImports(session.mallNo, productNo);
    if (!reviews)
      return NextResponse.json(
        { error: '저장소가 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.' },
        { status: 500 },
      );
    return NextResponse.json({ reviews });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { article_snos?: number[] };
  const snos = [...new Set((body.article_snos ?? []).map(Number).filter((n) => n > 0))];
  if (!snos.length) return NextResponse.json({ error: 'article_snos required' }, { status: 400 });

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
  return NextResponse.json({ deleted, failed });
}