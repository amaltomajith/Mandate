/**
 * Downloads PaySim (Kaggle: ealaxi/paysim1) via Kaggle's public API and
 * extracts the CSV into data/paysim.csv. One-time setup for the fraud-spike
 * detector's training pipeline (scripts/risk/trainModel.ts) — never runs as
 * part of the app itself.
 *
 * Needs KAGGLE_USERNAME / KAGGLE_KEY in .env.local (from
 * kaggle.com/settings > API > Create New Token).
 *
 * Usage: npx tsx scripts/risk/downloadPaysim.ts
 */
import "../lib/loadEnv";
import * as fs from "node:fs";
import * as path from "node:path";
import * as unzipper from "unzipper";

const DATASET = "ealaxi/paysim1";
const OUT_DIR = path.resolve(process.cwd(), "data");
const CSV_PATH = path.resolve(OUT_DIR, "paysim.csv");

async function main() {
  const username = process.env.KAGGLE_USERNAME;
  const key = process.env.KAGGLE_KEY;
  if (!username || !key) {
    console.error("Set KAGGLE_USERNAME and KAGGLE_KEY in .env.local (kaggle.com/settings > API > Create New Token).");
    process.exit(1);
  }

  if (fs.existsSync(CSV_PATH)) {
    console.log(`${CSV_PATH} already exists — delete it first if you want to re-download.`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const url = `https://www.kaggle.com/api/v1/datasets/download/${DATASET}`;
  const auth = "Basic " + Buffer.from(`${username}:${key}`).toString("base64");

  console.log(`Downloading ${DATASET} from Kaggle (this is ~470MB zipped — may take a while)...`);
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kaggle download failed: HTTP ${res.status} ${res.statusText}. ${text.slice(0, 300)}`);
  }

  const zipPath = path.resolve(OUT_DIR, "paysim.zip");
  const fileStream = fs.createWriteStream(zipPath);
  const { Readable } = await import("node:stream");
  await new Promise<void>((resolve, reject) => {
    const nodeStream = Readable.fromWeb(res.body as never);
    nodeStream.pipe(fileStream);
    nodeStream.on("error", reject);
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });
  console.log(`Downloaded to ${zipPath}, extracting...`);

  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Parse())
    .on("entry", (entry: unzipper.Entry) => {
      if (entry.path.toLowerCase().endsWith(".csv")) {
        console.log(`Extracting ${entry.path} -> ${CSV_PATH}`);
        entry.pipe(fs.createWriteStream(CSV_PATH));
      } else {
        entry.autodrain();
      }
    })
    .promise();

  fs.unlinkSync(zipPath);
  console.log(`\nDone. ${CSV_PATH} is ready for scripts/risk/trainModel.ts.`);
}

main().catch((err) => {
  console.error("Download failed:", err);
  process.exit(1);
});
