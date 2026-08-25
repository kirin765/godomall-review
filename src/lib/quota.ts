import postgres from 'postgres';
import { getSubscription, isActive } from './subscription';
import { getAppInstallStatus, type AppStatus } from './godomall';

// 게이트(2026-12-15)가 세는 것은 유료 전환. 무료 구간은 "하루 20건" 제한으로,
// 기존 cafe24의 "누적 20건" 대신 고객과 약속한 "3일 트라이얼 + 하루 20건" 모델을 따른다.
export const DAILY_LIMIT = 20;
export const TRIAL_DAYS = 3;

export type Quota = {
  allowed: number;
  paid: boolean;
  used: number; // 오늘 사용량
  limit: number;
  day: string; // KST YYYY-MM-DD
  status: AppStatus;
  expiresAt: string | null; // godomall 만료일
  error?: string;
};

/** KST 자정 기준 "오늘" 문자열 (하루 20건 리셋 기준). */
function kstDay(d: Date = new Date()): string {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { max: 1 });
  try {
    await sql`create table if not exists godo_usage (
      mall_no text not null,
      day text not null,
      written int not null default 0,
      updated_at timestamptz not null default now(),
      primary key (mall_no, day))`;
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/**
 * 접근 gate. godomall /app-installed/status가 최종 gate다(만료일이 지나면 godomall이
 * 앱 실행을 차단). 여기서는:
 *  - godomall ACTIVE + 미래 만료일 → 접근 가능
 *  - 유료(subscription active) → 무제한
 *  - 무료/트라이얼 → 하루 20건
 *  - godomall EXPIRED/DELETED 또는 만료일 경과 → 0건(402 유도)
 * godomall 상태를 못 읽는 네트워크 오류는 "만료"로 오판하지 않도록 예외를 던져
 * 호출자가 방어한다(리뷰 등록을 보수적으로 막되, 노트가 만료라고 거짓 표시하지 않게).
 */
export async function checkQuota(token: string, mallNo: string | number, want: number): Promise<Quota> {
  const url = process.env.DATABASE_URL;
  const { paid } = await resolvePaid(mallNo);
  const app = await getAppInstallStatus(token);

  const expiresAt = app.expireDateTime;
  const active =
    app.currentStatus === 'ACTIVE' && expiresAt != null && new Date(expiresAt) > new Date();
  if (!active)
    return { allowed: 0, paid, used: 0, limit: DAILY_LIMIT, day: kstDay(), status: app.currentStatus, expiresAt };

  if (paid) return { allowed: want, paid: true, used: 0, limit: DAILY_LIMIT, day: kstDay(), status: app.currentStatus, expiresAt };
  if (!url) return { allowed: 0, paid, used: 0, limit: DAILY_LIMIT, day: kstDay(), status: app.currentStatus, expiresAt };

  const used =
    (await withDb(async (sql) => {
      const [row] = await sql<{ written: number }[]>`
        select written from godo_usage where mall_no = ${String(mallNo)} and day = ${kstDay()}`;
      return row?.written ?? 0;
    })) ?? 0;

  return {
    allowed: Math.max(0, DAILY_LIMIT - used),
    paid: false,
    used,
    limit: DAILY_LIMIT,
    day: kstDay(),
    status: app.currentStatus,
    expiresAt,
  };
}

export async function addUsage(mallNo: string | number, n: number) {
  if (n <= 0) return;
  await withDb(async (sql) => {
    await sql`insert into godo_usage (mall_no, day, written) values (${String(mallNo)}, ${kstDay()}, ${n})
              on conflict (mall_no, day) do update set written = godo_usage.written + ${n}, updated_at = now()`;
  });
}

/** 앱 삭제·만료 웹훅 시 구독·사용량·설치토큰 전부 폐기. 재설치하면 새 트라이얼로 재시작. */
export async function resetUsage(mallNo: string | number) {
  await withDb(async (sql) => {
    await sql`delete from godo_usage where mall_no = ${String(mallNo)}`;
  });
  const { cancel } = await import('./subscription');
  await cancel(mallNo);
  const { clearInstall } = await import('./install');
  await clearInstall(mallNo);
}

export async function resolvePaid(mallNo: string | number): Promise<{ paid: boolean }> {
  return { paid: isActive(await getSubscription(mallNo)) };
}
