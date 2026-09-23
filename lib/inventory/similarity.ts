import { normalizeInventoryName } from "@/lib/inventory/normalize";

export type InventorySimilarityItem = {
  id: number;
  item_name?: string | null;
  item_name_vi?: string | null;
};

export type ScoredInventorySimilarityItem<T extends InventorySimilarityItem> = {
  item: T;
  score: number;
};

const compact = (value: string) => value.replace(/\s+/g, "");

const tokenDice = (left: string, right: string) => {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return (2 * overlap) / (leftTokens.size + rightTokens.size);
};

const trigrams = (value: string) => {
  const normalized = compact(value);
  if (normalized.length < 3) return new Set(normalized ? [normalized] : []);

  const result = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    result.add(normalized.slice(index, index + 3));
  }
  return result;
};

const trigramDice = (left: string, right: string) => {
  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) return 0;

  let overlap = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) overlap += 1;
  }

  return (2 * overlap) / (leftTrigrams.size + rightTrigrams.size);
};

export const scoreInventoryNameSimilarity = (
  input: unknown,
  candidate: unknown
) => {
  const normalizedInput = normalizeInventoryName(input);
  const normalizedCandidate = normalizeInventoryName(candidate);
  if (normalizedInput.length < 2 || !normalizedCandidate) return 0;

  if (normalizedInput === normalizedCandidate) return 100;

  const compactInput = compact(normalizedInput);
  const compactCandidate = compact(normalizedCandidate);
  if (compactInput === compactCandidate) return 96;

  const shorterLength = Math.min(compactInput.length, compactCandidate.length);
  const longerLength = Math.max(compactInput.length, compactCandidate.length);
  const containmentScore =
    compactInput.includes(compactCandidate) || compactCandidate.includes(compactInput)
      ? 78 + (shorterLength / longerLength) * 12
      : 0;
  const tokenScore = tokenDice(normalizedInput, normalizedCandidate) * 82;
  const trigramScore = trigramDice(normalizedInput, normalizedCandidate) * 70;

  return Math.max(containmentScore, tokenScore, trigramScore);
};

export function findSimilarInventoryItems<T extends InventorySimilarityItem>(
  input: unknown,
  items: readonly T[],
  limit = 5
): ScoredInventorySimilarityItem<T>[] {
  const normalizedInput = normalizeInventoryName(input);
  if (normalizedInput.length < 2 || limit <= 0) return [];

  return items
    .map((item, index) => ({
      item,
      index,
      score: Math.max(
        scoreInventoryNameSimilarity(normalizedInput, item.item_name),
        scoreInventoryNameSimilarity(normalizedInput, item.item_name_vi)
      ),
    }))
    .filter((candidate) => candidate.score >= 40)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ item, score }) => ({ item, score }));
}
