import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const page = fs.readFileSync(
  path.join(process.cwd(), "app/(protected)/attendance/leave/page.tsx"),
  "utf8"
);

test("every role requests the selected month's complete leave records", () => {
  assert.match(page, /requestLeaveRecords\(date: Date\)/);
  assert.match(
    page,
    /scope=leave_month&month=\$\{month\}/
  );
  assert.doesNotMatch(page, /userQuery/);
  assert.doesNotMatch(page, /canManageLeave \? undefined : currentUser\?\.id/);
  assert.match(page, /const visibleLeaveRecords = leaveRecords/);
});

test("staff controls remain own-record only while admin record actions stay gated", () => {
  assert.match(
    page,
    /normalizeId\(record\.user_id\) === normalizeId\(currentUser\?\.id\)/
  );
  assert.match(page, /\{canManageLeave && \(/);
  assert.match(page, /\{!canManageLeave && \(/);
  assert.doesNotMatch(page, /user_id: currentUser\.id/);
  assert.doesNotMatch(page, /admin_id: currentUser\?\.id/);
  assert.match(page, /attendanceFetch\(url/);
  assert.match(
    page,
    /normalizeId\(record\.user_id\) === normalizeId\(currentUser\?\.id\)/
  );
  assert.match(page, /LEAVE_ACTION\.CANCEL_REQUEST/);
  assert.match(page, /copy\.cancelForbidden/);
  assert.match(page, /copy\.cancelApprovalFirst/);
  assert.match(page, /copy\.cancelNotFound/);
});

test("pending leave remains ordered before approved leave for every viewer", () => {
  assert.match(page, /const approvalDiff =/);
  assert.doesNotMatch(page, /if \(canManageLeave\) \{\s*const approvalDiff/);
});
