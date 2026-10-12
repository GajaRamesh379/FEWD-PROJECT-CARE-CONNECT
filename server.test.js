'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const CC = require('../shared.js');
const { createApp } = require('../server.js');

const TZ = 'Asia/Kolkata';
let clock = CC.zonedToEpoch('2026-10-12', '08:30', TZ); // a Monday
const DAY = '2026-10-12';

let app, base;
test.before(async () => {
  app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), now: () => clock, tz: TZ });
  const port = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});
test.after(() => app.close());

async function api(method, url, body, token) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, ...(await r.json()) };
}
const login = (email, password, role) => api('POST', '/api/login', { email, password, role });
const act = (token, type, payload) => api('POST', '/api/action', { type, payload }, token);

function wsClient(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const queue = []; const waiters = [];
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex(w => w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    const c = {
      ws, send: o => ws.send(JSON.stringify(o)),
      next(type, ms = 2000) {
        const i = queue.findIndex(m => m.type === type);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
          waiters.push({ type, resolve: m => { clearTimeout(t); res(m); } });
        });
      }
    };
    c.next('ready').then(() => resolve(c), reject);
  });
}

test('static files, security headers and whitelist', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(base + '/server.js')).status, 404);
  assert.equal((await fetch(base + '/data/db.json')).status, 404);
  assert.equal((await fetch(base + '/shared.js')).status, 200);
  assert.match(await (await fetch(base + '/robots.txt')).text(), /Sitemap:/);
});

test('login rejects wrong credentials; no password hashes leak', async () => {
  assert.equal((await login('syed@gmail.com', 'nope', 'admin')).status, 401);
  assert.equal((await login('syed@gmail.com', 'Syed@7866', 'patient')).status, 401);
  const a = await login('syed@gmail.com', 'Syed@7866', 'admin');
  assert.ok(a.token);
  assert.ok(!JSON.stringify(a.view).includes('pwHash'));
});

let patientToken, patient2Token, doctorToken, adminToken, apptId;
test('signup + booking flow notifies both doctor and patient', async () => {
  adminToken = (await login('syed@gmail.com', 'Syed@7866', 'admin')).token;
  doctorToken = (await login('ramesh@gmail.com', '2007', 'doctor')).token;
  const s1 = await api('POST', '/api/signup', { role: 'patient', name: 'Asha Rao', email: 'asha@example.com', phone: '9999900000', password: 'secret1' });
  assert.ok(s1.token, s1.error);
  patientToken = s1.token;
  const s2 = await api('POST', '/api/signup', { role: 'patient', name: 'Bala K', email: 'bala@example.com', phone: '9999911111', password: 'secret2' });
  patient2Token = s2.token;
  assert.equal((await api('POST', '/api/signup', { role: 'patient', name: 'X', email: 'asha@example.com', phone: '1', password: 'secret1' })).status, 400);

  const r = await act(patientToken, 'book', { doctorId: 'd1', date: DAY, time: '09:00', mode: 'online', reason: 'Fever' });
  assert.ok(r.ok, r.error);
  apptId = r.result.appointmentId;
  const pv = r.view;
  assert.ok(pv.notifications.some(n => n.title === 'Appointment booked'));
  const dv = (await api('GET', '/api/sync?rev=0', null, doctorToken)).view;
  assert.ok(dv.appointments.some(a => a.id === apptId), 'doctor sees booking');
  assert.ok(dv.notifications.some(n => n.title === 'New appointment booked' && /Asha Rao/.test(n.message)), 'doctor notified');
});

test('double booking, past slots, wrong day are rejected', async () => {
  const dup = await act(patient2Token, 'book', { doctorId: 'd1', date: DAY, time: '09:00', mode: 'offline', reason: 'x' });
  assert.equal(dup.ok, false); assert.match(dup.error, /already booked/);
  const wrongDay = await act(patient2Token, 'book', { doctorId: 'd1', date: '2026-10-13', time: '09:00', mode: 'offline', reason: 'x' });
  assert.match(wrongDay.error, /available on/);
  clock = CC.zonedToEpoch(DAY, '10:30', TZ);
  const past = await act(patient2Token, 'book', { doctorId: 'd1', date: DAY, time: '10:00', mode: 'offline', reason: 'x' });
  assert.match(past.error, /passed/);
  clock = CC.zonedToEpoch(DAY, '08:30', TZ);
});

