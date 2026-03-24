import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/lib/db/schema.ts",
    "./src/lib/semantos-kernel/schema.core.ts",
    "./src/lib/semantos-kernel/verticals/trades/schema.trades.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
