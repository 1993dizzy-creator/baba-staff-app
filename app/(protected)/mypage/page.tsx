"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { getUser } from "@/lib/supabase/auth";
import { useLanguage } from "@/lib/language-context";
import { mypageText } from "@/lib/text";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";

type UserInfo = {
  id: number;
  username: string;
  name: string;
  part: string | null;
  position: string | null;
  birth_date: string | null;
  hire_date: string | null;
};

export default function MyPage() {
  const { lang } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);

  const t = mypageText[lang];

  const formatDate = (value: string | null) => {
    if (!value) return "-";
    return value;
  };

  const fetchMyInfo = async () => {
    const savedUser = getUser();

    if (!savedUser?.id) {
      alert(t.noLoginInfo);
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("users")
      .select("id, username, name, part, position, birth_date, hire_date")
      .eq("id", savedUser.id)
      .single();

    if (error) {
      console.error(error);
      alert(t.fetchFail);
      setLoading(false);
      return;
    }

    setUserInfo(data);
    setLoading(false);
  };

  useEffect(() => {
    fetchMyInfo();
  }, []);

  if (loading) {
    return <Container>{t.loading}</Container>;
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
            <b>{t.position}:</b> {userInfo?.position || "-"}
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