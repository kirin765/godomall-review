export type WriteOutcome = {
  written: number; failed: number; permanentFailed: number; uncertain: number;
  uncertainCharged: number; photoDropped: number; retryableIndices: number[]; failMessage: string[]; failureReason?: string;
};

export type WriteChunk = { start: number; count: number };

/** A confirmed claim always precedes a remote write; only known non-writes can retry. */
export async function writeClaimedReviews<Row>(options: {
  rows: Row[]; hashes: string[]; batchSize: number; delayMs?: number; deadline: number;
  claim: (hashes: string[]) => Promise<boolean>;
  release: (hashes: string[]) => Promise<void>;
  save: (rows: Row[]) => Promise<void>;
  send: (start: number, count: number, signal: AbortSignal) => Promise<'complete' | 'rejected' | 'uncertain'>;
  /** Optional contiguous chunks; useful when a platform's bulk response cannot map partial photo success. */
  chunks?: readonly WriteChunk[];
}): Promise<WriteOutcome> {
  const result: WriteOutcome = { written: 0, failed: 0, permanentFailed: 0, uncertain: 0, uncertainCharged: 0, photoDropped: 0, retryableIndices: [], failMessage: [] };
  const { rows, hashes, deadline } = options;
  const retryable = (start: number, count: number) => {
    result.failed += count;
    for (let i = start; i < start + count; i++) result.retryableIndices.push(i);
  };
  const chunks = options.chunks ?? Array.from({ length: Math.ceil(rows.length / options.batchSize) }, (_, index) => {
    const start = index * options.batchSize;
    return { start, count: Math.min(options.batchSize, rows.length - start) };
  });
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const { start, count } = chunks[chunkIndex];
    const chunk = rows.slice(start, start + count);
    const keys = hashes.slice(start, start + chunk.length);
    if (Date.now() + 5000 >= deadline) { retryable(start, rows.length - start); break; }
    try {
      if (!await options.claim(keys)) {
        result.failed += chunk.length; result.uncertain += chunk.length;
        result.failMessage.push('이미 처리 중이거나 등록 여부 확인이 필요한 리뷰입니다.');
        retryable(start + chunk.length, rows.length - start - chunk.length); break;
      }
    } catch {
      retryable(start, rows.length - start);
      result.failMessage.push('리뷰 저장소에 연결하지 못했습니다.'); break;
    }
    let outcome: 'complete' | 'rejected' | 'uncertain' | 'retryable' = 'uncertain';
    let message = '';
    if (Date.now() + 3000 >= deadline) outcome = 'retryable';
    else {
      try {
        outcome = await options.send(start, chunk.length, AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - Date.now() - 2000))));
      } catch (error) {
        const status = (error as { status?: number }).status;
        outcome = status === 429 ? 'retryable' : [400, 401, 403, 404, 413, 422].includes(status ?? 0) ? 'rejected' : 'uncertain';
        message = error instanceof Error ? error.message : '이관 요청을 확인하지 못했습니다.';
      }
    }
    if (outcome === 'complete') {
      try { await options.save(chunk); result.written += chunk.length; }
      catch { outcome = 'uncertain'; message = '등록 후 기록 저장에 실패했습니다. 등록 여부를 확인해 주세요.'; }
    }
    if (outcome === 'rejected' || outcome === 'retryable') {
      try { await options.release(keys); }
      catch { outcome = 'uncertain'; message = '처리 상태를 확인하지 못했습니다.'; }
    }
    if (outcome === 'uncertain') {
      result.failed += chunk.length; result.uncertain += chunk.length; result.uncertainCharged += chunk.length;
      result.failMessage.push(message || '일부 또는 전체 리뷰의 등록 여부 확인이 필요합니다. 자동 재전송하지 않습니다.');
      retryable(start + chunk.length, rows.length - start - chunk.length); break;
    }
    if (outcome === 'rejected') {
      result.failed += chunk.length; result.permanentFailed += chunk.length;
      if (message) result.failureReason ??= message;
    }
    if (outcome === 'retryable') {
      retryable(start, rows.length - start);
      result.failMessage.push(message || '잠시 후 다시 시도해 주세요.'); break;
    }
    if (message) result.failMessage.push(message);
    if (options.delayMs && chunkIndex + 1 < chunks.length) await new Promise(resolve => setTimeout(resolve, Math.min(options.delayMs!, Math.max(0, deadline - Date.now()))));
  }
  return result;
}
