export function shouldBlockIncompleteRecipe(input: {
  source: string | null | undefined;
  isModified: boolean | null | undefined;
  isOption: boolean | null | undefined;
}) {
  return (
    input.source === "manual" ||
    input.isModified === true ||
    input.isOption === true
  );
}
