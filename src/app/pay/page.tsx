'use client';

import { useEffect, useState } from 'react';

type Prepare = {
  mallNo?: number;
  price?: string;
  clientToken?: string;
  priceId?: string;
  environment?: 'sandbox' | 'production';
  error?: string;
};

declare global {
  interface Window {
    Paddle?: {
      Initialize: (opts: { token: string; environment: string }) => void;
      Checkout: { open: (opts: { items: { priceId: string }[]; customData?: Record<string, unknown> }) => void };
    };
  }
}

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';

export default function Pay() {
  const [data, setData] = useState<Prepare | null>(null);
  const [noSession, setNoSession] = useState(false);

  useEffect(() => {
    fetch('/api/billing/prepare').then(async (r) => {
      if (r.status === 401) return setNoSession(true);
      const d: Prepare = await r.json();
      setData(d);
      if (d.error) return;
      // Paddle.js 로드 + Initialize (client token + environment)
      if (!document.querySelector(`script[src="${PADDLE_JS}"]`)) {
        const s = document.createElement('script');
        s.src = PADDLE_JS;
        document.head.appendChild(s);
      }
    }).catch(() => setData({ error: '결제 정보를 불러오지 못했습니다' }));
  }, []);

  function checkout() {
    if (!data?.clientToken || !data.priceId) return;
    window.Paddle?.Initialize({ token: data.clientToken, environment: data.environment ?? 'sandbox' });
    window.Paddle?.Checkout.open({
      items: [{ priceId: data.priceId }],
      customData: { mallNo: String(data.mallNo ?? '') },
    });
  }

  if (noSession)
    return (
      <main className="mx-auto max-w-md p-8 text-sm">
        세션이 만료됐습니다. 고도몰 관리자에서 앱을 다시 실행한 뒤 결제 화면을 열어 주세요.
      </main>
    );

  if (!data) return <main className="mx-auto max-w-md p-8 text-sm text-neutral-500">결제 정보를 준비하는 중입니다…</main>;
  if (data.error) return <main className="mx-auto max-w-md p-8 text-sm text-red-600">{data.error}</main>;

  return (
    <main className="mx-auto max-w-md p-8 font-sans">
      <h1 className="text-lg font-semibold">리뷰이사 월 이용권</h1>
      <p className="mt-1 text-xs text-neutral-500">몰 #{data.mallNo}</p>

      <div className="mt-6 rounded-lg border p-5">
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-semibold">{data.price}원</span>
          <span className="text-sm text-neutral-500">/ 월</span>
        </div>
        <ul className="mt-4 space-y-2 text-sm text-neutral-700">
          <li>✓ 리뷰 건수 제한 없이 이관</li>
          <li>✓ 이미 옮긴 리뷰는 해지해도 그대로 유지</li>
          <li>✓ 매월 자동 결제 — 언제든 해지 가능</li>
        </ul>
        <button
          onClick={checkout}
          className="mt-5 w-full rounded bg-black px-4 py-3 text-sm font-medium text-white"
        >
          카드 등록하고 계속 옮기기
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
          Paddle(글로벌 결제사)을 통해 안전하게 처리되며, 카드 정보는 Paddle에만 저장됩니다.
          첫 달 결제 후 매월 같은 날 자동 결제됩니다.
        </p>
      </div>
    </main>
  );
}
