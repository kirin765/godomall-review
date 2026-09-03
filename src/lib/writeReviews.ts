import { randomBytes } from 'crypto';
import { importReviews, type ExternalReview } from '@/lib/godomall';
import { toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { recordImports, type NewImport } from '@/lib/imports';

// 고도몰 server API 스펙 기준 외부 리뷰 bulk 등록은 한 호출에 최대 100개.
// (카페24는 한 호출 10건 — 고도몰은 10배 크다. 배치 크기는 이 상수로만 결정한다.)
const BULK_MAX = 100;

const SOURCES: Record<string, { name: string; url: string; naver: 'Y' | 'N' }> = {
  coupang: { name: '쿠팡', url: 'https://www.coupang.com', naver: 'N' },
  smartstore: { name: '네이버 스마트스토어', url: 'https://smartstore.naver.com', naver: 'Y' },
  etc: { name: '기타', url: '', naver: 'N' },
};

function toPayload(source: string, productNo: number, r: ImportedReview): ExternalReview {
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
    attachmentUrls: r.imageUrl ? [r.imageUrl].slice(0, 10) : undefined,
  };
}

/** 벌크 등록에 보낸 값과 똑같이 원장에 남긴다 — 나중에 게시판 목록과 대조해 글 번호를 찾으려면 정확히 일치해야 한다. */
function toNewImport(productNo: number, r: ImportedReview): NewImport {
  return {
    goods_no: productNo,
    // toPayload와 같은 정제를 그대로 적용한다 (대조는 writerName 정확 일치 기준이라 어긋나면 안 된다).
    writer: (r.writer || '익명').slice(0, 50),
    score: Number.isFinite(r.score) ? r.score : 5,
    content: r.option ? `${r.content} [옵션] ${r.option}` : r.content,
    image_url: r.imageUrl || null,
    created_date: toDateTime(r.createdAt),
  };
}

export type WriteOutcome = {
  written: number;
  failed: number;
  failMessage: string[];
};

/**
 * 리뷰 목록을 고도몰 외부 리뷰 bulk API로 쓴다. 한 호출 100건 제한이라 100건씩 나눠 호출하고,
 * 배치마다 원장(imported_review)에 즉시 기록한다. 이 요청이 중간에 죽어도(서버리스 시간 초과 등)
 * 이미 성공한 글은 목록·삭제에서 복구된다 — 대량 이관의 핵심.
 *
 * 고도몰 bulk 응답({success, fail})은 글 번호를 주지 않아 "어느 행이 성공"인지는 알 수 없다.
 * 성공이 1건이라도 있으면 제출한 행 전체를 원장에 남기고, 실제 게시글과 대조된 행만
 * article_sno가 채워진다(reconcileImports — 목록 조회 때 수행).
 *
 * 배치 실패는 그 배치 전체를 failed로 돌리고 다음 배치를 계속 진행한다.
 */
export async function writeReviews(
  token: string,
  mallNo: number,
  productNo: number,
  source: string,
  reviews: ImportedReview[],
): Promise<WriteOutcome> {
  let written = 0;
  let failed = 0;
  const failMessage: string[] = [];
  const recorded: NewImport[] = [];

  for (let i = 0; i < reviews.length; i += BULK_MAX) {
    const chunk = reviews.slice(i, i + BULK_MAX);
    const payload = chunk.map((r) => toPayload(source, productNo, r));
    try {
      const res = await importReviews(token, payload);
      written += res.success;
      failed += res.fail;
      failMessage.push(...(res.failMessage ?? []));
      if (res.success > 0) recorded.push(...chunk.map((r) => toNewImport(productNo, r)));
    } catch (e) {
      failed += chunk.length;
      failMessage.push((e as Error).message.slice(0, 120));
    }
  }

  // 옮긴 글을 원장에 남긴다 → 관리 화면에서 "리뷰이사가 옮긴 리뷰"로 걸러 삭제할 수 있다.
  // 원장 기록이 실패해도 글 자체는 이미 고도몰에 등록됐으므로 쓰기 흐름을 막지 않는다.
  await recordImports(mallNo, recorded);

  return { written, failed, failMessage };
}