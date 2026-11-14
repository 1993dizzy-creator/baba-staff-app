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
import { BenefitChoice, BenefitField, m } from "@/components/payroll/BenefitModalParts";
import { useLeaveGuard } from "@/components/payroll/payrollUnsaved";

type CreateResponse = {
  ok: boolean;
  error?: string;
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
  level_base_mode: "hire_month" | "override_month";
  level_base_month: string;
  attendance_tracking_enabled: boolean;
  app_login_enabled: boolean;
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
  level_base_mode: "hire_month",
  level_base_month: "",
  attendance_tracking_enabled: true,
  app_login_enabled: true,
};

type AdminUsersPageText = (typeof adminUsersText)[keyof typeof adminUsersText];
type Created = { id: string | null; name: string };

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
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} style={styles.toggleRow}>
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
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [canAccess, setCanAccess] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  // 생성 요청은 한 번에 하나만 보낸다(더블 클릭·연타가 isSaving 반영 전에 두 번째 POST를 보내지 않게).
  const submitting = useRef(false);
  const formRef = useRef(form);
  formRef.current = form;
  const hours = shiftHours(form.work_start_time, form.work_end_time);
  const autoBaseMonth = hireMonthBase(form.hire_date);

  // 등록 전 입력이 있으면 메뉴 링크·새로고침·창 닫기에서 확인한다(등록 성공 후에는 묻지 않는다).
  const leaveMessage = !created && isDirty(form) ? text.createLeaveConfirm : null;
  useLeaveGuard(leaveMessage, () => (!created && isDirty(formRef.current) ? text.createLeaveConfirm : null));

  useEffect(() => {
    const user = getUser();
    if (user?.role === "leader") {
      router.replace("/admin");
      return;
    }
    setCanAccess(isAdmin(user));
    setChecked(true);
  }, [router]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    if (submitting.current) return;
    if (!form.username.trim() || !form.password.trim() || !form.name.trim()) {
      setMessage(text.required);
      return;
    }

    if (
      form.attendance_tracking_enabled &&
      (!form.work_start_time || !form.work_end_time)
    ) {
      setMessage(text.workTimeRequiredForTracking);
      return;
    }

    if (form.level_program_enabled && !form.hire_date) {
      setMessage(text.createLevelHireDateRequired);
      return;
    }

    submitting.current = true;
    setIsSaving(true);
    setMessage("");

    try {
      const res = await attendanceFetch("/api/admin/users/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lang,
          ...form,
        }),
      });
      const result = (await res.json()) as CreateResponse;

      if (!res.ok || !result.ok) {
        // 409(중복 ID)는 서버의 영문 오류 대신 화면 언어의 안내를 보여 준다.
        throw new Error(res.status === 409 ? text.duplicateUsername : result.error || text.createFailed);
      }

      // 생성 RPC가 돌려준 직원 id로 직원 상세(근무·급여)를 연다. id가 없으면 목록으로 이동한다.
      const id = result.user?.id;
      setCreated({ id: id === undefined || id === null || id === "" ? null : String(id), name: form.name.trim() });
      setForm(initialForm);
    } catch (error) {
      // 실패 시 입력값은 그대로 둔다.
      setMessage(error instanceof Error ? error.message : text.createFailed);
    } finally {
      submitting.current = false;
      setIsSaving(false);
    }
  }

  if (checked && !canAccess) {
    return (
      <Container noPaddingTop>
        <UserNav active="create" />
        <section style={styles.notice}>{text.noPermission}</section>
      </Container>
    );
  }

  if (created) {
    return (
      <Container noPaddingTop>
        <UserNav active="create" />
        <section style={styles.card}>
          <section role="status" style={{ ...styles.detailSection, ...SECTION_TONES.appAccess }}>
            <strong style={styles.sectionTitle}><span aria-hidden="true">✅</span>{text.createSuccess}</strong>
            <p style={styles.successText}>{text.createdNextStep.replace("{name}", created.name)}</p>
            <p style={styles.modalHint}>{text.createPayrollNote}</p>
          </section>
          <div style={styles.actionRow}>
            <button type="button" style={styles.secondaryAction} onClick={() => { setCreated(null); setMessage(""); }}>
              {text.createAnother}
            </button>
            <button
              type="button"
              style={styles.createButton}
              onClick={() => router.push(created.id ? `/admin/users?userId=${encodeURIComponent(created.id)}&section=payroll` : "/admin/users")}
            >
              {text.createOpenPayroll}
            </button>
          </div>
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
                value={form.hire_date}
                onChange={(event) => update("hire_date", event.target.value)}
                style={styles.input}
              />
            </Field>
            <Toggle label={text.attendanceTracking} checked={form.attendance_tracking_enabled} onChange={(value) => update("attendance_tracking_enabled", value)} />
            {form.attendance_tracking_enabled ? (
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

            {/* 📈 장기근무 레벨: 직원 상세 레벨 설정과 같은 2분할 선택(적용 = 초록, 기준 선택 = 중립 회색). 신규 직원이라 이력·예약·현재 급여는 없다. */}
            <div style={styles.subsection}>
              <SubsectionTitle emoji="📈">{text.longTermLevel}</SubsectionTitle>
              <BenefitChoice
                label={text.levelParticipation}
                value={form.level_program_enabled}
                onLabel={text.levelEnabled}
                offLabel={text.levelDisabled}
                onChange={(enabled) => update("level_program_enabled", enabled)}
              />
              {form.level_program_enabled ? <>
                <BenefitChoice
                  tone="neutral"
                  label={text.levelBasisShort}
                  value={form.level_base_mode === "hire_month"}
                  onLabel={text.levelAutoShort}
                  offLabel={text.levelDirectShort}
                  onChange={(auto) => setForm((current) => ({
                    ...current,
                    level_base_mode: auto ? "hire_month" : "override_month",
                    level_base_month: !auto && !current.level_base_month ? hireMonthBase(current.hire_date) ?? "" : current.level_base_month,
                  }))}
                />
                {form.level_base_mode === "hire_month"
                  ? <p style={m.muted}>{text.hireDate} {form.hire_date || "-"} → {text.levelBaseMonth} {autoBaseMonth ?? "-"}</p>
                  : <BenefitField label={text.levelBaseMonth}><input type="month" min={form.hire_date ? form.hire_date.slice(0, 7) : undefined} value={form.level_base_month} onChange={(event) => update("level_base_month", event.target.value)} style={m.input} /></BenefitField>}
                {!form.hire_date ? <span style={styles.fieldNotice}>{text.createLevelHireDateRequired}</span> : null}
              </> : null}
              {hours !== null && hours < 9 ? <span style={styles.shortShiftNotice}>{text.shortShiftNotice.replace("{hours}", String(hours))}</span> : null}
              <details style={m.details}>
                <summary style={m.summary}>{text.levelHelp}</summary>
                <ul style={styles.helpList}>
                  <li>{text.levelHireMonthRule}</li>
                  <li>{text.levelPolicyHelp}</li>
                  <li>{text.levelAutomaticRaise}</li>
                </ul>
              </details>
            </div>

            {/* 💰 급여계약·복리후생은 등록 후 직원 상세에서 설정한다(생성 단계에서는 저장하지 않음). */}
            <div style={styles.subsection}>
              <SubsectionTitle emoji="💰">{text.payrollContract} · {text.benefits}</SubsectionTitle>
              <span style={styles.helpText}>{text.createPayrollNote}</span>
            </div>
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
