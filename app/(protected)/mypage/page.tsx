"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { getUser } from "@/lib/supabase/auth";
import { useLanguage } from "@/lib/language-context";
import { mypageText } from "@/lib/text";
import Container from "@/components/Container";
import LoadingState from "@/components/LoadingState";
import { ui } from "@/lib/styles/ui";
import { getEmployeeRoleLabel } from "@/lib/common/roles";

type UserInfo = {
  id: number;
  username: string;
  name: string;
  part: string | null;
  position: string | null;
  role: string | null;
  birth_date: string | null;
  hire_date: string | null;
};

export default function MyPage() {
  const { lang } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loadError, setLoadError] = useState<"login" | "fetch" | null>(null);
  const requestSequenceRef = useRef(0);

  const t = mypageText[lang];

  const formatDate = (value?: string | null) => {
    if (!value) return "-";
    return value;
  };

  const fetchMyInfo = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const savedUser = getUser();
      if (!savedUser?.id) {
        setUserInfo(null);
        setLoadError("login");
        return;
      }
      const { data, error } = await supabase
        .from("users")
        .select("id, username, name, part, position, role, birth_date, hire_date")
        .eq("id", savedUser.id)
        .single();
      if (requestSequence !== requestSequenceRef.current) return;
      if (error || !data) throw new Error("PROFILE_LOAD_FAILED");
      setUserInfo(data);
    } catch {
      if (requestSequence === requestSequenceRef.current) {
        setUserInfo(null);
        setLoadError("fetch");
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMyInfo();
    return () => { requestSequenceRef.current += 1; };
  }, [fetchMyInfo]);

  if (loading) {
    return <Container><LoadingState label={t.loading} variant="page" /></Container>;
  }

  if (loadError || !userInfo) {
    return <Container>
      <h1>{t.title}</h1>
      <div role="alert" style={{ ...ui.card, padding: 20 }}>
        <p>{loadError === "login" ? t.noLoginInfo : t.fetchFail}</p>
        <button type="button" onClick={() => void fetchMyInfo()} style={ui.subButton}>{t.retry}</button>
      </div>
    </Container>;
  }

  return (
    <Container>
      <h1 style={{ fontSize: 32, fontWeight: "bold", marginBottom: 20 }}>
        {t.title}
      </h1>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            ...ui.card,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>
            Account
          </div>

          <div>
            <b>{t.name}:</b> {userInfo?.name || "-"}
          </div>
          <div>
            <b>{t.username}:</b> {userInfo?.username || "-"}
          </div>
          <div>
            <b>{t.birthDate}:</b> {formatDate(userInfo?.birth_date)}
          </div>
        </div>

        <div
          style={{
            ...ui.card,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>
            Work Info
          </div>

          <div>
            <b>{t.position}:</b> {userInfo?.role ? getEmployeeRoleLabel(userInfo.role, lang) : "-"}
          </div>
          <div>
            <b>{t.part}:</b> {userInfo?.part || "-"}
          </div>
          <div>
            <b>{t.hireDate}:</b> {formatDate(userInfo?.hire_date)}
          </div>
        </div>
      </div>
    </Container>
  );
}
