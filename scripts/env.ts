import { existsSync } from "node:fs";

/** Scripts read the same .env files the Next.js server does. */
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
