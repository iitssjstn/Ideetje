// Kleine webserver zonder extra pakketten: serveert de website uit public/
// en stuurt een Discord-melding als ze Ja zegt of een plan instuurt.
// De webhook-URL stel je in via het adminpaneel op /admin (of env DISCORD_WEBHOOK_URL)
// en blijft altijd geheim op de server.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const POORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ADMIN_HTML = path.join(__dirname, 'admin', 'index.html');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG = path.join(DATA, 'config.json');

// Alleen echte Discord-webhooks, zodat de server nergens anders naartoe kan posten
const WEBHOOK_PATROON = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

// ---------- Instellingen (data/config.json) ----------

let config = {};
let schrijfbaar = false;

function laadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    config = {};
  }
}

function bewaarConfig() {
  if (!schrijfbaar) return false;
  const tmp = CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
  return true;
}

function webhook() {
  return config.webhook || process.env.DISCORD_WEBHOOK_URL || '';
}

function verberg(url) {
  const m = url.match(/\/webhooks\/(\d+)\//);
  return m ? `…/webhooks/${m[1]}/••••••••` : '••••••••';
}

// ---------- Admin-wachtwoord ----------

function hashWachtwoord(wachtwoord, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(wachtwoord), salt, 32).toString('hex');
}

function klopt(wachtwoord, opgeslagen) {
  const [salt, hash] = String(opgeslagen || '').split(':');
  if (!salt || !hash) return false;
  const verwacht = Buffer.from(hash, 'hex');
  const gegeven = crypto.scryptSync(String(wachtwoord), salt, 32);
  return verwacht.length === gegeven.length && crypto.timingSafeEqual(verwacht, gegeven);
}

function wachtwoordKlopt(wachtwoord) {
  if (process.env.ADMIN_WACHTWOORD) return klopt(wachtwoord, hashWachtwoord(process.env.ADMIN_WACHTWOORD));
  return klopt(wachtwoord, config.wachtwoord);
}

function maakNieuwWachtwoord() {
  const nieuw = crypto.randomBytes(9).toString('base64url');
  config.wachtwoord = hashWachtwoord(nieuw);
  const bewaard = bewaarConfig();
  console.log('');
  console.log('==============================================');
  console.log(`  Admin-wachtwoord voor /admin: ${nieuw}`);
  console.log(bewaard
    ? '  (je kunt het daarna wijzigen in het paneel)'
    : '  LET OP: data/ is niet schrijfbaar, dit wachtwoord verandert bij elke herstart');
  console.log('==============================================');
  console.log('');
}

// Ingelogde sessies: token -> verloopt-op
const SESSIE_DUUR = 12 * 60 * 60 * 1000;
const sessies = new Map();

function leesCookie(req, naam) {
  for (const deel of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = deel.trim().split('=');
    if (k === naam) return v.join('=');
  }
  return '';
}

function isIngelogd(req) {
  const token = leesCookie(req, 'admin');
  const tot = token && sessies.get(token);
  if (!tot || tot < Date.now()) {
    if (token) sessies.delete(token);
    return false;
  }
  return true;
}

