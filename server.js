require('dotenv').config();
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = 3000;
const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';
const HISTORICAL_DIR = path.join(__dirname, 'historical_data');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.static('public'));
app.use(express.json());

// Live UFC odds from DraftKings
app.get('/api/ufc', (req, res) => {
  const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try {
        console.log(`Odds API — used: ${apiRes.headers['x-requests-used']} | remaining: ${apiRes.headers['x-requests-remaining']}`);
        res.json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

// List all historical fights
app.get('/api/fights', (req, res) => {
  try {
    const files = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json'));
    const index = files.map(f => {
      const d = JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, f)));
      return {
        fightId: d.fightId,
        fightTitle: d.fightTitle,
        date: f.match(/\d{4}-\d{2}-\d{2}/)?.[0],
        dataPoints: d.dataPoints,
      };
    });
    res.json(index);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ask Claude a question about the historical data
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    // Build a summary of all fights for context
    const files = fs.readdirSync(HISTORICAL_DIR).filter(f => f.endsWith('.json'));
    const summaries = files.map(f => {
      const d = JSON.parse(fs.readFileSync(path.join(HISTORICAL_DIR, f)));
      const h = d.oddsHistory || [];
      if (!h.length) return null;

      // Detect crossovers
      const crossovers = [];
      for (let i = 1; i < h.length; i++) {
        const pf1 = h[i-1].fighter1.numericOdds, cf1 = h[i].fighter1.numericOdds;
        const pf2 = h[i-1].fighter2.numericOdds, cf2 = h[i].fighter2.numericOdds;
        if ((pf1 > 0 && cf1 < 0) || (pf2 > 0 && cf2 < 0)) {
          const o1 = pf1 > 0 ? pf1 : pf2;
          const o2 = pf1 > 0 ? cf2 : cf1;
          const d1 = o1 > 0 ? (o1/100)+1 : (100/Math.abs(o1))+1;
          const d2 = o2 > 0 ? (o2/100)+1 : (100/Math.abs(o2))+1;
          const winWin = (d1-1)*(d2-1) > 1;
          crossovers.push({ o1, o2, winWin });
        }
      }

      const open = h[0];
      const close = h[h.length - 1];
      return {
        fight: d.fightId,
        date: f.match(/\d{4}-\d{2}-\d{2}/)?.[0],
        dataPoints: d.dataPoints,
        openOdds: `${open.fighter1.name} ${open.fighter1.odds} / ${open.fighter2.name} ${open.fighter2.odds}`,
        closeOdds: `${close.fighter1.name} ${close.fighter1.odds} / ${close.fighter2.name} ${close.fighter2.odds}`,
        crossovers: crossovers.length,
        winWinCrossovers: crossovers.filter(c => c.winWin).length,
        bestWinWin: crossovers.filter(c => c.winWin).map(c => `+${c.o1} → +${c.o2}`)[0] || null,
      };
    }).filter(Boolean);

    const context = JSON.stringify(summaries, null, 2);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are an analyst for Ish, a professional live MMA bettor. You have access to historical UFC fight odds data captured live from DraftKings (Dec 2025 – May 2026).

A "crossover" is when a fighter's odds flip from underdog (plus money) to favorite (minus money) during a live fight. A "win-win" crossover is one where both bets — placed at plus money before and after the crossover — satisfy the condition (D1-1)(D2-1) > 1, guaranteeing profit regardless of outcome.

Answer Ish's questions concisely and specifically using the data provided.`,
      messages: [
        {
          role: 'user',
          content: `Here is the historical fight data summary:\n\n${context}\n\nQuestion: ${question}`,
        }
      ],
    });

    res.json({ answer: response.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`UFC Dashboard running at http://localhost:${PORT}`);
});
