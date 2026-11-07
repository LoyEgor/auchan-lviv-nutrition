// Shared helpers for the per-store scrapers and the data build step.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRAPER_DIR = dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = join(SCRAPER_DIR, "raw");
export const OUT_DIR = join(SCRAPER_DIR, "..", "public", "data");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-host "don't call before" timestamps. A 429 on one request means the whole
// host is throttling us, so every concurrent worker pauses together instead of
// each one hammering on and burning its retries inside the same throttle window
// (zakaz.ua keeps a window open for over a minute).
const cooldownUntil = new Map();

function retryAfterMs(res) {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export async function fetchJson(url, { headers = {}, tries = 5, throttleTries = 9, timeoutMs = 30000 } = {}) {
  const host = new URL(url).host;
  let lastErr;
  let attempts = 0; // non-429 failures; 429s have their own budget
  let throttled = 0;
  while (attempts < tries) {
    const wait = (cooldownUntil.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 200) return await res.json();
      if (res.status === 404) return null;
      if (res.status === 429) {
        lastErr = new Error("HTTP 429");
        if (++throttled > throttleTries) break;
        // 5s, 10s, 20s, 40s, then 60s; Retry-After wins when the API sends it.
        const delay = retryAfterMs(res) ?? Math.min(60000, 5000 * 2 ** (throttled - 1)) + Math.random() * 2000;
        cooldownUntil.set(host, Math.max(cooldownUntil.get(host) ?? 0, Date.now() + delay));
        continue;
      }
      attempts++;
      // Client errors other than 404/429 won't fix on retry — fail fast.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP ${res.status} (not retryable)`);
      }
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(1500 * attempts);
      continue;
    } catch (e) {
      if (!String(e?.message).startsWith("HTTP")) attempts++; // network error / timeout
      lastErr = e;
    }
    await sleep(600 * attempts);
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
