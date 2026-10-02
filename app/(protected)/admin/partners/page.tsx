import { redirect } from "next/navigation";
import { legacyPartnerRedirectHref } from "@/lib/partners/settings-view";

// 거래처관리 now lives in 장부설정 > 거래처. Old bookmarks land on 등록대기.
export default async function PartnerRegistrationRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyPartnerRedirectHref("pending", await searchParams));
}
