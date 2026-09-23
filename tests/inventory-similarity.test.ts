import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(path: string, dependencies: Record<string, unknown> = {}) {
  const testModule = { exports: {} as Record<string, unknown> };
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    testModule,
    testModule.exports
  );
  return testModule.exports;
}

const normalize = load("lib/inventory/normalize.ts");
const { findSimilarInventoryItems } = load("lib/inventory/similarity.ts", {
  "@/lib/inventory/normalize": normalize,
}) as {
  findSimilarInventoryItems: <T extends { id: number; item_name?: string; item_name_vi?: string }>(
    input: unknown,
    items: readonly T[],
    limit?: number
  ) => Array<{ item: T; score: number }>;
};

test("MOSA and Vinamilk token-overlap examples appear as similar candidates", () => {
  const items = [
    { id: 1, item_name: "모사 가스", item_name_vi: "Gas làm foam mosa" },
    { id: 2, item_name: "비나밀크 포도주스", item_name_vi: "Nước ép nho Vinamilk 1L" },
    { id: 3, item_name: "양파", item_name_vi: "Hanh tay" },
  ];

  assert.deepEqual(
    findSimilarInventoryItems("Hộp gas mosa", items).map(({ item }) => item.id),
    [1]
  );
  assert.equal(
    findSimilarInventoryItems("Nuoc nho ep vinamilk", items)[0]?.item.id,
    2
  );
});

test("similar candidates are local name recommendations capped at five regardless of code", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    item_name: `헤네시 VSOP ${index + 1}`,
    item_name_vi: `Hennessy VSOP ${index + 1}`,
    code: index === 0 ? "PC" : `Z${index}`,
  }));

  const candidates = findSimilarInventoryItems("헤네시 VSOP", items);
  assert.equal(candidates.length, 5);
  assert.equal(candidates.some(({ item }) => item.code !== "PC"), true);
  assert.deepEqual(findSimilarInventoryItems("ㅎ", items), []);
});
