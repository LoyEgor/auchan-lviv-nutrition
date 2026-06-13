// Shared helpers for the per-store scrapers and the data build step.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRAPER_DIR = dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = join(SCRAPER_DIR, "raw");
export const OUT_DIR = join(SCRAPER_DIR, "..", "public", "data");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, { headers = {}, tries = 5, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 200) return await res.json();
      if (res.status === 404) return null;
      lastErr = new Error(`HTTP ${res.status}`);
      // Back off harder when the API is throttling or failing.
      await sleep((res.status === 429 || res.status >= 500 ? 1500 : 600) * (i + 1));
      continue;
    } catch (e) {
      lastErr = e;
    }
    await sleep(600 * (i + 1));
  }
  throw new Error(`failed ${url}: ${lastErr?.message}`);
}

// Pull the first numeric value out of strings like "197.00ккал", "9,95г", "389,2/1625,6".
export function num(s) {
  if (s == null) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const m = String(s).replace(/,/g, ".").match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

export async function writeJson(path, data, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

export async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// Run an async worker over all items with a fixed concurrency.
export async function pool(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}
