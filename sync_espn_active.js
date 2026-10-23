"use strict";
/**
 * sync_espn_active.js - Pulls all official UFC ranked fighters and all historical fighters from ESPN.
 * Saves high-res transparent PNGs directly into fighter_images.
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

async function downloadHeadshot(slug, athleteId, name) {
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
        name: name || slug,
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

async function searchEspn(name) {
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
  } catch (_) {}
  return null;
}

async function syncRankings() {
  console.log("=== Syncing Official UFC Rankings from ESPN ===");
  const res = await get("https://site.api.espn.com/apis/site/v2/sports/mma/ufc/rankings", false);
  if (res.status !== 200) throw new Error("Rankings HTTP " + res.status);
  const data = JSON.parse(res.body);
  const rankings = data.rankings || [];

  let count = 0, downloaded = 0;
  for (const cat of rankings) {
    for (const r of (cat.ranks || [])) {
      const athlete = r.athlete;
      if (!athlete || !athlete.id) continue;
      count++;
      // Get athlete details to obtain full name
      const athRes = await get("https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/athletes/" + athlete.id, false);
      if (athRes.status !== 200) continue;
      const athData = JSON.parse(athRes.body);
      const name = athData.fullName;
      const slug = slugify(name);

      if (index[slug] && index[slug].status === "found" && fs.existsSync(path.join(IMG_DIR, index[slug].file))) {
        // already have photo
        continue;
      }
      process.stdout.write("Downloading [" + cat.name + "] " + name + "... ");
      const dl = await downloadHeadshot(slug, athlete.id, name);
      if (dl.success) {
        downloaded++;
        console.log("✓ " + (dl.bytes/1024).toFixed(1) + " KB");
      } else {
        console.log("✗ " + dl.error);
      }
      await new Promise(res => setTimeout(res, 50));
    }
  }
  console.log("Rankings sync complete! Processed " + count + " ranked slots, downloaded " + downloaded + " new headshots.");
}

async function syncFightFighters() {
  console.log("\n=== Syncing Fighters from Fight Files Needing Photos ===");
  const fighterStats = require("./fighter_stats");
  const names = fighterStats.extractAllFighters();
  console.log("Total fighters in historical fights: " + names.length);

  let needed = 0, saved = 0;
  for (const name of names) {
    const slug = slugify(name);
    const existing = index[slug];
    if (existing && existing.status === "found" && fs.existsSync(path.join(IMG_DIR, existing.file))) {
      continue;
    }
    needed++;
    process.stdout.write("Searching ESPN for " + name + "... ");
    const match = await searchEspn(name);
    if (match && match.athleteId) {
      const dl = await downloadHeadshot(slug, match.athleteId, match.name);
      if (dl.success) {
        saved++;
        console.log("✓ SAVED (ID " + match.athleteId + ", " + (dl.bytes/1024).toFixed(1) + " KB)");
      } else {
        console.log("✗ No CDN image");
      }
    } else {
      console.log("✗ Not found on ESPN");
    }
    await new Promise(res => setTimeout(res, 50));
  }
  console.log("Fights sync complete! Needed: " + needed + ", Saved: " + saved);
}

async function main() {
  await syncRankings();
  await syncFightFighters();
}

main().catch(console.error);
