"use client";
import { useLayoutEffect, useRef } from "react";

/**
 * 직원별 급여 설정 카드(식대·개근·보험·세금)의 미저장 입력 여부를 상위(공용 패널)에 알린다.
 * 값이 바뀔 때만 알리고, 카드가 사라지면(직원 변경·영역 접기) false로 되돌려
 * 이전 직원의 미저장 상태가 남지 않게 한다.
 *
 * 입력 이벤트로 생긴 렌더의 커밋 단계(layout effect)에서 바로 알린다. 패널·페이지는 이 값을 ref에 즉시 기록하므로,
 * 입력 직후 이어지는 Escape·닫기·이동 이벤트도 최신 미저장 상태로 판단한다(passive effect·후속 렌더를 기다리지 않음).
 */
export function useReportDirty(dirty: boolean, onDirtyChange?: (dirty: boolean) => void) {
  const reportRef = useRef(onDirtyChange);
  useLayoutEffect(() => { reportRef.current = onDirtyChange; });
  useLayoutEffect(() => { reportRef.current?.(dirty); }, [dirty]);
  useLayoutEffect(() => () => { reportRef.current?.(false); }, []);
}

/** 폼 값이 열었을 때의 기준값과 다른지(키 순서가 같은 단순 값 객체). */
export function formValuesChanged<T extends Record<string, unknown>>(values: T, baseline: T) {
  return Object.keys(baseline).some((key) => values[key] !== baseline[key]);
}
