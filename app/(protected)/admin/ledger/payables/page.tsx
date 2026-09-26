import { redirect } from "next/navigation";

// The separate payables screen was merged into 장부작성 > 미납금 현황.
// Old bookmarks/links land there, keeping a valid ?month=YYYY-MM.
export default async function LegacyPayablesRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const month = (await searchParams).month;
  redirect(typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
    ? `/admin/ledger/entries?month=${month}`
    : "/admin/ledger/entries");
}
