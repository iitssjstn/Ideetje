// Kleine webserver zonder extra pakketten: serveert de website uit public/
// en stuurt een Discord-melding als ze Ja zegt of een plan instuurt.
// De webhook-URL blijft geheim op de server (env DISCORD_WEBHOOK_URL).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const POORT = Number(process.env.PORT) || 3000;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const PUBLIC = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

const ACTIVITEITEN = {
  eten: '🍕 Uit eten',
  film: '🎬 Film kijken',
  ijs: '🍦 Ijsje halen',
  bowlen: '🎳 Bowlen',
  wandelen: '🌳 Wandelen',
  verrassing: '🎁 Verras me!',
};

// Max 10 meldingen per 10 minuten per IP, zodat niemand je Discord kan volspammen
const LIMIET = 10;
const VENSTER = 10 * 60 * 1000;
const teller = new Map();

function teVeel(ip) {
  const nu = Date.now();
  const recent = (teller.get(ip) || []).filter(t => nu - t < VENSTER);
  recent.push(nu);
  teller.set(ip, recent);
  return recent.length > LIMIET;
}

// Ruim af en toe oude IP's op zodat het geheugen niet volloopt
setInterval(() => {
  const nu = Date.now();
  for (const [ip, tijden] of teller) if (tijden.every(t => nu - t >= VENSTER)) teller.delete(ip);
}, VENSTER).unref();

function schoon(waarde, max) {
  return String(waarde ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function maakBericht(d) {
  const naam = schoon(d.naam, 50) || 'Ze';
  const pogingen = Math.max(0, Math.min(Number.parseInt(d.pogingen, 10) || 0, 9999));

  if (d.type === 'ja') {
    const extra = pogingen ? ` (na ${pogingen}× proberen op Nee te klikken 😏)` : ' (meteen, zonder twijfel 😍)';
    return { content: `💘 **${naam} heeft JA gezegd!**${extra}` };
  }

  if (d.type === 'plan') {
    const activiteit = ACTIVITEITEN[d.activiteit];
    const datum = String(d.datum ?? '');
    const tijd = String(d.tijd ?? '');
    if (!activiteit || !/^\d{4}-\d{2}-\d{2}$/.test(datum) || !/^\d{2}:\d{2}$/.test(tijd)) return null;
    const dag = new Date(datum + 'T12:00:00');
    if (Number.isNaN(dag.getTime())) return null;
    const dagTekst = dag.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const bericht = schoon(d.bericht, 300);

    const fields = [
      { name: 'Wat', value: activiteit, inline: true },
      { name: 'Wanneer', value: `${dagTekst} om ${tijd}`, inline: true },
    ];
    if (bericht) fields.push({ name: 'Bericht', value: bericht });
    return {
      embeds: [{
        title: `📅 ${naam} heeft een date gepland!`,
        color: 0xff4f81,
        fields,
      }],
    };
  }

  return null;
}

async function stuurNaarDiscord(bericht) {
  if (!WEBHOOK) {
    console.log('[geen DISCORD_WEBHOOK_URL ingesteld] melding:', JSON.stringify(bericht));
    return true;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Geen @everyone of andere pings, wat er ook ingetypt wordt
    body: JSON.stringify({ ...bericht, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) console.error('Discord gaf een fout:', res.status, await res.text());
  return res.ok;
}

function leesBody(req, max) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (data.length > max) {
        reject(new Error('te groot'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function stuur(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

async function verwerkMelding(req, res) {
  if (teVeel(req.socket.remoteAddress)) return stuur(res, 429, 'Even rustig aan 🙂');
  let data;
  try {
    data = JSON.parse(await leesBody(req, 4096));
  } catch {
    return stuur(res, 400, 'Ongeldig verzoek');
  }
  const bericht = maakBericht(data);
  if (!bericht) return stuur(res, 400, 'Ongeldig verzoek');
  try {
    const ok = await stuurNaarDiscord(bericht);
    stuur(res, ok ? 200 : 502, ok ? 'ok' : 'Discord-fout');
  } catch (err) {
    console.error('Versturen naar Discord mislukt:', err);
    stuur(res, 502, 'Discord-fout');
  }
}

function serveerBestand(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pad = decodeURIComponent(url.pathname);
  if (pad.endsWith('/')) pad += 'index.html';
  const bestand = path.join(PUBLIC, path.normalize(pad));
  const type = TYPES[path.extname(bestand).toLowerCase()];
  if (!bestand.startsWith(PUBLIC + path.sep) || !type) return stuur(res, 404, 'Niet gevonden');

  fs.stat(bestand, (err, info) => {
    if (err || !info.isFile()) return stuur(res, 404, 'Niet gevonden');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(bestand).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/api/melding') {
    if (req.method !== 'POST') return stuur(res, 405, 'Alleen POST');
    return verwerkMelding(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return stuur(res, 405, 'Niet toegestaan');
  try {
    serveerBestand(req, res);
  } catch {
    stuur(res, 400, 'Ongeldig verzoek');
  }
});

server.listen(POORT, () => {
  console.log(`Website draait op poort ${POORT}` + (WEBHOOK ? ' (Discord-meldingen aan)' : ' (Discord-meldingen uit: DISCORD_WEBHOOK_URL ontbreekt)'));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
