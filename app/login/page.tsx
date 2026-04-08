"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import Image from "next/image";
import { ui } from "@/lib/styles/ui";

export default function LoginPage() {
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

        const { data, error } = await supabase
            .from("users")
            .select("*")
            .eq("username", username)
            .eq("password", password)
            .eq("is_active", true)
            .single();

        if (error || !data) {
            setLoading(false);
            alert("Login failed");
            return;
        }

        localStorage.setItem("baba_user", JSON.stringify(data));
        alert("Login successful");
        setLoading(false);
        router.push("/inventory");
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