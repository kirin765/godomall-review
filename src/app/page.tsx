import { redirect } from 'next/navigation';
import { sessionMall } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** godomall 앱 실행 진입점. 쇼핑몰 관리자가 실행하면 루트가 ?code=...&solution=godomall로 열린다. */
export default async function Home({ searchParams }: { searchParams: Promise<{ code?: string; solution?: string }> }) {
  const sp = await searchParams;

  if (sp.code && sp.solution === 'godomall') {
    redirect(`/api/auth/launch?code=${encodeURIComponent(sp.code)}&solution=godomall`);
  }

  const mallNo = await sessionMall();
  if (mallNo) redirect('/admin');

  return (
    <main className="mx-auto max-w-xl p-8 font-sans">
      <h1 className="text-xl font-semibold">리뷰이사</h1>
      <p className="mt-2 text-sm text-neutral-600">
        쿠팡·네이버 스마트스토어 구매평을 고도몰 상품 후기로 한 번에 옮깁니다.
      </p>

      <div className="mt-6 rounded border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
        고도몰 쇼핑몰 관리자에서 <b>앱 서비스 → 설치 리스트</b>에서 이 앱을 실행하면
        이곳으로 연결됩니다.
      </div>

      <ul className="mt-6 space-y-2 text-sm text-neutral-700">
        <li>① 리뷰 엑셀을 준비합니다 — 판매처에서 받은 구매평 파일 그대로</li>
        <li>② 옮길 상품을 고르고 파일을 올립니다</li>
        <li>③ 미리보기로 확인한 뒤 옮기기를 누르면 고도몰 상품 후기로 등록됩니다</li>
      </ul>

      <p className="mt-8 border-t pt-4 text-xs text-neutral-500">
        <a href="/privacy" className="underline">개인정보처리방침</a>
      </p>
    </main>
  );
}
