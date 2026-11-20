import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { kinds, sampleEvents } from './catalog.mjs';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
const production = process.env.NODE_ENV === 'production' || !loopbackHosts.has(host);
const trustLocalProxy = process.env.TRUST_LOCAL_PROXY === '1' && loopbackHosts.has(host);
const origin = process.env.APP_ORIGIN;
const ownerPassword = process.env.OWNER_PASSWORD;
const partnerPassword = process.env.PARTNER_PASSWORD;
const demoPasswords = ['meste-owner-demo', 'meste-partner-demo'];
if (production && (!origin?.startsWith('https://') || [ownerPassword, partnerPassword].some(value => !value || value.length < 12 || value.length > 256 || demoPasswords.includes(value)) || ownerPassword === partnerPassword)) {
  throw new Error('Задайте APP_ORIGIN с HTTPS и два разных пароля длиной от 12 символов.');
}
const passwords = new Map([['owner', ownerPassword || demoPasswords[0]], ['partner', partnerPassword || demoPasswords[1]]]);
const dataDir = process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dataDir + '/site.sqlite');
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL,
    category TEXT NOT NULL, room TEXT NOT NULL, description TEXT NOT NULL, price INTEGER NOT NULL,
    published INTEGER NOT NULL, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY, month TEXT UNIQUE NOT NULL, open INTEGER NOT NULL DEFAULT 1, demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS choices (
    id INTEGER PRIMARY KEY, poll_id INTEGER NOT NULL REFERENCES polls(id), label TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS votes (
    poll_id INTEGER NOT NULL REFERENCES polls(id), voter TEXT NOT NULL,
    choice_id INTEGER NOT NULL REFERENCES choices(id), PRIMARY KEY (poll_id, voter)
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, event_id INTEGER REFERENCES events(id), event_title TEXT,
    event_day TEXT, name TEXT NOT NULL, contact TEXT NOT NULL, guests INTEGER,
    message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
    created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
`);

function addPoll(month, labels, demo = 0) {
  const { lastInsertRowid } = db.prepare('INSERT INTO polls(month, demo) VALUES (?, ?)').run(month, demo);
  const insert = db.prepare('INSERT INTO choices(poll_id, label) VALUES (?, ?)');
  for (const label of labels) insert.run(lastInsertRowid, label);
}

function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    action();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

transaction(() => {
  if (!db.prepare("INSERT OR IGNORE INTO settings VALUES ('initialized', '1')").run().changes) return;
  if (process.env.SEED_DEMO === '0' || (production && process.env.SEED_DEMO !== '1')) return;
  const insert = db.prepare('INSERT INTO events(title, day, time, category, room, description, price, published, demo) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)');
  for (const [day, time, category, title, description, price, room] of sampleEvents) {
    insert.run(title, `2026-12-${String(day).padStart(2, '0')}`, time, category, room, description, price);
  }
  addPoll('2027-01', ['Быстрые свидания', 'Квартирник', 'Мафия', 'Караоке-баттл'], 1);
});

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new RequestError(status, message); };
const invalid = (message = 'Проверь поля формы и попробуй ещё раз.') => fail(400, message);
const token = () => randomBytes(24).toString('hex');
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const sessionAge = 12 * 60 * 60;
const voteAge = 365 * 24 * 60 * 60;

function cookieValue(req, key) {
  return (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(key + '='))?.slice(key.length + 1) || '';
}
function cookie(res, key, value, age) {
  res.setHeader('Set-Cookie', `${key}=${value}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${production ? '; Secure' : ''}`);
}
function session(req) {
  const value = cookieValue(req, 'meste_session');
  return /^[a-f0-9]{48}$/.test(value) && db.prepare('SELECT 1 FROM sessions WHERE token = ? AND expires > ?').get(tokenHash(value), Date.now());
}
function checkOrigin(req) {
  const expected = origin || `http://${req.headers.host}`;
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== expected)) {
    fail(403, 'Обнови страницу и попробуй ещё раз.');
  }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  checkOrigin(req);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) invalid();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 16_384) chunks.push(chunk);
  }
  if (size > 16_384) fail(413, 'Сообщение слишком длинное.');
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return parsed;
}
function field(value, min, max) {
  if (typeof value !== 'string') invalid();
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) invalid();
  return trimmed;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
