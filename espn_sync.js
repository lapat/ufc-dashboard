"use strict";
/**
 * espn_sync.js - Synchronizes official transparent PNG cutout headshots from ESPN MMA API.
 * Sourced directly from ESPNs open CDN (zero API key, zero Cloudflare).
 * Resolves missing fighter photos (e.g. Losene Keita, Douglas Silva de Andrade, Robert Bryczek).
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, "..", "ufc_local_data");
const IMG_DIR = path.join(DATA_ROOT, "fighter_images");
const INDEX_FILE = path.join(IMG_DIR, "index.json");

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
let index = {};
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); } catch (_) {}
const saveIndex = () => { try { fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2)); } catch (_) {} };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function get(url, binary = false) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), binary));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")
      }));
    }).on("error", reject);
  });
}

function slugify(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function searchEspnAthlete(name) {
  const q = encodeURIComponent(name);
  const url = "https://site.web.api.espn.com/apis/search/v2?query=" + q + "&type=player&sport=mma";
  try {
    const res = await get(url, false);
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body);
    const players = json.results?.find(r => r.type === "player")?.contents || [];
    if (!players.length) return null;

    const normTarget = slugify(name);
    for (const p of players) {
      if (p.description?.includes("MMA") || p.link?.web?.includes("/mma/")) {
        const normPlayer = slugify(p.displayName);
        if (normPlayer === normTarget || normPlayer.includes(normTarget) || normTarget.includes(normPlayer)) {
          const athleteId = p.uid?.split("~a:")?.[1] || p.id;
          return { name: p.displayName, athleteId };
        }
      }
    }
    if (players[0]?.description?.includes("MMA")) {
      const athleteId = players[0].uid?.split("~a:")?.[1] || players[0].id;
      return { name: players[0].displayName, athleteId };
    }
  } catch (e) {
    return null;
  }
  return null;
}

async function downloadHeadshot(slug, athleteId) {
  const imgUrl = "https://a.espncdn.com/i/headshots/mma/players/full/" + athleteId + ".png";
  try {
    const res = await get(imgUrl, true);
    if (res.status === 200 && res.body.length > 2000) {
      const file = slug + ".png";
      const filePath = path.join(IMG_DIR, file);
      fs.writeFileSync(filePath, res.body);
      const md5 = crypto.createHash("md5").update(res.body).digest("hex");
      index[slug] = {
        status: "found",
        file,
        md5,
        source: imgUrl,
        provider: "espn",
        checkedAt: new Date().toISOString()
      };
      saveIndex();
      return { success: true, file, bytes: res.body.length };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
  return { success: false, error: "no image" };
}

async function syncSingle(name) {
  const slug = slugify(name);
  console.log("Searching ESPN for: " + name + " (" + slug + ")...");
  const match = await searchEspnAthlete(name);
  if (!match || !match.athleteId) {
    console.log("  ✗ No ESPN athlete match for " + name);
    return false;
  }
  console.log("  ✓ Matched ESPN Athlete ID: " + match.athleteId + " (" + match.name + ")");
  const dl = await downloadHeadshot(slug, match.athleteId);
  if (dl.success) {
    console.log("  ✓ Downloaded " + dl.file + " (" + dl.bytes + " bytes)");
    return true;
  } else {
    console.log("  ✗ Headshot not available on ESPN CDN (" + dl.error + ")");
    return false;
  }
}

async function run() {
  const args = process.argv.slice(2);
  if (args.includes("--fighter")) {
    const idx = args.indexOf("--fighter");
    const name = args[idx + 1];
    await syncSingle(name);
    return;
  }

  const misses = Object.entries(index)
    .filter(([k, v]) => v.status === "miss" || v.status === "wrong-source" || v.status === "shared")
    .map(([slug]) => slug);

  console.log("=== ESPN Headshot Sync ===");
  console.log("Total fighters in index: " + Object.keys(index).length);
  console.log("Fighters marked as miss/shared needing photos: " + misses.length);

  let recovered = 0;
  for (let i = 0; i < misses.length; i++) {
    const slug = misses[i];
    const name = slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    process.stdout.write("[" + (i + 1) + "/" + misses.length + "] " + name + "... ");
    const match = await searchEspnAthlete(name);
    if (match && match.athleteId) {
      const dl = await downloadHeadshot(slug, match.athleteId);
      if (dl.success) {
        recovered++;
        console.log("✓ SAVED from ESPN (ID " + match.athleteId + ", " + (dl.bytes / 1024).toFixed(1) + " KB)");
      } else {
        console.log("✗ No headshot on ESPN");
      }
    } else {
      console.log("✗ No ESPN match");
    }
    await new Promise(r => setTimeout(r, 40));
  }

  console.log("\n=== ESPN Headshot Sync Complete ===");
  console.log("Successfully recovered " + recovered + " missing fighter photos!");
}

if (require.main === module) {
  run().catch(console.error);
}

module.exports = { syncSingle, searchEspnAthlete, downloadHeadshot };
