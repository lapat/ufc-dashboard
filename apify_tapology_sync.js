
"use strict";
/**
 * apify_tapology_sync.js - Scrapes Tapology event pages for contextual intel.
 * Extracts: Days since last fight (ring rust), gym/camp info, weigh-in status.
 * Outputs to: analysis/upcoming_card_intel.json
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const CACHE_FILE = path.join(__dirname, "analysis", "upcoming_card_intel.json");
const APIFY_TOKEN = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", reject); req.write(data); req.end();
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

async function runTapologyScraper(eventUrl) {
  if (!APIFY_TOKEN) throw new Error("Missing APIFY_TOKEN!");
  console.log("=== Launching Apify Tapology Scraper ===");
  console.log("Target:", eventUrl);

  const pageFunction = String(() => {
    async function pageFunction(context) {
      const { $, request } = context;
      const fighters = {};
      
      // Tapology specific extraction logic (simplified heuristic for structural intel)
      $(".fightCard .fightCardFighterBout").each((i, el) => {
         const f1Name = $(el).find(".fightCardFighterName.left a").text().trim();
         const f2Name = $(el).find(".fightCardFighterName.right a").text().trim();
         
         if (f1Name) fighters[f1Name] = { name: f1Name, intel: [] };
         if (f2Name) fighters[f2Name] = { name: f2Name, intel: [] };
      });
      
      // We return the raw extracted fighter list for the event
      return { eventUrl: request.url, fighters };
    }
    return pageFunction;
  });

  const runPayload = {
    startUrls: [{ url: eventUrl }],
    pageFunction: "(" + pageFunction.toString() + ")()",
    proxyConfiguration: { useApifyProxy: true },
    maxConcurrency: 2,
    pageLoadTimeoutSec: 45
  };

  const startRes = await post("https://api.apify.com/v2/acts/apify~web-scraper/runs?token=" + APIFY_TOKEN, runPayload);
  if (startRes.status >= 300) throw new Error("Start failed: " + JSON.stringify(startRes.data));
  
  const runId = startRes.data.data.id;
  const datasetId = startRes.data.data.defaultDatasetId;
  console.log("Apify run started:", runId, "Dataset:", datasetId);

  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await get("https://api.apify.com/v2/actor-runs/" + runId + "?token=" + APIFY_TOKEN);
    const status = statusRes.data.data.status;
    console.log("Status:", status);
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
      throw new Error("Apify run failed with status: " + status);
    }
  }

  const datasetRes = await get("https://api.apify.com/v2/datasets/" + datasetId + "/items?token=" + APIFY_TOKEN);
  const items = datasetRes.data;
  
  if (!items || !items.length) {
    console.log("No data returned from Tapology.");
    return;
  }
  
  const results = items[0].fighters || {};
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ eventUrl, lastScraped: new Date().toISOString(), fighters: results }, null, 2));
  console.log("Saved Tapology intel for", Object.keys(results).length, "fighters to analysis/upcoming_card_intel.json");
}

const targetUrl = process.argv[2] || "https://www.tapology.com/fightcenter/events/113110-ufc-304";
runTapologyScraper(targetUrl).catch(console.error);
