// 고도몰 리뷰 이관 — 첨부 거부 분류 + 이미지 파싱 검증.
// 실행: node scripts/verify-attachment-fallback.mts
// (Node 22.18+ 는 .ts 타입 스트리핑이 기본이라 별도 러너가 필요 없다.)
//
// 검증 대상
//  1) isAttachmentRejectedMessage — 첨부 거부 메시지를 정확히 잡는지
//  2) parseReviewFile — 스마트스토어 구매평 엑셀의 '포토/영상' URL을 이미지로 뽑는지
//  3) resizedImageUrl — 네이버 이미지 URL만 ?type=w640 축소본으로 바꾸는지
// (writeReviews의 text-only 폴백 자체는 고도몰 응답 목킹이 필요해 여기서 다루지 않는다.)
import * as XLSX from 'xlsx';
import { parseReviewFile } from '../src/lib/reviewImport.ts';
import { isAttachmentRejectedMessage } from '../src/lib/attachmentError.ts';
import { resizedImageUrl } from '../src/lib/imageUrl.ts';

let pass = 0;
let fail = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) {
    pass++;
    console.log(`  ok   ${msg}`);
  } else {
    fail++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- 1) 첨부 거부 분류 -----------------------------------------------------
console.log('첨부 거부 분류');
const ATTACH_ERR =
  'bulk 422: {"success":0,"fail":1,"failMessage":["첨부파일 업로드에 실패했습니다. 저장 공간을 확인해 주세요."]}';
check(isAttachmentRejectedMessage(422, ATTACH_ERR), '첨부 거부(422)를 잡는다');
check(
  isAttachmentRejectedMessage(422, 'Your file cannot be uploaded. Please check the maximum capacity.'),
  '영문 첨부 거부 문구도 잡는다',
);
check(!isAttachmentRejectedMessage(400, 'Please enter the Requests parameter.'), '400(파라미터 오류)은 첨부 거부가 아니다');
check(!isAttachmentRejectedMessage(422, 'An invalid request is entered.'), '다른 422는 첨부 거부가 아니다');
check(!isAttachmentRejectedMessage(200, ATTACH_ERR), '2xx는 첨부 거부가 아니다');

// --- 2) 스마트스토어 구매평 엑셀 파싱 ---------------------------------------
console.log('스마트스토어 구매평 엑셀 파싱');
const HEADERS = [
  '상품번호', '상품명', '리뷰구분', '구매자평점', '포토/영상', '리뷰상세내용', '리뷰도움수',
  '등록자', '리뷰등록일', '최종수정일', '리뷰글번호', '관련리뷰글번호', '관련리뷰상세내용',
  '전시상태', '답글여부', '답글등록일시', '베스트리뷰', '베스트리뷰선정일시', '이벤트번호',
  '혜택지급', '혜택지급일시', '유저정보 등록 항목', '상품주문번호', '풀필먼트사', '리뷰이동일',
];
const PHOTO_URL =
  'https://phinf.pstatic.net/checkout.phinf/20260902_195/1788322082783O9ATM_JPEG/image.jpg';
const ROWS = [
  ['8471392739', '스테나 선풍기', '한달사용', 5, PHOTO_URL, '사진 리뷰입니다', 2, 'spdl******', '2026.09.02. 13:08:06', '', '5055733027', '', '', '정상', 'N', '', 'N', '', '', '', '', '', '', '', ''],
  ['8471392739', '스테나 선풍기', '일반', 4, '', '사진 없는 텍스트 리뷰', 0, 'bums****', '2026.09.02. 10:10:07', '', '5055608900', '', '', '정상', 'N', '', 'N', '', '', '', '', '', '', '', ''],
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...ROWS]), 'Sheet0');
const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

const { reviews, headers } = parseReviewFile(buf);
check(headers.length === HEADERS.length, `헤더 25개를 읽는다 (${headers.length})`);
check(reviews.length === 2, `2건을 파싱한다 (${reviews.length})`);
check(reviews[0]?.content === '사진 리뷰입니다', `본문을 '리뷰상세내용'에서 가져온다`);
check(reviews[0]?.images.length === 1, `'포토/영상' URL을 이미지로 뽑는다 (${reviews[0]?.images.length})`);
check(reviews[0]?.images[0] === PHOTO_URL, `이미지 URL이 원본과 같다`);
check(reviews[0]?.writer === 'spdl******', `작성자가 '등록자' 컬럼 (${reviews[0]?.writer})`);
check(reviews[1]?.images.length === 0, `빈 '포토/영상'은 이미지 없음 (${reviews[1]?.images.length})`);

// --- 3) 첨부 이미지 축소 URL 변환 -------------------------------------------
console.log('첨부 이미지 축소 URL 변환');
const variant = (u: string) => new URL(u).searchParams.get('type');
check(variant(resizedImageUrl(PHOTO_URL)) === 'w640', 'phinf URL에 ?type=w640을 붙인다');
check(
  resizedImageUrl(`${PHOTO_URL}?type=w1000`) === `${PHOTO_URL}?type=w640`,
  '기존 type 파라미터를 w640으로 덮어쓴다',
);
check(resizedImageUrl(`${PHOTO_URL}?a=1`).endsWith('a=1&type=w640'), '다른 쿼리는 유지하고 type만 더한다');
check(
  resizedImageUrl('https://img.coupang.com/a.jpg') === 'https://img.coupang.com/a.jpg',
  '네이버가 아닌 호스트는 그대로 둔다',
);
check(resizedImageUrl('not a url') === 'not a url', '잘못된 문자열은 그대로 둔다');
check(
  variant(resizedImageUrl('https://shop-phinf.pstatic.net/x/y.jpg')) === 'w640',
  'pstatic 하위 호스트도 축소한다',
);
check(!reviews[0]?.images[0]?.includes('type='), '파싱 결과(해시 입력)는 원본 URL 그대로다');

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
