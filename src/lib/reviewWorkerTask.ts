import type { ImportedReview } from './reviewImport';

export type PreparedReviewFile = { reviews: ImportedReview[]; fileHash: string };
export type ReviewWorkerResponse = PreparedReviewFile | { error: string };

/** Transfer buffer ownership and always release the worker, including failures/timeouts. */
export function runReviewWorker(worker: Worker, buffer: ArrayBuffer): Promise<PreparedReviewFile> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error('엑셀을 읽는 시간이 초과되었습니다. 파일을 나누어 다시 시도해 주세요.'));
    }, 60000);
    worker.onmessage = (event: MessageEvent<ReviewWorkerResponse>) => {
      finish();
      if ('error' in event.data) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = () => { finish(); reject(new Error('엑셀을 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.')); };
    worker.onmessageerror = () => { finish(); reject(new Error('엑셀 분석 결과를 읽지 못했습니다.')); };
    try { worker.postMessage(buffer, [buffer]); }
    catch (error) { finish(); reject(error); }
  });
}
