'use client';

import { useCallback, useEffect, useState } from 'react';

type Product = { no: number; name: string };
type Quota = { used: number; limit: number; paid: boolean };
type ImportedReview = {
  import_key: string;
  article_sno: number | null;
  goods_no: number;
  writer: string;
  score: number;
  content: string;
  image_url: string | null;
  created_date: string | null;
  imported_at: string;
};
type Plan = {
  mode: 'plus' | 'free';
  status: 'ACTIVE' | 'EXPIRED' | 'DELETED' | 'UNKNOWN';
  expireAt: string | null;
  price: number;
  blockedBy: 'expired' | 'deleted' | null;
  /** 앱스토어 앱 상세 URL — 여기에서 리뷰이사 플러스를 결제한다. 없으면 결제 문구를 링크 없이 보여준다. */
  storeUrl: string | null;
};
type Result = {
  dryRun?: boolean;
  count?: number;
  sample?: { writer: string; content: string; option?: string; score?: number; createdAt?: string | null; imageUrl?: string | null }[];
  parsed?: number;
  written?: number;
  skipped?: number;
  freeRemaining?: number | null;
  paid?: boolean;
  plan?: Plan;
  quotaExceeded?: boolean;
  used?: number;
  error?: string;
  headers?: string[];
};

type GoodsPayload = {
  mallNo: number;
  quota: Quota;
  plan: Plan;
  products: Product[];
  /** 만료/삭제 상태에서 godomall server API가 상품 목록을 거부할 때의 메시지 (SA0010 등) */
  goodsError?: string | null;
};

