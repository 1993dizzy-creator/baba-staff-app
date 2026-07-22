import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const transitionModulePath = "../lib/auth/attendance-session-transition.ts";
const {
  ATTENDANCE_RETURN_PATH_KEY,
  classifyAttendanceSessionResponse,
  isSafeAttendanceReturnPath,
  saveAttendanceReturnPath,
  takeAttendanceReturnPath,
} = await import(transitionModulePath);

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

test("attendance session responses distinguish login, configuration, and network-safe errors", () => {
  assert.deepEqual(classifyAttendanceSessionResponse(200, { authenticated: true }), {
    status: "authenticated",
  });
  assert.deepEqual(classifyAttendanceSessionResponse(401, { code: "RELOGIN_REQUIRED" }), {
    status: "relogin_required",
  });
  assert.deepEqual(classifyAttendanceSessionResponse(500, { code: "SESSION_CONFIG_ERROR" }), {
    status: "error",
    reason: "configuration",
  });
  assert.deepEqual(classifyAttendanceSessionResponse(403, { code: "FORBIDDEN" }), {
    status: "error",
    reason: "forbidden",
  });
  assert.deepEqual(classifyAttendanceSessionResponse(401, null), {
    status: "error",
    reason: "server",
  });
});

test("only same-site attendance return paths are accepted", () => {
  for (const path of [
    "/attendance",
    "/attendance/leave?month=2026-07",
    "/attendance/overview/42?month=2026-07&date=2026-07-22",
  ]) {
    assert.equal(isSafeAttendanceReturnPath(path), true, path);
  }

  for (const path of [
    "/login",
    "/inventory",
    "//example.com/attendance",
    "https://example.com/attendance",
    "/\\example.com/attendance",
    " /attendance",
    "/attendance#fragment",
  ]) {
    assert.equal(isSafeAttendanceReturnPath(path), false, path);
  }
});

test("a return path is consumed once and invalid values are removed", () => {
  const storage = createStorage();
  assert.equal(saveAttendanceReturnPath(storage, "/attendance/leave?month=2026-07"), true);
  assert.equal(
    storage.getItem(ATTENDANCE_RETURN_PATH_KEY),
    "/attendance/leave?month=2026-07"
  );
  assert.equal(takeAttendanceReturnPath(storage), "/attendance/leave?month=2026-07");
  assert.equal(takeAttendanceReturnPath(storage), null);

  storage.setItem(ATTENDANCE_RETURN_PATH_KEY, "https://example.com");
  assert.equal(takeAttendanceReturnPath(storage), null);
  assert.equal(storage.getItem(ATTENDANCE_RETURN_PATH_KEY), null);
});

test("attendance layout gates child pages without the legacy me fallback", () => {
  const layout = read("app/(protected)/attendance/layout.tsx");
  const guard = read("components/AttendanceSessionGuard.tsx");
  const refresher = read("components/UserSessionRefresher.tsx");

  assert.match(layout, /<AttendanceSessionGuard>\{children\}<\/AttendanceSessionGuard>/);
  assert.match(guard, /fetch\("\/api\/session"/);
  assert.doesNotMatch(guard, /\/api\/me/);
  assert.match(guard, /gate\.status === "authenticated"/);
  assert.match(guard, /saveAttendanceReturnPath/);
  assert.match(guard, /abortControllerRef\.current\?\.abort\(\)/);
  assert.match(refresher, /pathname\.startsWith\("\/attendance"\)/);
});

test("login consumes the safe path only after a successful login", () => {
  const login = read("app/login/page.tsx");
  const failureIndex = login.indexOf("if (!res.ok || !result.ok)");
  const saveUserIndex = login.indexOf('localStorage.setItem("baba_user"');
  const consumeIndex = login.indexOf("const returnPath = takeAttendanceReturnPath");

  assert.ok(failureIndex >= 0);
  assert.ok(saveUserIndex > failureIndex);
  assert.ok(consumeIndex > saveUserIndex);
  assert.match(login, /router\.replace\(returnPath \|\| \(isAdmin/);
});

test("attendance APIs and the unauthenticated me route remain unchanged by the guard", () => {
  for (const path of [
    "app/api/attendance/records/route.ts",
    "app/api/attendance/users/route.ts",
    "app/api/attendance/check-in/route.ts",
    "app/api/attendance/check-out/route.ts",
    "app/api/me/route.ts",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /getAuthenticatedActor|requireRole/);
  }
});
