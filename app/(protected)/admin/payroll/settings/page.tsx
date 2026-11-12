"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import PayrollCommonSettings from "@/components/payroll/PayrollCommonSettings";
import EmployeePayrollSettingsPanel from "@/components/payroll/EmployeePayrollSettingsPanel";
import { usePayrollContracts } from "@/components/payroll/usePayrollContracts";
import { NO_PAYROLL_UNSAVED, payrollLeaveMessage, useLeaveGuard, type PayrollUnsavedState } from "@/components/payroll/payrollUnsaved";
import { resolveSettingsSummaryReference } from "@/lib/payroll/settings-summary";
import { useLanguage } from "@/lib/language-context";
import {
  partLabel,
  type PayrollUiLang,
} from "@/lib/payroll/ui-labels";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";
import { comparePayrollEmployees } from "@/lib/payroll/employee-sort";
import { ui } from "@/lib/styles/ui";
import { getEmployeeRoleLabel } from "@/lib/common/roles";
type User = {
  id: number;
  name: string | null;
  username: string;
  part: string | null;
  position: string | null;
  role: string | null;
  attendanceTrackingEnabled: boolean;
  levelInfo: EmployeeLevelInfo;
};

export default function PayrollSettingsPage() {
  const { lang } = useLanguage();
  const l = lang as PayrollUiLang;
  const vi = lang === "vi";
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tabParam = params.get("tab");
  const requestedUserIdParam = params.get("userId");
  const activeTab: "common" | "employee" =
    tabParam === "common" || tabParam === "employee"
      ? tabParam
      : params.has("userId")
        ? "employee"
        : "common";
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");
  const [usersReloadKey, setUsersReloadKey] = useState(0);
  const [employeeListOpen, setEmployeeListOpen] = useState(true);
  const [scrollRequestVersion, setScrollRequestVersion] = useState(0);
  const [userId, setUserId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // 선택 직원 패널의 첫 조회 완료 여부와 미확정 계약 편집(등록·정정 창, 저장 결과 확인 대기) 여부.
  const [panelSettled, setPanelSettled] = useState<{ userId: number; settled: boolean } | null>(null);
  const [panelUnsaved, setPanelUnsavedState] = useState<PayrollUnsavedState>(NO_PAYROLL_UNSAVED);
  // 이탈 확인은 패널이 알린 최신 값(ref)으로 한다. 입력 직후의 이동도 다음 렌더를 기다리지 않고 판단한다.
  const panelUnsavedRef = useRef<PayrollUnsavedState>(NO_PAYROLL_UNSAVED);
  const setPanelUnsaved = useCallback((state: PayrollUnsavedState) => {
    panelUnsavedRef.current = state;
    setPanelUnsavedState(state);
  }, []);
  const employeeSettingsRef = useRef<HTMLDivElement>(null);
  const pendingScrollUserIdRef = useRef<number | null>(null);
  // 계약 조회는 선택 직원 1명만, 직원 탭에서만 한다(공용 훅: 직원 변경 시 이전 요청 중단·늦은 응답 무시).
  const contractsSource = usePayrollContracts(activeTab === "employee" ? userId : null);
  // 선택 직원 패널의 미저장 입력·저장 결과 확인 대기. 없으면 null(경고 없음).
  const leaveMessage = payrollLeaveMessage(panelUnsaved, vi);
  const latestLeaveMessage = () => payrollLeaveMessage(panelUnsavedRef.current, vi);
  const confirmLeave = () => {
    const message = latestLeaveMessage();
    return message === null || window.confirm(message);
  };
  useLeaveGuard(leaveMessage, latestLeaveMessage);
  function changeTab(tab: "common" | "employee") {
    // 공통 탭으로 가면 직원 패널이 사라지므로 미저장 입력을 먼저 확인한다.
    if (tab !== activeTab && !confirmLeave()) return;
    const next = new URLSearchParams(params.toString());
    next.set("tab", tab);
    router.replace(`${pathname}?${next}`, { scroll: false });
  }
  function selectUser(id: number) {
    if (id !== userId && !confirmLeave()) return;
    pendingScrollUserIdRef.current = id;
    setScrollRequestVersion((version) => version + 1);
    setEmployeeListOpen(false);
    setUserId(id);
    const next = new URLSearchParams(params.toString());
    next.set("tab", "employee");
    next.set("userId", String(id));
    router.replace(`${pathname}?${next}`, { scroll: false });
  }
  useEffect(() => {
    if (activeTab !== "employee") return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- unchanged bootstrap moved from the pre-2차 page; React Compiler now analyzes this smaller component.
    setUsersLoading(true);
    setUsersError("");
    // HTTP 오류·잘못된 응답은 "직원 0명"이 아니라 조회 실패로 표시한다.
    void fetch("/api/admin/payroll/users", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || data.ok === false || !Array.isArray(data.users)) throw new Error("PAYROLL_USERS_READ_FAILED");
        return data.users as User[];
      })
      .then((loadedUsers) => {
        if (active) setUsers(loadedUsers.sort(comparePayrollEmployees));
      })
      .catch(() => {
        if (active)
          setUsersError(
            vi
              ? "Không thể tải danh sách nhân viên."
              : "직원 목록을 불러오지 못했습니다.",
          );
      })
      .finally(() => {
        if (active) setUsersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeTab, vi, usersReloadKey]);
  useEffect(() => {
    if (activeTab !== "employee" || usersLoading) return;
    const requested = Number(requestedUserIdParam);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- unchanged bootstrap moved from the pre-2차 page; React Compiler now analyzes this smaller component.
    setUserId(Number.isSafeInteger(requested) && users.some((user) => user.id === requested) ? requested : null);
  }, [activeTab, requestedUserIdParam, users, usersLoading]);
  const positionLabel = useCallback(
    (user: User) => (user.role ? getEmployeeRoleLabel(user.role, l) : user.username),
    [l],
  );
  const employeeMetaLabel = useCallback((user: User) => {
    const displayedPart = user.part ? partLabel(l, user.part) : "";
    const displayedPosition = user.role ? positionLabel(user) : "";
    const values = [displayedPart, displayedPosition].filter((value, index, all) => value && all.indexOf(value) === index);
    return values.join(" · ") || user.username;
  }, [l, positionLabel]);
  const visible = useMemo(
    () =>
      users.filter((user) =>
        `${user.name ?? ""} ${user.username} ${user.part ?? ""} ${user.role ?? ""} ${employeeMetaLabel(user)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ).sort(comparePayrollEmployees),
    [employeeMetaLabel, query, users],
  );
  const selected = users.find((user) => user.id === userId);
  const selectedId = selected?.id ?? null;
  const vietnamToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  // 급여관리에서 월(month=YYYY-MM)을 전달받으면 그 월 기준으로 요약한다. 없으면 현재 기준.
  const summaryReference = resolveSettingsSummaryReference(params.get("month"), vietnamToday);
  const selectedPanelSettled = Boolean(selectedId && panelSettled?.userId === selectedId && panelSettled.settled);
  const handlePanelSettled = useCallback((settled: boolean, settledUserId: number) => {
    setPanelSettled({ userId: settledUserId, settled });
  }, []);
  useEffect(() => {
    if (!selectedId || employeeListOpen || !selectedPanelSettled || pendingScrollUserIdRef.current !== selectedId) return;
    const frame = requestAnimationFrame(() => {
      if (pendingScrollUserIdRef.current !== selectedId) return;
      requestAnimationFrame(() => {
        if (pendingScrollUserIdRef.current !== selectedId) return;
        employeeSettingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        pendingScrollUserIdRef.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [employeeListOpen, scrollRequestVersion, selectedId, selectedPanelSettled]);
  function openEmployeeManagement(id: number) {
    if (!confirmLeave()) return;
    // 직원관리에서 이 직원의 상세와 급여·복리후생 영역을 연다(뒤로가기로 이 화면에 돌아온다).
    router.push(`/admin/users?userId=${id}&section=payroll`);
  }
  return (
    <Container noPaddingTop>
      <main style={s.page}>
        <div
          role="tablist"
          aria-label={vi ? "Loại cài đặt lương" : "급여설정 유형"}
          style={s.tabs}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "common"}
            onClick={() => changeTab("common")}
            style={tabStyle(activeTab === "common")}
          >
            {vi ? "Cài đặt chung" : "공통 설정"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "employee"}
            onClick={() => changeTab("employee")}
            style={tabStyle(activeTab === "employee")}
          >
            {vi ? "Cài đặt nhân viên" : "직원 설정"}
          </button>
        </div>

        {activeTab === "common" ? (
          <PayrollCommonSettings vi={vi} />
        ) : (
          <section style={s.section}>
          <section style={s.card}>
            <div style={s.listHeader}>
              <b style={s.listTitle}>
                {usersError ? (vi ? "Danh sách nhân viên" : "직원 목록") : vi ? `Danh sách nhân viên ${users.length} người` : `직원 목록 ${users.length}명`}
                {!employeeListOpen && selected ? <span style={s.selectedSummary}> · {vi ? "Đã chọn" : "선택"}: {selected.name ?? selected.username} · {employeeMetaLabel(selected)}</span> : null}
              </b>
              <button
                type="button"
                style={s.listToggle}
                aria-expanded={employeeListOpen}
                aria-controls="payroll-employee-list"
                onClick={() => setEmployeeListOpen((value) => !value)}
              >
                {employeeListOpen ? (vi ? "Thu gọn ▲" : "접기 ▲") : (vi ? "Mở rộng ▼" : "펼치기 ▼")}
              </button>
            </div>
            {employeeListOpen ? <div id="payroll-employee-list" style={s.listBody}>
              <input
                style={s.input}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={vi ? "Tìm nhân viên" : "직원 검색"}
                aria-label={vi ? "Tìm nhân viên" : "직원 검색"}
              />
              {usersError ? (
              <div role="alert" style={s.error}>
                {usersError}
                <button type="button" style={s.retryButton} disabled={usersLoading} onClick={() => setUsersReloadKey((key) => key + 1)}>{vi ? "Tải lại" : "다시 조회"}</button>
              </div>
            ) : usersLoading ? (
              <p style={s.emptyState}>{vi ? "Đang tải danh sách nhân viên…" : "직원 목록을 불러오는 중입니다…"}</p>
            ) : visible.length === 0 ? (
              <p style={s.emptyState}>{vi ? "Không có nhân viên cần cài đặt lương." : "급여 설정 대상 직원이 없습니다."}</p>
            ) : (
              <div style={s.people}>
                {visible.map((user) => {
                  const selectedUser = user.id === userId;
                  return (
                    <button
                      key={user.id}
                      type="button"
                      style={selectedUser ? { ...s.person, ...s.personSelected } : s.person}
                      aria-pressed={selectedUser}
                      onClick={() => selectUser(user.id)}
                    >
                      <span style={s.personIdentity}>
                        <EmployeeNameWithLevel
                          name={user.name ?? user.username}
                          levelInfo={user.levelInfo}
                          lang={lang}
                          showDisabledBadge
                          nameStyle={s.personName}
                        />
                        <small style={s.personMeta}>{employeeMetaLabel(user)}</small>
                      </span>
                      <span style={selectedUser ? s.selectedLabel : s.selectMark}>
                        {selectedUser ? (vi ? "Đã chọn" : "선택됨") : "›"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}</div> : null}
          </section>

          {!selected ? (
            <p style={s.emptyState}>
              {vi
                ? "Chọn nhân viên để xem cài đặt lương."
                : "직원을 선택하면 급여 설정을 확인할 수 있습니다."}
            </p>
          ) : (
            <div ref={employeeSettingsRef} style={s.employeeSettings}>
              <EmployeePayrollSettingsPanel
                key={selected.id}
                user={selected}
                lang={l}
                contracts={contractsSource}
                summaryReference={summaryReference}
                metaLabel={employeeMetaLabel(selected)}
                headerAction={
                  <button type="button" style={s.usersLink} onClick={() => openEmployeeManagement(selected.id)}>
                    {vi ? "Đến quản lý nhân viên" : "직원관리로 이동"} →
                  </button>
                }
                onSettledChange={handlePanelSettled}
                onUnsavedChange={setPanelUnsaved}
              />
            </div>
          )}
          </section>
        )}
      </main>
    </Container>
  );
}

const s = {
  page: { display: "grid", gap: 8, padding: "8px 0 30px", minWidth: 0 },
  tabs: { ...ui.card, padding: 4, marginBottom: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  section: { display: "grid", gap: 9, minWidth: 0 },
  card: {
    padding: 13,
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    background: "#fff",
    display: "grid",
    gap: 9,
    minWidth: 0,
  },
  error: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 },
  retryButton: { display: "block", minHeight: 30, marginTop: 6, padding: "4px 10px", border: "1px solid #fca5a5", borderRadius: 8, background: "#fff", color: "#b91c1c", fontSize: 12, fontWeight: 800 },
  emptyState: { margin: 0, padding: "10px 11px", border: "1px dashed #d1d5db", borderRadius: 10, color: "#6b7280", fontSize: 12, textAlign: "center" },
  input: {
    width: "100%",
    minHeight: 40,
    padding: "8px 9px",
    border: "1px solid #d1d5db",
    borderRadius: 10,
  },
  people: {
    display: "grid",
    gap: 6,
    maxHeight: 360,
    overflowY: "auto",
    overflowX: "hidden",
  },
  listHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 },
  listTitle: { minWidth: 0, fontSize: 13, overflowWrap: "anywhere" },
  selectedSummary: { color: "#4b5563", fontWeight: 600 },
  listToggle: { flexShrink: 0, minHeight: 34, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", color: "#374151", fontSize: 12, fontWeight: 800 },
  listBody: { display: "grid", gap: 9, minWidth: 0 },
  person: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 52,
    padding: "9px 10px",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#fff",
    textAlign: "left",
    alignItems: "center",
    minWidth: 0,
    color: "#111827",
  },
  personSelected: { border: "1px solid #2563eb", background: "#eff6ff" },
  personIdentity: { display: "grid", gap: 3, minWidth: 0 },
  personName: { fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  personMeta: { color: "#6b7280", fontSize: 12, whiteSpace: "normal", overflowWrap: "anywhere" },
  selectedLabel: { flexShrink: 0, color: "#1d4ed8", fontSize: 12, fontWeight: 900 },
  selectMark: { flexShrink: 0, color: "#9ca3af", fontSize: 20 },
  employeeSettings: { minWidth: 0, scrollMarginTop: 72 },
  usersLink: { flexShrink: 0, minHeight: 32, padding: "5px 10px", border: "1px solid #c7d2fe", borderRadius: 999, background: "#eef2ff", color: "#3730a3", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer" },
} satisfies Record<string, CSSProperties>;


function tabStyle(active: boolean): CSSProperties {
  return {
    minHeight: 36,
    border: active ? "1px solid #93c5fd" : "1px solid transparent",
    borderRadius: 8,
    background: active ? "#eff6ff" : "transparent",
    color: active ? "#1d4ed8" : "#6b7280",
    fontSize: 13,
    fontWeight: 900,
    cursor: "pointer",
  };
}
