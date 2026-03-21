import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    const db = await getDb();
    const result = await db.execute(sql`SELECT NOW() as time`);
    return NextResponse.json({
      status: "ok",
      database: "connected",
      time: result.rows[0]?.time,
    });
  } catch (error) {
    console.error("Health check failed:", error);
    return NextResponse.json(
      { status: "error", database: "disconnected", error: String(error) },
      { status: 500 }
    );
  }
}
