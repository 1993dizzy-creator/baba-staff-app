"use client";

import { useLanguage } from "@/lib/language-context";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ui } from "@/lib/styles/ui";
import { isAdmin } from "@/lib/supabase/auth";
import { takeAttendanceReturnPath } from "@/lib/auth/attendance-session-transition";

export default function LoginPage() {
    const { lang } = useLanguage();
    const router = useRouter();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleLogin = async () => {
        if (!username || !password) {
            setLoading(false);
            alert("Please enter username and password");
            return;
        }

        if (loading) return;
        setLoading(true);

        try {
            const res = await fetch("/api/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    username,
                    password,
                    lang,
                }),
            });

            const result = await res.json();
            if (!result || typeof result !== "object" || typeof result.ok !== "boolean"
                || (result.ok && (!result.user || typeof result.user !== "object" || Array.isArray(result.user)))) {
                throw new Error("Invalid login response");
            }

            if (!res.ok || !result.ok) {
                setLoading(false);
                alert(result.message || "Login failed");
                return;
            }

            localStorage.setItem("baba_user", JSON.stringify(result.user));

            const returnPath = takeAttendanceReturnPath(window.sessionStorage);
            router.replace(returnPath || (isAdmin(result.user) ? "/admin" : "/inventory"));
        } catch {
            alert(lang === "ko"
                ? "로그인 요청을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요."
                : "Không thể xử lý yêu cầu đăng nhập. Vui lòng kiểm tra kết nối và thử lại.");
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            handleLogin();
        }
    };

    return (
        <div
            style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 20,
                background: "#f3f4f6",
            }}
        >
            <div
                style={{
                    width: "100%",
                    maxWidth: 420,
                    ...ui.card,
                    padding: "32px 24px",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        marginBottom: 18,
                    }}
                >
                    <Image
                        src="/img/logo.png"
                        alt="BABA logo"
                        width={140}
                        height={140}
                        style={{
                            width: 140,
                            height: 140,
                            objectFit: "contain",
                        }}
                    />
                    <h1
                        style={{
                            margin: 0,
                            fontSize: 28,
                            fontWeight: "bold",
                            letterSpacing: "-0.02em",
                        }}
                    >
                        BABA
                    </h1>
                    <p
                        style={{
                            marginTop: 8,
                            marginBottom: 0,
                            fontSize: 14,
                            color: "#666",
                        }}
                    >
                        Staff Login
                    </p>
                </div>

                <input
                    onKeyDown={handleKeyDown}
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    style={{
                        ...ui.input,
                        marginTop: 10,
                    }}
                    onFocus={(e) => (e.target.style.border = "1px solid black")}
                    onBlur={(e) => (e.target.style.border = "1px solid #d1d5db")}
                />

                <input
                    onKeyDown={handleKeyDown}
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{
                        ...ui.input,
                        marginTop: 10,
                    }}
                    onFocus={(e) => (e.target.style.border = "1px solid black")}
                    onBlur={(e) => (e.target.style.border = "1px solid #d1d5db")}
                />

                <button
                    onClick={handleLogin}
                    disabled={loading}
                    style={{
                        ...ui.button,
                        marginTop: 22,
                        cursor: loading ? "not-allowed" : "pointer",
                        opacity: loading ? 0.6 : 1,
                        transition: "all 0.15s ease",
                    }}
                    onMouseEnter={(e) => {
                        if (loading) return;
                        e.currentTarget.style.background = "#222";
                    }}
                    onMouseLeave={(e) => {
                        if (loading) return;
                        e.currentTarget.style.background = "black";
                    }}
                    onMouseDown={(e) => {
                        if (loading) return;
                        e.currentTarget.style.transform = "scale(0.98)";
                    }}
                    onMouseUp={(e) => {
                        if (loading) return;
                        e.currentTarget.style.transform = "scale(1)";
                    }}
                >
                    {loading ? "Logging in..." : "Login"}
                </button>
            </div>
        </div>
    );
}