function sessieCookie(req, token, maxAge) {
  const https = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` + (https ? '; Secure' : '');
}

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

// Max 10 meldingen per 10 minuten per IP, zodat niemand je Discord kan volspammen,
// en max 5 inlogpogingen per 15 minuten tegen wachtwoord raden
const VENSTER = 15 * 60 * 1000;
const meldingTeller = new Map();
const loginTeller = new Map();

function teVeel(teller, ip, limiet, venster) {
  const nu = Date.now();
  const recent = (teller.get(ip) || []).filter(t => nu - t < venster);
  recent.push(nu);
  teller.set(ip, recent);
  return recent.length > limiet;
}

// Ruim af en toe oude IP's en sessies op zodat het geheugen niet volloopt
setInterval(() => {
  const nu = Date.now();
  for (const teller of [meldingTeller, loginTeller]) {
    for (const [ip, tijden] of teller) if (tijden.every(t => nu - t >= VENSTER)) teller.delete(ip);
  }
  for (const [token, tot] of sessies) if (tot < nu) sessies.delete(token);
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
  const url = webhook();
  if (!url) {
    console.log('[geen Discord-webhook ingesteld, zie /admin] melding:', JSON.stringify(bericht));
    return true;
  }
  const res = await fetch(url, {
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
  if (teVeel(meldingTeller, req.socket.remoteAddress, 10, 10 * 60 * 1000)) return stuur(res, 429, 'Even rustig aan 🙂');
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

// ---------- Adminpaneel ----------

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function status() {
  const url = webhook();
  return {
    ingelogd: true,
    webhook: url ? verberg(url) : '',
    bron: config.webhook ? 'paneel' : url ? 'env' : '',
    naam: config.naam || '',
    schrijfbaar,
    wachtwoordViaEnv: Boolean(process.env.ADMIN_WACHTWOORD),
  };
}

async function verwerkAdmin(req, res, actie) {
  if (req.method === 'GET' && actie === 'status') {
    return isIngelogd(req) ? json(res, 200, status()) : json(res, 200, { ingelogd: false });
  }
  if (req.method !== 'POST') return json(res, 405, { fout: 'Alleen POST' });
  // Alleen JSON, zodat andere websites geen formulieren naar het paneel kunnen sturen
  if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { fout: 'Verwacht JSON' });

  let data;
  try {
    data = JSON.parse((await leesBody(req, 4096)) || '{}');
  } catch {
    return json(res, 400, { fout: 'Ongeldig verzoek' });
  }
  if (schrijfbaar) laadConfig(); // pak wijzigingen op, bijv. na een wachtwoord-reset

  if (actie === 'login') {
    if (teVeel(loginTeller, req.socket.remoteAddress, 5, VENSTER)) {
      return json(res, 429, { fout: 'Te veel pogingen, probeer het over 15 minuten opnieuw' });
    }
    if (!wachtwoordKlopt(data.wachtwoord)) return json(res, 401, { fout: 'Verkeerd wachtwoord' });
    const token = crypto.randomBytes(32).toString('hex');
    sessies.set(token, Date.now() + SESSIE_DUUR);
    return json(res, 200, status(), { 'Set-Cookie': sessieCookie(req, token, SESSIE_DUUR / 1000) });
  }

  if (!isIngelogd(req)) return json(res, 401, { fout: 'Niet ingelogd' });

  if (actie === 'uitloggen') {
    sessies.delete(leesCookie(req, 'admin'));
    return json(res, 200, { ingelogd: false }, { 'Set-Cookie': sessieCookie(req, '', 0) });
  }

  if (actie === 'naam') {
    const naam = schoon(data.naam, 50);
    if (naam) config.naam = naam;
    else delete config.naam;
    const bewaard = bewaarConfig();
    return json(res, 200, { ...status(), bewaard });
  }

  if (actie === 'webhook') {
    const url = String(data.url ?? '').trim();
    if (url && !WEBHOOK_PATROON.test(url)) {
      return json(res, 400, { fout: 'Dit is geen geldige Discord-webhook. Hij begint met https://discord.com/api/webhooks/' });
    }
    if (url) config.webhook = url;
    else delete config.webhook;
    const bewaard = bewaarConfig();
    return json(res, 200, { ...status(), bewaard });
  }

  if (actie === 'test') {
    if (!webhook()) return json(res, 400, { fout: 'Er is nog geen webhook ingesteld' });
    try {
      const ok = await stuurNaarDiscord({ content: '✅ Testmelding vanuit het adminpaneel. Het werkt!' });
      return ok ? json(res, 200, { ok: true }) : json(res, 502, { fout: 'Discord weigerde de melding. Klopt de webhook nog?' });
    } catch {
      return json(res, 502, { fout: 'Kon Discord niet bereiken vanaf de server' });
    }
  }

  if (actie === 'wachtwoord') {
    if (process.env.ADMIN_WACHTWOORD) return json(res, 400, { fout: 'Het wachtwoord komt uit ADMIN_WACHTWOORD en kan hier niet gewijzigd worden' });
    const nieuw = String(data.nieuw ?? '');
    if (nieuw.length < 8) return json(res, 400, { fout: 'Kies minstens 8 tekens' });
    config.wachtwoord = hashWachtwoord(nieuw);
    if (!bewaarConfig()) return json(res, 500, { fout: 'Kon niet opslaan: data/ is niet schrijfbaar' });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { fout: 'Onbekend' });
}

function serveerAdmin(req, res) {
  fs.readFile(ADMIN_HTML, (err, html) => {
    if (err) return stuur(res, 500, 'Adminpaneel ontbreekt');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
}

// ---------- Website ----------

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
  const pad = req.url.split('?')[0];
  if (pad.startsWith('/api/admin/')) {
    return verwerkAdmin(req, res, pad.slice('/api/admin/'.length)).catch(err => {
      console.error('Adminfout:', err);
      if (!res.headersSent) json(res, 500, { fout: 'Serverfout' });
    });
  }
  if (pad === '/admin' || pad === '/admin/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return stuur(res, 405, 'Niet toegestaan');
    return serveerAdmin(req, res);
  }
  if (pad === '/api/instellingen' && req.method === 'GET') {
    // Alleen wat de bezoeker toch al te zien krijgt
    return json(res, 200, { naam: config.naam || '' });
  }
  if (pad === '/api/melding') {
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

// ---------- Opstarten ----------

try {
  fs.mkdirSync(DATA, { recursive: true });
  fs.accessSync(DATA, fs.constants.W_OK);
  schrijfbaar = true;
} catch {
  console.warn(`LET OP: ${DATA} is niet schrijfbaar. Instellingen gaan verloren bij een herstart (zie docker-compose.yml).`);
}
laadConfig();

// `node server.js --reset-wachtwoord` maakt een nieuw admin-wachtwoord en stopt dan
if (process.argv.includes('--reset-wachtwoord')) {
  maakNieuwWachtwoord();
  process.exit(0);
}
if (!process.env.ADMIN_WACHTWOORD && !config.wachtwoord) maakNieuwWachtwoord();

server.listen(POORT, () => {
  const bron = config.webhook ? 'ingesteld via /admin' : process.env.DISCORD_WEBHOOK_URL ? 'uit DISCORD_WEBHOOK_URL' : '';
  console.log(`Website draait op poort ${POORT}` + (bron ? ` (Discord-meldingen aan, ${bron})` : ' (Discord-meldingen uit: stel een webhook in op /admin)'));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
