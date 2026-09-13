import type { ImportedReview } from './reviewImport';

export const IMPORT_BATCH = 100;
export type TransferProgress = {
  written: number; already: number; failed: number; uncertain: number;
  permanentFailed: number; photoDropped: number; completedThrough: number;
  paid?: boolean; freeRemaining: number | null; quotaExhausted: boolean; error?: string;
};
type BatchResult = Omit<TransferProgress, 'completedThrough' | 'error'> & { retryableIndices?: number[] };

function readBatch(value: unknown, count: number): BatchResult | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const keys = ['written', 'already', 'failed', 'uncertain', 'permanentFailed', 'photoDropped'] as const;
  const numbers = Object.fromEntries(keys.map((k) => [k, r[k] ?? (['uncertain', 'photoDropped', 'permanentFailed'].includes(k) ? 0 : NaN)])) as Record<typeof keys[number], number>;
  if (Object.values(numbers).some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  const accounted = numbers.written + numbers.already + numbers.failed;
  if (accounted > count || (!r.quotaExhausted && accounted !== count) || numbers.uncertain > numbers.failed || numbers.permanentFailed > numbers.failed) return null;
  const retryable = r.retryableIndices;
  if (retryable !== undefined && (!Array.isArray(retryable) || new Set(retryable).size !== retryable.length ||
    retryable.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= count) ||
    retryable.length > numbers.failed - numbers.permanentFailed - numbers.uncertain)) return null;
  return { ...numbers, ...(typeof r.paid === 'boolean' ? { paid: r.paid } : {}), ...(Array.isArray(retryable) ? { retryableIndices: retryable as number[] } : {}), quotaExhausted: r.quotaExhausted === true, freeRemaining: typeof r.freeRemaining === 'number' ? r.freeRemaining : null };
}

/** Sequential, bounded retries. Persist only the fully completed contiguous prefix. */
export async function transferReviews(options: {
  reviews: ImportedReview[]; productNo: number | string; source?: string; startOffset: number;
  shouldStop: () => boolean; onProgress: (progress: TransferProgress) => void;
  fetcher?: typeof fetch; pause?: () => Promise<void>;
}): Promise<TransferProgress> {
  const { reviews, productNo, shouldStop, onProgress } = options;
  const fetcher = options.fetcher ?? fetch;
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5000)));
  const start = Math.max(0, Math.floor(options.startOffset / IMPORT_BATCH) * IMPORT_BATCH);
  const results = new Map<number, BatchResult>();
  let completedThrough = start;
  let error: string | undefined;
  let freeRemaining: number | null = null;
  let quotaExhausted = false;
  let paid: boolean | undefined;
  const summary = (): TransferProgress => {
    const total = { written: 0, already: 0, failed: 0, uncertain: 0, permanentFailed: 0, photoDropped: 0 };
    for (const r of results.values()) for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += r[key];
    return { ...total, paid, completedThrough, freeRemaining, quotaExhausted, ...(error ? { error } : {}) };
  };
  for (let offset = start; offset < reviews.length && !shouldStop() && !quotaExhausted && !error; offset += IMPORT_BATCH) {
    const slice = reviews.slice(offset, offset + IMPORT_BATCH);
    let toSend = slice;
    let partialRetry = false;
    for (let attempt = 0; attempt < 3 && !shouldStop(); attempt++) {
      let response: Response;
      let json: Record<string, unknown>;
      try {
        response = await fetcher('/api/reviews/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(70000), body: JSON.stringify({ product_no: productNo, source: options.source, reviews: toSend }),
        });
        json = await response.json();
      } catch {
        // The server may have committed. A lost HTTP response is not a safe retry signal.
        error = '응답을 확인하지 못해 이관을 멈췄습니다. 옮긴 리뷰 목록을 확인한 뒤 이어서 진행해 주세요.';
        const previous = results.get(offset);
        const remaining = slice.length - (previous?.written ?? 0) - (previous?.already ?? 0);
        results.set(offset, { written: previous?.written ?? 0, already: previous?.already ?? 0, failed: remaining, uncertain: partialRetry ? toSend.length : remaining, permanentFailed: previous?.permanentFailed ?? 0, photoDropped: previous?.photoDropped ?? 0, freeRemaining, quotaExhausted: false });
        break;
      }
      if (response.status === 402) { if (typeof json.paid === 'boolean') paid = json.paid; quotaExhausted = true; break; }
      if (!response.ok) {
        // Only explicitly pre-write service errors can be retried automatically.
        if ((response.status === 429 || (response.status === 503 && json?.retryable === true)) && attempt < 2) { await pause(); continue; }
        error = typeof json?.error === 'string' ? json.error : `이관 요청을 처리하지 못했습니다 (${response.status}).`;
        break;
      }
      const received = readBatch(json, toSend.length);
      const previous = results.get(offset);
      const result = received && partialRetry && previous ? {
        ...received,
        written: previous.written + received.written,
        already: previous.already + received.already,
        failed: previous.failed - toSend.length + received.failed,
        permanentFailed: previous.permanentFailed + received.permanentFailed,
        uncertain: previous.uncertain + received.uncertain,
        photoDropped: previous.photoDropped + received.photoDropped,
      } : received;
      if (!result) { error = '이관 결과의 건수가 맞지 않아 멈췄습니다. 옮긴 리뷰 목록을 확인해 주세요.'; break; }
      results.set(offset, result);
      freeRemaining = result.freeRemaining;
      if (result.paid !== undefined) paid = result.paid;
      quotaExhausted = result.quotaExhausted;
      if (result.uncertain) error = `${result.uncertain}건은 등록 여부 확인이 필요합니다. 중복 방지를 위해 자동 재전송을 멈췄습니다. 고객지원에 문의해 주세요.`;
      if (!result.failed && !quotaExhausted && offset === completedThrough) completedThrough = Math.min(reviews.length, offset + IMPORT_BATCH);
      onProgress(summary());
      if (!result.failed || result.uncertain || quotaExhausted) break;
      if (received?.retryableIndices) {
        if (!received.retryableIndices.length) break;
        toSend = received.retryableIndices.map((index) => toSend[index]);
        partialRetry = true;
      } else {
        // Compatibility with an older server: only full-batch responses can be replaced.
        if (result.permanentFailed || partialRetry) break;
      }
      if (attempt < 2) await pause();
    }
    onProgress(summary());
  }
  return summary();
}