const SOURCES = [
  { value: 'coupang', label: '쿠팡' },
  { value: 'smartstore', label: '네이버 스마트스토어' },
  { value: 'etc', label: '기타' },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function PlanCard({ quota, plan }: { quota: Quota | null; plan: Plan | null }) {
  const price = plan?.price ?? 9900;
  const storeHref = plan?.storeUrl;
  /** "고도몰 앱스토어" 문구를 구매 페이지 링크로 만든다 (URL 없으면 평문). */
  const Store = ({ children }: { children: React.ReactNode }) =>
    storeHref ? (
      <a href={storeHref} target="_blank" rel="noreferrer" className="underline">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );

  if (plan?.mode === 'plus') {
    return (
      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-900">리뷰이사 플러스 — 무제한 이용 중</p>
        {plan.expireAt && (
          <p className="mt-1 text-[11px] text-amber-700">다음 결제일(만료): {fmtDate(plan.expireAt)} — 연장 결제 후 계속 이용하세요.</p>
        )}
      </div>
    );
  }

  const used = Math.min(quota?.used ?? 20, quota?.limit ?? 20);
  const limit = quota?.limit ?? 20;

  if (plan?.blockedBy === 'expired' || plan?.blockedBy === 'deleted') {
    return (
      <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4">
        <p className="text-sm font-semibold text-red-800">
          {plan.blockedBy === 'deleted' ? '앱이 삭제된 상태입니다. 다시 설치해 주세요.' : '유료 플랜 구독이 만료됐습니다.'}
        </p>
        <p className="mt-1 text-[11px] text-red-700">
          <Store>고도몰 앱스토어</Store>에서 리뷰이사 플러스(월 {price.toLocaleString()}원)를 결제하면 다시 이용할 수 있습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-neutral-300 bg-white p-4">
      <p className="text-sm font-medium">
        {used >= limit ? '무료 20건(쇼핑몰당)을 모두 사용했어요' : `무료 ${limit}건 중 ${used}건 사용`}
      </p>
      <div className="mt-3 h-1.5 w-full rounded-full bg-neutral-100">
        <div className="h-1.5 rounded-full bg-black transition-all" style={{ width: `${Math.min(100, Math.round((used / limit) * 100))}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-neutral-500">
        {used >= limit
          ? (
            <>
              <Store>고도몰 앱스토어</Store>에서 리뷰이사 플러스(월 {price.toLocaleString()}원) 결제 후 다시 실행하면 무제한으로 쓸 수 있어요.
            </>
          )
          : '쇼핑몰당 무료 20건까지 옮겨볼 수 있어요. 그 이상은 리뷰이사 플러스(월 9,900원)로 무제한.'}
      </p>
    </div>
  );
}

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [mallName, setMallName] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [goodsError, setGoodsError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productNo, setProductNo] = useState<number | ''>('');
  const [source, setSource] = useState('coupang');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [imports, setImports] = useState<ImportedReview[] | null>(null);
  const [importedError, setImportedError] = useState('');
  const [importedMsg, setImportedMsg] = useState('');
  const [filterProduct, setFilterProduct] = useState<number | ''>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [delBusy, setDelBusy] = useState(false);

  useEffect(() => {
    fetch('/api/goods')
      .then((r) => r.json())
      .then((d) => {
        if (d.mallNo) setMallName(`몰 #${d.mallNo}`);
        if (d.quota) setQuota(d.quota);
        if (d.plan) setPlan(d.plan);
        if (d.goodsError) setGoodsError(d.goodsError);
        if (Array.isArray(d.products)) setProducts(d.products);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadImports = useCallback((productNo: number | '') => {
    setImportedError('');
    setImportedMsg('');
    const q = productNo ? `?product_no=${productNo}` : '';
    fetch(`/api/imports${q}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? '목록을 불러오지 못했습니다.');
        setImports(d.reviews ?? []);
      })
      .catch((e: Error) => {
        setImportedError(e.message);
        setImports([]);
      });
  }, []);

  useEffect(() => {
    // 최초 마운트 시 1회 로드 — 로딩 상태로 시작하는 것이 의도된 동작이다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadImports('');
  }, [loadImports]);

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
      setResult({ quotaExceeded: true, used: json.used, plan: json.plan ?? plan ?? undefined });
      setQuota((q) => (q ? { ...q, used: q.limit } : q));
      if (json.plan) setPlan(json.plan);
    } else {
      setResult(json);
      if (json.plan) setPlan(json.plan);
      if (!dry && typeof json.freeRemaining === 'number')
        setQuota((q) => (q ? { ...q, used: q.limit - json.freeRemaining } : q));
      // 옮기기 성공 — 옮긴 리뷰 목록을 갱신한다 (방금 옮긴 글이 목록에 보여야 함).
      if (!dry && (json.written ?? 0) > 0) {
        setFilterProduct('');
        loadImports('');
      }
    }
    setBusy(false);
  }

  async function deleteImports(snos: number[]) {
    if (!snos.length || delBusy) return;
    setDelBusy(true);
    setImportedMsg('');
    setImportedError('');
    try {
      const res = await fetch('/api/imports', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article_snos: snos }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportedError(json.error ?? '삭제하지 못했습니다.');
        return;
      }
      const deleted: number[] = json.deleted ?? [];
      const failed: { article_sno: number; error: string }[] = json.failed ?? [];
      setImportedMsg(
        failed.length
          ? `삭제 완료 ${deleted.length}건 · 실패 ${failed.length}건 (${failed[0].error})`
          : `삭제 완료 ${deleted.length}건`,
      );
      if (deleted.length) {
        await loadImports(filterProduct);
        setSelected(new Set());
      }
    } finally {
      setDelBusy(false);
    }
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

      {goodsError && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
          상품 목록을 불러오지 못했습니다: {goodsError}
        </p>
      )}

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

      <PlanCard quota={quota} plan={plan} />

      <p className="mt-8 border-t pt-4 text-xs text-neutral-500">
        쇼핑몰당 무료 20건 · 리뷰이사 플러스(무제한) 월 {plan?.price ?? 9900}원{' · '}
        <a href="/privacy" className="underline">개인정보처리방침</a>
      </p>

      {result && (
        <div className="mt-6 rounded bg-neutral-50 p-4 text-sm">
          {result.quotaExceeded ? (
            <PlanCard quota={quota} plan={result.plan ?? plan} />
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

      {/* 리뷰이사가 옮긴 리뷰 관리 — 옮긴 글을 기록해 두고 필터·삭제할 수 있다 */}
      <div className="mt-8 border-t pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">리뷰이사가 옮긴 리뷰 관리</h2>
          <button
            onClick={() => loadImports(filterProduct)}
            className="rounded border px-3 py-1 text-xs hover:bg-neutral-50"
          >
            새로고침
          </button>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          이 배포 이후 옮긴 리뷰만 기록됩니다. 삭제하면 쇼핑몰 게시판에서도 함께 지워집니다.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="rounded border p-1.5 text-xs"
            value={filterProduct}
            onChange={(e) => {
              const v = Number(e.target.value) || '';
              setFilterProduct(v);
              loadImports(v);
            }}
          >
            <option value="">전체 상품</option>
            {products.map((p) => (
              <option key={p.no} value={p.no}>
                [{p.no}] {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              deleteImports(
                (imports ?? [])
                  .filter((r) => r.article_sno != null && selected.has(r.import_key))
                  .map((r) => r.article_sno as number),
              )
            }
            disabled={delBusy || selected.size === 0}
            className="rounded bg-black px-3 py-1.5 text-xs text-white disabled:opacity-40"
          >
            선택 삭제 ({selected.size})
          </button>
          <button
            onClick={() => {
              const snos = (imports ?? [])
                .filter((r) => r.article_sno != null)
                .map((r) => r.article_sno as number);
              if (
                !snos.length ||
                !window.confirm('현재 목록의 리뷰를 모두 삭제할까요? 쇼핑몰 게시판에서도 함께 삭제됩니다.')
              )
                return;
              deleteImports(snos);
            }}
            disabled={delBusy || !(imports ?? []).some((r) => r.article_sno != null)}
            className="rounded border px-3 py-1.5 text-xs text-red-600 disabled:opacity-40"
          >
            전체 삭제
          </button>
          {delBusy && <span className="text-xs text-neutral-500">삭제하는 중…</span>}
        </div>

        {importedError && <p className="mt-2 text-xs text-red-600">{importedError}</p>}
        {importedMsg && <p className="mt-2 text-xs text-neutral-600">{importedMsg}</p>}

        {imports === null ? (
          <p className="mt-3 text-xs text-neutral-400">목록을 불러오는 중입니다…</p>
        ) : imports.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400">
            기록된 리뷰가 없습니다. (이 배포 이후 옮긴 리뷰부터 표시됩니다)
          </p>
        ) : (
          <ul className="mt-3 max-h-72 space-y-1.5 overflow-y-auto text-xs">
            {imports.map((r) => {
              const pname = products.find((p) => p.no === r.goods_no)?.name ?? `상품 ${r.goods_no}`;
              const confirmed = r.article_sno != null;
              return (
                <li key={r.import_key} className="flex items-start gap-2 rounded border bg-white p-2">
                  <input
                    type="checkbox"
                    checked={selected.has(r.import_key)}
                    disabled={!confirmed}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(r.import_key);
                        else next.delete(r.import_key);
                        return next;
                      })
                    }
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-neutral-800">
                      <span className="font-medium">{pname}</span>
                      <span className="text-amber-500"> ★{r.score}</span>
                      {' · '}
                      <span>{r.writer}</span>
                    </div>
                    <div className="mt-0.5 text-neutral-400">
                      {confirmed ? `글번호 ${r.article_sno}` : '등록 확인 안 됨 (게시판 반영 전)'}
                      {r.created_date ? ` · 원 작성일 ${r.created_date}` : ''}
                      {' · '}옮긴 시각 {new Date(r.imported_at).toLocaleString('ko-KR')}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
