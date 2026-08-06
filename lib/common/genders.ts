// 성별 저장값(male/female/other, 또는 미입력 null/빈 문자열)은 그대로 유지하고 화면
// 표시만 언어별로 바꾼다. 직원 현황(app/(protected)/admin/users/page.tsx)과 직원 생성
// (app/(protected)/admin/users/create/page.tsx) 양쪽에서 같은 값·라벨을 썼는데, 각 페이지에
// 지역 helper로 중복 구현돼 있던 것을 이 파일로 모았다.

export const GENDER_VALUES = ["male", "female", "other"] as const;

export type GenderValue = (typeof GENDER_VALUES)[number];

export function isGenderValue(value: unknown): value is GenderValue {
  return GENDER_VALUES.includes(value as GenderValue);
}

const GENDER_LABELS: Record<GenderValue, { ko: string; vi: string }> = {
  male: { ko: "남성", vi: "Nam" },
  female: { ko: "여성", vi: "Nữ" },
  other: { ko: "기타", vi: "Khác" },
};

export function getGenderLabel(value: unknown, lang: "ko" | "vi"): string {
  return isGenderValue(value) ? GENDER_LABELS[value][lang] : "-";
}
