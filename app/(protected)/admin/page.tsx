"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { getUser, isAdmin, isManage } from "@/lib/supabase/auth";
import { ui } from "@/lib/styles/ui";

type AdminMenuAccess = "manage" | "admin";

const adminMenus = [
  {
    title: {
      ko: "매출확인",
      vi: "Kiểm tra doanh thu",
    },
    description: {
      ko: "POS 매출, 영수증, 일간/월간 현황을 확인합니다.",
      vi: "Kiểm tra doanh thu, hóa đơn và tình hình bán hàng.",
    },
    href: "/admin/sales",
    badge: "SALES",
    emoji: "💰",
    access: "manage" as AdminMenuAccess,
  },
  {
    title: {
      ko: "직원생성",
      vi: "Tạo nhân viên",
    },
    description: {
      ko: "직원 계정을 생성하고 기본 권한, 파트, 직급을 설정합니다.",
      vi: "Tạo tài khoản nhân viên và thiết lập quyền cơ bản.",
    },
    href: "/admin/users/create",
    badge: "USER",
    emoji: "👤",
    access: "admin" as AdminMenuAccess,
  },
  {
    title: {
      ko: "급여관리",
      vi: "Quản lý lương",
    },
    description: {
      ko: "근태 기록을 기준으로 급여 정산 화면을 준비합니다.",
      vi: "Quản lý lương dựa trên dữ liệu chấm công.",
    },
    href: "/admin/payroll",
    badge: "PAY",
    emoji: "💳",
    access: "admin" as AdminMenuAccess,
  },
  {
    title: {
      ko: "포스설정",
      vi: "Cài đặt POS",
    },
    description: {
      ko: "CUKCUK POS 연동, 상품 매핑, 재고 차감 설정을 관리합니다.",
      vi: "Thiết lập POS và kiểm tra dữ liệu liên kết.",
    },
    href: "/admin/pos",
    badge: "POS",
    emoji: "⚙️",
    access: "admin" as AdminMenuAccess,
  },
];

const adminPageText = {
  ko: {
    title: "관리자 메뉴",
    description: "매출, 직원, 급여, POS 설정을 한곳에서 관리합니다.",
    pendingTitle: "운영 기능 준비 중",
    pendingDescription:
      "현재 manager 권한으로 접근 가능한 운영 메뉴를 준비하고 있습니다.",
  },
  vi: {
    title: "Menu quản trị",
    description: "Quản lý doanh thu, nhân viên, lương và POS tại một nơi.",
    pendingTitle: "Chức năng vận hành đang chuẩn bị",
    pendingDescription:
      "Hiện chỉ có menu kiểm tra doanh thu dành cho quyền manager.",
  },
} as const;

export default function AdminPage() {
  const { lang } = useLanguage();
  const text = adminPageText[lang];
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState<ReturnType<typeof getUser>>(null);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      const user = getUser();
      setCurrentUser(user);
      setPermissionChecked(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const visibleMenus =
    permissionChecked && currentUser
      ? adminMenus.filter((menu) =>
          menu.access === "manage" ? isManage(currentUser) : isAdmin(currentUser),
        )
      : [];

  return (
    <Container>
      <section style={styles.header}>
        <div style={styles.badgeRow}>
          <span style={styles.adminBadge}>ADMIN</span>
        </div>
        <h1 style={styles.title}>{text.title}</h1>
        <p style={styles.description}>{text.description}</p>
      </section>

      {permissionChecked && visibleMenus.length > 0 && (
        <section style={styles.menuList}>
          {visibleMenus.map((menu) => (
            <Link key={menu.href} href={menu.href} style={styles.menuCard}>
              <span style={styles.emojiBox} aria-hidden="true">
                {menu.emoji}
              </span>

              <span style={styles.menuBody}>
                <span style={styles.menuTitleRow}>
                  <strong style={styles.menuTitle}>{menu.title[lang]}</strong>
                  <span style={styles.menuBadge}>{menu.badge}</span>
                </span>
                <span style={styles.menuDescription}>
                  {menu.description[lang]}
                </span>
              </span>

              <span style={styles.arrow} aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </section>
      )}

      {permissionChecked && visibleMenus.length === 0 && (
        <section style={styles.pendingCard}>
          <span style={styles.emojiBox} aria-hidden="true">
            🏪
          </span>
          <span style={styles.menuBody}>
            <strong style={styles.menuTitle}>{text.pendingTitle}</strong>
            <span style={styles.menuDescription}>{text.pendingDescription}</span>
          </span>
        </section>
      )}
    </Container>
  );
}

const styles = {
  header: {
    marginBottom: 12,
  },
  badgeRow: {
    display: "flex",
    marginBottom: 6,
  },
  adminBadge: {
    ...ui.badgeMini,
    background: "#111827",
  },
  title: {
    margin: "0 0 5px",
    fontSize: 22,
    lineHeight: 1.25,
    fontWeight: 950,
    color: "#111827",
  },
  description: {
    ...ui.metaText,
    margin: 0,
    fontSize: 13,
    fontWeight: 700,
  },
  menuList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  menuCard: {
    ...ui.card,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "11px 12px",
    borderRadius: 14,
    color: "#111827",
    textDecoration: "none",
  },
  pendingCard: {
    ...ui.card,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "11px 12px",
    borderRadius: 14,
    color: "#111827",
  },
  emojiBox: {
    width: 34,
    height: 34,
    borderRadius: 10,
    background: "#f9fafb",
    border: "1px solid #eef0f3",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 17,
    flexShrink: 0,
  },
  menuBody: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  menuTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minWidth: 0,
  },
  menuTitle: {
    fontSize: 14,
    fontWeight: 900,
    lineHeight: 1.3,
    color: "#111827",
  },
  menuBadge: {
    ...ui.badgeMini,
    background: "#111827",
    flexShrink: 0,
  },
  menuDescription: {
    ...ui.metaText,
    fontSize: 12,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  arrow: {
    color: "#9ca3af",
    fontSize: 16,
    fontWeight: 900,
    flexShrink: 0,
  },
} satisfies Record<string, CSSProperties>;
