"use client";
import { useEffect, useRef } from "react";
import type { SubmittedContractSave } from "@/lib/payroll/contract-save-verification";

/**
 * 직원별 급여 설정 패널의 이탈 위험 상태.
 * - input: 저장하지 않은 입력(계약 등록·정정 폼, 식대·개근·보험·세금 폼, 저장 진행 중 포함)
 * - pendingVerification: 급여계약 저장 응답이 유실돼 반영 여부를 아직 확인하지 못함.
 *   이 상태는 직원별로 sessionStorage에 남겨, 다른 화면에 갔다 와도 결과 확인 전에는
 *   새 저장을 막는다(중복 POST·잘못된 성공 판정 방지). 이동 자체는 저장을 다시 보내지 않는다.
 */
export type PayrollUnsavedState = { input: boolean; pendingVerification: boolean };
export const NO_PAYROLL_UNSAVED: PayrollUnsavedState = { input: false, pendingVerification: false };

export function hasPayrollUnsaved(state: PayrollUnsavedState) {
  return state.input || state.pendingVerification;
}

/** 앱 안 이동(직원 전환·화면 이동·영역 접기) 확인 문구. 확인할 것이 없으면 null. */
export function payrollLeaveMessage(state: PayrollUnsavedState, vi: boolean): string | null {
  const lines: string[] = [];
  if (state.input) {
    lines.push(vi
      ? "Có thay đổi lương · phúc lợi chưa lưu. Nếu rời đi, nội dung đã nhập sẽ bị mất."
      : "저장하지 않은 급여·복리후생 입력이 있습니다. 이동하면 입력한 내용이 사라집니다.");
  }
  if (state.pendingVerification) {
    lines.push(vi
      ? "Chưa xác nhận kết quả lưu hợp đồng lương. Rời đi sẽ không lưu lại; khi mở lại cài đặt lương của nhân viên này, bạn có thể tiếp tục kiểm tra kết quả."
      : "급여계약 저장 결과를 아직 확인하지 못했습니다. 이동해도 다시 저장되지 않으며, 이 직원의 급여 설정을 다시 열면 결과 확인을 이어서 할 수 있습니다.");
  }
  if (!lines.length) return null;
  lines.push(vi ? "Vẫn rời đi?" : "이동할까요?");
  return lines.join("\n\n");
}

const PENDING_KEY = (userId: number) => `baba:payroll:pending-contract-save:${userId}`;

export function readPendingContractSave(userId: number): SubmittedContractSave | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SubmittedContractSave;
    return parsed && (parsed.mode === "create" || parsed.mode === "correct") ? parsed : null;
  } catch {
    return null;
  }
}

export function writePendingContractSave(userId: number, submitted: SubmittedContractSave | null) {
  try {
    if (submitted) window.sessionStorage.setItem(PENDING_KEY(userId), JSON.stringify(submitted));
    else window.sessionStorage.removeItem(PENDING_KEY(userId));
  } catch {
    // 저장소를 쓸 수 없으면 화면 상태의 보호(같은 화면 안)만 유지된다.
  }
}

/**
 * 브라우저 새로고침·창 닫기(beforeunload)와 화면 안의 일반 링크 클릭(메뉴 등)에서 확인을 받는다.
 * 히스토리를 조작하지 않으므로 브라우저 뒤로가기는 가로채지 않는다.
 */
export function useLeaveGuard(message: string | null) {
  const messageRef = useRef(message);
  useEffect(() => { messageRef.current = message; });
  const active = message !== null;
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const linkClick = (event: MouseEvent) => {
      const current = messageRef.current;
      if (!current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
      if (!window.confirm(current)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", linkClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", linkClick, true);
    };
  }, [active]);
}
