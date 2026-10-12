'use strict';
/* CareConnect server
 * - serves the web app (static, with security headers)
 * - keeps ONE shared database so Patient / Doctor / Admin on any device see the same data
 * - real-time updates + WebRTC signalling for live video consultations over WebSocket
 * Only dependency: "ws". Start with:  npm install && npm start
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const CC = require('./shared.js');

const SESSION_DAYS = 30;
const MAX_BODY = 200 * 1024;
const STATIC_FILES = {
  '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js',
  '/shared.js': 'shared.js', '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest',
  '/icon-64.png': 'icon-64.png', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png',
  '/icon-maskable-512.png': 'icon-maskable-512.png'
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png'
};

function createApp(opts = {}) {
  const ROOT = opts.root || __dirname;
  const DATA_DIR = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const TZ = opts.tz || process.env.CLINIC_TZ || 'Asia/Kolkata';
  const ENFORCE_WINDOW = opts.enforceWindow !== undefined ? opts.enforceWindow : process.env.ENFORCE_CALL_WINDOW !== 'false';
  const PUBLIC_URL = (opts.publicUrl || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const now = opts.now || (() => Date.now());
  const adminCreds = {
    email: (process.env.ADMIN_EMAIL || 'syed@gmail.com').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || 'Syed@7866'
  };
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.ICE_SERVERS) {
    try { const extra = JSON.parse(process.env.ICE_SERVERS); if (Array.isArray(extra)) iceServers = extra; }
    catch (e) { console.warn('ICE_SERVERS is not valid JSON, using default STUN servers.'); }
  }

  // ---------- password hashing ----------
  function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
  }
  function verifyPassword(user, pw) {
    if (!user || !user.pwHash) return false;
    const [, salt, hash] = String(user.pwHash).split('$');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 32);
    const known = Buffer.from(hash, 'hex');
    return known.length === test.length && crypto.timingSafeEqual(known, test);
  }
  const ctxBase = () => ({ tz: TZ, nowMs: now(), setPassword: (u, pw) => { u.pwHash = hashPassword(pw); } });

  // ---------- storage ----------
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = {}; }
  db.sessions = db.sessions && typeof db.sessions === 'object' ? db.sessions : {};
  CC.seed(db, ctxBase(), adminCreds);
  let rev = Number(db.rev) || 1;
  let saveTimer = null;
  function persistNow() {
    clearTimeout(saveTimer); saveTimer = null;
    db.rev = rev;
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }
  function persistSoon() { if (!saveTimer) saveTimer = setTimeout(persistNow, 200); }
  persistNow();

  // ---------- sessions ----------
  const sha = t => crypto.createHash('sha256').update(t).digest('hex');
  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[sha(token)] = { userId, createdAt: now() };
    return token;
  }
  function userFromToken(token) {
    if (!token) return null;
    const s = db.sessions[sha(String(token))];
    if (!s) return null;
    if (now() - s.createdAt > SESSION_DAYS * 86400000) { delete db.sessions[sha(token)]; return null; }
    return db.users.find(u => u.id === s.userId) || null;
  }
  const publicUser = u => { const { pwHash, ...rest } = u; return rest; };

  // ---------- per-role views (privacy: patients never receive other patients' data) ----------
  function viewFor(user) {
    const doctors = db.doctors.map(d => ({ ...d }));
    CC.applyRatings(doctors, db.appointments);
    let users, appointments;
    if (user.role === 'admin') { users = db.users.map(publicUser); appointments = db.appointments; }
    else if (user.role === 'doctor') { users = [publicUser(user)]; appointments = db.appointments.filter(a => a.doctorId === user.doctorId); }
    else { users = [publicUser(user)]; appointments = db.appointments.filter(a => a.patientId === user.id); }
    const cutoff = CC.isoDateInTz(now() - 2 * 86400000, TZ);
    const slotsTaken = db.appointments.filter(a => a.status !== 'Cancelled' && a.date >= cutoff)
      .map(a => ({ id: a.id, doctorId: a.doctorId, date: a.date, time: a.time, mode: a.mode, tokenNumber: a.tokenNumber, status: a.status }));
    return {
      users, doctors, appointments, slotsTaken,
      notifications: db.notifications.filter(n => n.userId === user.id)
    };
  }

  // ---------- http helpers ----------
  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  function sendJSON(res, status, obj) {
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
      req.on('error', reject);
    });
  }
  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : '';
  }
  function origin(req) {
    if (PUBLIC_URL) return PUBLIC_URL;
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers.host}`;
  }

  // login throttling
  const attempts = new Map();
  function throttled(key) {
    const t = now(); const list = (attempts.get(key) || []).filter(x => t - x < 10 * 60000);
    attempts.set(key, list);
    return list.length >= 10;
  }
  const noteFail = key => { const l = attempts.get(key) || []; l.push(now()); attempts.set(key, l); };

  // ---------- realtime ----------
  const sockets = new Set();            // authed sockets: {ws, user}
  const rooms = new Map();              // appointmentId -> {members: Map(userId -> socketInfo), both: bool}
  function wsSend(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function bump() {
    rev++; persistSoon();
    for (const s of sockets) wsSend(s.ws, { type: 'changed', rev });
  }

  // ---------- API ----------
  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/health') return sendJSON(res, 200, { ok: true, app: 'careconnect' });
    if (route === 'GET /api/config') {
      return sendJSON(res, 200, { ok: true, tz: TZ, now: now(), iceServers, enforceCallWindow: ENFORCE_WINDOW, openBeforeMin: CC.OPEN_BEFORE_MIN, closeAfterMin: CC.CLOSE_AFTER_MIN });
    }
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'Invalid request.' }); }
    }
    if (route === 'POST /api/login') {
      const email = String(body.email || '').trim().toLowerCase();
      const key = `${req.socket.remoteAddress}|${email}`;
      if (throttled(key)) return sendJSON(res, 429, { ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
      const user = db.users.find(u => String(u.email).toLowerCase() === email && u.role === body.role);
      if (!user || !verifyPassword(user, body.password)) { noteFail(key); return sendJSON(res, 401, { ok: false, error: 'Incorrect role, email, or password.' }); }
      if (user.role === 'doctor' && !db.doctors.some(d => d.id === user.doctorId)) return sendJSON(res, 403, { ok: false, error: 'Doctor profile not found. Contact Admin.' });
      const token = createSession(user.id); persistSoon();
      return sendJSON(res, 200, { ok: true, token, userId: user.id, rev, view: viewFor(user) });
    }
    if (route === 'POST /api/signup') {
      const key = `signup|${req.socket.remoteAddress}`;
      if (throttled(key)) return sendJSON(res, 429, { ok: false, error: 'Too many attempts. Please try again later.' });
      noteFail(key);
      const r = CC.run('signup', db, null, body, ctxBase());
      if (!r.ok) return sendJSON(res, 400, r);
      const token = createSession(r.user.id); bump();
      return sendJSON(res, 200, { ok: true, token, userId: r.user.id, rev, view: viewFor(r.user) });
    }

    const user = userFromToken(bearer(req));
    if (!user) return sendJSON(res, 401, { ok: false, error: 'Session expired. Please sign in again.' });

    if (route === 'POST /api/logout') {
      delete db.sessions[sha(bearer(req))]; persistSoon();
      return sendJSON(res, 200, { ok: true });
    }
    if (route === 'GET /api/sync') {
      if (Number(url.searchParams.get('rev')) === rev) return sendJSON(res, 200, { ok: true, rev, unchanged: true });
      return sendJSON(res, 200, { ok: true, rev, view: viewFor(user) });
    }
    if (route === 'POST /api/action') {
      const type = String(body.type || '');
      if (type === 'signup') return sendJSON(res, 400, { ok: false, error: 'Unknown action.' });
      const r = CC.run(type, db, user, body.payload, ctxBase());
      if (!r.ok) return sendJSON(res, 200, { ok: false, error: r.error, rev, view: viewFor(user) });
      if (type === 'chat') {
        const room = rooms.get(body.payload.appointmentId);
        if (room) for (const m of room.members.values()) wsSend(m.ws, { type: 'chat', appointmentId: body.payload.appointmentId, message: r.message });
      }
      bump();
      const result = {};
      if (r.appointment) result.appointmentId = r.appointment.id;
      if (r.updated) result.updated = true;
      if (r.message) result.message = r.message;
      return sendJSON(res, 200, { ok: true, rev, result, view: viewFor(user) });
    }
    return sendJSON(res, 404, { ok: false, error: 'Not found.' });
  }

  // ---------- static ----------
  function serveStatic(req, res, url) {
    if (url.pathname === '/robots.txt') {
      return send(res, 200, `User-agent: *\nAllow: /\nSitemap: ${origin(req)}/sitemap.xml\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (url.pathname === '/sitemap.xml') {
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin(req)}/</loc><changefreq>monthly</changefreq></url></urlset>\n`, { 'Content-Type': 'application/xml; charset=utf-8' });
    }
    const file = STATIC_FILES[url.pathname];
    if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    let data;
    try { data = fs.readFileSync(path.join(ROOT, file)); } catch (e) { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' }); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (file === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (file === 'index.html') {
      const o = origin(req);
      data = data.toString('utf8').replace('<!--SEO-->', `<link rel="canonical" href="${o}/" /><meta property="og:url" content="${o}/" />`);
    }
    send(res, 200, data, headers);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url);
    } catch (e) {
      console.error('Request error:', e);
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: 'Server error.' });
    }
  });

  // ---------- WebSocket: realtime pings + video signalling ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  function leaveRoom(info, notify = true) {
    const id = info.roomId;
    if (!id) return;
    info.roomId = null;
    const room = rooms.get(id);
    if (!room) return;
    if (room.members.get(info.user.id) === info) room.members.delete(info.user.id);
    if (notify) for (const m of room.members.values()) wsSend(m.ws, { type: 'peer-left', userId: info.user.id });
    if (!room.members.size) rooms.delete(id);
  }
  wss.on('connection', ws => {
    const info = { ws, user: null, roomId: null, alive: true };
    const authTimer = setTimeout(() => { if (!info.user) ws.close(4001, 'auth timeout'); }, 8000);
    ws.on('pong', () => { info.alive = true; });
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'auth') {
        const user = userFromToken(msg.token);
        if (!user) { wsSend(ws, { type: 'auth-failed' }); return ws.close(4002, 'unauthorized'); }
        info.user = user; clearTimeout(authTimer); sockets.add(info);
        return wsSend(ws, { type: 'ready', rev });
      }
      if (!info.user) return;
      // refresh the user record (role/doctor link may have changed)
      info.user = db.users.find(u => u.id === info.user.id) || info.user;
      const u = info.user;

      if (msg.type === 'join-call') {
        const a = db.appointments.find(x => x.id === msg.appointmentId);
        const isParticipant = a && ((u.role === 'patient' && a.patientId === u.id) || (u.role === 'doctor' && a.doctorId === u.doctorId));
        if (!a || !isParticipant) return wsSend(ws, { type: 'call-error', error: 'You are not part of this appointment.' });
        if (a.mode !== 'online') return wsSend(ws, { type: 'call-error', error: 'This is not an online appointment.' });
        if (a.status !== 'Confirmed') return wsSend(ws, { type: 'call-error', error: `This appointment is ${a.status.toLowerCase()}.` });
        if (ENFORCE_WINDOW) {
          const w = CC.joinWindow(a, now(), TZ);
          if (w.state === 'early') return wsSend(ws, { type: 'call-error', error: `The video room opens ${CC.OPEN_BEFORE_MIN} minutes before the appointment time (${a.time}).` });
          if (w.state === 'late') return wsSend(ws, { type: 'call-error', error: 'The video room for this appointment has closed.' });
        }
        leaveRoom(info);
        let room = rooms.get(a.id);
        if (!room) { room = { members: new Map(), both: false }; rooms.set(a.id, room); }
        const prev = room.members.get(u.id);
        if (prev && prev !== info) { wsSend(prev.ws, { type: 'call-replaced' }); prev.roomId = null; room.members.delete(u.id); for (const m of room.members.values()) wsSend(m.ws, { type: 'peer-left', userId: u.id }); }
        const peers = [...room.members.values()].map(m => ({ userId: m.user.id, role: m.user.role, name: m.user.name }));
        room.members.set(u.id, info); info.roomId = a.id;
        if (room.members.size >= 2) room.both = true;
        wsSend(ws, { type: 'call-joined', appointmentId: a.id, peers, me: { userId: u.id, role: u.role } });
        for (const m of room.members.values()) if (m !== info) wsSend(m.ws, { type: 'peer-joined', peer: { userId: u.id, role: u.role, name: u.name } });
        return;
      }
      const room = info.roomId ? rooms.get(info.roomId) : null;
      if (!room) return;
      if (msg.type === 'signal' || msg.type === 'call-state') {
        for (const m of room.members.values()) if (m !== info) wsSend(m.ws, { type: msg.type, from: u.id, data: msg.data });
        return;
      }
      if (msg.type === 'leave-call') return leaveRoom(info);
      if (msg.type === 'end-call') {
        const apptId = info.roomId;
        let completed = false;
        if (room.both) {
          const a = db.appointments.find(x => x.id === apptId);
          if (a && a.status === 'Confirmed') {
            const r = CC.run('complete', db, u, { id: apptId }, ctxBase());
            completed = !!r.ok;
            if (completed) bump();
          } else completed = !!a && a.status === 'Completed';
        }
        for (const m of room.members.values()) if (m !== info) wsSend(m.ws, { type: 'call-ended', by: u.id, completed });
        wsSend(ws, { type: 'call-end-ack', completed });
        return leaveRoom(info, false);
      }
    });
    ws.on('close', () => { clearTimeout(authTimer); sockets.delete(info); leaveRoom(info); });
    ws.on('error', () => {});
  });
  const heartbeat = setInterval(() => {
    for (const info of sockets) {
      if (!info.alive) { info.ws.terminate(); continue; }
      info.alive = false; try { info.ws.ping(); } catch (e) { /* ignore */ }
    }
  }, 30000);

  // reminders
  const reminderTimer = setInterval(() => {
    if (CC.runReminders(db, now(), TZ)) bump();
  }, 30000);

  return {
    server, db: () => db, rev: () => rev, config: { TZ },
    listen(port, host) { return new Promise(r => server.listen(port, host, () => r(server.address().port))); },
    runRemindersNow() { if (CC.runReminders(db, now(), TZ)) bump(); },
    close() {
      clearInterval(heartbeat); clearInterval(reminderTimer);
      persistNow();
      for (const c of wss.clients) c.terminate();
      return new Promise(r => { wss.close(); server.close(() => r()); });
    }
  };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, process.env.HOST || '0.0.0.0').then(p => {
    console.log(`CareConnect running on port ${p}  (clinic timezone: ${app.config.TZ})`);
    if (!process.env.ADMIN_PASSWORD) console.log('NOTE: using the demo admin password. Set ADMIN_EMAIL / ADMIN_PASSWORD before going public.');
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
