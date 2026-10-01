import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { EARLY_LEAVE_REVIEW_START_DATE, type EarlyLeaveSelection } from "./early-leave-review";

export type EarlyLeaveReviewContext = {
  id: number;
  user_id: number;
  work_date: string;
  rawEarlyLeaveMinutes: number;
  earlyLeaveGraceMinutes: number;
  effectiveEarlyLeaveMinutes: number;
  normalCheckoutThresholdAt: string | null;
  earlyLeaveSelection: EarlyLeaveSelection | null;
  earlyLeaveReviewRequired: boolean;
};

export async function loadEarlyLeaveReviewContexts(start: string, end: string, userId?: number) {
  if (end < EARLY_LEAVE_REVIEW_START_DATE || end < start) return new Map<number, EarlyLeaveReviewContext>();
  const {data, error} = await supabaseServer.rpc("attendance_early_leave_contexts_v1", {
    p_start: start, p_end: end, p_user_id: userId ?? null,
  });
  if (error) throw new Error(`EARLY_LEAVE_REVIEW_READ_FAILED:${error.code}`);
  return new Map((data as EarlyLeaveReviewContext[]).map(context => [Number(context.id), context]));
}
