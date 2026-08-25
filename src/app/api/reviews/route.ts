import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { sessionMall } from '@/lib/launch';
import { importReviews, type ExternalReview } from '@/lib/godomall';
import { parseReviewFile, toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { checkQuota, addUsage, FREE_LIMIT } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const quota = await checkQuota(session.mallNo, reviews.length);
  if (!quota.configured) {
    return NextResponse.json(
      { error: 'review quota is not configured' },
      { status: 503 },
    );
  }
  if (quota.allowed <= 0) {
    return NextResponse.json({ quotaExceeded: true, used: quota.used, error: 'free limit reached' }, { status: 402 });
  }

  const toWrite = reviews.slice(0, quota.allowed);
  let written = 0;
  let skipped = 0;
  const failMessage: string[] = [];
  for (let i = 0; i < toWrite.length; i += BULK_MAX) {
    const chunk = toWrite.slice(i, i + BULK_MAX).map((r) => toPayload(source, productNo, r));
    try {
      const res = await importReviews(session.accessToken, chunk);
      written += res.success;
      skipped += res.fail;
      failMessage.push(...(res.failMessage ?? []));
    } catch (e) {
      skipped += chunk.length;
      failMessage.push((e as Error).message.slice(0, 120));
    }
  }

  if (!quota.paid) await addUsage(session.mallNo, written);

  const remaining = quota.paid ? null : Math.max(0, FREE_LIMIT - quota.used - written);
  return NextResponse.json({
    parsed: reviews.length,
    written,
    skipped,
    paid: quota.paid,
    freeRemaining: remaining,
    failMessage: failMessage.slice(0, 5),
  });
}
