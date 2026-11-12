"use client";
import { useEffect, useRef } from "react";

/**
 * 직원별 급여 설정 카드(식대·개근·보험·세금)의 미저장 입력 여부를 상위(공용 패널)에 알린다.
 * 값이 바뀔 때만 알리고, 카드가 사라지면(직원 변경·영역 접기) false로 되돌려
 * 이전 직원의 미저장 상태가 남지 않게 한다.
 */
export function useReportDirty(dirty: boolean, onDirtyChange?: (dirty: boolean) => void) {
  const reportRef = useRef(onDirtyChange);
  useEffect(() => { reportRef.current = onDirtyChange; });
  useEffect(() => { reportRef.current?.(dirty); }, [dirty]);
  useEffect(() => () => { reportRef.current?.(false); }, []);
}

/** 폼 값이 열었을 때의 기준값과 다른지(키 순서가 같은 단순 값 객체). */
export function formValuesChanged<T extends Record<string, unknown>>(values: T, baseline: T) {
  return Object.keys(baseline).some((key) => values[key] !== baseline[key]);
}
