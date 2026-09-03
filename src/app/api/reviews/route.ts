import { NextRequest, NextResponse } from 'next/server';
import { sessionMall } from '@/lib/launch';
import { APP_NO } from '@/lib/godomall';
import { parseReviewFile, toDateTime } from '@/lib/reviewImport';
import { checkQuota, addUsage, FREE_LIMIT } from '@/lib/quota';
import { getEntitlement } from '@/lib/entitlement';
import { PAID_PRICE, PAYMENT_INFO } from '@/lib/payment';
import { writeReviews } from '@/lib/writeReviews';
import { reconcileImports } from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 한 요청에 모든 리뷰를 넣는 이 경로는 소규모(미리보기·소량)용이다. 대량 이관은
// 클라이언트가 POST /api/reviews/batch로 나눠 보낸다 (2026-09 고객 문의 대응).
export const maxDuration = 60;

/** 고도몰 앱스토어의 이 앱 상세 페이지 (구매/인앱결제는 여기서). APP_NO 미설정이면 null. */
function appStoreUrl(): string | null {
  return APP_NO > 0 ? `https://apps.godo.co.kr/apps/${APP_NO}` : null;
}

export async function POST(req: NextRequest) {
  const session = await sessionMall();
  if (!session) return NextResponse.json({ error: 'no session' }, { status: 401 });

  const form = await req.formData();
  const productNo = Number(form.get('product_no'));
  const file = form.get('file');
  const source = String(form.get('source') || 'coupang');
  const dryRun = form.get('dry_run') === '1';

  if (!productNo || !file || typeof file === 'string') {
    return NextResponse.json({ error: 'product_no and file required' }, { status: 400 });
  }

  const buf = await (file as File).arrayBuffer();
  const { reviews, headers } = parseReviewFile(buf);
  if (!reviews.length) return NextResponse.json({ error: 'no reviews parsed', headers }, { status: 400 });

  if (dryRun) {
    const sample = reviews.slice(0, 3).map((r) => ({
      writer: r.writer, content: r.content, score: r.score, createdAt: toDateTime(r.createdAt), option: r.option, imageUrl: r.imageUrl,
    }));
    return NextResponse.json({ dryRun: true, count: reviews.length, sample });
  }

  const ent = await getEntitlement(session.mallNo, session.accessToken);
  const quota = await checkQuota(session.mallNo, reviews.length, ent.paid);
  if (!quota.configured) {
    return NextResponse.json(
      { error: 'review quota is not configured' },
      { status: 503 },
    );
  }
  if (quota.allowed <= 0) {
    return NextResponse.json({
      quotaExceeded: true,
      used: quota.used,
      plan: { mode: ent.mode, status: ent.status, price: PAID_PRICE, storeUrl: appStoreUrl(), payment: PAYMENT_INFO },
      error: 'free limit reached',
    }, { status: 402 });
  }

  const toWrite = reviews.slice(0, quota.allowed);
  const { written, failMessage } = await writeReviews(
    session.accessToken,
    session.mallNo,
    productNo,
    source,
    toWrite,
  );
  // 등록 직후엔 게시판 목록에 안 잡힐 수 있으므로 최선 노력으로 바로 대조해 보고(보정은 목록 조회 때도),
  // 실패해도 옮기기 응답에는 영향을 주지 않는다.
  await reconcileImports(session.accessToken, session.mallNo).catch((e) =>
    console.error('[imports] reconcile failed', (e as Error).message),
  );

  if (!ent.paid) await addUsage(session.mallNo, written);

  const remaining = ent.paid ? null : Math.max(0, FREE_LIMIT - quota.used - written);
  return NextResponse.json({
    parsed: reviews.length,
    written,
    skipped: reviews.length - written,
    paid: ent.paid,
    plan: { mode: ent.mode, status: ent.status, price: PAID_PRICE, storeUrl: appStoreUrl(), payment: PAYMENT_INFO },
    freeRemaining: remaining,
    failMessage: failMessage.slice(0, 5),
  });
}
