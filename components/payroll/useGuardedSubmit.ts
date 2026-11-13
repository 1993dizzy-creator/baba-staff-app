"use client";
import { useCallback, useLayoutEffect, useRef, type FormEvent } from "react";

/**
 * 폼 제출을 한 번에 하나만 실행한다(급여 설정 카드 공용).
 * 더블 클릭·Enter 연타는 saving 상태가 화면에 반영되기 전에 두 번째 submit을 보낼 수 있으므로,
 * 진행 중이면 ref로 즉시 막아 같은 저장 POST가 두 번 나가지 않게 한다. 기본 제출(페이지 이동)은 항상 막는다.
 */
export function useGuardedSubmit(save: (event: FormEvent) => Promise<void>) {
  const busyRef = useRef(false);
  const saveRef = useRef(save);
  useLayoutEffect(() => { saveRef.current = save; });
  return useCallback((event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    void saveRef.current(event).finally(() => { busyRef.current = false; });
  }, []);
}
