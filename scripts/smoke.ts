// 리뷰이사 스모크 테스트
// 1) 파서/날짜/마스킹/이미지 매핑 (오프라인)
// 2) 라이브 서버 API (세션 없이) — 401/200 확인
// 사용법: next build && next start &  →  npx tsx scripts/smoke.ts [baseUrl]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseReviewFile, toDateTime, maskWriter } from '../src/lib/reviewImport';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const log = (ok: boolean, msg: string) => {
  if (ok) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
};

console.log('== 1) 오프라인 파서/유틸 스모크 ==');

const buf = readFileSync(join(root, 'public/sample-reviews.xlsx'));
const { reviews, headers } = parseReviewFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
log(headers.includes('리뷰 이미지'), '샘플 엑셀에 "리뷰 이미지" 컬럼 존재');
log(reviews.length === 6, `구매평 6건 파싱 (실제 ${reviews.length})`);
const withImg = reviews.filter((r) => r.imageUrl);
const withoutImg = reviews.filter((r) => !r.imageUrl);
log(withImg.length === 5, `이미지 포함 5건 (실제 ${withImg.length})`);
log(withoutImg.length === 1, `이미지 없는 1건 (실제 ${withoutImg.length})`);
log(withImg.every((r) => r.imageUrl && /^https?:\/\//.test(r.imageUrl)), '이미지 URL 형식 유효');
log(reviews.every((r) => r.content && r.writer && r.score >= 1 && r.score <= 5), '본문/작성자/평점 모두 파싱');
log(maskWriter('kirin765') === 'kiri****', '작성자 마스킹(접두 4자 + ****)');
log(maskWriter('hana****') === 'hana****', '이미 마스킹된 작성자 그대로 유지');

log(toDateTime('2026-06-14') === '2026-06-14 00:00:00', `toDateTime yyyy-mm-dd -> ${toDateTime('2026-06-14')}`);
log(toDateTime('46000') !== null, 'toDateTime 엑셀 직렬값 처리');
log(toDateTime('') === null, 'toDateTime 빈 값 -> null');

console.log('== 2) 라이브 서버 API 스모크 ==');

const base = process.argv[2] || 'http://localhost:3000';

async function expectStatus(path: string, status: number) {
  try {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    log(res.status === status, `${path} -> ${res.status} (기대 ${status})`);
  } catch (e) {
    log(false, `${path} -> 요청 실패: ${(e as Error).message}`);
  }
}

async function main() {
  await expectStatus('/api/reviews', 401);
  try {
    const res = await fetch(`${base}/api/goods`);
    log(res.status === 401, `/api/goods (GET, 세션 없음) -> ${res.status} (기대 401)`);
  } catch (e) {
    log(false, `/api/goods 요청 실패: ${(e as Error).message}`);
  }
  await expectStatus('/api/webhook/app', 200);

  for (const p of ['/', '/privacy', '/support']) {
    try {
      const res = await fetch(`${base}${p}`);
      log(res.ok, `${p} -> ${res.status}`);
    } catch (e) {
      log(false, `${p} -> 요청 실패: ${(e as Error).message}`);
    }
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

void main();
