"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { ui } from "@/lib/styles/ui";
import { adminUsersText } from "@/lib/text";
import { attendanceFetch } from "@/lib/auth/client-session";
import { PART_VALUES } from "@/lib/common/parts";
import { EDITABLE_EMPLOYEE_ROLE_VALUES, getEmployeeRoleLabel } from "@/lib/common/roles";
import { GENDER_VALUES, getGenderLabel } from "@/lib/common/genders";
import { hireMonthBase } from "@/lib/employee-level/month";
import { BenefitChoice, m } from "@/components/payroll/BenefitModalParts";
import { useLeaveGuard } from "@/components/payroll/payrollUnsaved";
import { currencyAmount, formatIntegerInput, integerInputDigits } from "@/lib/payroll/contract-form";
import { payrollContractErrorMessage } from "@/lib/payroll/contract-errors";
import { calendarProration } from "@/lib/payroll/first-month-proration";
import {
  attendanceTrackingForPayKind,
  contractMatchesRequest,
  isNewEmployeeHireDate,
  newEmployeeBonusEffectiveMonth,
  newEmployeeContractRequest,
  newEmployeeMealEffectiveFrom,
  type NewEmployeeContractRequest,
  type NewEmployeePayKind,
  type NewEmployeePayUnit,
} from "@/lib/payroll/new-employee-setup";

type CreateResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  user?: { id?: number | string | null } | null;
};

type FormState = {
  username: string;
  password: string;
  name: string;
  full_name: string;
  role: string;
  part: string;
  gender: string;
  birth_date: string;
  hire_date: string;
  work_start_time: string;
  work_end_time: string;
  is_active: boolean;
  level_program_enabled: boolean;
  app_login_enabled: boolean;
  // 급여계약(생성 직후 기존 계약 API로 저장). 근태 사용 여부는 계약 유형에서 정해진다.
  pay_kind: NewEmployeePayKind;
  pay_unit: NewEmployeePayUnit;
  pay_amount: string;
  meal_enabled: boolean;
  bonus_enabled: boolean;
};

const roleOptions = EDITABLE_EMPLOYEE_ROLE_VALUES;
const partOptions = PART_VALUES;
const genders = ["", ...GENDER_VALUES] as const;

const initialForm: FormState = {
  username: "",
  password: "",
  name: "",
  full_name: "",
  role: "staff",
  part: "kitchen",
  gender: "",
  birth_date: "",
  hire_date: "",
  work_start_time: "16:00",
  work_end_time: "01:00",
  is_active: true,
  level_program_enabled: true,
  app_login_enabled: true,
  pay_kind: "monthly",
  pay_unit: "monthly",
  pay_amount: "",
  meal_enabled: false,
  bonus_enabled: false,
};

type AdminUsersPageText = (typeof adminUsersText)[keyof typeof adminUsersText];

// ── 생성 후 단계별 설정(급여계약 → 식대 → 개근 보너스). 단일 트랜잭션은 Migration 없이 불가능하므로
// 기존 API를 순서대로 부르고, 각 단계는 "이미 저장됐는지"를 먼저 확인해 재시도·응답 유실에도 중복 저장하지 않는다.
type StepKey = "contract" | "meal" | "bonus";
type StepStatus = "pending" | "running" | "done" | "failed";
type SetupState = {
  userId: string;
  name: string;
  // payroll: 급여 설정 진행 / owner: 사장 직급(급여 대상 아님) / inactive: 계정 OFF(계약 저장 불가) / noId: 생성 응답에 id 없음
  mode: "payroll" | "owner" | "inactive" | "noId";
  contract: NewEmployeeContractRequest | null;
  meal: { effectiveFrom: string } | null;
  bonus: { effectiveMonth: string } | null;
  status: Partial<Record<StepKey, StepStatus>>;
  errors: Partial<Record<StepKey, string>>;
  proration: { amount: number; days: number; total: number } | null;
};
const SETUP_KEY = "baba:admin-users:create-setup";
const STEP_ORDER: StepKey[] = ["contract", "meal", "bonus"];

