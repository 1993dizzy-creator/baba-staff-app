import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

const messages = {
  ko: {
    missingAction: "요청 구분이 없습니다.",
    missingRecord: "휴무 신청 정보가 없습니다.",
    noPermission: "권한이 없습니다.",
    updateError: "휴무 승인 처리 중 오류가 발생했습니다.",
    noTarget: "처리된 휴무 신청이 없습니다.",
    successApprove: "휴무 승인되었습니다.",
    successCancelApproval: "휴무 승인이 취소되었습니다.",
    exception: "휴무 승인 처리 중 오류가 발생했습니다.",
  },
  vi: {
    missingAction: "Không có loại yêu cầu.",
    missingRecord: "Không có thông tin yêu cầu nghỉ.",
    noPermission: "Không có quyền.",
    updateError: "Đã xảy ra lỗi khi xử lý duyệt nghỉ.",
    noTarget: "Không có yêu cầu nghỉ nào được xử lý.",
    successApprove: "Đã duyệt ngày nghỉ.",
    successCancelApproval: "Đã hủy duyệt ngày nghỉ.",
    exception: "Đã xảy ra lỗi khi xử lý duyệt nghỉ.",
  },
} as const;

type Lang = keyof typeof messages;

function getLang(value: unknown): Lang {
  return value === "vi" ? "vi" : "ko";
}

export async function POST(req: Request) {
  let lang: Lang = "ko";

  try {
    const body = await req.json();
    lang = getLang(body.language);

    const { action, record_id, admin_name } = body;

    if (!action) {
      return NextResponse.json(
        { ok: false, message: messages[lang].missingAction },
        { status: 400 }
      );
    }

    if (!record_id) {
      return NextResponse.json(
        { ok: false, message: messages[lang].missingRecord },
        { status: 400 }
      );
    }

    if (action === "approve") {
      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update({
          approval_status: "approved",
          approved_by: admin_name || null,
          approved_at: new Date().toISOString(),
        })
        .eq("id", record_id)
        .eq("status", "leave")
        .select("id, approval_status, approved_by, approved_at");

      if (error) {
        console.error("leave approve error:", error);
        return NextResponse.json(
          { ok: false, message: messages[lang].updateError },
          { status: 500 }
        );
      }

      if (!data || data.length === 0) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noTarget },
          { status: 404 }
        );
      }

      return NextResponse.json({
        ok: true,
        message: messages[lang].successApprove,
      });
    }

    if (action === "cancel-approval") {
      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update({
          approval_status: "pending",
          approved_by: null,
          approved_at: null,
        })
        .eq("id", record_id)
        .eq("status", "leave")
        .select("id, approval_status, approved_by, approved_at");

      if (error) {
        console.error("leave cancel approval error:", error);
        return NextResponse.json(
          { ok: false, message: messages[lang].updateError },
          { status: 500 }
        );
      }

      if (!data || data.length === 0) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noTarget },
          { status: 404 }
        );
      }

      return NextResponse.json({
        ok: true,
        message: messages[lang].successCancelApproval,
      });
    }

    return NextResponse.json(
      { ok: false, message: messages[lang].missingAction },
      { status: 400 }
    );
  } catch (err) {
    console.error("leave admin exception:", err);

    return NextResponse.json(
      { ok: false, message: messages[lang].exception },
      { status: 500 }
    );
  }
}