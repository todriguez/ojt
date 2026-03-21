import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { customers, sites, jobs } from "@/lib/db/schema";
import { eq, desc, sql, ilike, or } from "drizzle-orm";
import { z } from "zod";

// ── Validation ──────────────────────────────

const createCustomerSchema = z.object({
  organisationId: z.string().uuid(),
  name: z.string().min(1),
  mobile: z.string().optional(),
  email: z.string().email().optional(),
  preferredContactChannel: z.enum(["sms", "email", "phone", "whatsapp", "messenger", "webchat"]).optional(),
  notes: z.string().optional(),
});

// ── GET /api/v2/customers ───────────────────

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const { searchParams } = new URL(request.url);

    const search = searchParams.get("search");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = parseInt(searchParams.get("offset") || "0");

    const whereClause = search
      ? or(
          ilike(customers.name, `%${search}%`),
          ilike(customers.email, `%${search}%`),
          ilike(customers.mobile, `%${search}%`)
        )
      : undefined;

    const query = db
      .select()
      .from(customers)
      .$dynamic();

    const results = await (whereClause
      ? query.where(whereClause).orderBy(desc(customers.createdAt)).limit(limit).offset(offset)
      : query.orderBy(desc(customers.createdAt)).limit(limit).offset(offset));

    return NextResponse.json({ customers: results });
  } catch (error) {
    console.error("GET /api/v2/customers error:", error);
    return NextResponse.json({ error: "Failed to fetch customers" }, { status: 500 });
  }
}

// ── POST /api/v2/customers ──────────────────

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    const body = await request.json();
    const validated = createCustomerSchema.parse(body);

    const [newCustomer] = await db
      .insert(customers)
      .values(validated)
      .returning();

    return NextResponse.json(newCustomer, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("POST /api/v2/customers error:", error);
    return NextResponse.json({ error: "Failed to create customer" }, { status: 500 });
  }
}
