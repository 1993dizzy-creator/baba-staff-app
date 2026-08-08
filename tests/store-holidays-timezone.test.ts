import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { getVietnamDateParts, BUSINESS_TIME_ZONE } from "../lib/common/business-time.ts";

// ---------------------------------------------------------------------------
// /admin/settings/store 공휴일 탭의 "11월 이후 다음 연도 준비 안내" 판정은 반드시
// BABA 공식 시간대(Asia/Ho_Chi_Minh) 기준 달력 날짜로 이뤄져야 한다 — 브라우저/
// 서버의 로컬 new Date()를 직접 쓰면 사용자가 다른 시간대에서 접속했을 때 11월
// 경계가 어긋난다. 이 판정에는 영업일 03:00 cutoff가 적용되면 안 되므로(순수
// 달력 날짜 판정), getVietnamDateParts(cutoff 없음)를 재사용한다 —
// calculateStoreBusinessDate/getBusinessDate(cutoff 적용됨)는 쓰지 않는다.
//
// 이 파일은 getVietnamDateParts 자체를 실제로 호출해 결과값을 검증한다(정적
// 소스 텍스트 매칭이 아니라 직접 실행 — 순수 함수라 가능하다). page.tsx가 이
// 값을 어떻게 소비하는지(storeToday.month < 11 등)는 tests/store-settings-
// holidays-ui.test.ts에서 정적으로 검증한다.
// ---------------------------------------------------------------------------

function shouldCheckNextYear(month: number) {
  // page.tsx의 실제 판정 로직과 동일 — 여기서는 getVietnamDateParts의 결과값이
  // 그 판정에 올바르게 들어맞는지 검증하기 위한 미러 구현이다.
  return month >= 11;
}

test("BUSINESS_TIME_ZONE is Asia/Ho_Chi_Minh (BABA's official timezone)", () => {
  assert.equal(BUSINESS_TIME_ZONE, "Asia/Ho_Chi_Minh");
});

test("[boundary 1] Vietnam local 2026-10-31 23:59 (UTC 2026-10-31 16:59Z) → month=10, shouldCheckNextYear=false", () => {
  const instant = new Date("2026-10-31T16:59:00Z");
  const parts = getVietnamDateParts(instant);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 10);
  assert.equal(parts.day, 31);
  assert.equal(parts.hour, 23);
  assert.equal(parts.minute, 59);
  assert.equal(shouldCheckNextYear(parts.month), false);
});

test("[boundary 2] Vietnam local 2026-11-01 00:00 (UTC 2026-10-31 17:00Z) → month=11, shouldCheckNextYear=true", () => {
  const instant = new Date("2026-10-31T17:00:00Z");
  const parts = getVietnamDateParts(instant);
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 1);
  assert.equal(parts.hour, 0);
  assert.equal(parts.minute, 0);
  assert.equal(shouldCheckNextYear(parts.month), true);
});

test("[boundary 3] the exact same instant expressed as 'UTC 2026-10-31 17:00' is judged by its Vietnam-local date (2026-11-01), not its UTC calendar date (2026-10-31) — a naive UTC-based or host-local check would wrongly stay in October", () => {
  const instant = new Date(Date.UTC(2026, 9, 31, 17, 0, 0)); // month is 0-indexed in Date.UTC: 9 = October
  const parts = getVietnamDateParts(instant);
  // UTC 캘린더 날짜 자체는 여전히 10/31이다 — 아래 assert는 "UTC 기준으로 보면
  // 아직 10월"이라는 사실을 명시적으로 보여주기 위한 대조군이다.
  assert.equal(instant.getUTCMonth() + 1, 10);
  assert.equal(instant.getUTCDate(), 31);
  // 하지만 베트남 현지 기준으로는 이미 11/1이다 — 판정은 반드시 이 값을 써야 한다.
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 1);
  assert.equal(shouldCheckNextYear(parts.month), true);
});

test("[boundary 4] one minute before boundary 3 (UTC 16:59Z, same UTC calendar date 10/31) is still Vietnam-local 10/31 — the flip happens exactly at the Vietnam midnight instant, not the UTC one", () => {
  const beforeMidnight = getVietnamDateParts(new Date("2026-10-31T16:59:59Z"));
  const atMidnight = getVietnamDateParts(new Date("2026-10-31T17:00:00Z"));
  assert.equal(beforeMidnight.month, 10);
  assert.equal(atMidnight.month, 11);
});

test("independence from host system timezone: the underlying formatter always passes an explicit timeZone option, so process.env.TZ (or any host default) cannot change the result", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const source = readFileSync(join(process.cwd(), "lib/common/business-time.ts"), "utf8");
  assert.match(source, /timeZone: BUSINESS_TIME_ZONE,/);

  const originalTz = process.env.TZ;
  try {
    const instant = new Date("2026-10-31T17:00:00Z");

    process.env.TZ = "America/Los_Angeles";
    const partsFromLA = getVietnamDateParts(instant);

    process.env.TZ = "Asia/Seoul";
    const partsFromSeoul = getVietnamDateParts(instant);

    process.env.TZ = "UTC";
    const partsFromUTC = getVietnamDateParts(instant);

    // 어떤 host TZ 환경에서도 베트남 현지 판정 결과는 동일해야 한다.
    for (const parts of [partsFromLA, partsFromSeoul, partsFromUTC]) {
      assert.equal(parts.year, 2026);
      assert.equal(parts.month, 11);
      assert.equal(parts.day, 1);
      assert.equal(parts.hour, 0);
    }
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test("page.tsx uses getVietnamDateParts (not calculateStoreBusinessDate/getBusinessDate) for the November-reminder judgement — those cutoff-aware helpers would incorrectly shift the calendar date backward before 03:00 Vietnam time", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const page = readFileSync(
    join(process.cwd(), "app/(protected)/admin/settings/store/page.tsx"),
    "utf8"
  );
  const effectBlock = page.slice(
    page.indexOf("const storeToday = getVietnamDateParts();"),
    page.indexOf("// 날짜 1개씩 즉시 저장한다")
  );
  assert.ok(effectBlock.length > 0, "could not locate the November-reminder effect block");
  assert.doesNotMatch(effectBlock, /calculateStoreBusinessDate|getBusinessDate\(/);
  assert.match(page, /import \{ getVietnamDateParts \} from "@\/lib\/common\/business-time";/);
});