const isMonth = value => typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
function isDay(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d\d-\d\d$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().startsWith(value);
}
function moscowNow() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
}
function choicesFor(id) {
  return db.prepare(`
    SELECT c.id, c.label, count(v.choice_id) AS count FROM choices c
    LEFT JOIN votes v ON v.choice_id = c.id WHERE c.poll_id = ? GROUP BY c.id ORDER BY c.id
  `).all(id);
}
function publicPoll(req) {
  const poll = db.prepare('SELECT * FROM polls ORDER BY open DESC, month DESC LIMIT 1').get();
  if (!poll) return null;
  const choice = db.prepare('SELECT choice_id FROM votes WHERE poll_id = ? AND voter = ?').get(poll.id, cookieValue(req, 'meste_vote'));
  return { ...poll, selected: choice?.choice_id ?? null, choices: choicesFor(poll.id).map(({ id, label, count }) => ({ id, label, count: choice || !poll.open ? count : null })) };
}
const attempts = new Map();
function limit(req, route, max, window) {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
  const peer = req.socket.remoteAddress;
  const forwarded = req.headers['x-forwarded-for'];
  // A directly exposed Caddy instance replaces this header with the client address.
  const client = trustLocalProxy && loopbackHosts.has(peer) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
  const key = `${route}:${client}`;
  const entry = attempts.get(key) || { count: 0, until: now + window };
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > max) fail(429, 'Слишком много попыток. Попробуй чуть позже.');
  return key;
}

