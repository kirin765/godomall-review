/**
 * 쇼핑몰이 "첨부파일" 때문에 리뷰 등록을 거부했는지 판별한다. (cafe24-review e057f41 이식)
 *
 * 첨부(이미지 URL)를 붙여 등록할 때 저장 공간 부족·첨부 미지원 등으로 거부되면
 * 재시도해도 같은 결과이므로, 사진을 빼고 한 번 더 쓰는 폴백이 필요하다.
 *
 * 고도몰은 bulk API가 HTTP 200으로 `{success, fail, failMessage}`를 돌려주므로,
 * 거부가 예외(status 422)로 올 수도 있고 failMessage 문자열로 올 수도 있다.
 * 두 경로를 모두 판별할 수 있게 순수 함수만 둔다 — writeReviews가 쓴다.
 */

const ATTACH_HINTS = [
  'file cannot be uploaded',
  'capacity of the library board',
  'attach_file',
  'attachment',
  'attached file',
  '첨부파일',
  '첨부 파일',
  '이미지',
  '사진',
];

/** 메시지 문자열만으로 첨부 거부로 보이는지 (bulk failMessage 경로). */
export function mentionsAttachmentRejection(message: unknown): boolean {
  const msg = String(message ?? '').toLowerCase();
  if (!msg) return false;
  if (ATTACH_HINTS.some((h) => msg.includes(h.toLowerCase()))) return true;
  if (/attach(ed)?[ _-]?file/.test(msg)) return true;
  return msg.includes('file') && msg.includes('upload');
}

/** 상태코드와 오류 메시지로 첨부 거부인지 판별한다 (예외 경로). 2xx는 항상 아니다. */
export function isAttachmentRejectedMessage(status: unknown, message: unknown): boolean {
  const s = Number(status);
  if (Number.isFinite(s) && s >= 200 && s < 300) return false;
  return mentionsAttachmentRejection(message);
}

/** 던져진 오류가 첨부 거부인지. 호출부가 붙인 status를 함께 본다. */
export function isAttachmentRejected(e: unknown): boolean {
  return isAttachmentRejectedMessage(
    (e as { status?: number } | null)?.status,
    (e as Error | null)?.message,
  );
}
