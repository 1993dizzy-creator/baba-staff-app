"use client";

import { useEffect } from "react";
import { useLanguage } from "@/lib/language-context";

export default function AppVersionChecker() {
    const { lang } = useLanguage();

    useEffect(() => {
        const CURRENT_VERSION = "1.0.3";

        const checkVersion = async () => {
            try {
                const res = await fetch("/version.json?ts=" + Date.now());
                const data = await res.json();

                if (data.version !== CURRENT_VERSION) {
                    alert(
                        lang === "vi"
                            ? "Ứng dụng đã được cập nhật. Đang tải lại..."
                            : "앱이 업데이트되었습니다. 새로고침합니다."
                    );
                    window.location.reload();
                }
            } catch (e) {
                console.error("version check fail", e);
            }
        };

        checkVersion(); // 처음 1회 바로 체크
        const interval = setInterval(checkVersion, 1000 * 60);

        return () => clearInterval(interval);
    }, [lang]);

    return null;
}