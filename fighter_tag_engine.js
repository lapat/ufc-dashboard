'use strict';
/**
 * fighter_tag_engine.js — Global Fighter Tagging & Subjective Override System
 *
 * Implements Ish's custom fighter classifications:
 * - Allows Ish to override automated algorithmic badges with real stylistic ground-truth.
 * - Stores subjective tags and the dedicated permanent "Raw Dog" (🐕) intuition marker.
 * - Atomically persists tags locally and to Railway persistent volume (/data).
 */

const fs = require('fs');
const path = require('path');

const ANALYSIS_DIR = path.join(__dirname, 'analysis');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'historical_data');
const LOCAL_FILE = path.join(ANALYSIS_DIR, 'fighter_tags.json');
const VOL_FILE = path.join(DATA_DIR, 'fighter_tags.json');

// Supported Catalog of Stylistic Tags
const TAG_CATALOG = [
  { id: 'heavy_wrestler',   label: 'Heavy Wrestler',    icon: '🤼', desc: 'Heavy takedown & top-control pressure' },
  { id: 'takedown_defense', label: 'Takedown Defense',  icon: '🛡️', desc: 'Elite sprawl & anti-grappling' },
  { id: 'striking_power',   label: 'Striking Power',    icon: '💥', desc: 'High KO danger / 1-punch fight ending power' },
  { id: 'efficient_striker',label: 'Efficient Striker', icon: '🥊', desc: 'Technical striking volume & output' },
  { id: 'older',            label: 'Age Cliff (35+)',   icon: '⏳', desc: 'Reaction & chin vulnerability' },
  { id: 'size_advantage',   label: 'Size Advantage',    icon: '📏', desc: 'Height, reach, or physical frame leverage' },
  { id: 'sub_threat',       label: 'Sub Threat',        icon: '🥋', desc: 'Dangerous ground submission finisher' },
  { id: 'cardio_machine',   label: 'Cardio Machine',    icon: '🔋', desc: 'Relentless 15-to-25 minute pace' },
  { id: 'gas_tank_risk',    label: 'Gas Tank Risk',     icon: '⚠️', desc: 'High Round 2/3 fade probability' }
];

// Seed data from Ish's phone call
const INITIAL_SEEDS = {
  "pierarodriguez": {
    "tags": ["striking_power", "efficient_striker"],
    "isRawDog": true,
    "notes": "50% KO rate; prefers striking, effective striker (Ish canon)",
    "updatedAt": "2026-10-29T21:00:00.000Z"
  },
  "talitaalencar": {
    "tags": ["heavy_wrestler", "older", "size_advantage"],
    "isRawDog": false,
    "notes": "World champ BJJ; heavy wrestling pressure, older (Ish canon)",
    "updatedAt": "2026-10-29T21:00:00.000Z"
  }
};

function _norm(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function loadTags() {
  let tags = { ...INITIAL_SEEDS };

  if (fs.existsSync(LOCAL_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
      tags = { ...tags, ...data };
    } catch (_) {}
  }

  if (fs.existsSync(VOL_FILE)) {
    try {
      const volData = JSON.parse(fs.readFileSync(VOL_FILE, 'utf8'));
      tags = { ...tags, ...volData };
    } catch (_) {}
  }

  return tags;
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function saveTags(tagsObj) {
  const jsonStr = JSON.stringify(tagsObj, null, 2);
  try {
    atomicWrite(LOCAL_FILE, jsonStr);
  } catch (err) {
    console.error('Failed writing local fighter tags:', err.message);
  }

  try {
    atomicWrite(VOL_FILE, jsonStr);
  } catch (err) {
    console.error('Failed writing volume fighter tags:', err.message);
  }
}

function getTags(fighterName) {
  if (!fighterName) return { tags: [], isRawDog: false, notes: '' };
  const tags = loadTags();
  const key = _norm(fighterName);
  return tags[key] || { tags: [], isRawDog: false, notes: '' };
}

function setTags(fighterName, tagData) {
  const key = _norm(fighterName);
  if (!key) return null;

  const tags = loadTags();
  const existing = tags[key] || { tags: [], isRawDog: false, notes: '' };

  const validTagIds = new Set(TAG_CATALOG.map(t => t.id));
  const cleanTags = Array.isArray(tagData.tags)
    ? tagData.tags.filter(t => validTagIds.has(t))
    : existing.tags;

  tags[key] = {
    tags: Array.from(new Set(cleanTags)),
    isRawDog: tagData.isRawDog !== undefined ? !!tagData.isRawDog : existing.isRawDog,
    notes: tagData.notes !== undefined ? String(tagData.notes) : existing.notes,
    updatedAt: new Date().toISOString()
  };

  saveTags(tags);
  return tags[key];
}

function toggleTag(fighterName, tagId) {
  const current = getTags(fighterName);
  let newTags = [...current.tags];
  if (newTags.includes(tagId)) {
    newTags = newTags.filter(t => t !== tagId);
  } else {
    newTags.push(tagId);
  }
  return setTags(fighterName, { tags: newTags, isRawDog: current.isRawDog, notes: current.notes });
}

function toggleRawDog(fighterName) {
  const current = getTags(fighterName);
  return setTags(fighterName, { tags: current.tags, isRawDog: !current.isRawDog, notes: current.notes });
}

function getAllTags() {
  return loadTags();
}

module.exports = {
  TAG_CATALOG,
  getTags,
  setTags,
  toggleTag,
  toggleRawDog,
  getAllTags,
  loadTags,
  _norm
};