test('offline tokens are unique per doctor+date even across patients', async () => {
  const a = await act(patient2Token, 'book', { doctorId: 'd1', date: DAY, time: '10:00', mode: 'offline', reason: 'Checkup' });
  const b = await act(patientToken, 'book', { doctorId: 'd1', date: DAY, time: '11:00', mode: 'offline', reason: 'Checkup 2' });
  const ta = a.view.appointments.find(x => x.id === a.result.appointmentId).tokenNumber;
  const tb = b.view.appointments.find(x => x.id === b.result.appointmentId).tokenNumber;
  assert.deepEqual([ta, tb], [1, 2]);
});

test('patients cannot see other patients; doctors only see their own', async () => {
  const v = (await api('GET', '/api/sync?rev=0', null, patient2Token)).view;
  assert.ok(v.appointments.every(a => a.patientName === 'Bala K'));
  assert.equal(v.users.length, 1);
  const dv = (await api('GET', '/api/sync?rev=0', null, (await login('rahul.mehta@careconnect.demo', 'Doctor@1001', 'doctor')).token)).view;
  assert.equal(dv.appointments.length, 0);
});

test('doctor schedule change propagates to patient, admin and doctor views', async () => {
  const r = await act(doctorToken, 'saveDoctor', { id: 'd1', fee: 750, availability: 'Tue, Thu', slots: '09:00, 10:00, 11:00, 16:00', available: true });
  assert.ok(r.ok, r.error);
  for (const [t, who] of [[patientToken, 'patient'], [adminToken, 'admin'], [doctorToken, 'doctor']]) {
    const d = (await api('GET', '/api/sync?rev=0', null, t)).view.doctors.find(x => x.id === 'd1');
    assert.equal(d.fee, 750, who); assert.equal(d.availability, 'Tue, Thu', who);
  }
  const pv = (await api('GET', '/api/sync?rev=0', null, patientToken)).view;
  assert.ok(pv.notifications.some(n => /changed their schedule/.test(n.title)), 'patient told about schedule conflict');
  await act(doctorToken, 'saveDoctor', { id: 'd1', fee: 500, availability: 'Mon, Wed, Fri', slots: '09:00, 10:00, 11:00, 16:00', available: true });
});

test('unavailable toggle blocks booking and notifies; admin edits sync everywhere', async () => {
  const t = await act(doctorToken, 'toggleDoctor', { id: 'd1' });
  assert.equal(t.view.doctors.find(d => d.id === 'd1').available, false);
  assert.match((await act(patient2Token, 'book', { doctorId: 'd1', date: DAY, time: '16:00', mode: 'offline', reason: 'x' })).error, /unavailable/);
  const pv = (await api('GET', '/api/sync?rev=0', null, patientToken)).view;
  assert.ok(pv.notifications.some(n => /is unavailable/.test(n.title)));
  await act(adminToken, 'toggleDoctor', { id: 'd1' });
  const ed = await act(adminToken, 'saveDoctor', { id: 'd1', name: 'Ramesh Kumar', specialty: 'Cardiologist', experience: '11 years', fee: 650, availability: 'Mon, Wed, Fri', slots: '09:00, 10:00, 11:00, 16:00', available: true, loginEmail: 'ramesh@gmail.com', loginPassword: 'newpass1' });
  assert.ok(ed.ok, ed.error);
  const pd = (await api('GET', '/api/sync?rev=0', null, patientToken)).view.doctors.find(d => d.id === 'd1');
  assert.equal(pd.specialty, 'Cardiologist'); assert.equal(pd.fee, 650);
  assert.equal((await login('ramesh@gmail.com', '2007', 'doctor')).status, 401);
  assert.ok((await login('ramesh@gmail.com', 'newpass1', 'doctor')).token);
  doctorToken = (await login('ramesh@gmail.com', 'newpass1', 'doctor')).token;
});

