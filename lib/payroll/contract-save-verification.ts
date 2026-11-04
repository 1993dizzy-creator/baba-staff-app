// 급여계약 등록·정정 요청의 응답이 유실됐을 때, 기존 계약 조회 결과로 실제 반영 여부를 판정한다.
// 읽기 전용 판정이며 저장을 다시 보내지 않는다. 판정 기준:
// - 등록: 요청 전에 없던 계약 id가 같은 적용일·급여·고정인상액으로 생겼는가
// - 정정: 같은 계약 id의 감사 버전(auditVersion)이 바뀌었고 값이 제출값과 같은가

export type SavedContractLike = {
  id: number;
  effectiveFrom: string;
  payType: string;
  baseSalary: number;
  fixedRaiseAmount: number;
  auditVersion: number | null;
};

export type SubmittedContractSave =
  | { mode: "create"; knownContractIds: number[]; effectiveFrom: string; payType: string; baseSalary: number; fixedRaiseAmount: number }
  | { mode: "correct"; contractId: number; expectedAuditVersion: number | null; effectiveFrom: string; payType: string; baseSalary: number; fixedRaiseAmount: number };

function sameValues(contract: SavedContractLike, submitted: SubmittedContractSave) {
  return contract.effectiveFrom === submitted.effectiveFrom
    && contract.payType === submitted.payType
    && contract.baseSalary === submitted.baseSalary
    && contract.fixedRaiseAmount === submitted.fixedRaiseAmount;
}

export function contractSaveApplied(history: SavedContractLike[], submitted: SubmittedContractSave): boolean {
  if (submitted.mode === "create") {
    const known = new Set(submitted.knownContractIds);
    return history.some((contract) => !known.has(contract.id) && sameValues(contract, submitted));
  }
  const target = history.find((contract) => contract.id === submitted.contractId);
  return Boolean(target && target.auditVersion !== submitted.expectedAuditVersion && sameValues(target, submitted));
}
