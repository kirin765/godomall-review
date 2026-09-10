import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { checkQuota, addUsage, FREE_LIMIT } from '@/lib/quota';
import { getEntitlement } from '@/lib/entitlement';
import { writeReviews, toNewImport } from '@/lib/writeReviews';
import { maskWriter, type ImportedReview } from '@/lib/reviewImport';
import { splitByExisting, reviewHash, reconcileImports } from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 고도몰 외부 리뷰 bulk 호출(스펙 기준 최대 100건/호출)이 여러 번 이어지므로
// 서버리스 시간 제한을 넉넉히 잡는다. Hobby 상한 60초 안에서 최대한 여유를 준다.
export const maxDuration = 60;

// 클라이언트가 한 번에 보내는 리뷰 수 상한. 200건 = bulk 호출 2회(100건/호출).
export const MAX_BATCH = 200;

/**
 * 대량 이관용 배치 쓰기. 클라이언트가 엑셀을 브라우저에서 파싱한 리뷰를
 * MAX_BATCH 이하로 나눠 보내면 고도몰 외부 리뷰 게시판에 쓰고 원장을 남긴다.
 *
 * 한 요청에 모든 리뷰를 넣지 않는 이유: 1만 건이면 서버리스 함수 시간 제한(60초)을 무조건 넘어
 * 중간에 죽고, 죽으면 원장 기록도 안 돼 목록·삭제가 모두 무력화된다 (2026-09 고객 문의).
 * 배치마다 성공분이 즉시 원장에 남으므로(writeReviews 내부), 실패해도 여기까지 온 글은 목록에서
 * 보인다.
 *
 * 멱등성(부분): 내용 해시(dedup_hash)로 "이미 게시판에 확인된(article_sno 확정) 리뷰"는
 * 재전송에서 건너뛰고 already로 돌려준다. 요청이 죽은 뒤 재시도가 오면 같은 해시가
 * 미확정으로 남아 있어 우선 고도몰 게시판과 대조해(needsReconcile) 올라간 글을 확정시킨다.
 * 그렇게 해도 미확정인 행은 다시 보낸다(고도몰 bulk가 행별 성공을 안 줘서, 확인된 것만 멱등).
 */
export async function POST(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    product_no?: number;
    source?: string;
    reviews?: Partial<ImportedReview>[];
  };
  const productNo = Number(body.product_no ?? 0);
  const source = String(body.source ?? 'coupang');
  const raw = Array.isArray(body.reviews) ? body.reviews : [];
  if (!productNo) return NextResponse.json({ error: 'product_no required' }, { status: 400 });
  if (!raw.length) return NextResponse.json({ error: 'reviews required' }, { status: 400 });

  // 클라이언트 파싱 값은 신뢰하지 않고 서버에서 한 번 더 정제·마스킹한다.
  const reviews = raw.slice(0, MAX_BATCH).map((r) => ({
    score: Number.isFinite(Number(r.score))
      ? Math.min(5, Math.max(1, Math.round(Number(r.score))))
      : 5,
    content: String(r.content ?? '').slice(0, 5000),
    writer: maskWriter(String(r.writer ?? '익명')),
    createdAt: r.createdAt ? String(r.createdAt).slice(0, 40) : null,
    option: r.option ? String(r.option).slice(0, 200) : null,
    productName: r.productName ? String(r.productName).slice(0, 200) : null,
    imageUrl: r.imageUrl ? String(r.imageUrl).slice(0, 2000) : null,
  }));

  // 이미 게시판에 확인된 리뷰를 내용 해시로 걸러낸다 (부분 멱등 — article_sno 확정분만).
  // DB가 없으면 null → 중복 제거 없이 진행.
  const hashes = reviews.map((r) => reviewHash(productNo, toNewImport(productNo, r)));
  let dedup = await splitByExisting(session.mallNo, productNo, hashes);
  if (dedup?.needsReconcile) {
    // 요청 중단 후 재시도로 같은 해시가 미확정으로 남아 있다 → 게시판과 대조해 실제로
    // 올라간 글을 확정시킨 뒤 다시 판정한다. 조회 실패는 최선 노력으로 무시한다.
    await reconcileImports(session.accessToken, session.mallNo).catch((e) =>
      console.error('[reviews/batch] reconcile failed', (e as Error).message),
    );
    dedup = await splitByExisting(session.mallNo, productNo, hashes);
  }
  const pending = dedup
    ? reviews.filter((_, i) => !dedup!.confirmedHashes.has(hashes[i]))
    : reviews;
  const already = reviews.length - pending.length;

  const ent = await getEntitlement(session.mallNo, session.accessToken);
  const quota = ent.paid
    ? { allowed: pending.length, configured: true, used: 0 }
    : await checkQuota(session.mallNo, pending.length, false);
  if (pending.length && !quota.configured) {
    return NextResponse.json({ error: 'review quota is not configured' }, { status: 503 });
  }
  if (pending.length && quota.allowed <= 0) {
    return NextResponse.json(
      {
        error: `무료로 ${FREE_LIMIT}건까지 옮길 수 있어요. 계속 쓰시려면 유료로 전환해 주세요.`,
        used: quota.used,
        already,
      },
      { status: 402 },
    );
  }

  // 무료면 잔여 한도만큼만 쓴다(쓰기 후 실제 성공분만 addUsage로 집계 — 클라이언트가
  // 단일 배치씩 순차로 보내므로 카페24판의 원자적 예약은 불필요).
  const toWrite = pending.slice(0, quota.allowed);
  const { written, failed, permanentFailed, failMessage } = await writeReviews(
    session.accessToken,
    session.mallNo,
    productNo,
    source,
    toWrite,
  );
  if (!ent.paid && written) await addUsage(session.mallNo, written);

  // 무료 한도로 보낸 슬라이스 일부가 아예 시도되지 않은 경우에만 "한도 소진"이다.
  // (일부 실패는 failed로 반환될 뿐 한도와 무관하다.)
  const quotaExhausted = !ent.paid && toWrite.length < pending.length;
  return NextResponse.json({
    written,
    failed,
    // 재시도로 풀리지 않는 오류(400·422·행 단위 거부)로 끝난 건수 — 클라이언트는 실패가
    // 전부 영구적일 때만 그 배치의 자동 재시도를 멈춘다.
    permanentFailed,
    already,
    quotaExhausted,
    paid: ent.paid,
    freeRemaining: ent.paid ? null : Math.max(0, quota.allowed - written),
    failMessage: failMessage.slice(0, 5),
  });
}
