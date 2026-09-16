import postgres from 'postgres';
import { extendAppStatus, expiryAfterDays } from '@/lib/payment';
import { FREE_TRIAL_DAYS } from '@/lib/quota';

/**
 * 무료 체험(14일) 부여 — 몰당 1회.
 *
 * 결제형(인앱) 앱은 설치 직후 workspace가 EXPIRED라 server API(SA0010)가 막혀
 * 무료 체험조차 쓸 수 없다. 앱을 처음 실행할 때 여기서 TRIAL extend를 1회 호출해
 * 14일 실행창을 연다(구독 기록은 남기지 않으므로 paid가 아니라 무료 20건/일 유지).
 *
 * 재실행·재설치에도 다시 늘리지 않는다 — godo_trial에 시작 기록이 있으면 끝이다.
 * (14일이 지나면 workspace가 EXPIRED가 되고, 유료 전환 전까지 앱이 차단된다.)
 * 이미 유료 구독이 있으면 체험을 주지 않는다(만료일을 앞당길 수 있어서).
 */

const TABLE = 'godo_trial';

export type TrialGrant = { granted: boolean; reason: string; expiresAt?: string };

export async function ensureFreeTrial(mallNo: number, accessToken: string): Promise<TrialGrant> {
  const url = process.env.DATABASE_URL;
  if (!url) return { granted: false, reason: 'no-db' };

  const sql = postgres(url, { max: 1 });
  try {
    await sql`create table if not exists ${sql(TABLE)} (
      mall_id text primary key,
      started_at timestamptz not null default now(),
      expires_at timestamptz)`;

    const [sub] = await sql`
      select 1 from app_subscriptions where mall_id = ${String(mallNo)} and until_ts > now() limit 1`;
    if (sub) return { granted: false, reason: 'paid' };

    const [existing] = await sql`select started_at from ${sql(TABLE)} where mall_id = ${String(mallNo)}`;
    if (existing) return { granted: false, reason: 'already' };

    const requestDateTime = expiryAfterDays(FREE_TRIAL_DAYS);
    await extendAppStatus(accessToken, {
      orderNo: `trial-${FREE_TRIAL_DAYS}d`,
      requestDateTime,
      paymentType: 'TRIAL',
      price: 0,
    });
    await sql`insert into ${sql(TABLE)} (mall_id, started_at, expires_at)
              values (${String(mallNo)}, now(), ${requestDateTime})
              on conflict (mall_id) do nothing`;
    return { granted: true, reason: 'granted', expiresAt: requestDateTime };
  } catch (e) {
    return { granted: false, reason: (e as Error).message.slice(0, 120) };
  } finally {
    await sql.end();
  }
}
