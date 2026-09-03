export const metadata = { title: '개인정보처리방침 — 리뷰이사' };

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl p-8 text-sm leading-7">
      <h1 className="text-lg font-semibold dark:text-neutral-100">개인정보처리방침</h1>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">최종 수정 2026-08-10</p>

      <h2 className="mt-6 font-medium dark:text-neutral-200">1. 수집하는 정보</h2>
      <ul className="mt-1 list-disc pl-5 dark:text-neutral-300">
        <li>쇼핑몰 식별자(mallNo)와 고도몰 접근 토큰</li>
        <li>이용자가 업로드한 구매평의 <b>내용·평점·작성일·옵션</b></li>
        <li>작성자 표기는 <b>마스킹된 형태로만</b> 저장합니다 (예: <code>cher****</code>)</li>
      </ul>

      <h2 className="mt-6 font-medium dark:text-neutral-200">2. 수집하지 않는 정보</h2>
      <p className="dark:text-neutral-300">구매자의 실명·연락처·주소·주문번호는 수집하지 않습니다. 업로드 파일에 포함돼 있어도 저장하지 않습니다.</p>

      <h2 className="mt-6 font-medium dark:text-neutral-200">3. 이용 목적</h2>
      <p className="dark:text-neutral-300">업로드한 구매평을 이용자 본인의 고도몰 쇼핑몰 상품 후기로 옮기는 목적으로만 사용합니다.</p>

      <h2 className="mt-6 font-medium dark:text-neutral-200">4. 보관 및 파기</h2>
      <p className="dark:text-neutral-300">토큰은 앱 삭제 시 지체 없이 파기합니다. 업로드 파일은 처리 후 서버에 남기지 않습니다.</p>

      <h2 className="mt-6 font-medium dark:text-neutral-200">5. 제3자 제공</h2>
      <p className="dark:text-neutral-300">제3자에게 제공하지 않습니다.</p>

      <h2 className="mt-6 font-medium dark:text-neutral-200">6. 문의</h2>
      <p className="dark:text-neutral-300">kwan765@naver.com</p>
    </main>
  );
}
