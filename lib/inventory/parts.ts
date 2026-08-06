// 재고(inventory) 화면·API가 실제로 사용하는 파트는 직원 공통 파트(lib/common/parts.ts의
// PART_VALUES = owner/kitchen/hall/bar/cleaning/etc) 중 4개뿐이다. 재고 화면이 공통
// PART_VALUES를 그대로 써서 초기 필터를 정하면, owner·cleaning 계정은 화면에 없는 버튼값이
// 내부 상태로 들어가 "로딩은 끝났지만 재고가 하나도 안 보이는" 숨은 필터 상태가 된다.
// 이 파일은 재고 전용 파트 정책을 공통 파트 정책과 분리해, 재고 화면/폼/필터/서버 검증이
// 항상 이 4개 값만 유효하다고 보게 만든다.

export const INVENTORY_PART_VALUES = ["kitchen", "hall", "bar", "etc"] as const;

export type InventoryPartValue = (typeof INVENTORY_PART_VALUES)[number];

export const INVENTORY_PART_FALLBACK: InventoryPartValue = "kitchen";

export function isInventoryPart(value: unknown): value is InventoryPartValue {
  return INVENTORY_PART_VALUES.includes(value as InventoryPartValue);
}

// 초기 파트 결정 순서:
//   1. localStorage 저장값이 유효한 재고 파트면 그 값을 쓴다.
//   2. 저장값이 없거나 잘못됐고, 로그인 사용자의 파트(owner/kitchen/hall/bar/cleaning/etc
//      중 하나)가 유효한 재고 파트면 그 값을 쓴다.
//   3. 둘 다 아니면(owner/cleaning/알 수 없는 값 포함) kitchen으로 떨어진다.
export function resolveInventoryDefaultPart(
  savedPart: unknown,
  userPart: unknown
): InventoryPartValue {
  if (isInventoryPart(savedPart)) return savedPart;
  if (isInventoryPart(userPart)) return userPart;
  return INVENTORY_PART_FALLBACK;
}

// POST/PATCH 재고 API가 공유하는 순수 payload 검증 로직. NextResponse 등 HTTP 타입에
// 의존하지 않아 실제 payload 객체로 직접 호출해 반환값을 검증할 수 있다(예:
// tests/inventory-part-api-contract.test.ts). HTTP 에러 응답으로 감싸는 책임은 호출부
// (app/api/inventory/items/route.ts)에 남겨둔다.
//
// - required: true (POST) — payload에 part가 아예 없어도 거부한다.
// - required: false (PATCH) — part 자체가 없는 quick-save/active-status/사진·수량 흐름은
//   그대로 통과시키고, part가 포함된 경우에만(값이 undefined로 명시된 경우 포함) 검사한다.
// - 유효하면 trim된 값을 normalizedPart로 돌려준다(공백이 섞인 값이 그대로 저장되지 않게).
export type InventoryPartPayloadValidation =
  | { ok: true; normalizedPart?: InventoryPartValue }
  | { ok: false };

export function validateInventoryPartPayload(
  payload: Record<string, unknown>,
  { required }: { required: boolean }
): InventoryPartPayloadValidation {
  const hasPart = Object.prototype.hasOwnProperty.call(payload, "part");

  if (!hasPart) {
    return required ? { ok: false } : { ok: true };
  }

  const rawPart = payload.part;
  const normalizedPart = typeof rawPart === "string" ? rawPart.trim() : rawPart;

  if (!isInventoryPart(normalizedPart)) {
    return { ok: false };
  }

  return { ok: true, normalizedPart };
}