async function api(req, res, path) {
  const method = req.method;
  if (method === 'GET' && path === '/api/site') {
    const events = db.prepare("SELECT * FROM events WHERE published = 1 AND day || ' ' || time >= ? ORDER BY day, time, id").all(moscowNow());
    return json(res, 200, { events, poll: publicPoll(req), kinds, address: process.env.VENUE_ADDRESS || '' });
  }
  if (method === 'POST' && path === '/api/vote') {
    limit(req, path, 90, 60_000);
    const { pollId, choiceId } = await body(req);
    const poll = publicPoll(req);
    if (!poll?.open || poll.id !== pollId) fail(409, 'Это голосование уже закрыто.');
    if (!poll.choices.some(choice => choice.id === choiceId)) invalid('Выбери вариант голосования.');
    let voter = cookieValue(req, 'meste_vote');
    if (!/^[a-f0-9]{48}$/.test(voter)) voter = token();
    db.prepare('INSERT INTO votes VALUES (?, ?, ?) ON CONFLICT(poll_id, voter) DO UPDATE SET choice_id = excluded.choice_id').run(pollId, voter, choiceId);
    cookie(res, 'meste_vote', voter, voteAge);
    return json(res, 200, { ...poll, selected: choiceId, choices: choicesFor(pollId) });
  }
  if (method === 'POST' && ['/api/book', '/api/partner'].includes(path)) {
    limit(req, path, 25, 600_000);
    const input = await body(req);
    const name = field(input.name, 2, 80);
    const contact = field(input.contact, 5, 120);
    if (path === '/api/book') {
      const id = integer(input.eventId, 1, Number.MAX_SAFE_INTEGER);
      const guests = integer(input.guests, 1, 8);
      const event = db.prepare("SELECT * FROM events WHERE id = ? AND published = 1 AND day || ' ' || time >= ?").get(id, moscowNow());
      if (!event) fail(409, 'Запись на это событие закрыта.');
      db.prepare("INSERT INTO requests(kind, event_id, event_title, event_day, name, contact, guests) VALUES ('booking', ?, ?, ?, ?, ?, ?)").run(id, event.title, event.day, name, contact, guests);
    } else {
      const message = field(input.message, 10, 2000);
      db.prepare("INSERT INTO requests(kind, name, contact, message) VALUES ('partner', ?, ?, ?)").run(name, contact, message);
    }
    return json(res, 201, { ok: true });
  }
  if (method === 'POST' && path === '/api/admin/login') {
    const key = limit(req, path, 12, 600_000);
    const { login, password } = await body(req);
    const expected = passwords.get(login);
    const candidate = typeof password === 'string' ? password : '';
    if (!timingSafeEqual(Buffer.from(tokenHash(candidate)), Buffer.from(tokenHash(expected || 'invalid'))) || !expected) {
      fail(401, 'Проверь логин и пароль.');
    }
    attempts.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires <= ? OR token = ?').run(Date.now(), tokenHash(cookieValue(req, 'meste_session')));
    const value = token();
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(tokenHash(value), Date.now() + sessionAge * 1000);
    cookie(res, 'meste_session', value, sessionAge);
    return json(res, 200, { ok: true });
  }
  if (path.startsWith('/api/admin/')) {
    if (!session(req)) fail(401, 'Войди в админку.');
    if (method === 'GET' && path === '/api/admin/data') {
      return json(res, 200, {
        kinds,
        events: db.prepare('SELECT * FROM events ORDER BY day DESC, time DESC').all(),
        polls: db.prepare('SELECT * FROM polls ORDER BY month DESC').all().map(poll => ({ ...poll, choices: choicesFor(poll.id) })),
        requests: db.prepare('SELECT * FROM requests ORDER BY id DESC').all(),
      });
    }
    if (method !== 'POST') fail(404, 'Страница не найдена.');
    const input = await body(req);
    if (path === '/api/admin/logout') {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(cookieValue(req, 'meste_session')));
      cookie(res, 'meste_session', '', 0);
    } else if (path === '/api/admin/event') {
      if (!Object.hasOwn(kinds, input.category) || !isDay(input.day) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time) || typeof input.published !== 'boolean') invalid();
      const values = [field(input.title, 2, 100), input.day, input.time, input.category, field(input.room, 2, 80), field(input.description, 5, 450), integer(input.price, 0, 100000), Number(input.published), Number(input.demo === true)];
      if (input.id) {
        if (!db.prepare('UPDATE events SET title=?, day=?, time=?, category=?, room=?, description=?, price=?, published=?, demo=? WHERE id=?').run(...values, integer(input.id, 1, Number.MAX_SAFE_INTEGER)).changes) fail(404, 'Событие не найдено.');
      } else {
        db.prepare('INSERT INTO events(title, day, time, category, room, description, price, published, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...values);
      }
    } else if (path === '/api/admin/poll') {
      const { month, labels } = input;
      if (!isMonth(month) || !Array.isArray(labels) || labels.length < 2 || labels.length > 8) invalid('Укажи месяц и от 2 до 8 вариантов.');
      const clean = labels.map(label => field(label, 2, 75));
      if (new Set(clean.map(label => label.toLocaleLowerCase('ru'))).size !== clean.length) invalid('Варианты должны отличаться.');
      transaction(() => {
        if (db.prepare('SELECT 1 FROM polls WHERE month = ?').get(month)) fail(409, 'На этот месяц уже есть голосование.');
        if (db.prepare('SELECT 1 FROM polls WHERE open = 1').get()) fail(409, 'Сначала закрой текущее голосование.');
        addPoll(month, clean);
      });
    } else if (path === '/api/admin/poll/close') {
      if (!db.prepare('UPDATE polls SET open = 0 WHERE id = ? AND open = 1').run(integer(input.id, 1, Number.MAX_SAFE_INTEGER)).changes) fail(409, 'Голосование уже закрыто.');
    } else if (path === '/api/admin/request') {
      if (!['new', 'progress', 'closed'].includes(input.status)) invalid();
      if (!db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(input.status, integer(input.id, 1, Number.MAX_SAFE_INTEGER)).changes) fail(404, 'Заявка не найдена.');
    } else {
      fail(404, 'Страница не найдена.');
    }
    return json(res, 200, { ok: true });
  }
  fail(404, 'Страница не найдена.');
}

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/site.css': ['site.css', 'text/css; charset=utf-8'],
  '/site.js': ['site.js', 'text/javascript; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/hero.jpg': ['hero.jpg', 'image/jpeg'],
  '/mark.svg': ['mark.svg', 'image/svg+xml'],
};

createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (!['GET', 'HEAD'].includes(req.method) || !Object.hasOwn(files, pathname)) fail(404, 'Страница не найдена.');
    const [file, type] = files[pathname];
    const content = await readFile(new URL(`./public/${file}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (!(error instanceof RequestError) && error.code !== 'ENOENT') console.error(error);
    const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
    if (!res.headersSent) json(res, status, { error: error instanceof RequestError ? error.message : status === 404 ? 'Страница не найдена.' : 'Что-то пошло не так. Попробуй ещё раз.' });
  }
}).listen(port, host, () => console.log(`На месте → http://${host}:${port}  ·  Админка → /admin`));
