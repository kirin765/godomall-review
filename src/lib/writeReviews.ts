import { randomBytes } from 'crypto';
import { importReviews, type ExternalReview } from '@/lib/godomall';
import { toDateTime, type ImportedReview } from '@/lib/reviewImport';
import { recordImports, reviewHash, type NewImport } from '@/lib/imports';

// 고도몰 server API 스펙 기준 외부 리뷰 bulk 등록은 한 호출에 최대 100개.
// (카페24는 한 호출 10건 — 고도몰은 10배 크다. 배치 크기는 이 상수로만 결정한다.)
const BULK_MAX = 100;
// 함수 시간 예산. Vercel 함수 제한(60초)을 넘겨 죽으면 클라이언트가 응답을 못 받고
// 원장 기록도 건너뛴다. 예산이 다하면 남은 청크를 실패로 돌려 반드시 응답한다 —
// 클라이언트가 해시 멱등으로 이어서 재시도하므로 안전하다 (cafe24-review b75caf8).
const BUDGET_MS = 45000;

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

/**
 * 벌크 등록에 보낸 값과 똑같이 원장에 남긴다 — 나중에 게시판 목록과 대조해 글 번호를 찾으려면
 * 정확히 일치해야 한다. 멱등 해시(reviewHash)도 이 정제 결과로 만들어야 재전송 간 값이
 * 어긋나지 않는다(중복 판정이 깨지는 것을 막는다). 배치 라우터가 사전 중복 필터를 돌릴 수
 * 있게 공개한다.
 */
export function toNewImport(productNo: number, r: ImportedReview): NewImport {
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
  /**
   * 재시도로 풀리지 않는 오류(400·422, 고도몰이 행 단위로 돌려준 검증 거부)로 끝난 건수.
   * 클라이언트는 실패가 전부 영구적일 때만 그 배치의 자동 재시도를 멈춘다 —
   * 일부면 다시 보내 나머지(일시 오류)를 건진다.
   */
  permanentFailed: number;
  failMessage: string[];
};

/**
 * 리뷰 목록을 고도몰 외부 리뷰 bulk API로 쓴다. 한 호출 100건 제한이라 100건씩 나눠 호출하고,
 * **배치마다** 원장(imported_review)에 즉시 기록한다. 이 요청이 중간에 죽어도(서버리스 시간 초과 등)
 * 이미 성공한 배치는 목록·삭제에서 복구된다 — 대량 이관의 핵심.
 * (카페24판 2464d56처럼, 기록을 마지막에 몰아 하면 요청이 죽을 때 그 배치 전체가 원장에서
 *  사라져 목록·삭제가 무력화된다. 배치 단위 즉시 기록이 이를 막는다.)
 *
 * 고도몰 bulk 응답({success, fail})은 글 번호를 주지 않아 "어느 행이 성공"인지는 알 수 없다.
 * 성공이 1건이라도 있으면 제출한 행 전체를 원장에 남기고, 실제 게시글과 대조된 행만
 * article_sno가 채워진다(reconcileImports — 목록 조회 때 수행). dedup_hash는 재전송 시
 * "이미 확인된 글은 건너뛰기"의 근거가 된다.
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
  let permanentFailed = 0;
  const failMessage: string[] = [];
  const deadline = Date.now() + BUDGET_MS;

  for (let i = 0; i < reviews.length; i += BULK_MAX) {
    const chunk = reviews.slice(i, i + BULK_MAX);
    // 예산이 다 찼으면 남은 청크는 시작도 하지 않고 실패로 돌려준다 — 함수가 죽어
    // 응답을 못 하는 것보다, 실패로 정직하게 돌려 클라이언트가 이어서 재시도하게 한다.
    if (Date.now() > deadline) {
      failed += chunk.length;
      failMessage.push('함수 시간 예산 초과 — 다시 시도해 주세요.');
      continue;
    }
    // 보낼 값과 원장·해시를 같은 정제로 미리 만들어 둔다 (멱등 판정이 어긋나지 않게).
    const ledgerRows = chunk.map((r) => {
      const ni = toNewImport(productNo, r);
      return { ...ni, dedup_hash: reviewHash(productNo, ni) };
    });
    const payload = chunk.map((r) => toPayload(source, productNo, r));
    try {
      const res = await importReviews(token, payload);
      written += res.success;
      failed += res.fail;
      // 고도몰이 행 단위로 돌려준 거부는 데이터 검증 실패라 재시도로 풀리지 않는다.
      permanentFailed += res.fail;
      failMessage.push(...(res.failMessage ?? []));
      if (res.success > 0) {
        // 성공이 있는 배치는 즉시 원장에 남긴다 — 기록 실패는 쓰기 흐름을 막지 않는다.
        // 글 자체는 이미 고도몰에 등록됐으므로, 기록은 목록·삭제를 위한 최선 노력이다.
        await recordImports(mallNo, ledgerRows).catch((e) =>
          console.error('[writeReviews] ledger failed', (e as Error).message),
        );
      }
    } catch (e) {
      failed += chunk.length;
      const msg = (e as Error).message;
      // importReviews가 던지는 "bulk {status}: ..." 메시지에서 상태코드를 읽는다.
      // 요청 자체가 거부된 400·422는 다시 보내도 실패한다 — 영구 실패로 표시한다.
      const status = (e as { status?: number }).status ?? Number(/bulk (\d{3})/.exec(msg)?.[1]);
      if (status === 400 || status === 422) permanentFailed += chunk.length;
      failMessage.push(msg.slice(0, 120));
    }
  }

  return { written, failed, permanentFailed, failMessage };
}
