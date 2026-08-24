import { config } from "dotenv";
import path from "node:path";

// Plain `dotenv/config` only loads a file literally named `.env` — this project
// follows Next.js convention and keeps secrets in `.env.local` instead, so CLI
// scripts need to point dotenv at it explicitly.
config({ path: path.resolve(process.cwd(), ".env.local") });
