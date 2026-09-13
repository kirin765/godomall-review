import * as XLSX from 'xlsx';

export type ImportedReview = {
  /** Stable occurrence identity within the full source file, assigned before transfer. */
  sourceId?: string;
  score: number;
  content: string;
  writer: string;
  createdAt: string | null;
  option: string | null;
  productName: string | null;
  images: string[];
};

/**
 * 스마트스토어 구매평 엑셀과 쿠팡 템플릿(윙 리뷰 목록 컬럼 그대로)을 파싱한다.
 * 컬럼 구성이 확정되지 않아 헤더명으로 유연하게 찾는다.
 * 쿠팡윙 헤더: 등록일 | 노출상품ID(옵션ID) | 노출 상품명 | 별점 | 상품평 코멘트 | 작성자
 */
const PATTERNS: Record<Exclude<keyof ImportedReview, 'sourceId'>, RegExp> = {
  score: /평점|별점|점수|score|rating/i,
  content: /리뷰|구매평|내용|후기|본문|상품평|코멘트|content|review/i,
  writer: /작성자|등록자|아이디|구매자|닉네임|writer|^id$/i,
  createdAt: /작성일|등록일|날짜|일시|date/i,
  option: /옵션|option/i,
  productName: /상품명|상품|product/i,
  images: /이미지|사진|포토|영상|첨부|attachment|image|img|photo|video|review.*url|url.*image/i,
};

/**
 * 같은 열을 다른 키가 먼저 가로채지 않도록 제외한다.
 * 스마트스토어 구매평 엑셀: '리뷰구분'·'리뷰글번호'·'리뷰도움수'가 content 후보보다 앞에 있고,
 * '구매자평점'이 writer 패턴(구매자)에, '상품번호'가 productName 패턴(상품)에 먼저 걸린다.
 */
function excludedFrom(key: Exclude<keyof ImportedReview, 'sourceId'>, header: string): boolean {
  if (key === 'content')
    return (
      // '내용' 계열이 상품명 컬럼을 잡지 않게, '리뷰사진'·'이미지'가 content 패턴(리뷰)을 먼저 잡지 않게
      /상품명/.test(header) ||
      PATTERNS.images.test(header) ||
      // '리뷰구분'·'글번호'·'도움수'·'일시'류 메타 컬럼이 본문 컬럼보다 앞에 있는데 걸리지 않게
      /구분|글번호|번호|도움수|답글|전시|혜택|유저정보|이동일|풀필먼트|작성일|등록일|날짜|일시|date/i.test(header)
    );
  if (key === 'option') return /id/i.test(header); // 쿠팡의 노출상품ID(옵션ID)가 옵션으로 오인되지 않게
  if (key === 'images') return /상품명|노출상품|옵션/.test(header); // 상품 URL·옵션ID 컬럼이 이미지 컬럼으로 오인되지 않게
  if (key === 'writer') return /평점|별점|점수|rating/.test(header); // '구매자평점'이 작성자로 잡히지 않게
  if (key === 'productName') return /번호|id/i.test(header); // '상품번호'·'노출상품ID'가 상품명으로 잡히지 않게
  return false;
}

/** 셀에서 이미지 URL을 모두 뽑는다. 플랫폼별 제한은 전송 전에 검증한다. 이미지 확장자로 끝나는 http(s) 주소만 허용한다. */
export function extractImageUrls(cell: string): string[] {
  const parts = cell.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const urls = parts.flatMap((p) => p.split(/[,;](?=https?:\/\/)/i)).filter((p) =>
    /^https?:\/\/.+\.(jpe?g|png|gif|webp|bmp)(\?.*)?$/i.test(p),
  );
  return [...new Set(urls)];
}

function pickColumns(headers: string[]) {
  const map: Partial<Record<keyof ImportedReview, number>> = {};
  (Object.keys(PATTERNS) as (Exclude<keyof ImportedReview, 'sourceId'>)[]).forEach((key) => {
    const i = headers.findIndex((h) => PATTERNS[key].test(h) && !excludedFrom(key, h));
    if (i >= 0) map[key] = i;
  });
  return map;
}

export function parseReviewFile(buf: ArrayBuffer): { reviews: ImportedReview[]; headers: string[] } {
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true });
  if (!rows.length) return { reviews: [], headers: [] };

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? '').trim());
  const col = pickColumns(headers);
  if (col.content === undefined) throw new Error('리뷰 내용 컬럼을 찾지 못했습니다. 헤더를 확인해 주세요.');
  if (col.score === undefined) throw new Error('평점 컬럼을 찾지 못했습니다. 헤더를 확인해 주세요.');
  const imageColumns = headers.flatMap((h, i) => PATTERNS.images.test(h) && !excludedFrom('images', h) ? [i] : []);
  const cell = (r: unknown[], i?: number) => (i === undefined ? '' : String(r[i] ?? '').trim());

  const reviews: ImportedReview[] = [];
  for (const [index, raw] of rows.slice(1).entries()) {
    const r = raw as unknown[];
    if (r.every((value) => String(value ?? '').trim() === '')) continue;
    const content = cell(r, col.content);
    if (!content) throw new Error(`${index + 2}행: 리뷰 내용이 비어 있습니다.`);
    const score = Number(cell(r, col.score));
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error(`${index + 2}행: 평점은 1~5 사이의 정수여야 합니다.`);
    const rawDate = cell(r, col.createdAt);
    const createdAt = rawDate && wb.Workbook?.WBProps?.date1904 && /^\d+(\.\d+)?$/.test(rawDate) ? String(Number(rawDate) + 1462) : rawDate;
    reviews.push({
      score,
      content,
      writer: maskWriter(cell(r, col.writer)),
      createdAt: createdAt || null,
      option: cell(r, col.option) || null,
      productName: cell(r, col.productName) || null,
      images: [...new Set(imageColumns.flatMap((i) => extractImageUrls(cell(r, i))))],
    });
  }
  return { reviews, headers };
}

/** 엑셀 작성일(2026-06-14 · 2026.06.14. · 직렬값 46000 등)을 API 날짜(KST)로 바꾼다. */
export function toDateTime(raw: string | null): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    // 엑셀 날짜 직렬값 (1899-12-30 기준 일수)
    const n = Number(t);
    if (n < 20000 || n > 80000) return null;
    const d = new Date(Math.round((n - 25569) * 86400000));
    return fmtKst(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  const m = t.match(/^(\d{4})[.\-/]\s?(\d{1,2})[.\-/]\s?(\d{1,2})\.?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const [y, mo, day, h, mi, sec] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const date = new Date(Date.UTC(y, mo - 1, day, h, mi, sec));
  if (y < 1900 || mo < 1 || mo > 12 || day < 1 || date.getUTCDate() !== day || h > 23 || mi > 59 || sec > 59) return null;
  if (m[7]) {
    if (!m[4]) return null;
    const zone = m[7].toUpperCase();
    const offset = zone === 'Z' ? 0 : Number(zone.slice(1, 3)) * 60 + Number(zone.replace(':', '').slice(3, 5));
    if (offset > 14 * 60 || (zone !== 'Z' && Number(zone.replace(':', '').slice(3, 5)) > 59)) return null;
    date.setTime(date.getTime() - (zone.startsWith('-') ? -offset : offset) * 60000 + 9 * 3600000);
    return fmtKst(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
  }
  return fmtKst(y, mo, day, h, mi, sec);
}

function fmtKst(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
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
