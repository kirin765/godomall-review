import * as XLSX from 'xlsx';

export type ImportedReview = {
  score: number;
  content: string;
  writer: string;
  createdAt: string | null;
  option: string | null;
  productName: string | null;
  imageUrl: string | null;
};

/**
 * 스마트스토어 구매평 엑셀과 쿠팡 템플릿(윙 리뷰 목록 컬럼 그대로)을 파싱한다.
 * 컬럼 구성이 확정되지 않아 헤더명으로 유연하게 찾는다.
 * 쿠팡윙 헤더: 등록일 | 노출상품ID(옵션ID) | 노출 상품명 | 별점 | 상품평 코멘트 | 작성자
 */
const PATTERNS: Record<keyof ImportedReview, RegExp> = {
  score: /평점|별점|점수|score|rating/i,
  content: /리뷰|구매평|내용|후기|본문|상품평|코멘트|content|review/i,
  writer: /작성자|등록자|아이디|구매자|닉네임|writer|^id$/i,
  createdAt: /작성일|등록일|날짜|일시|date/i,
  option: /옵션|option/i,
  productName: /상품명|상품|product/i,
  imageUrl: /이미지|사진|포토|영상|사진url|이미지url|리뷰사진|image|photo|video|url/i,
};

/**
 * 같은 열을 다른 키가 먼저 가로채지 않도록 제외한다.
 * 스마트스토어 구매평 엑셀: '리뷰구분'·'리뷰글번호'·'리뷰도움수'가 content 후보보다 앞에 있고,
 * '구매자평점'이 writer 패턴(구매자)에, '상품번호'가 productName 패턴(상품)에 먼저 걸린다.
 */
function excludedFrom(key: keyof ImportedReview, header: string): boolean {
  if (key === 'content')
    return (
      // '내용' 계열이 상품명 컬럼을 잡지 않게, '리뷰사진'·'포토/영상'이 content 패턴(리뷰)을 먼저 잡지 않게
      /상품명/.test(header) ||
      PATTERNS.imageUrl.test(header) ||
      // '리뷰구분'·'글번호'·'도움수'·'일시'류 메타 컬럼이 본문 컬럼보다 앞에 있는데 걸리지 않게
      /구분|글번호|번호|도움수|답글|전시|혜택|유저정보|이동일|풀필먼트/.test(header)
    );
  if (key === 'option') return /id/i.test(header); // 쿠팡의 노출상품ID(옵션ID)가 옵션으로 오인되지 않게
  if (key === 'imageUrl') return /상품명|노출상품|옵션/.test(header); // 상품 URL·옵션ID 컬럼이 이미지 컬럼으로 오인되지 않게
  if (key === 'writer') return /평점|별점|점수|rating/.test(header); // '구매자평점'이 작성자로 잡히지 않게
  if (key === 'productName') return /번호|id/i.test(header); // '상품번호'·'노출상품ID'가 상품명으로 잡히지 않게
  return false;
}

function pickColumns(headers: string[]) {
  const map: Partial<Record<keyof ImportedReview, number>> = {};
  (Object.keys(PATTERNS) as (keyof ImportedReview)[]).forEach((key) => {
    const i = headers.findIndex((h) => PATTERNS[key].test(h) && !excludedFrom(key, h));
    if (i >= 0) map[key] = i;
  });
  return map;
}

export function parseReviewFile(buf: ArrayBuffer): { reviews: ImportedReview[]; headers: string[] } {
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  if (!rows.length) return { reviews: [], headers: [] };

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? '').trim());
  const col = pickColumns(headers);
  const cell = (r: unknown[], i?: number) => (i === undefined ? '' : String(r[i] ?? '').trim());

  const reviews: ImportedReview[] = [];
  for (const raw of rows.slice(1)) {
    const r = raw as unknown[];
    const content = cell(r, col.content);
    if (!content) continue;
    const score = Number(cell(r, col.score));
    reviews.push({
      score: Number.isFinite(score) && score > 0 ? Math.min(5, Math.round(score)) : 5,
      content,
      writer: maskWriter(cell(r, col.writer)),
      createdAt: cell(r, col.createdAt) || null,
      option: cell(r, col.option) || null,
      productName: cell(r, col.productName) || null,
      imageUrl: cell(r, col.imageUrl) || null,
    });
  }
  return { reviews, headers };
}

/**
 * 엑셀 작성일(2026-06-14 · 2026.06.14. · 직렬값 46000 등)을
 * 고도몰 외부 리뷰 API 날짜 형식 "YYYY-MM-DD HH:mm:ss"로 바꾼다.
 */
export function toDateTime(raw: string | null): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    // 엑셀 날짜 직렬값 (1899-12-30 기준 일수)
    const n = Number(t);
    if (n < 20000 || n > 80000) return null;
    const d = new Date(Math.round((n - 25569) * 86400000));
    return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  const m = t.match(/^(\d{4})[.\-/]\s?(\d{1,2})[.\-/]\s?(\d{1,2})\.?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  return fmt(y, mo, day, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
}

function fmt(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
}

/** 엑셀에는 마스킹이 안 돼 있을 수 있다. 앞 4자만 남기고 가린다. */
export function maskWriter(s: string): string {
  const t = s.trim();
  if (!t) return '익명';
  if (/\*/.test(t)) return t; // 이미 마스킹됨
  return t.slice(0, Math.min(4, t.length)) + '****';
}
