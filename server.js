require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = 3000;
const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4';

app.use(express.static('public'));

app.get('/api/ufc', async (req, res) => {
  try {
    const url = `${BASE_URL}/sports/mma_mixed_martial_arts/odds/?apiKey=${API_KEY}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;
    const response = await fetch(url);
    const data = await response.json();

    const remaining = response.headers.get('x-requests-remaining');
    const used = response.headers.get('x-requests-used');
    console.log(`API requests used: ${used} | remaining: ${remaining}`);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`UFC Dashboard running at http://localhost:${PORT}`);
});
