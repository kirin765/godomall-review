This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## 결제 (Paddle Billing)

리뷰이사 플러스(월 9,900원, 부가세 포함)는 **Paddle Billing** 호스티드 체크아웃(Paddle.js overlay)으로 수신한다.

- 관리 화면(`/admin`)의 `PlanCard` → `PaddlePay` 컴포넌트가 `/api/goods`의 `plan.payment` 설정으로 결제 버튼을 렌더링한다.
- 결제 완료/구독 갱신은 웹훅 `POST /api/payment/paddle/webhook`으로 통보받아
  `custom_data.mallNo`로 몰을 식별 → workspace 만료일 연장 + `app_subscriptions` 기록 → 무제한 전환한다.
- Paddle 대시보드 > Developer tools > Notifications에서 위 웹훅 URL을 destination으로 등록하고
  `subscription.created`·`subscription.activated`·`subscription.updated`·`subscription.canceled`·`transaction.completed`를 구독한다.

필요한 환경변수:

| 변수 | 설명 |
| --- | --- |
| `PADDLE_ENV` | `sandbox`(기본) 또는 `production` |
| `PADDLE_CLIENT_TOKEN` | Paddle.js client-side 토큰 (공개 가능) |
| `PADDLE_PRICE_ID` | 리뷰이사 플러스 가격 ID (`pri_…`) |
| `PADDLE_WEBHOOK_SECRET` | 웹훅 서명 검증 시크릿 (`pdl_ntfset_…`, 서버 전용) |
| `PADDLE_API_KEY` | 서버 API 키 (`pdl_live_…`/`pdl_sdbx_…`, 서버 전용) |
| `PADDLE_CURRENCY` | 표시 통화 (기본 `KRW`) |

값이 비어 있으면 관리 화면은 결제 버튼 대신 판매사 문의 안내를 보여준다(결제 비활성).

## 고객지원 챗봇 (AI)

모든 페이지 우측 하단의 채팅 버튼과 [`/support`](http://localhost:3000/support) 페이지에
고객지원 AI 챗봇이 붙어 있다.

- 엔드포인트: `POST /api/chat` — OpenRouter(OpenAI 호환) Chat Completions 스트리밍을 `{"text": ...}` SSE로 흘려보낸다
- 지식 베이스: [`src/lib/chat/knowledge.ts`](src/lib/chat/knowledge.ts) — 앱 소개·이용 방법·규칙을
  수정하면 프롬프트에 반영된다 (빌드 불필요, 글만 고치면 됨)
- 설정: `OPENROUTER_API_KEY` 필수, `OPENROUTER_MODEL`(기본 `openai/gpt-4o-mini`) 선택.
  키가 없으면 챗봇은 503을 반환하고 화면에는 이메일 안내가 대신 보인다
- UI: `src/components/chat/ChatPanel.tsx`(패널 본체) + `ChatWidget.tsx`(플로팅 버튼)

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
