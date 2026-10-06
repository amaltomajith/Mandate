import { config } from "dotenv";
import path from "node:path";

// Same file Next.js reads. Loaded before any module that touches process.env.
config({ path: path.resolve(process.cwd(), ".env.local") });
