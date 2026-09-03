import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { checkQuota, addUsage, FREE_LIMIT } from '@/lib/quota';
import { getEntitlement } from '@/lib/entitlement';
import { writeReviews } from '@/lib/writeReviews';
import { maskWriter, type ImportedReview } from '@/lib/reviewImport';

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
 * 배치마다 성공분이 즉시 원장에 남으므로, 실패해도 여기까지 온 글은 목록에서 보인다.
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

  const ent = await getEntitlement(session.mallNo, session.accessToken);
  const quota = await checkQuota(session.mallNo, reviews.length, ent.paid);
  if (!quota.configured) {
    return NextResponse.json({ error: 'review quota is not configured' }, { status: 503 });
  }
  if (quota.allowed <= 0) {
    return NextResponse.json(
      { error: `무료로 ${FREE_LIMIT}건까지 옮길 수 있어요. 계속 쓰시려면 유료로 전환해 주세요.`, used: quota.used },
      { status: 402 },
    );
  }

  const toWrite = reviews.slice(0, quota.allowed);
  const { written, failed, failMessage } = await writeReviews(
    session.accessToken,
    session.mallNo,
    productNo,
    source,
    toWrite,
  );
  if (!ent.paid && written) await addUsage(session.mallNo, written);

  // 무료 한도로 보낸 슬라이스 일부가 아예 시도되지 않은 경우에만 "한도 소진"이다.
  // (일부 실패는 failed로 반환될 뿐 한도와 무관하다.)
  const quotaExhausted = !ent.paid && toWrite.length < reviews.length;
  return NextResponse.json({
    written,
    failed,
    quotaExhausted,
    paid: ent.paid,
    freeRemaining: ent.paid ? null : Math.max(0, quota.allowed - written),
    failMessage: failMessage.slice(0, 5),
  });
}