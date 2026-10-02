import { redirect } from "next/navigation";
import { legacyPartnerRedirectHref } from "@/lib/partners/settings-view";

// 거래처 정보 now lives in 장부설정 > 거래처 (사용중). Old bookmarks keep working.
export default async function PartnerInfoRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyPartnerRedirectHref("active", await searchParams));
}
