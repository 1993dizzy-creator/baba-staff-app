import { NextResponse } from "next/server";

function getSnapshotDate() {
    const now = new Date();
    const vietnamTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    vietnamTime.setDate(vietnamTime.getDate() - 1);

    const yyyy = vietnamTime.getFullYear();
    const mm = String(vietnamTime.getMonth() + 1).padStart(2, "0");
    const dd = String(vietnamTime.getDate()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
}

export async function GET(request: Request) {
    try {
        const authHeader = request.headers.get("authorization");
        const userAgent = request.headers.get("user-agent") || "";
        const isCron = userAgent.includes("vercel-cron");
        const expected = `Bearer ${process.env.CRON_SECRET}`;

        if (!isCron && authHeader !== expected) {
            return NextResponse.json(
                { ok: false, step: "unauthorized", message: "Unauthorized" },
                { status: 401 }
            );
        }

        const snapshotDate = getSnapshotDate();

        return NextResponse.json({
            ok: true,
            step: "passed-before-db",
            userAgent,
            isCron,
            snapshotDate,
            now: new Date().toISOString(),
        });
    } catch (error) {
        return NextResponse.json(
            {
                ok: false,
                step: "top-level-catch",
                error: error instanceof Error ? error.message : String(error),
            },
            { status: 500 }
        );
    }
}