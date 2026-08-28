import ChatPanel from '@/components/chat/ChatPanel';

export const metadata = { title: '문의하기 — 리뷰이사' };

export default function Support() {
  return (
    <main className="mx-auto max-w-xl p-8 text-sm leading-7">
      <h1 className="text-lg font-semibold">문의하기</h1>
      <p className="mt-2 text-neutral-600">
        설치·이용 중 문제가 있으면 아래 챗봇이나 연락처로 문의 주세요. 영업일 기준 2일 이내에 답변
        드립니다.
      </p>

      <div className="mt-5">
        <ChatPanel title="리뷰이사 고객지원" variant="inline" />
      </div>

      <ul className="mt-6 list-disc pl-5 text-neutral-700">
        <li>이메일: kwan765@naver.com</li>
        <li>판매사: 온누리문방구</li>
      </ul>
      <p className="mt-8 border-t pt-4 text-xs text-neutral-500">
        <a href="/privacy" className="underline">개인정보처리방침</a>
      </p>
    </main>
  );
}