function readStoredSetup(): SetupState | null {
  try {
    const raw = window.sessionStorage.getItem(SETUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SetupState;
    return parsed && typeof parsed.userId === "string" && parsed.mode ? parsed : null;
  } catch {
    return null;
  }
}

function storeSetup(setup: SetupState | null) {
  try {
    if (setup) window.sessionStorage.setItem(SETUP_KEY, JSON.stringify(setup));
    else window.sessionStorage.removeItem(SETUP_KEY);
  } catch {
    // 저장소를 못 쓰면 이 화면 안에서만 이어서 설정할 수 있다.
  }
}

function plannedSteps(setup: SetupState) {
  return STEP_ORDER.filter((key) => setup[key] !== null);
}

function setupComplete(setup: SetupState) {
  return setup.mode !== "inactive" && setup.mode !== "noId" && plannedSteps(setup).every((key) => setup.status[key] === "done");
}

async function readJson(response: Response) {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

function vietnamCurrentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

type StepResult = { ok: true } | { ok: false; message: string };

/** 저장 전·실패 후 모두 같은 조회로 확인한다: 같은 값이 있으면 완료, 다른 값이 있으면 충돌(덮어쓰지 않음). */
async function ensureStep<T>(input: {
  read: () => Promise<T[]>;
  matches: (row: T) => boolean;
  write: () => Promise<Response>;
  repairMatching?: (row: T) => boolean;
  conflictMessage: string;
  failureMessage: (data: Record<string, unknown> | null) => string;
}): Promise<StepResult> {
  let rows: T[];
  try {
    rows = await input.read();
  } catch {
    return { ok: false, message: input.failureMessage(null) };
  }
  if (rows.some(input.matches)) return { ok: true };
  if (rows.length > 0 && !rows.every(row => input.repairMatching?.(row))) return { ok: false, message: input.conflictMessage };
  let data: Record<string, unknown> | null = null;
  try {
    const response = await input.write();
    data = await readJson(response);
    if (response.ok && data?.ok === true && !input.repairMatching) return { ok: true };
  } catch {
    data = null;
  }
  // 실패·응답 유실: 서버에 실제로 저장됐는지 다시 조회한다.
  try {
    if ((await input.read()).some(input.matches)) return { ok: true };
  } catch {
    // 확인하지 못하면 실패로 남겨 재시도하게 한다(재시도도 먼저 조회하므로 중복 저장되지 않는다).
  }
  return { ok: false, message: input.failureMessage(data) };
}

async function readHistory<T>(url: string): Promise<T[]> {
  const response = await fetch(url, { cache: "no-store" });
  const data = await readJson(response);
  if (!response.ok || data?.ok !== true) throw new Error("READ_FAILED");
  return (Array.isArray(data.history) ? data.history : []) as T[];
}

async function runStep(key: StepKey, setup: SetupState, lang: "ko" | "vi", text: AdminUsersPageText): Promise<StepResult> {
  const userId = Number(setup.userId);
  const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (key === "contract" && setup.contract) {
    const request = setup.contract;
    return ensureStep<{ payType: string; calculationBasis: string; baseSalary: number; effectiveFrom: string; fixedRaiseAmount:number; standardWorkdays:number|null; firstMonthPolicy?: {status:string;firstContractId:number;hireDate:string;hireDateMatches:boolean;rehired:boolean}; id:number }>({
      read: () => readHistory(`/api/admin/payroll/contracts?userId=${userId}`),
      matches: (contract) => contractMatchesRequest(contract, request) && (!request.firstMonthProration
        || (contract.firstMonthPolicy?.status === "active" && contract.firstMonthPolicy.firstContractId === contract.id
          && contract.firstMonthPolicy.hireDateMatches && !contract.firstMonthPolicy.rehired)),
      write: () => fetch("/api/admin/payroll/contracts", json({ userId, ...request })),
      conflictMessage: text.createStepConflict,
      repairMatching: request.firstMonthProration ? (contract) => contractMatchesRequest(contract, request) : undefined,
      failureMessage: (data) => request.firstMonthProration ? text.createStepConflict : payrollContractErrorMessage(lang, data?.code, "PAYROLL_CONTRACT_CREATE_FAILED"),
    });
  }
  if (key === "meal" && setup.meal) {
    const effectiveFrom = setup.meal.effectiveFrom;
    return ensureStep<{ isEligible: boolean; effectiveFrom: string }>({
      read: () => readHistory(`/api/admin/payroll/meal-allowance/eligibility?userId=${userId}`),
      matches: (row) => row.isEligible === true && row.effectiveFrom === effectiveFrom,
      write: () => fetch("/api/admin/payroll/meal-allowance/eligibility", json({ userId, isEligible: true, effectiveFrom })),
      conflictMessage: text.createStepConflict,
      failureMessage: (data) => data?.code === "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING" ? text.createBenefitFixedOff : text.createStepFailedGeneric,
    });
  }
  if (key === "bonus" && setup.bonus) {
    const effectiveMonth = setup.bonus.effectiveMonth;
    return ensureStep<{ isEligible: boolean; effectiveMonth: string }>({
      read: () => readHistory(`/api/admin/payroll/attendance-bonus/eligibility?userId=${userId}`),
      matches: (row) => row.isEligible === true && row.effectiveMonth === effectiveMonth,
      write: () => fetch("/api/admin/payroll/attendance-bonus/eligibility", json({ userId, isEligible: true, effectiveMonth })),
      conflictMessage: text.createStepConflict,
      failureMessage: (data) => data?.code === "ATTENDANCE_BONUS_REQUIRES_ATTENDANCE_TRACKING" ? text.createBenefitFixedOff : text.createStepFailedGeneric,
    });
  }
  return { ok: true };
}

function getPartLabel(part: string, text: AdminUsersPageText) {
  if (part === "owner") return text.ownerGroup;
  if (part === "kitchen") return text.kitchenGroup;
  if (part === "hall") return text.hallGroup;
  if (part === "bar") return text.barGroup;
  if (part === "cleaning") return text.cleaningGroup;
  if (part === "etc") return text.etcGroup;
  return part;
}

function shiftHours(start: string, end: string) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) return null;
  const minutes = (endHour * 60 + endMinute - startHour * 60 - startMinute + 1440) % 1440;
  return Number((minutes / 60).toFixed(1));
}

