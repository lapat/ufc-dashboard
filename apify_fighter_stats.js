"use strict";
/**
 * apify_fighter_stats.js - Scrapes complete fighter volatility statistics using Apify.
 * Uses Apifys proxy pool to effortlessly bypass Cloudflare and rate limits.
 * Outputs to: analysis/fighter_profiles.json
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const { computeVolatility, loadFighterProfiles } = require("./fighter_stats");

const CACHE_FILE = path.join(__dirname, "analysis", "fighter_profiles.json");
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, body }); }
      });
    }).on("error", reject);
  });
}

async function runApifyScraper(targetFighters) {
  if (!APIFY_TOKEN) {
    throw new Error("Missing APIFY_TOKEN! Please export APIFY_TOKEN=... or add to .env");
  }

  console.log("=== Launching Apify Career Stats Scraper ===");
  console.log("Fighters to hydrate:", targetFighters.length);

  // Build target URLs on ufc.com or ufcstats.com
  const startUrls = targetFighters.map(name => {
    const slug = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return { url: "https://www.ufc.com/athlete/" + slug, userData: { name } };
  });

  const pageFunction = String(() => {
    async function pageFunction(context) {
      const { $, request } = context;
      const name = request.userData.name;
      
      const pairs = [];
      $(".c-stat-compare__number, .c-stat-compare__label").each((_, el) => {
        pairs.push($(el).text().trim());
      });

      const stats = {};
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        stats[pairs[i + 1].toLowerCase()] = pairs[i];
      }

      const sf = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
      const slpm = sf(stats["sig. str. landed"]);
      const sapm = sf(stats["sig. str. absorbed"]);
      const tdAvg = sf(stats["takedown avg"]);
      const subAvg = sf(stats["submission avg"]);
      const strDef = sf(stats["sig. str. defense"]);
      const tdDef = sf(stats["takedown defense"]);
      const kdAvg = sf(stats["knockdown avg"]);

      const bodyText = $("body").text();
      const recordM = bodyText.match(/(\d+)-(\d+)-(\d+)/);

      return {
        name,
        stats: {
          slpm, sapm, tdAvg, subAvg, strDef, tdDef, kdAvg,
          wins: recordM ? parseInt(recordM[1]) : null,
          losses: recordM ? parseInt(recordM[2]) : null,
          url: request.url
        }
      };
    }
    return pageFunction;
  });

  const runPayload = {
    startUrls,
    pageFunction: "(" + pageFunction.toString() + ")()",
    proxyConfiguration: { useApifyProxy: true },
    maxConcurrency: 10,
    pageLoadTimeoutSec: 30
  };

  console.log("Starting Apify Web Scraper Actor...");
  const startRes = await post("https://api.apify.com/v2/acts/apify~web-scraper/runs?token=" + APIFY_TOKEN, runPayload);
  if (startRes.status >= 300) {
    throw new Error("Apify API start failed (HTTP " + startRes.status + "): " + JSON.stringify(startRes.data));
  }

  const runId = startRes.data.data.id;
  const datasetId = startRes.data.data.defaultDatasetId;
  console.log("Actor running! Run ID:", runId, "Dataset ID:", datasetId);

  // Poll for completion
  let status = "RUNNING";
  while (status === "RUNNING" || status === "READY") {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await get("https://api.apify.com/v2/actor-runs/" + runId + "?token=" + APIFY_TOKEN);
    status = statusRes.data.data.status;
    console.log("Apify run status:", status);
  }

  if (status !== "SUCCEEDED") {
    throw new Error("Apify run finished with status: " + status);
  }

  console.log("Fetching scraped dataset from Apify...");
  const datasetRes = await get("https://api.apify.com/v2/datasets/" + datasetId + "/items?token=" + APIFY_TOKEN);
  const items = datasetRes.data;
  console.log("Retrieved " + items.length + " fighter records!");

  const profiles = loadFighterProfiles();
  let updated = 0;
  for (const item of items) {
    if (!item.name || !item.stats || (item.stats.slpm == null && item.stats.sapm == null)) continue;
    const vol = computeVolatility(item.stats);
    profiles[item.name] = {
      name: item.name,
      stats: item.stats,
      volatility: vol,
      cachedAt: new Date().toISOString(),
      provider: "apify"
    };
    updated++;
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(profiles, null, 2));
  console.log("=== Apify Hydration Complete ===");
  console.log("Updated " + updated + " fighter profiles in " + CACHE_FILE);
}

if (require.main === module) {
  const { extractAllFighters, loadFighterProfiles } = require("./fighter_stats");
  const all = extractAllFighters();
  const cached = loadFighterProfiles();
  const missing = all.filter(n => !cached[n]);
  console.log("Missing fighters for crossover_predictor:", missing.length);

  runApifyScraper(missing).catch(e => {
    console.error("Scraper failed:", e.message);
  });
}

module.exports = { runApifyScraper };
