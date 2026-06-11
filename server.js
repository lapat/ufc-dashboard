require('dotenv').config();
const express = require('express');
const https = require('https');

const app = express();
const PORT = 3000;
const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

app.use(express.static('public'));

app.get('/api/ufc', (req, res) => {
  const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try {
        console.log(`API requests used: ${apiRes.headers['x-requests-used']} | remaining: ${apiRes.headers['x-requests-remaining']}`);
        res.json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

app.listen(PORT, () => {
  console.log(`UFC Dashboard running at http://localhost:${PORT}`);
});