test('admin adds a doctor who can log in and is visible to patients', async () => {
  const r = await act(adminToken, 'saveDoctor', { name: 'Meera Iyer', specialty: 'ENT', experience: '6 years', fee: 400, availability: 'Mon-Fri', slots: '9:30, 14:00', available: true, loginEmail: 'meera@example.com', loginPassword: 'meera123' });
  assert.ok(r.ok, r.error);
  assert.ok((await login('meera@example.com', 'meera123', 'doctor')).token);
  const pv = (await api('GET', '/api/sync?rev=0', null, patientToken)).view;
  const d = pv.doctors.find(x => x.name === 'Meera Iyer');
  assert.deepEqual(d.slots, ['09:30', '14:00']);
  assert.ok((await act(patientToken, 'saveDoctor', {})).error);
});

test('authorization: patients cannot touch others appointments or rate before completion', async () => {
  assert.equal((await act(patient2Token, 'cancel', { id: apptId })).ok, false);
  assert.equal((await act(patientToken, 'rate', { id: apptId, stars: 5 })).ok, false);
  assert.equal((await act(doctorToken, 'deleteDoctor', { id: 'd2' })).ok, false);
});

test('video: join window, signalling relay, end call completes visit and rating works', async () => {
  const p = await wsClient(patientToken), d = await wsClient(doctorToken);
  p.send({ type: 'join-call', appointmentId: apptId });
  assert.match((await p.next('call-error')).error, /opens 10 minutes before/);
  clock = CC.zonedToEpoch(DAY, '08:55', TZ);
  p.send({ type: 'join-call', appointmentId: apptId });
  const pj = await p.next('call-joined'); assert.equal(pj.peers.length, 0);
  d.send({ type: 'join-call', appointmentId: apptId });
  const dj = await d.next('call-joined'); assert.equal(dj.peers.length, 1);
  assert.equal((await p.next('peer-joined')).peer.role, 'doctor');
  p.send({ type: 'signal', data: { description: { type: 'offer', sdp: 'x' } } });
  assert.equal((await d.next('signal')).data.description.type, 'offer');
  d.send({ type: 'call-state', data: { audio: true, video: false } });
  assert.equal((await p.next('call-state')).data.video, false);
  const other = await wsClient(patient2Token);
  other.send({ type: 'join-call', appointmentId: apptId });
  assert.match((await other.next('call-error')).error, /not part/);
  const chat = await act(patientToken, 'chat', { appointmentId: apptId, text: 'Hello doctor' });
  assert.ok(chat.ok);
  assert.equal((await d.next('chat')).message.text, 'Hello doctor');
  d.send({ type: 'end-call' });
  assert.equal((await p.next('call-ended')).completed, true);
  const pv = (await api('GET', '/api/sync?rev=0', null, patientToken)).view;
  assert.equal(pv.appointments.find(a => a.id === apptId).status, 'Completed');
  const rate = await act(patientToken, 'rate', { id: apptId, stars: 4, comment: 'Clear call' });
  assert.ok(rate.ok, rate.error);
  const dr = rate.view.doctors.find(x => x.id === 'd1');
  assert.deepEqual([dr.ratingCount, dr.ratingSum], [1, 4]);
  [p, d, other].forEach(c => c.ws.close());
});

test('reminders are created for both parties before an appointment', async () => {
  const r = await act(patient2Token, 'book', { doctorId: 'd1', date: DAY, time: '16:00', mode: 'online', reason: 'Follow up' });
  assert.ok(r.ok, r.error);
  clock = CC.zonedToEpoch(DAY, '15:50', TZ);
  app.runRemindersNow();
  const pv = (await api('GET', '/api/sync?rev=0', null, patient2Token)).view;
  assert.ok(pv.notifications.some(n => /starting/i.test(n.title)));
  const dv = (await api('GET', '/api/sync?rev=0', null, doctorToken)).view;
  assert.ok(dv.notifications.some(n => /starting/i.test(n.title)));
  app.runRemindersNow();
  const again = (await api('GET', '/api/sync?rev=0', null, patient2Token)).view;
  assert.equal(again.notifications.filter(n => /starting/i.test(n.title)).length, pv.notifications.filter(n => /starting/i.test(n.title)).length, 'no duplicates');
});