function isDirty(form: FormState) {
  return (Object.keys(initialForm) as (keyof FormState)[]).some((key) => form[key] !== initialForm[key]);
}

/** 사장 직급은 급여 대상이 아니고(owner 역할 = 월 고정급 대상), 근태는 기존 기본값(사용)을 유지한다. */
function attendanceFor(form: FormState) {
  return form.role === "owner" ? true : attendanceTrackingForPayKind(form.pay_kind);
}

function payrollApplies(form: FormState) {
  return form.role !== "owner" && form.is_active;
}

/** 직원 생성 API 요청(기존 형식 그대로). 레벨 기준월은 항상 입사월 자동. */
function createPayload(form: FormState, lang: string) {
  return {
    lang,
    username: form.username,
    password: form.password,
    name: form.name,
    full_name: form.full_name,
    role: form.role,
    part: form.part,
    gender: form.gender,
    birth_date: form.birth_date,
    hire_date: form.hire_date,
    work_start_time: form.work_start_time,
    work_end_time: form.work_end_time,
    is_active: form.is_active,
    level_program_enabled: form.level_program_enabled,
    level_base_mode: "hire_month" as const,
    attendance_tracking_enabled: attendanceFor(form),
    first_month_proration: payrollApplies(form) && form.pay_kind === "fixed",
    app_login_enabled: form.app_login_enabled,
  };
}

function planSetup(form: FormState, userId: string | null): SetupState {
  const name = form.name.trim();
  const base = { userId: userId ?? "", name, contract: null, meal: null, bonus: null, status: {}, errors: {}, proration: null };
  if (!userId) return { ...base, mode: "noId" };
  if (form.role === "owner") return { ...base, mode: "owner" };
  if (!form.is_active) return { ...base, mode: "inactive" };
  const amount = Number(form.pay_amount);
  const monthly = form.pay_kind === "monthly";
  const proration = form.pay_kind === "fixed" ? calendarProration(amount, form.hire_date) : null;
  const setup: SetupState = {
    ...base,
    mode: "payroll",
    contract: newEmployeeContractRequest({ kind: form.pay_kind, unit: form.pay_unit, amount, hireDate: form.hire_date }),
    // 고정급(근태 미사용)은 식대·개근 보너스를 저장하지 않는다(화면 값과 무관하게 요청에서 제외).
    meal: monthly && form.meal_enabled ? { effectiveFrom: newEmployeeMealEffectiveFrom(form.hire_date) } : null,
    bonus: monthly && form.bonus_enabled ? { effectiveMonth: newEmployeeBonusEffectiveMonth(form.hire_date, vietnamCurrentMonth()) } : null,
    proration: proration ? { amount: proration.amount, days: proration.employedDays, total: proration.totalDays } : null,
  };
  for (const key of plannedSteps(setup)) setup.status[key] = "pending";
  return setup;
}

