"use client";

import { useEffect } from "react";
import { useLanguage } from "@/lib/language-context";

export default function AppVersionChecker() {
    const { lang } = useLanguage();

    useEffect(() => {
        const CURRENT_VERSION = "1.0.6";

        const checkVersion = async () => {
            try {
                const res = await fetch("/version.json?ts=" + Date.now(), {
                    cache: "no-store",
                });

                if (!res.ok) {
                    return;
                }

                const data = await res.json();

                if (data.version && data.version !== CURRENT_VERSION) {
                    // 기존 업데이트 처리 로직 유지
                }
            } catch {
                // 개발 환경이나 네트워크 일시 오류는 무시
            }
        };

        checkVersion(); // 처음 1회 바로 체크
        const interval = setInterval(checkVersion, 1000 * 60);

        return () => clearInterval(interval);
    }, [lang]);

    return null;
}