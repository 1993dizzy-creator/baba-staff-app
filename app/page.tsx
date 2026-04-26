"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn } from "@/lib/supabase/auth";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => {
      if (isLoggedIn()) {
        router.replace("/inventory");
      } else {
        router.replace("/login");
      }
    }, 700);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <main
      style={{
        minHeight: "100dvh",
        background:
          "radial-gradient(circle at top, #374151 0%, #111827 45%, #030712 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          justifyItems: "center",
          gap: 18,
          transform: "translateY(-20px)",
        }}
      >
        <div
          style={{
            width: 118,
            height: 118,
            borderRadius: 28,
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.16)",
            boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(14px)",
            animation: "logoFloat 1.8s ease-in-out infinite",
          }}
        >
          <img
            src="/img/logo-w.png"
            alt="BABA"
            style={{
              width: 78,
              height: "auto",
              display: "block",
            }}
          />
        </div>

        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.18em",
            color: "rgba(255,255,255,0.72)",
          }}
        >
          BABA STAFF APP
        </div>

        <div
          style={{
            width: 120,
            height: 3,
            borderRadius: 999,
            background: "rgba(255,255,255,0.14)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "45%",
              height: "100%",
              borderRadius: 999,
              background: "white",
              animation: "loadingBar 1.1s ease-in-out infinite",
            }}
          />
        </div>
      </div>

      <style jsx>{`
        @keyframes logoFloat {
          0%,
          100% {
            transform: translateY(0) scale(1);
          }
          50% {
            transform: translateY(-8px) scale(1.03);
          }
        }

        @keyframes loadingBar {
          0% {
            transform: translateX(-130%);
          }
          100% {
            transform: translateX(260%);
          }
        }
      `}</style>
    </main>
  );
}