function UserNav({ active }: { active: "list" | "create" }) {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const pathname = usePathname();

  return (
    <SubNav
      tabs={[
        {
          href: "/admin/users",
          label: text.listTab,
          active: active === "list" || pathname === "/admin/users",
        },
        {
          href: "/admin/users/create",
          label: text.createTab,
          active: active === "create" || pathname === "/admin/users/create",
        },
      ]}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

// 직원 상세(/admin/users)의 리뉴얼 디자인과 같은 부품: 카드별 은은한 배경 섹션, 제목, 슬라이딩 스위치.
// 값은 직원 상세 styles와 같게 유지한다(tests/admin-users-create-ui.test.ts가 어긋남을 막는다).
const SECTION_TONES = {
  basic: { background: "#f8fafc", borderColor: "#e2e8f0" },
  workPay: { background: "#f0f9ff", borderColor: "#e0f2fe" },
  appAccess: { background: "#f0fdf4", borderColor: "#dcfce7" },
} satisfies Record<string, CSSProperties>;

function Section({ tone, emoji, title, children }: { tone: keyof typeof SECTION_TONES; emoji: string; title: string; children: ReactNode }) {
  return <section style={{ ...styles.detailSection, ...SECTION_TONES[tone] }}>
    <strong style={styles.sectionTitle}><span aria-hidden="true">{emoji}</span>{title}</strong>
    <div style={styles.sectionBody}>{children}</div>
  </section>;
}

function SubsectionTitle({ emoji, children }: { emoji: string; children: ReactNode }) {
  return <strong style={styles.subsectionTitle}><span aria-hidden="true">{emoji}</span>{children}</strong>;
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} style={{ ...styles.toggleRow, ...(disabled ? styles.toggleDisabled : null) }}>
    <span style={styles.toggleLabel}>{label}</span>
    <span style={styles.switchControl}><strong style={styles.switchText}>{checked ? "ON" : "OFF"}</strong>
      <span aria-hidden="true" style={{ ...styles.switchTrack, ...(checked ? styles.switchTrackOn : null) }}>
        <span style={{ ...styles.switchKnob, ...(checked ? styles.switchKnobOn : null) }} />
      </span>
    </span>
  </button>;
}

export default function AdminUserCreatePage() {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const vi = lang === "vi";
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [canAccess, setCanAccess] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [setup, setSetup] = useState<SetupState | null>(null);
  // 생성·설정 요청은 한 번에 하나만 보낸다(더블 클릭·연타가 isSaving 반영 전에 두 번째 POST를 보내지 않게).
  const submitting = useRef(false);
  // 생성 응답이 유실된 로그인 ID. 같은 ID로 다시 시도해 409가 나면 이미 생성됐는지 확인한다.
  const ambiguousCreate = useRef<string | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const hours = shiftHours(form.work_start_time, form.work_end_time);
  const autoBaseMonth = hireMonthBase(form.hire_date);
  const attendance = attendanceFor(form);
  const applies = payrollApplies(form);
  const monthlyPay = form.pay_kind === "monthly";
  const hireValid = isNewEmployeeHireDate(form.hire_date);
  const amount = Number(form.pay_amount || 0);
  const contractPreview = applies && hireValid ? newEmployeeContractRequest({ kind: form.pay_kind, unit: form.pay_unit, amount, hireDate: form.hire_date }) : null;
  const prorationPreview = applies && hireValid && form.pay_kind === "fixed" && amount > 0 ? calendarProration(amount, form.hire_date) : null;

  // 등록 전 입력, 또는 생성 후 설정이 끝나지 않은 경우 메뉴 링크·새로고침·창 닫기에서 확인한다.
  const leaveFor = (currentSetup: SetupState | null, currentForm: FormState) =>
    currentSetup ? (setupComplete(currentSetup) || currentSetup.mode !== "payroll" ? null : text.createSetupLeaveConfirm)
      : isDirty(currentForm) ? text.createLeaveConfirm : null;
  useLeaveGuard(leaveFor(setup, form), () => leaveFor(setupRef.current, formRef.current));

  useEffect(() => {
    const user = getUser();
    if (user?.role === "leader") {
      router.replace("/admin");
      return;
    }
    setCanAccess(isAdmin(user));
    setChecked(true);
    // 새로고침·이동 후 돌아와도 끝나지 않은 설정을 이어서 할 수 있다.
    const stored = readStoredSetup();
    if (stored) setSetup(stored);
  }, [router]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function setPayKind(kind: NewEmployeePayKind) {
    // 고정급은 근태 미사용이라 식대·개근 보너스를 끈다. 월급제로 바꿔도 자동으로 켜지 않는다.
    setForm((current) => ({ ...current, pay_kind: kind, ...(kind === "fixed" ? { meal_enabled: false, bonus_enabled: false } : null) }));
  }

  async function runSetup(start: SetupState) {
    let current: SetupState = { ...start, status: { ...start.status }, errors: { ...start.errors } };
    for (const key of plannedSteps(current)) {
      if (current.status[key] === "done") continue;
      current = { ...current, status: { ...current.status, [key]: "running" }, errors: { ...current.errors, [key]: undefined } };
      setSetup(current);
      const result = await runStep(key, current, lang, text);
      current = {
        ...current,
        status: { ...current.status, [key]: result.ok ? "done" : "failed" },
        errors: { ...current.errors, [key]: result.ok ? undefined : result.message },
      };
      setSetup(current);
      storeSetup(current);
    }
    if (setupComplete(current) || current.mode !== "payroll") storeSetup(current);
    return current;
  }

  async function findCreatedUser(payload: ReturnType<typeof createPayload>) {
    try {
      const response = await attendanceFetch("/api/admin/users");
      const data = await readJson(response);
      const users = Array.isArray(data?.users) ? data.users as Array<Record<string, unknown>> : [];
      const found = users.find((user) => user.username === payload.username.trim() && user.name === payload.name.trim() && user.hire_date === payload.hire_date);
      return found ? String(found.id) : null;
    } catch {
      return null;
    }
  }

  async function submit() {
    if (submitting.current) return;
    if (!form.username.trim() || !form.password.trim() || !form.name.trim()) {
      setMessage(text.required);
      return;
    }
    // 입사일은 레벨 적용 여부와 관계없이 필수(생성 RPC 조건).
    if (!hireValid) {
      setMessage(text.createHireDateRequired);
      return;
    }
    if (attendance && (!form.work_start_time || !form.work_end_time)) {
      setMessage(text.workTimeRequiredForTracking);
      return;
    }
    if (applies && !(amount > 0)) {
      setMessage(text.createAmountRequired);
      return;
    }

    submitting.current = true;
    setIsSaving(true);
    setMessage("");
    const payload = createPayload(form, lang);

    try {
      let userId: string | null = null;
      let response: Response | null = null;
      let result: CreateResponse | null = null;
      try {
        response = await attendanceFetch("/api/admin/users/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        result = await readJson(response) as CreateResponse | null;
      } catch {
        response = null;
      }

      if (response && result?.ok) {
        const id = result.user?.id;
        userId = id === undefined || id === null || id === "" ? null : String(id);
      } else if (response && result && !(response.status === 409 && ambiguousCreate.current === payload.username.trim())) {
        // 409(중복 ID)는 서버의 영문 오류 대신 화면 언어의 안내를 보여 준다.
        throw new Error(response.status === 409 ? text.duplicateUsername : result.error || text.createFailed);
      } else {
        // 응답 유실(또는 유실 뒤 재시도의 409): 이미 생성됐는지 직원 목록으로 확인한다. 확인 못 하면 생성하지 않은 것으로 본다.
        ambiguousCreate.current = payload.username.trim();
        userId = await findCreatedUser(payload);
        if (!userId) throw new Error(text.createFailed);
      }

      ambiguousCreate.current = null;
      const planned = planSetup(form, userId);
      storeSetup(planned);
      setSetup(planned);
      setForm(initialForm);
      if (planned.mode === "payroll") await runSetup(planned);
    } catch (error) {
      // 실패 시 입력값은 그대로 둔다.
      setMessage(error instanceof Error ? error.message : text.createFailed);
    } finally {
      submitting.current = false;
      setIsSaving(false);
    }
  }

  async function retrySetup() {
    if (submitting.current || !setup) return;
    submitting.current = true;
    setIsSaving(true);
    try {
      await runSetup(setup);
    } finally {
      submitting.current = false;
      setIsSaving(false);
    }
  }

  function closeSetup(next: "detail" | "another") {
    const current = setup;
    storeSetup(null);
    setSetup(null);
    setMessage("");
    if (next === "detail" && current) router.push(current.userId ? `/admin/users?userId=${encodeURIComponent(current.userId)}&section=payroll` : "/admin/users");
  }

  if (checked && !canAccess) {
    return (
      <Container noPaddingTop>
        <UserNav active="create" />
        <section style={styles.notice}>{text.noPermission}</section>
      </Container>
    );
  }

  if (setup) {
    const complete = setupComplete(setup);
    const stepLabel: Record<StepKey, string> = { contract: text.createStepContract, meal: text.benefitMeal, bonus: text.benefitBonus };
    const statusLabel = (status: StepStatus | undefined) => status === "done" ? text.createStepDone : status === "failed" ? text.createStepFailed : status === "running" ? text.createStepRunning : text.createStepPending;
    const incompletePayroll = setup.mode === "payroll" && !complete;
    return (
      <Container noPaddingTop>
        <UserNav active="create" />
        <section style={styles.card}>
          <section role="status" style={{ ...styles.detailSection, ...(incompletePayroll || setup.mode === "inactive" ? styles.warnTone : SECTION_TONES.appAccess) }}>
            <strong style={styles.sectionTitle}><span aria-hidden="true">{incompletePayroll ? "⚠️" : "✅"}</span>{incompletePayroll ? text.createSetupIncompleteTitle : text.createSuccess}</strong>
            {/* 진행 중·일부 실패는 아래 단계 목록이 저장 상태를 보여 준다(일부 저장된 항목을 "미설정"이라 하지 않음). */}
            {incompletePayroll ? null : <p style={styles.successText}>
              {setup.mode === "payroll" ? text.createdComplete.replace("{name}", setup.name) : text.createdNextStep.replace("{name}", setup.name)}
            </p>}
            {setup.mode === "owner" ? <p style={styles.modalHint}>{text.createOwnerNoPayroll}</p> : null}
            {setup.mode === "inactive" ? <p style={styles.modalHint}>{text.createInactiveNoPayroll}</p> : null}
            {setup.mode === "payroll" ? <ul style={styles.stepList} aria-label={text.createStepContract}>
              <li style={styles.stepRow}><span>{text.createStepEmployee}</span><b style={styles.stepDone}>{text.createStepDone}</b></li>
              {plannedSteps(setup).map((key) => <li key={key} style={styles.stepRow}>
                <span>{stepLabel[key]}</span>
                <b style={setup.status[key] === "done" ? styles.stepDone : setup.status[key] === "failed" ? styles.stepFailed : styles.stepPending}>{statusLabel(setup.status[key])}</b>
                {setup.errors[key] ? <span role="alert" style={styles.stepError}>{setup.errors[key]}</span> : null}
              </li>)}
            </ul> : null}
            {incompletePayroll ? <p style={styles.modalHint}>{text.createSetupIncompleteHelp}</p> : null}
            {setup.mode === "payroll" && setup.contract?.firstMonthProration && setup.proration && setup.status.contract === "done" ? <p style={styles.prorationNotice}>
              {text.createFixedProrationNotice.replace("{amount}", currencyAmount(setup.proration.amount, vi)).replace("{days}", String(setup.proration.days)).replace("{total}", String(setup.proration.total))}
            </p> : null}
            {setup.mode === "payroll" ? <p style={styles.modalHint}>{text.createPayrollNote}</p> : null}
          </section>
          {incompletePayroll ? <div style={styles.actionRow}>
            <button type="button" style={styles.secondaryAction} disabled={isSaving} onClick={() => closeSetup("detail")}>{text.createSetupOpenDetail}</button>
            <button type="button" style={styles.createButton} disabled={isSaving} onClick={retrySetup}>{isSaving ? text.createStepRunning : text.createSetupRetry}</button>
          </div> : <div style={styles.actionRow}>
            <button type="button" style={styles.secondaryAction} onClick={() => closeSetup("another")}>{text.createAnother}</button>
            <button type="button" style={styles.createButton} onClick={() => closeSetup("detail")}>{setup.mode === "payroll" ? text.createOpenDetail : text.createOpenPayroll}</button>
          </div>}
        </section>
      </Container>
    );
  }

  return (
    <Container noPaddingTop>
      <UserNav active="create" />

      {/* 제목은 상단 탭(직원 생성)과 같아 카드 머리글을 두지 않는다(모바일 세로 길이 절약). */}
      <section style={styles.card} aria-label={text.createTab}>
        <fieldset disabled={isSaving} style={styles.sections}>
          {/* ① 기본정보 */}
          <Section tone="basic" emoji="🪪" title={text.basicInfo}>
            <div style={styles.fieldRow2}>
              <Field label={text.name}>
                <input
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  style={styles.input}
                />
              </Field>
              <Field label={text.fullName}>
                <input
                  value={form.full_name}
                  onChange={(event) => update("full_name", event.target.value)}
                  style={styles.input}
                />
              </Field>
            </div>
            <div style={styles.fieldRow2}>
              <Field label={text.role}>
                <select
                  value={form.role}
                  onChange={(event) => {
                    const role = event.target.value;
                    setForm((current) => ({
                      ...current,
                      role,
                      level_program_enabled: role !== "owner",
                    }));
                  }}
                  style={styles.input}
                >
                  {roleOptions.map((role) => (
                    <option key={role} value={role}>
                      {getEmployeeRoleLabel(role, lang)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={text.part}>
                <select
                  value={form.part}
                  onChange={(event) => update("part", event.target.value)}
                  style={styles.input}
                >
                  {partOptions.map((part) => (
                    <option key={part} value={part}>
                      {getPartLabel(part, text)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <span style={styles.helpText}>{text.roleFieldHelp}</span>
            <div style={styles.fieldRow2}>
              <Field label={text.gender}>
                <select
                  value={form.gender}
                  onChange={(event) => update("gender", event.target.value)}
                  style={styles.input}
                >
                  {genders.map((gender) => (
                    <option key={gender || "none"} value={gender}>
                      {getGenderLabel(gender, lang)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={text.birthDate}>
                <input
                  type="date"
                  value={form.birth_date}
                  onChange={(event) => update("birth_date", event.target.value)}
                  style={styles.input}
                />
              </Field>
            </div>
          </Section>

          {/* ② 근무·급여 */}
          <Section tone="workPay" emoji="⏰" title={text.workPayInfo}>
            <Field label={text.hireDate}>
              <input
                type="date"
                required
                value={form.hire_date}
                onChange={(event) => update("hire_date", event.target.value)}
                style={styles.input}
              />
            </Field>

            {/* 💰 급여계약: 고정급 / 월급제. 근태 기록 사용 여부는 유형에서 자동으로 정해진다(독립 스위치 없음). */}
            <div style={styles.subsection}>
              <SubsectionTitle emoji="💰">{text.payrollContract}</SubsectionTitle>
              {form.role === "owner" ? <span style={styles.helpText}>{text.createOwnerNoPayroll}</span> : <>
                <BenefitChoice
                  tone="neutral"
                  label={text.createPayKind}
                  value={form.pay_kind === "fixed"}
                  onLabel={text.createPayFixed}
                  offLabel={text.createPayMonthly}
                  onChange={(fixed) => setPayKind(fixed ? "fixed" : "monthly")}
                />
                {monthlyPay ? <BenefitChoice
                  tone="neutral"
                  label={text.createPayUnit}
                  value={form.pay_unit === "monthly"}
                  onLabel={text.createPayUnitMonthly}
                  offLabel={text.createPayUnitHourly}
                  onChange={(monthlyUnit) => update("pay_unit", monthlyUnit ? "monthly" : "hourly")}
                /> : null}
                {applies ? <>
                  <Field label={monthlyPay && form.pay_unit === "hourly" ? text.createAmountHourly : text.createAmountMonthly}>
                    <input
                      inputMode="numeric"
                      value={formatIntegerInput(form.pay_amount)}
                      onChange={(event) => update("pay_amount", integerInputDigits(event.target.value))}
                      style={styles.input}
                    />
                  </Field>
                  {contractPreview ? <span style={styles.helpText}>{text.createContractEffective.replace("{date}", contractPreview.effectiveFrom)}</span> : null}
                  {prorationPreview ? <span role="status" style={styles.prorationNotice}>
                    {text.createFixedProrationNotice.replace("{amount}", currencyAmount(prorationPreview.amount, vi)).replace("{days}", String(prorationPreview.employedDays)).replace("{total}", String(prorationPreview.totalDays))}
                  </span> : null}
                </> : <span style={styles.fieldNotice}>{text.createInactiveNoPayroll}</span>}
              </>}
              <span role="status" style={styles.attendanceLine}>{attendance ? text.createAttendanceOnByPay : text.createAttendanceOffByPay}</span>
              {attendance ? (
                <div style={styles.fieldRow2}>
                  <Field label={text.workStartTime}>
                    <input
                      type="time"
                      value={form.work_start_time}
                      onChange={(event) => update("work_start_time", event.target.value)}
                      style={styles.input}
                    />
                  </Field>
                  <Field label={text.workEndTime}>
                    <input
                      type="time"
                      value={form.work_end_time}
                      onChange={(event) => update("work_end_time", event.target.value)}
                      style={styles.input}
                    />
                  </Field>
                </div>
              ) : null}
            </div>

            {/* 📈 장기근무 레벨: 적용/미적용만. 기준월은 입사일로 자동 계산(1~15일 입사월, 16일~ 다음 달). */}
            <div style={styles.subsection}>
              <SubsectionTitle emoji="📈">{text.longTermLevel}</SubsectionTitle>
              <BenefitChoice
                label={text.levelParticipation}
                value={form.level_program_enabled}
                onLabel={text.levelEnabled}
                offLabel={text.levelDisabled}
                onChange={(enabled) => update("level_program_enabled", enabled)}
              />
              {form.level_program_enabled ? <p style={m.muted}>{text.hireDate} {form.hire_date || "-"} → {text.levelBaseMonth} {autoBaseMonth ?? "-"}</p> : null}
              {hours !== null && hours < 9 && attendance ? <span style={styles.shortShiftNotice}>{text.shortShiftNotice.replace("{hours}", String(hours))}</span> : null}
              <details style={m.details}>
                <summary style={m.summary}>{text.levelHelp}</summary>
                <ul style={styles.helpList}>
                  <li>{text.levelHireMonthRule}</li>
                  <li>{text.levelPolicyHelp}</li>
                  <li>{text.levelAutomaticRaise}</li>
                </ul>
              </details>
            </div>

            {/* 🎁 복리후생: 식대·개근 보너스는 ON/OFF만(적용일은 입사일 기준 자동). 고정급은 대상 아님. 보험·TNCN은 상세에서. */}
            {form.role !== "owner" ? <div style={styles.subsection}>
              <SubsectionTitle emoji="🎁">{text.benefits}</SubsectionTitle>
              <Toggle label={text.benefitMeal} checked={monthlyPay && form.meal_enabled} disabled={!monthlyPay || !applies} onChange={(value) => update("meal_enabled", value)} />
              {monthlyPay && applies && form.meal_enabled && hireValid ? <span style={styles.helpText}>{text.createMealFrom.replace("{date}", newEmployeeMealEffectiveFrom(form.hire_date))}</span> : null}
              <Toggle label={text.benefitBonus} checked={monthlyPay && form.bonus_enabled} disabled={!monthlyPay || !applies} onChange={(value) => update("bonus_enabled", value)} />
              {monthlyPay && applies && form.bonus_enabled && hireValid ? <span style={styles.helpText}>{text.createBonusFrom.replace("{month}", newEmployeeBonusEffectiveMonth(form.hire_date, vietnamCurrentMonth()))}</span> : null}
              {!monthlyPay ? <span style={styles.helpText}>{text.createBenefitFixedOff}</span> : null}
              <span style={styles.helpText}>{text.createPayrollNote}</span>
            </div> : null}
          </Section>

          {/* ③ 앱 접근 */}
          <Section tone="appAccess" emoji="🔐" title={text.appAccess}>
            <div style={styles.fieldRow2}>
              <Field label={text.username}>
                <input
                  value={form.username}
                  onChange={(event) => update("username", event.target.value)}
                  style={styles.input}
                  autoComplete="off"
                />
              </Field>
              <Field label={text.password}>
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => update("password", event.target.value)}
                  style={styles.input}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            {/* 앱 로그인 허용과 계정 활성은 서로 다른 필드다(합치지 않음). */}
            <Toggle label={text.appLoginEnabled} checked={form.app_login_enabled} onChange={(value) => update("app_login_enabled", value)} />
            <span style={styles.helpText}>{text.appLoginEnabledHelp}</span>
            <Toggle label={text.activeStatus} checked={form.is_active} onChange={(value) => update("is_active", value)} />
          </Section>

          {message ? <p role="alert" style={styles.message}>{message}</p> : null}

          <button
            type="button"
            style={styles.createButton}
            onClick={submit}
            disabled={isSaving}
          >
            {isSaving ? text.creating : text.create}
          </button>
        </fieldset>
      </section>
    </Container>
  );
}

const styles = {
  card: {
    ...ui.card,
    borderRadius: 12,
    padding: 10,
    display: "grid",
    gap: 10,
  },
  sections: {
    display: "grid",
    gap: 8,
    minWidth: 0,
    margin: 0,
    padding: 0,
    border: 0,
  },
  // ── 직원 상세(/admin/users) styles와 같은 값 ──
  detailSection: { display: "grid", gap: 8, padding: 10, border: "1px solid #e5e7eb", borderRadius: 9, minWidth: 0 },
  sectionTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 800, color: "#111827" },
  sectionBody: { display: "grid", gap: 8, minWidth: 0 },
  switchControl: { flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 },
  switchText: { minWidth: 26, fontSize: 11, fontWeight: 900, textAlign: "right", color: "#374151" },
  switchTrack: { position: "relative", display: "inline-block", flexShrink: 0, width: 44, height: 24, borderRadius: 999, background: "#d1d5db", transition: "background-color 0.18s ease" },
  switchTrackOn: { background: "#16a34a" },
  switchKnob: { position: "absolute", top: 2, left: 2, width: 20, height: 20, borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "transform 0.18s ease" },
  switchKnobOn: { transform: "translateX(20px)" },
  toggleRow: { width: "100%", minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "6px 8px 6px 12px", border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff", color: "#111827", fontFamily: "inherit", fontSize: 13, fontWeight: 800, textAlign: "left", cursor: "pointer" },
  toggleLabel: { minWidth: 0, overflowWrap: "anywhere" },
  subsection: { display: "grid", gap: 8, paddingTop: 10, marginTop: 2, borderTop: "1px solid #bae6fd", minWidth: 0 },
  subsectionTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 800, color: "#0f172a" },
  modalHint: { margin: "7px 0 0", fontSize: 11, color: "#6b7280", lineHeight: 1.5, overflowWrap: "anywhere" },
  // 생성 화면은 모바일 세로 길이를 줄이려고 320px에서도 2열을 유지한다(기존 생성 화면과 같은 규칙).
  fieldRow2: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: 7,
    minWidth: 0,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    gap: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 900,
    color: "#374151",
  },
  fieldNotice: {
    fontSize: 11,
    lineHeight: 1.4,
    fontWeight: 800,
    color: "#b45309",
  },
  input: {
    ...ui.input,
    // 카드 배경색이 있어도 입력창은 흰 바탕으로 대비를 유지한다.
    background: "#fff",
    padding: "7px 8px",
    borderRadius: 7,
    fontSize: 12,
    minWidth: 0,
  },
  actionRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
  },
  // ── 생성 화면 전용 ──
  // 비활성 스위치(고정급의 식대·개근 보너스)는 눌러 볼 수 있는 것처럼 보이지 않게 흐리게 표시한다.
  toggleDisabled: { opacity: 0.55, cursor: "not-allowed" },
  attendanceLine: { fontSize: 11, lineHeight: 1.45, fontWeight: 800, color: "#0f172a" },
  prorationNotice: { margin: 0, padding: 8, borderRadius: 8, background: "#fffbeb", color: "#92400e", fontSize: 11, lineHeight: 1.5, overflowWrap: "anywhere" },
  warnTone: { background: "#fffbeb", borderColor: "#fde68a" },
  stepList: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 },
  stepRow: { display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "2px 8px", padding: "6px 8px", borderRadius: 8, background: "#fff", fontSize: 12, fontWeight: 700, color: "#111827" },
  stepDone: { color: "#15803d", fontSize: 12 },
  stepFailed: { color: "#b91c1c", fontSize: 12 },
  stepPending: { color: "#6b7280", fontSize: 12 },
  stepError: { flexBasis: "100%", fontSize: 11, fontWeight: 700, color: "#b91c1c", overflowWrap: "anywhere" },
  // 주요 버튼은 직원 상세 저장 버튼과 같은 색(ui.button)에 터치 영역 44px 이상.
  createButton: { ...ui.button, minHeight: 44, padding: "8px 12px", fontSize: 14, fontWeight: 800, borderRadius: 10 },
  secondaryAction: { ...ui.subButton, minHeight: 44, padding: "8px 12px", fontSize: 13, borderRadius: 10 },
  successText: { margin: 0, fontSize: 13, fontWeight: 700, color: "#111827", lineHeight: 1.5, overflowWrap: "anywhere" },
  notice: {
    ...ui.card,
    borderRadius: 12,
    padding: 13,
    fontSize: 13,
    fontWeight: 800,
    color: "#374151",
  },
  message: {
    margin: "0",
    padding: "8px 10px",
    borderRadius: 10,
    background: "#fef2f2",
    fontSize: 12,
    fontWeight: 800,
    color: "#b91c1c",
    lineHeight: 1.45,
  },
  helpText: { fontSize: 11, lineHeight: 1.5, color: "#6b7280" },
  helpList: { margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 4, color: "#6b7280", fontSize: 11, lineHeight: 1.5 },
  shortShiftNotice: { padding: 8, borderRadius: 8, background: "#fffbeb", color: "#92400e", fontSize: 11, lineHeight: 1.5 },
} satisfies Record<string, CSSProperties>;
