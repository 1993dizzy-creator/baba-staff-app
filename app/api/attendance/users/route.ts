import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET() {
  try {
    const { data, error } = await supabaseServer
      .from("users")
      .select(
        `
        id,
        username,
        name,
        full_name,
        role,
        is_active,
        part,
        position,
        birth_date,
        hire_date,
        gender,
        work_start_time,
        work_end_time
      `
      )
      .eq("is_active", true)
      .order("part", { ascending: true })
      .order("position", { ascending: true })
      .order("name", { ascending: true });

    if (error) {
      console.error("attendance users error:", error);

      return NextResponse.json(
        {
          ok: false,
          message: "직원 목록 조회 중 오류가 발생했습니다.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      users: data ?? [],
    });
  } catch (err) {
    console.error("attendance users exception:", err);

    return NextResponse.json(
      {
        ok: false,
        message: "직원 목록 처리 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}