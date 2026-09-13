import { writeClaimedReviews, type WriteOutcome } from './writeClaimedReviews';
import { randomBytes } from 'crypto';
import { importReviews, type ExternalReview } from '@/lib/godomall';
import { toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { recordImports, reviewHash, claimImports, releaseClaims, type NewImport } from '@/lib/imports';
import { resizedImageUrl } from '@/lib/imageUrl';

const BULK_MAX = 100;
const BUDGET_MS = 45000;

const SOURCES: Record<string, { name: string; url: string; naver: 'Y' | 'N' }> = {
  coupang: { name: '쿠팡', url: 'https://www.coupang.com', naver: 'N' },
  smartstore: { name: '네이버 스마트스토어', url: 'https://smartstore.naver.com', naver: 'Y' },
  etc: { name: '기타', url: '', naver: 'N' },
};

function toPayload(source: string, productNo: number, r: ImportedReview, withImages = true): ExternalReview {
  const s = SOURCES[source] ?? SOURCES.etc;
  return {
    // 스펙 필드 제한에 맞춰 방어적으로 자른다: subject 100자, writerName 50자, 첨부 10개.
    writerName: (r.writer || '익명').slice(0, 50),
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
    attachmentUrls:
      withImages && r.images.length ? r.images.slice(0, 10).map(resizedImageUrl) : undefined,
  };
}

export function toNewImport(productNo: number, r: ImportedReview, photoDropped = false): NewImport {
  return {
    sourceId: r.sourceId,
    goods_no: productNo,
    // toPayload와 같은 정제를 그대로 적용한다 (대조는 writerName 정확 일치 기준이라 어긋나면 안 된다).
    writer: (r.writer || '익명').slice(0, 50),
    score: Number.isFinite(r.score) ? r.score : 5,
    content: r.option ? `${r.content} [옵션] ${r.option}` : r.content,
    images: r.images,
    created_date: toDateTime(r.createdAt),
    photo_dropped: photoDropped && r.images.length > 0,
  };
}

export type { WriteOutcome } from './writeClaimedReviews';

export async function writeReviews(token: string, mallNo: number, productNo: number, source: string, reviews: ImportedReview[], deadline = Date.now() + BUDGET_MS): Promise<WriteOutcome> {
  const rows = reviews.map(r => { const row = toNewImport(productNo, r); return { ...row, dedup_hash: reviewHash(productNo, row) }; });
  return writeClaimedReviews({ rows, hashes: rows.map(r => r.dedup_hash), batchSize: BULK_MAX, deadline,
    claim: hashes => claimImports(mallNo, hashes), release: hashes => releaseClaims(mallNo, hashes),
    save: rows => recordImports(mallNo, rows),
    send: async (start, count, signal) => {
      const response = await importReviews(token, reviews.slice(start, start + count).map(r => toPayload(source, productNo, r)), { signal });
      if (!response || !Number.isSafeInteger(response.success) || !Number.isSafeInteger(response.fail) || response.success < 0 || response.fail < 0 || response.success + response.fail !== count) return 'uncertain';
      if (response.success === count) return 'complete';
      if (response.fail === count) throw Object.assign(new Error((response.failMessage ?? []).map(String).join('; ').slice(0, 300) || '리뷰가 거부되었습니다.'), { status: 422 });
      // Counts cannot identify successful rows. Keep every claim until verified.
      return 'uncertain';
    },
  });
}
