"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn } from "@/lib/supabase/auth";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    if (isLoggedIn()) {
      router.replace("/inventory");
    } else {
      router.replace("/login");
    }
  }, [router]);

  return <main style={{ padding: 40 }}>이동 중...</main>;
}