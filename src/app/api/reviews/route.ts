import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { sessionMall } from '@/lib/launch';
import { importReviews, APP_NO, type ExternalReview } from '@/lib/godomall';
import { parseReviewFile, toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { checkQuota, addUsage, FREE_LIMIT } from '@/lib/quota';
import { getEntitlement } from '@/lib/entitlement';
import { PAID_PRICE } from '@/lib/payment';
import { recordImports, reconcileImports, type NewImport } from '@/lib/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 고도몰 앱스토어의 이 앱 상세 페이지 (구매/인앱결제는 여기서). APP_NO 미설정이면 null. */
function appStoreUrl(): string | null {
  return APP_NO > 0 ? `https://apps.godo.co.kr/apps/${APP_NO}` : null;
}

const SOURCES: Record<string, { name: string; url: string; naver: 'Y' | 'N' }> = {
  coupang: { name: '쿠팡', url: 'https://www.coupang.com', naver: 'N' },
  smartstore: { name: '네이버 스마트스토어', url: 'https://smartstore.naver.com', naver: 'Y' },
  etc: { name: '기타', url: '', naver: 'N' },
};

const BULK_MAX = 100; // 외부 리뷰 bulk API 최대 100개/호출

function toPayload(source: string, productNo: number, r: ImportedReview): ExternalReview {
  const s = SOURCES[source] ?? SOURCES.etc;
  return {
    writerName: r.writer || '익명',
    password: randomBytes(8).toString('hex'),
    subject: r.content.slice(0, 40),
    content: r.option ? `${r.content} [옵션] ${r.option}` : r.content,
    reviewRating: Number.isFinite(r.score) ? r.score : 5,
    goodsSno: productNo,
    externalSiteName: s.name,
    externalSiteUrl: s.url,
    externalSiteDateTime: toDateTime(r.createdAt),
    naverReviewFlag: s.naver,
    secretFlag: 'N',
    attachmentUrls: r.imageUrl ? [r.imageUrl] : undefined,
  };
}

/** 벌크 등록에 보낸 값과 똑같이 원장에 남긴다 — 나중에 게시판 목록과 대조해 글 번호를 찾으려면 정확히 일치해야 한다. */
function toNewImport(productNo: number, r: ImportedReview): NewImport {
  return {
    goods_no: productNo,
    writer: r.writer || '익명',
    score: Number.isFinite(r.score) ? r.score : 5,
    content: r.option ? `${r.content} [옵션] ${r.option}` : r.content,
    image_url: r.imageUrl || null,
    created_date: toDateTime(r.createdAt),
  };
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
      plan: { mode: ent.mode, status: ent.status, price: PAID_PRICE, storeUrl: appStoreUrl() },
      error: 'free limit reached',
    }, { status: 402 });
  }

  const toWrite = reviews.slice(0, quota.allowed);
  let written = 0;
  let skipped = 0;
  const failMessage: string[] = [];
  const recorded: NewImport[] = [];
  for (let i = 0; i < toWrite.length; i += BULK_MAX) {
    const chunk = toWrite.slice(i, i + BULK_MAX);
    const payload = chunk.map((r) => toPayload(source, productNo, r));
    try {
      const res = await importReviews(session.accessToken, payload);
      written += res.success;
      skipped += res.fail;
      failMessage.push(...(res.failMessage ?? []));
      // 고도몰 bulk 응답은 글 번호를 주지 않아 "어느 행이 성공"인지는 알 수 없다.
      // 제출한 행 전체를 원장에 남기고, 실제 게시글과 대조된 행만 article_sno가 채워진다.
      if (res.success > 0) recorded.push(...chunk.map((r) => toNewImport(productNo, r)));
    } catch (e) {
      skipped += chunk.length;
      failMessage.push((e as Error).message.slice(0, 120));
    }
  }

  // 옮긴 글을 원장에 남긴다 → 관리 화면에서 "리뷰이사가 옮긴 리뷰"로 걸러 삭제할 수 있다.
  await recordImports(session.mallNo, recorded);
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
    skipped,
    paid: ent.paid,
    plan: { mode: ent.mode, status: ent.status, price: PAID_PRICE, storeUrl: appStoreUrl() },
    freeRemaining: remaining,
    failMessage: failMessage.slice(0, 5),
  });
}
