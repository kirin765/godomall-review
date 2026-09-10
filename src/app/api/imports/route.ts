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
// 삭제는 1건/호출이라 순차면 느리다. 서버리스 60초 상한 안에서 마지막 삭제 페이지가
// 끝나도록 이 정도로만 병렬로 돌린다. 삭제는 멱등이라(404=이미 지워짐=성공) 재실행이 안전하다.
const DELETE_CONCURRENCY = 6;
const DELETE_TIMEOUT_MS = 30000;
// 함수 시간 예산 — 예산이 다 살면 반드시 응답한다. 60초 제한을 넘겨 함수가 죽으면
// 클라이언트가 응답을 못 받고 원장 정리(removeImports)도 실행되지 않아 "지웠는데
// 목록엔 남아" 보인다 (cafe24-review 613816f). 못 지운 글은 실패로 돌려 다음 턴에 이어간다.
const BUDGET_MS = 45000;
// 예산이 이만큼 덜 남으면 새 삭제를 시작하지 않는다(호출 1회 + 백오프 여유).
const DELETE_MIN_MS = 5000;

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
  // 1건씩 지우되 DELETE_CONCURRENCY만큼 병렬로 돌린다. 삭제는 멱등(404=이미 없음=성공)이라
  // 타임아웃·연결 오류도 안심하고 재시도할 수 있다 — 예전엔 타임아웃을 재시도하지 않아
  // 불필요한 실패가 남았다. 고도몰은 속도 제한이 문서에 없어(고도몰 스펙) 인위적 간격은 두지
  // 않고, 함수 예산(45초) 안에서만 재시도한다.
  const deadline = Date.now() + BUDGET_MS;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** 글 하나를 지운다. 성공·이미 없음(404)이면 ok. */
  const deleteOne = async (sno: number): Promise<{ ok: boolean; error: string }> => {
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (Date.now() >= deadline)
        return { ok: false, error: '함수 시간 예산 초과 — 다시 시도해 주세요.' };
      const remaining = deadline - Date.now();
      try {
        await deleteBoardArticle(session.accessToken, GOODSREVIEW_BOARD, sno, {
          signal: AbortSignal.timeout(Math.max(3000, Math.min(DELETE_TIMEOUT_MS, remaining - 500))),
        });
        return { ok: true, error: '' };
      } catch (e) {
        lastErr = (e as Error).message.slice(0, 200);
        const status = (e as { status?: number }).status;
        // 이미 지워진 글(404)은 목표가 이뤄진 것이다.
        if (status === 404) return { ok: true, error: '' };
        if (attempt === 3) break;
        // 429(속도 제한)는 넉넉히, 그 외 타임아웃·연결 오류·5xx는 짧게 물러나 재시도한다.
        const wait = status === 429 ? 1200 * (attempt + 1) : 500 * (attempt + 1);
        if (Date.now() + wait > deadline - 3000) return { ok: false, error: lastErr };
        await sleep(wait);
      }
    }
    return { ok: false, error: lastErr };
  };

  let cursor = 0;
  // 예산이 다 살아 시작도 못 한 글은 한 워커만 털어야 한다 — 두 워커가 같은 while 탈출을
  // 동시에 하면 같은 글을 실패에 두 번 넣을 수 있다(공유 커서).
  let drained = false;
  const worker = async () => {
    while (deadline - Date.now() > DELETE_MIN_MS) {
      const sno = snos[cursor++];
      if (sno === undefined) return;
      const r = await deleteOne(sno);
      if (r.ok) deleted.push(sno);
      else failed.push({ article_sno: sno, error: r.error });
    }
    // 예산이 다 살아 시작도 못 한 글 — 실패로 돌려 클라이언트가 이어서 지운다.
    if (!drained) {
      drained = true;
      for (let rest = snos[cursor++]; rest !== undefined; rest = snos[cursor++])
        failed.push({ article_sno: rest, error: '함수 시간 예산 초과 — 다시 시도해 주세요.' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, snos.length) }, worker));
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