#!/usr/bin/env tsx
/**
 * Generate an ADMIN_PASSWORD_HASH for .env.local
 *
 * Usage: npx tsx scripts/hash-password.ts <password>
 */

import { scrypt, randomBytes } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error("Usage: npx tsx scripts/hash-password.ts <password>");
    process.exit(1);
  }

  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const hash = `${salt}:${derived.toString("hex")}`;

  console.log("\nAdd this to your .env.local and Vercel:\n");
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
}

main();
