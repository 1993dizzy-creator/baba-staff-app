/**
 * /admin/users 복리후생 타일(이름·스위치)에서 설정 하나만 모달로 열 때의 요청.
 * 카드는 조회가 끝나면 폼을 바로 열고 서버에서 확인한 현재 적용 상태로 채운다(스위치로 열어도 반대 상태를 미리 고르지 않음).
 * 그 값이 미저장 판정·저장 활성화의 기준값이므로 아무것도 바꾸지 않고 닫으면 경고·저장 없이 닫힌다.
 * - enable: 예전 스위치 목표 상태 필드. 카드는 더 이상 이 값으로 폼을 미리 채우지 않는다(호출부는 null).
 * 저장은 각 카드의 기존 저장 API·검증을 그대로 쓴다(스위치가 직접 저장하지 않음).
 */
export type PayrollSettingFormRequest = { enable: boolean | null };

/** 모달 모드에서 폼이 끝났음을 알린다: 저장 성공(재조회 완료) 또는 사용자의 취소. */
export type PayrollSettingFormResult = "saved" | "cancelled";
