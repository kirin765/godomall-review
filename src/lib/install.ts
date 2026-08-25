import postgres from 'postgres';

/**
 * godomall 장기 토큰(100년)을 설치 단위로 저장한다.
 *
 * 왜 저장하는가: godomall은 토큰이 "그 설치"의 정체인데, Paddle 웹훅이 서버에서
 * /app-installed/extend를 호출하려면 몰 세션 없이 토큰이 필요하다. 그래서 OAuth 설치
 * 때 이 테이블에 저장하고, 웹훅이 이 토큰으로 godomall 만료일을 연장한다.
 *
 * godomall 장기 토큰은 몰당 (재설치 시) 재발급된다 — 재설치 때 이 행을 덮어쓴다.
 * (godomall 1:1 특성상 이전 토큰은 무효가 되지만, 저장본은 항상 최신 설치본을 담는다.)
 */
export type Install = {
  mall_no: string;
  access_token: string;
  updated_at: Date;
};

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1 });
  try {
    await sql`create table if not exists godo_install (
      mall_no text primary key,
      access_token text not null,
      updated_at timestamptz not null default now())`;
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** OAuth 설치 성공 시 토큰 저장(덮어쓰기). */
export const saveInstall = (mallNo: string | number, token: string) =>
  withDb(async (sql) => {
    await sql`insert into godo_install (mall_no, access_token)
      values (${String(mallNo)}, ${token})
      on conflict (mall_no) do update set access_token = ${token}, updated_at = now()`;
  });

export const getInstallToken = (mallNo: string | number) =>
  withDb(async (sql) => {
    const [row] = await sql<Install[]>`select * from godo_install where mall_no = ${String(mallNo)}`;
    return row?.access_token ?? null;
  });

/** 앱 삭제 웹훅 시 토큰 폐기. */
export const clearInstall = (mallNo: string | number) =>
  withDb(async (sql) => {
    await sql`delete from godo_install where mall_no = ${String(mallNo)}`;
  });

/** Paddle custom_data로 보낼 몰 식별자. godomall은 shopNo를 쓰지만 프로필에서 둘 다 올 수 있다. */
export type MallIdentity = { mallNo: number | string; shopNo?: number | string };
