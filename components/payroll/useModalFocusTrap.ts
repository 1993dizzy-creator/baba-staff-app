"use client";
import { useEffect, type RefObject } from "react";

/**
 * 열린 모달(급여·복리후생 시트, 계약 등록·정정 창 등) 안에 키보드 포커스를 가둔다.
 * - 여러 모달이 겹치면 최상단 모달만 Tab/Shift+Tab을 순환시킨다. 최상단은 다른 모달을 품지 않은 가장 안쪽 모달이고,
 *   네이티브 `<dialog>`(showModal, 예: 레벨 설정)가 열려 있으면 그 dialog가 최상단이다.
 * - 포커스가 최상단 모달 밖(배경)으로 나가면 모달 안으로 되돌린다. body 전체 inert는 쓰지 않는다.
 * - 모달이 닫히면 열기 전에 포커스가 있던 요소로 되돌리고, 그 요소가 사라졌으면 다음 최상단 모달 안으로 옮긴다.
 * - 마지막 모달이 닫히면 문서 이벤트 리스너를 모두 해제한다.
 */
const stack: HTMLElement[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function openNativeDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>("dialog[open]");
}

function topModal(): HTMLElement | null {
  const native = openNativeDialog();
  if (native) return native;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const candidate = stack[i];
    if (!stack.some((other) => other !== candidate && candidate.contains(other))) return candidate;
  }
  return null;
}

/** el이 지금 최상단 모달인지(Escape 처리 등에서 안쪽 모달이 열려 있으면 바깥은 무시하기 위해 사용). */
export function isTopModal(el: HTMLElement | null): boolean {
  return Boolean(el) && topModal() === el;
}

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest("[inert]"));
}

function focusInto(root: HTMLElement, last = false) {
  const items = tabbables(root);
  const target = last ? items[items.length - 1] : items[0];
  (target ?? root).focus();
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const top = topModal();
  if (!top) return;
  const items = tabbables(top);
  const current = document.activeElement;
  if (!items.length) { event.preventDefault(); top.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (!(current instanceof HTMLElement) || !top.contains(current) || current === top) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && current === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && current === last) {
    event.preventDefault();
    first.focus();
  }
}

function onFocusIn(event: FocusEvent) {
  const top = topModal();
  const target = event.target;
  if (!top || !(target instanceof Node) || top.contains(target)) return;
  focusInto(top);
}

export function useModalFocusTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    stack.push(el);
    if (stack.length === 1) {
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("focusin", onFocusIn, true);
    }
    return () => {
      const index = stack.indexOf(el);
      if (index >= 0) stack.splice(index, 1);
      if (!stack.length) {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("focusin", onFocusIn, true);
      }
      const next = topModal();
      if (opener?.isConnected && (!next || next.contains(opener))) opener.focus();
      else if (next) focusInto(next);
    };
  }, [ref]);
}
