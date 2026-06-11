require('dotenv').config();
const https = require('https');

const key = process.env.ODDS_API_KEY;
const url = `https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/?apiKey=${key}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;

https.get(url, (res) => {
  console.log('Status:', res.statusCode);
  console.log('Requests remaining:', res.headers['x-requests-remaining']);
  console.log('Requests used:', res.headers['x-requests-used']);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      console.log(`\nFights found: ${parsed.length}`);
      parsed.forEach(f => {
        const dk = f.bookmakers?.[0];
        const market = dk?.markets?.find(m => m.key === 'h2h');
        const outcomes = market?.outcomes ?? [];
        console.log(`\n${f.home_team} vs ${f.away_team}`);
        console.log(`  Starts: ${new Date(f.commence_time).toLocaleString()}`);
        outcomes.forEach(o => console.log(`  ${o.name}: ${o.price > 0 ? '+' : ''}${o.price}`));
      });
    } else {
      console.log('Response:', JSON.stringify(parsed, null, 2));
    }
  });
}).on('error', e => console.error('Error:', e.message));
