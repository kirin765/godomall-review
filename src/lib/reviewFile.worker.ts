import { parseReviewFile } from './reviewImport';
import { identifyReviews } from './transferInput';
import type { ReviewWorkerResponse } from './reviewWorkerTask';

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  let result: ReviewWorkerResponse;
  try {
    const { reviews } = parseReviewFile(event.data);
    const identified = identifyReviews(reviews);
    const digest = await crypto.subtle.digest('SHA-256', event.data);
    const fileHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    result = { reviews: identified, fileHash };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : '엑셀 파일을 읽지 못했습니다.' };
  }
  self.postMessage(result);
};
