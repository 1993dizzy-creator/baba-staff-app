import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const userId = searchParams.get("user_id");
    const workDate = searchParams.get("work_date");
    const startDate = searchParams.get("start_date");
    const endDate = searchParams.get("end_date");
    const status = searchParams.get("status");

    let query = supabaseServer.from("attendance_records").select("*");

    if (userId) {
      query = query.eq("user_id", userId);
    }

    if (workDate) {
      query = query.eq("work_date", workDate);
    }

    if (startDate) {
      query = query.gte("work_date", startDate);
    }

    if (endDate) {
      query = query.lte("work_date", endDate);
    }

    if (status) {
      query = query.eq("status", status);
    }

    query = query.order("work_date", { ascending: true });

    const { data, error } = await query;

    if (error) {
      console.error("attendance records error:", error);

      return NextResponse.json(
        {
          ok: false,
          message: "근태 기록 조회 중 오류가 발생했습니다.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      records: data ?? [],
    });
  } catch (err) {
    console.error("attendance records exception:", err);

    return NextResponse.json(
      {
        ok: false,
        message: "근태 기록 처리 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}