import { maskWriter, normalizeReviewLineEndings, toDateTime, type ImportedReview } from './reviewImport';

export const MAX_BATCH = 200;

/** Validate before sending; never silently truncate text, photos, or input rows. */
export function normalizeReviews(raw: unknown[]): ImportedReview[] {
  return raw.map((value, index) => {
    const fail = (message: string): never => { throw new Error(`${index + 1}번째 리뷰: ${message}`); };
    if (!value || typeof value !== 'object') return fail('리뷰 형식이 올바르지 않습니다.');
    const r = value as Partial<ImportedReview>;
    const content = typeof r.content === 'string' ? normalizeReviewLineEndings(r.content).trim() : '';
    if (!content || content.length > 5000) return fail('본문은 1~5,000자여야 합니다.');
    const score = Number(r.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) return fail('평점은 1~5 사이의 정수여야 합니다.');
    const createdAt = r.createdAt == null || r.createdAt === '' ? null : String(r.createdAt);
    if (createdAt && !toDateTime(createdAt)) return fail('작성일을 확인해 주세요.');
    const option = r.option ? normalizeReviewLineEndings(String(r.option)) : null;
    if (option && option.length > 200) return fail('옵션은 200자 이하여야 합니다.');
    const images = r.images ?? [];
    if (!Array.isArray(images) || images.length > 10) return fail('사진은 최대 10장까지 옮길 수 있습니다.');
    for (const image of images) {
      try {
        const url = new URL(image);
        if (typeof image !== 'string' || image.length > 2000 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail('사진 URL을 확인해 주세요.');
      } catch { return fail('사진 URL을 확인해 주세요.'); }
    }
    if (String(r.writer ?? '').length > 50) return fail('작성자 이름이 너무 깁니다.');
    const sourceId = r.sourceId;
    if (sourceId !== undefined && (typeof sourceId !== 'string' || !/^occurrence:\d{1,9}$/.test(sourceId))) return fail('원본 리뷰 식별자를 확인해 주세요.');
    return { content, score, writer: maskWriter(String(r.writer ?? '익명')), createdAt, option,
      productName: r.productName ? String(r.productName) : null, images: [...images], ...(sourceId ? { sourceId } : {}) };
  });
}

/** Assign occurrence numbers across the WHOLE file, before slicing into requests. */
export function identifyReviews(reviews: ImportedReview[]): ImportedReview[] {
  const counts = new Map<string, number>();
  return normalizeReviews(reviews).map((r) => {
    const key = JSON.stringify([r.writer, r.score, r.option ? `${r.content} [옵션] ${r.option}` : r.content, toDateTime(r.createdAt), [...r.images].sort()]);
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    return { ...r, sourceId: `occurrence:${occurrence}` };
  });
}
