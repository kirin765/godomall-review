import { randomUUID } from 'crypto';
import postgres from 'postgres';
import { listGoodsReviewArticles, type GoodsReviewArticle } from '@/lib/godomall';

/**
 * 리뷰이사가 옮긴 리뷰 원장. 옮기기 성공 시 기록해 두고 관리 화면에서 걸러 보고,
 * 골라서 고도몰 상품 후기 게시판에서 실제 삭제할 수 있게 한다.
 *
 * 카페24판과 달리 고도몰 bulk 등록 응답({success, fail, failMessage})에는 글 번호가 없다.
 * 그래서 등록 직후 (·관리 화면 목록을 열 때) 상품 후기 게시판(goodsreview) 목록과
 * (상품·작성자·본문·평점)을 대조해 article_sno를 채운다(reconcileImports).
 * 그 sno가 있어야만 DELETE /boards/goodsreview/articles/{sno}로 지울 수 있다.
 * (과거 옮긴 글은 기록이 없어 자동 식별 불가 — 기능은 이 배포 이후 옮긴 글부터 적용된다.)
 *
 * ⚠️ 테이블 명을 고유하게(`godo_review_imported`) 쓴다. 이 DATABASE_URL은 다른 프로젝트와
 *    공유되는 DB라, 제네릭한 `imported_review`라는 이름이 다른 앱의 테이블과 충돌해
 *    `column "import_key" does not exist` 같은 스키마가 어긋나는 문제가 실제로 발생했다
 *    (운영 로그 실측, 2026-09-01).
 */

export type ImportedReviewRow = {
  import_key: string;
  article_sno: number | null;
  goods_no: number;
  writer: string;
  score: number;
  content: string;
  image_url: string | null;
  created_date: string | null;
  imported_at: Date;
};

export type NewImport = {
  goods_no: number;
  writer: string;
  score: number;
  content: string;
  image_url: string | null;
  created_date: string | null;
};

const MATCH_PAGES_MAX = 10; // 시간 창 안 게시글이 많아도 1만 건까지만 대조한다
const MATCH_PAGE_SIZE = 1000;
const MATCH_START_MARGIN_MS = 2 * 60 * 1000; // 등록 직후 목록에 안 잡힐 수 있어 시작 시각을 앞으로 당긴다
const MATCH_END_MARGIN_MS = 60 * 1000;

const TABLE = 'godo_review_imported';

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1 });
  try {
    await sql`
      create table if not exists ${sql(TABLE)} (
        import_key text primary key,
        mall_no bigint not null,
        article_sno bigint,
        goods_no bigint not null,
        writer text not null,
        score int not null,
        content text not null,
        image_url text,
        created_date text,
        imported_at timestamptz not null default now()
      )`;
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** 옮기기 성공으로 집계된 리뷰를 원장에 남긴다. 글 번호는 뒤늦게 대조해서 채운다. 실패해도 조용히 넘어간다. */
export async function recordImports(mallNo: number, rows: NewImport[]): Promise<void> {
  if (!rows.length) return;
  try {
    await withDb(async (sql) => {
      for (const r of rows)
        await sql`
          insert into ${sql(TABLE)} (import_key, mall_no, goods_no, writer, score, content, image_url, created_date)
          values (${randomUUID()}, ${mallNo}, ${r.goods_no}, ${r.writer}, ${r.score}, ${r.content}, ${r.image_url}, ${r.created_date})`;
    });
  } catch (e) {
    console.error('[imports] record failed', (e as Error).message);
  }
}

/** 이 몰이 옮긴 리뷰 목록. 상품 필터가 있으면 그 상품만. 최신순. */
export async function listImports(mallNo: number, productNo?: number): Promise<ImportedReviewRow[] | null> {
  return withDb(async (sql) => {
    const rows = productNo
      ? await sql<ImportedReviewRow[]>`
          select import_key, article_sno, goods_no, writer, score, content, image_url, created_date, imported_at
          from ${sql(TABLE)} where mall_no = ${mallNo} and goods_no = ${productNo}
          order by imported_at desc`
      : await sql<ImportedReviewRow[]>`
          select import_key, article_sno, goods_no, writer, score, content, image_url, created_date, imported_at
          from ${sql(TABLE)} where mall_no = ${mallNo}
          order by imported_at desc`;
    return rows;
  });
}

/** 고도몰에서 실제 삭제에 성공한 글 번호만 원장에서 지운다. */
export async function removeImports(mallNo: number, articleSnos: number[]): Promise<void> {
  if (!articleSnos.length) return;
  await withDb(async (sql) => {
    for (const sno of articleSnos)
      await sql`delete from ${sql(TABLE)} where mall_no = ${mallNo} and article_sno = ${sno}`;
  });
}

/** 글 번호가 아직 없는 원장 행을 고도몰 상품 후기 게시판과 대조해 article_sno를 채운다. */
export async function reconcileImports(token: string, mallNo: number): Promise<void> {
  await withDb(async (sql) => {
    type Pending = { import_key: string; goods_no: number; writer: string; score: number; content: string; imported_at: Date };
    const pending = await sql<Pending[]>`
      select import_key, goods_no, writer, score, content, imported_at
      from ${sql(TABLE)}
      where mall_no = ${mallNo} and article_sno is null
      order by imported_at asc`;
    if (!pending.length) return;

    // 가장 오래된 미대조 행의 등록 시각부터 지금까지를 시간 창으로 잡는다 (등록일 필터만 지원되는 API라서).
    const start = new Date(pending[0].imported_at.getTime() - MATCH_START_MARGIN_MS);
    const end = new Date(Date.now() + MATCH_END_MARGIN_MS);
    const articles: GoodsReviewArticle[] = [];
    for (let page = 1; page <= MATCH_PAGES_MAX; page++) {
      const res = await listGoodsReviewArticles(token, {
        registerStartDate: fmtKst(start),
        registerEndDate: fmtKst(end),
        page,
        pageSize: MATCH_PAGE_SIZE,
      });
      articles.push(...(res.contents ?? []));
      if (articles.length >= (res.totalCount ?? 0)) break;
      if ((res.contents ?? []).length === 0) break;
    }
    if (!articles.length) return;

    // 같은 값으로 여러 건 옮겼을 때 한 글에 여러 원장이 붙지 않게, 대조된 글은 후보 풀에서 뺀다.
    const pool = [...articles];
    for (const p of pending) {
      const ai = pool.findIndex(
        (a) =>
          a.sno != null &&
          a.goodsSno === p.goods_no &&
          (a.writerName ?? '') === p.writer &&
          (a.content ?? '') === p.content &&
          (a.rating ?? null) === p.score,
      );
      if (ai < 0) continue;
      await sql`update ${sql(TABLE)} set article_sno = ${pool[ai].sno} where import_key = ${p.import_key}`;
      pool.splice(ai, 1);
    }
  });
}

/** 고도몰 서버 API의 일시 필터 형식(yyyy-MM-dd HH:mm:ss, KST)으로 만든다. */
function fmtKst(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
}