'use client';

import { useEffect, useState } from 'react';

type Product = { no: number; name: string };
type Quota = { used: number; limit: number; paid: boolean };
type Result = {
  dryRun?: boolean;
  count?: number;
  sample?: { writer: string; content: string; option?: string; score?: number; createdAt?: string | null; imageUrl?: string | null }[];
  parsed?: number;
  written?: number;
  skipped?: number;
  freeRemaining?: number | null;
  paid?: boolean;
  quotaExceeded?: boolean;
  used?: number;
  error?: string;
  headers?: string[];
};

const SOURCES = [
  { value: 'coupang', label: '쿠팡' },
  { value: 'smartstore', label: '네이버 스마트스토어' },
  { value: 'etc', label: '기타' },
];

function QuotaBar({ quota }: { quota: Quota | null }) {
  const used = Math.min(quota?.used ?? 20, quota?.limit ?? 20);
  const limit = quota?.limit ?? 20;
  return (
    <div className="mt-4 rounded-lg border border-neutral-300 bg-white p-4">
      <p className="text-sm font-medium">무료 20건을 모두 사용했어요</p>
      <div className="mt-3 h-1.5 w-full rounded-full bg-neutral-100">
        <div className="h-1.5 rounded-full bg-black transition-all" style={{ width: `${Math.min(100, Math.round((used / limit) * 100))}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">무료 {limit}건 중 {used}건 사용</p>
      <p className="mt-2 text-[11px] text-neutral-500">유료 전환은 준비 중입니다.</p>
    </div>
  );
}

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [mallName, setMallName] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productNo, setProductNo] = useState<number | ''>('');
  const [source, setSource] = useState('coupang');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    fetch('/api/goods')
      .then((r) => r.json())
      .then((d) => {
        if (d.mallNo) setMallName(`몰 #${d.mallNo}`);
        if (d.quota) setQuota(d.quota);
        if (Array.isArray(d.products)) setProducts(d.products);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function run(dry: boolean) {
    if (!file || !productNo) return;
    setBusy(true);
    setResult(null);
    const fd = new FormData();
    fd.set('product_no', String(productNo));
    fd.set('source', source);
    fd.set('file', file);
    if (dry) fd.set('dry_run', '1');
    const res = await fetch('/api/reviews', { method: 'POST', body: fd });
    const json = await res.json();
    if (res.status === 402) {
      setResult({ quotaExceeded: true, used: json.used });
      setQuota((q) => (q ? { ...q, used: q.limit } : q));
    } else {
      setResult(json);
      if (!dry && typeof json.freeRemaining === 'number')
        setQuota((q) => (q ? { ...q, used: q.limit - json.freeRemaining } : q));
    }
    setBusy(false);
  }

  async function useSample() {
    const blob = await fetch('/sample-reviews.xlsx').then((r) => r.blob());
    setFile(new File([blob], 'sample-reviews.xlsx', { type: blob.type }));
    setResult(null);
  }

  if (loading)
    return <main className="p-8 text-sm text-neutral-500">몰 정보를 불러오는 중입니다…</main>;

  if (!mallName)
    return <main className="p-8 text-sm">고도몰 관리자에서 앱을 실행해 주세요.</main>;

  return (
    <main className="mx-auto max-w-2xl p-6 font-sans">
      <h1 className="text-lg font-semibold">리뷰 옮기기</h1>
      <p className="mt-1 text-xs text-neutral-500">{mallName}</p>

      <ol className="mt-6 space-y-5 text-sm">
        <li>
          <div className="font-medium">1. 리뷰 엑셀과 출처를 준비하세요</div>
          <div className="mt-2">
            <select
              className="w-full rounded border p-2"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}에서 온 리뷰</option>
              ))}
            </select>
          </div>
        </li>

        <li>
          <div className="font-medium">2. 어느 상품에 넣을지 고르세요</div>
          <select
            className="mt-2 w-full rounded border p-2"
            value={productNo}
            onChange={(e) => setProductNo(Number(e.target.value) || '')}
          >
            <option value="">상품 선택</option>
            {products.map((p) => (
              <option key={p.no} value={p.no}>
                [{p.no}] {p.name}
              </option>
            ))}
          </select>
        </li>

        <li>
          <div className="font-medium">3. 엑셀 파일을 올리세요</div>
          <label className="mt-2 inline-block cursor-pointer rounded border px-4 py-2 text-sm hover:bg-neutral-50">
            파일 선택
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="mt-2 text-xs text-neutral-500">
            엑셀이 아직 없다면{' '}
            <button onClick={useSample} className="underline">샘플 엑셀로 체험하기</button>
            {' · '}
            <a href="/sample-reviews.xlsx" className="underline">샘플 내려받기</a>
          </div>
          {file && <div className="mt-1 text-xs text-neutral-600">선택된 파일: {file.name}</div>}
        </li>
      </ol>

      <div className="mt-6 flex gap-2">
        <button
          onClick={() => run(true)}
          disabled={busy || !file || !productNo}
          className="rounded border px-4 py-2 text-sm disabled:opacity-40"
        >
          미리보기
        </button>
        <button
          onClick={() => run(false)}
          disabled={busy || !file || !productNo}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {busy ? '옮기는 중…' : '옮기기'}
        </button>
      </div>

      <p className="mt-8 border-t pt-4 text-xs text-neutral-500">
        무료로 20건까지 옮겨볼 수 있어요.{' · '}
        <a href="/privacy" className="underline">개인정보처리방침</a>
      </p>

      {result && (
        <div className="mt-6 rounded bg-neutral-50 p-4 text-sm">
          {result.quotaExceeded ? (
            <QuotaBar quota={quota} />
          ) : result.error ? (
            <p className="text-red-600">
              {result.parsed === 0
                ? '엑셀을 읽지 못했습니다. 구매평 엑셀 파일이 맞는지 확인해 주세요.'
                : '옮기는 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.'}
              <span className="mt-1 block text-xs text-neutral-500">{result.error}</span>
            </p>
          ) : result.dryRun ? (
            <>
              <p className="font-medium">구매평 {result.count}건을 읽었습니다. 아래는 앞 3건입니다.</p>
              <ul className="mt-2 space-y-2 text-xs text-neutral-700">
                {result.sample?.map((s, i) => (
                  <li key={i} className="rounded border bg-white p-2">
                    <span className="font-medium">{s.writer}</span>
                    {s.score ? <span className="text-amber-500"> ★{s.score}</span> : null}
                    {s.createdAt && <span className="text-neutral-400"> {s.createdAt}</span>}
                    {' — '}{s.content}
                    {s.option && <span className="text-neutral-500"> [옵션] {s.option}</span>}
                    {s.imageUrl && (
                      <span className="mt-1 block">
                        <a href={s.imageUrl} target="_blank" rel="noreferrer" className="underline">첨부 이미지</a>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-neutral-500">아직 아무것도 등록되지 않았습니다. 「옮기기」를 누르면 실제로 등록됩니다.</p>
            </>
          ) : (
            <>
              <p className="font-medium">구매평 {result.written}건을 옮겼습니다.</p>
              {(result.skipped ?? 0) > 0 && (
                <p className="mt-1 text-xs text-neutral-500">(건너뜀 {result.skipped}건)</p>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}
