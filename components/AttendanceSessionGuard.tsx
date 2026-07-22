"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import {
  classifyAttendanceSessionResponse,
  saveAttendanceReturnPath,
  type AttendanceSessionGateState,
} from "@/lib/auth/attendance-session-transition";

type SessionUser = {
  id: number;
  username: string;
  name: string;
  role: string;
  part: string | null;
  position: string | null;
};

type SessionResponse = {
  authenticated?: boolean;
  code?: string;
  user?: SessionUser;
};

const copy = {
  ko: {
    checking: "로그인 상태를 확인하고 있습니다.",
    title: "로그인 확인이 필요합니다",
    description:
      "안전한 출퇴근 처리를 위해 로그인 상태를 한 번 확인해야 합니다. 다시 로그인하면 원래 근태 화면으로 돌아옵니다.",
    login: "다시 로그인",
    configurationTitle: "서버 로그인 설정을 확인해 주세요",
    configurationDescription:
      "다시 로그인해도 해결되지 않는 문제입니다. 관리자에게 알려 주세요.",
    forbiddenTitle: "근태 화면을 사용할 수 없습니다",
    forbiddenDescription: "현재 계정의 접근 권한을 관리자에게 확인해 주세요.",
    errorTitle: "로그인 상태를 확인하지 못했습니다",
    errorDescription:
      "네트워크 연결을 확인한 뒤 다시 시도해 주세요. 확인 전에는 안전을 위해 출퇴근 기능을 사용할 수 없습니다.",
    retry: "다시 시도",
  },
  vi: {
    checking: "Đang kiểm tra trạng thái đăng nhập.",
    title: "Cần xác nhận đăng nhập",
    description:
      "Để chấm công an toàn, bạn cần đăng nhập lại một lần. Sau khi đăng nhập, ứng dụng sẽ quay lại màn hình chấm công hiện tại.",
    login: "Đăng nhập lại",
    configurationTitle: "Vui lòng kiểm tra cài đặt đăng nhập máy chủ",
    configurationDescription:
      "Đăng nhập lại không thể khắc phục lỗi này. Vui lòng báo cho quản lý.",
    forbiddenTitle: "Không thể sử dụng màn hình chấm công",
    forbiddenDescription: "Vui lòng hỏi quản lý để kiểm tra quyền của tài khoản.",
    errorTitle: "Không thể kiểm tra trạng thái đăng nhập",
    errorDescription:
      "Vui lòng kiểm tra kết nối mạng rồi thử lại. Để đảm bảo an toàn, chức năng chấm công tạm thời chưa thể sử dụng.",
    retry: "Thử lại",
  },
} as const;

function mergeSessionUser(user: SessionUser) {
  try {
    const raw = window.localStorage.getItem("baba_user");
    const cached = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem(
      "baba_user",
      JSON.stringify({ ...cached, ...user })
    );
  } catch {
    // A valid server session remains sufficient even when local storage is unavailable.
  }
}

export default function AttendanceSessionGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { lang } = useLanguage();
  const t = copy[lang];
  const [gate, setGate] = useState<AttendanceSessionGateState>({
    status: "checking",
  });
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const checkSession = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const requestId = ++requestIdRef.current;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    if (mountedRef.current) setGate({ status: "checking" });

    try {
      const response = await fetch("/api/session", {
        cache: "no-store",
        signal: abortController.signal,
      });
      const body = (await response.json().catch(() => null)) as SessionResponse | null;
      if (!mountedRef.current || requestId !== requestIdRef.current) return;

      const nextGate = classifyAttendanceSessionResponse(response.status, body);
      if (nextGate.status === "authenticated" && body?.user) {
        mergeSessionUser(body.user);
      }
      setGate(nextGate);
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setGate({ status: "error", reason: "network" });
      }
    } finally {
      if (requestId === requestIdRef.current) {
        inFlightRef.current = false;
        abortControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void checkSession();
    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      requestIdRef.current += 1;
      inFlightRef.current = false;
    };
  }, [checkSession]);

  const handleRelogin = () => {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    saveAttendanceReturnPath(window.sessionStorage, returnPath);
    router.push("/login");
  };

  if (gate.status === "authenticated") return children;

  if (gate.status === "checking") {
    return (
      <main style={{ padding: "48px 20px", textAlign: "center", color: "#6b7280" }}>
        {t.checking}
      </main>
    );
  }

  const reloginRequired = gate.status === "relogin_required";
  const configurationError =
    gate.status === "error" && gate.reason === "configuration";
  const forbidden = gate.status === "error" && gate.reason === "forbidden";
  const title = reloginRequired
    ? t.title
    : configurationError
      ? t.configurationTitle
      : forbidden
        ? t.forbiddenTitle
        : t.errorTitle;
  const description = reloginRequired
    ? t.description
    : configurationError
      ? t.configurationDescription
      : forbidden
        ? t.forbiddenDescription
        : t.errorDescription;

  return (
    <main style={{ padding: "32px 20px" }}>
      <section
        role="status"
        aria-live="polite"
        style={{ ...ui.card, maxWidth: 520, margin: "0 auto", padding: 24 }}
      >
        <h1 style={{ margin: 0, fontSize: 22, color: "#111827" }}>{title}</h1>
        <p style={{ margin: "12px 0 22px", color: "#4b5563", lineHeight: 1.65 }}>
          {description}
        </p>
        {reloginRequired ? (
          <button type="button" onClick={handleRelogin} style={ui.button}>
            {t.login}
          </button>
        ) : gate.reason !== "configuration" && gate.reason !== "forbidden" ? (
          <button type="button" onClick={() => void checkSession()} style={ui.button}>
            {t.retry}
          </button>
        ) : null}
      </section>
    </main>
  );
}
