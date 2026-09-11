/**
 * 리뷰 이미지를 쇼핑몰에 등록할 때 쓰는 "축소본 URL"로 바꾼다.
 *
 * 스마트스토어 구매평 사진은 원본이 장당 평균 2.6MB라, 수천 건을 옮기면 쇼핑몰
 * 저장 공간이 금방 가득 찬다 (2026-09 고객 문의: 7,128장 ≈ 18GB).
 * 네이버는 같은 사진을 640px 축소본으로도 제공하는데(장당 약 85KB), URL에
 * ?type=w640을 붙이면 쇼핑몰이 축소본을 내려받아 저장한다. 용량이 원본의 약 3%로
 * 줄어 수천 장도 들어간다.
 *
 * ⚠️ 이 변환은 "첨부할 때만" 적용한다. 파싱 결과(ImportedReview.images)는 원본 URL을
 * 유지해야 한다 — 중복 판정 해시(reviewHash)가 이미지 URL을 포함하므로, 파싱 단계에서
 * 바꾸면 이미 옮긴 리뷰가 새 리뷰로 오인돼 중복 등록된다.
 * 호출처: writeReviews.toPayload (첨부 URL 생성 시점). (cafe24-review e057f41 이식)
 */

/** 고도몰에 저장할 때 쓸 네이버 이미지 축소본 규격. 품질/용량을 조절하려면 여기만 바꾼다. */
export const IMAGE_VARIANT = 'w640';

/** 네이버 이미지 CDN(*.pstatic.net)만 축소본을 제공한다. 그 외 호스트·잘못된 문자열은 그대로 둔다. */
export function resizedImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)pstatic\.net$/i.test(u.hostname)) return url;
    u.searchParams.set('type', IMAGE_VARIANT);
    return u.toString();
  } catch {
    return url;
  }
}
