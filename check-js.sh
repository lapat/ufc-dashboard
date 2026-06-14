#!/bin/bash
# Extract inline JS from index.html and syntax-check it
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const matches = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)];
let combined = '';
for (const m of matches) combined += m[1] + '\n';
fs.writeFileSync('/tmp/_dash_check.js', combined);
" && node --check /tmp/_dash_check.js && echo "✓ JS syntax OK" && rm /tmp/_dash_check.js
