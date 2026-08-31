// 스마트스토어 구매평 엑셀 헤더 시나리오 (cafe24-review cff5eff 픽스 검증)
// '리뷰구분'·'리뷰글번호'·'리뷰도움수'가 본문을 가로채면 안 되고,
// '구매자평점'이 작성자를, '상품번호'가 상품명을, '포토/영상'이 이미지를 잡아야 한다.
import * as XLSX from 'xlsx';
import { parseReviewFile, toDateTime } from '../src/lib/reviewImport';

let pass = 0, fail = 0;
const log = (ok: boolean, msg: string) => {
  if (ok) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); }
};

function sheet(headers: string[], rows: unknown[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Sheet1');
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

const HEADERS = [
  '리뷰구분', '리뷰글번호', '리뷰도움수', '리뷰상세내용', '포토/영상',
  '작성자', '구매자평점', '구매자등급', '등록일', '상품번호', '상품명', '옵션정보',
];
const ROWS = [
  ['일반', '9001', '3', '재구매 의사 있어요 배송도 빨랐습니다', 'http://img1.test.com/a.jpg', 'kiri****', '5', '골드', '2026-06-14', '12345', '여름 원피스', '블루'],
  ['포토', '9002', '0', '생각보다 밝은 색이에요', '', 'haneul77', '4', '실버', '2026-06-15', '12345', '여름 원피스', '레드'],
  ['일반', '9003', '12', '리뷰이벤트 참여합니다', 'http://img1.test.com/b.jpg', 'ssal**', '5', '골드', '2026-06-16', '67890', '가죽 벨트', '브라운'],
];

const { reviews, headers } = parseReviewFile(sheet(HEADERS, ROWS));
log(headers.length === HEADERS.length, '헤더 12개 인식');
log(reviews.length === 3, `3건 파싱 (실제 ${reviews.length})`);

const [r1, r2, r3] = reviews;
log(r1.content === ROWS[0][3], `본문이 '리뷰상세내용' (리뷰구분 X) → ${JSON.stringify(r1.content)}`);
log(r1.writer === 'kiri****', `작성자가 '작성자' 컬럼 (구매자평점 X) → ${r1.writer}`);
log(r2.writer === 'hane****', `마스킹: haneul77 → hane**** (앞 4자 + ****) → ${r2.writer}`);
log(r1.score === 5, `평점 5 (구매자평점) → ${r1.score}`);
log(r1.productName === '여름 원피스', `상품명이 '상품명' 컬럼 (상품번호 X) → ${r1.productName}`);
log(r1.imageUrl === 'http://img1.test.com/a.jpg', `이미지가 '포토/영상' 컬럼 → ${r1.imageUrl}`);
log(r2.imageUrl === null, `빈 '포토/영상'은 이미지 없음 → ${r2.imageUrl}`);
log(r3.productName === '가죽 벨트', `2번째 상품 상품명 → ${r3.productName}`);
log((toDateTime(r1.createdAt) ?? '').startsWith('2026-06-14'), `등록일 파싱 → ${r1.createdAt}`);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);