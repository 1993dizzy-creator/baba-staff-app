import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const messages = {
  ko: {
    required: "아이디와 비밀번호를 입력하세요.",
    serverError: "서버 오류가 발생했습니다.",
    invalid: "아이디 또는 비밀번호가 올바르지 않습니다.",
    exception: "요청 처리 중 오류가 발생했습니다.",
  },
  vi: {
    required: "Vui lòng nhập tài khoản và mật khẩu.",
    serverError: "Đã xảy ra lỗi máy chủ.",
    invalid: "Tài khoản hoặc mật khẩu không đúng.",
    exception: "Đã xảy ra lỗi khi xử lý yêu cầu.",
  },
};

export async function POST(req: Request) {
  try {
    const { username, password, lang = "ko" } = await req.json();

    const t = messages[lang === "vi" ? "vi" : "ko"];

    if (!username || !password) {
      return NextResponse.json(
        { ok: false, message: t.required },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin
      .from("users")
      .select(
        `
        id,
        username,
        name,
        full_name,
        role,
        part,
        position,
        birth_date,
        hire_date,
        gender,
        work_start_time,
        work_end_time,
        is_active
      `
      )
      .eq("username", username)
      .eq("password", password)
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      console.error("login error:", error);
      return NextResponse.json(
        { ok: false, message: t.serverError },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json(
        { ok: false, message: t.invalid },
        { status: 401 }
      );
    }

    return NextResponse.json({
      ok: true,
      user: data,
    });
  } catch (err) {
    console.error("login exception:", err);
    return NextResponse.json(
      { ok: false, message: messages.ko.exception },
      { status: 500 }
    );
  }
}