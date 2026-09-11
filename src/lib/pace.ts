export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 한 번의 요청 안에서 여러 워커가 공유하는 발화 율 상태. */
export type Pace = {
  /** 다음 호출을 허용할 시각. 워커 몇 개든 슬롯을 줄 때 최소 간격을 둔다. */
  nextSlot: number;
  /** 429 이후 회복되기를 기다릴 시각. 워커들이 함께 여기서 기다린다. */
  cooldownUntil: number;
  /** 슬롯 배정을 직렬화하는 잠금(프라미스 체인). */
  tail: Promise<void>;
};

export const newPace = (): Pace => ({ nextSlot: 0, cooldownUntil: 0, tail: Promise.resolve() });

/**
 * 호출 슬롯을 하나 배정받는다. 최소 간격·429 쿨다운을 함께 기다리고, 대기가 끝난 뒤에도
 * 함수 예산이 남아 있을 때만 true를 돌려준다. (cafe24-review pace.ts 이식)
 */
export async function acquireSlot(p: Pace, deadline: number, minGapMs = 150): Promise<boolean> {
  const run = p.tail.then(async () => {
    const at = Math.max(p.nextSlot, p.cooldownUntil);
    if (at > Date.now()) await sleep(at - Date.now());
    p.nextSlot = Math.max(at, Date.now()) + minGapMs;
  });
  p.tail = run.catch(() => {});
  await run;
  return deadline - Date.now() > 3000;
}
