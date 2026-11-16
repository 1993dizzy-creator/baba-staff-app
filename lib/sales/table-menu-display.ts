const hangul = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/u;
const hangulLetters = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/gu;

/** Display only. Split exactly one slash only when it separates a Hangul-only
 * label from a Latin-script label. Mixed scripts, extra slashes and other
 * ambiguous names retain the exact original; no translation or source mutation.
 */
export function localizedTableMenuName(original: string, lang: "ko" | "vi"): string {
  const trimmed = original.trim();
  const code = trimmed.match(/^(\[[A-Za-z0-9][A-Za-z0-9._-]*\])\s*/)?.[0] ?? "";
  const parts = trimmed.slice(code.length).split("/").map(part => part.trim());
  if (parts.length !== 2 || parts.some(part => !part)) return original;
  const korean = (part: string) => hangul.test(part) && !/\p{L}/u.test(part.replace(hangulLetters, ""));
  const latin = (part: string) => /\p{Script=Latin}/u.test(part)
    && !/\p{L}/u.test(part.replace(/\p{Script=Latin}/gu, ""));
  const koIndex = korean(parts[0]) && latin(parts[1]) ? 0 : korean(parts[1]) && latin(parts[0]) ? 1 : -1;
  if (koIndex === -1) return original;
  const label = parts[lang === "ko" ? koIndex : 1 - koIndex];
  return code ? `${code.trim()} ${label}` : label;
}
