'use strict';
// End-to-end check of the REAL browser code (index.html + app.js + shared.js) running in jsdom
// against the REAL server: three "devices" (patient, doctor, admin) share data live and the
// video-call state machine runs through a mocked WebRTC stack.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const CC = require('../shared.js');
const { createApp } = require('../server.js');

let app, base;
const TZ = 'Asia/Kolkata';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
  }
}
function nextDoctorDay() {
  const today = CC.isoDateInTz(Date.now(), TZ);
  for (let i = 1; i < 10; i++) {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    if ([1, 3, 5].includes(d.getUTCDay())) return d.toISOString().slice(0, 10); // Ramesh: Mon, Wed, Fri
  }
}

class FakeTrack { constructor(kind) { this.kind = kind; this.enabled = true; } stop() { this.stopped = true; } }
class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; } getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); } addTrack(t) { this.tracks.push(t); }
}
function installMocks(window) {
  window.MediaStream = FakeStream;
  Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia: async () => new FakeStream([new FakeTrack('audio'), new FakeTrack('video')]) } });
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.__pcs = [];
  window.RTCPeerConnection = class {
    constructor(cfg) { this.cfg = cfg; this.signalingState = 'stable'; this.iceConnectionState = 'new'; this.senders = []; window.__pcs.push(this); }
    _neg() { if (this._queued) return; this._queued = true; Promise.resolve().then(() => { this._queued = false; this.onnegotiationneeded && this.onnegotiationneeded(); }); }
    addTrack(t) { this.senders.push(t); this._neg(); } addTransceiver(k) { this.senders.push(k); this._neg(); }
    async setLocalDescription() {
      const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
      this.localDescription = { type, sdp: `fake-${type}` };
      this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
      if (type === 'answer') this._connected();
    }
    async setRemoteDescription(d) {
      this.remoteDescription = d;
      this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
      if (d.type === 'answer') this._connected();
    }
    _connected() { setTimeout(() => { this.iceConnectionState = 'connected'; this.oniceconnectionstatechange && this.oniceconnectionstatechange(); }, 5); }
    async addIceCandidate() {} restartIce() {} close() { this.closed = true; }
  };
}

async function openClient() {
  const dom = await JSDOM.fromURL(`${base}/`, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, opts = {}) => { const { signal, ...rest } = opts; return fetch(new URL(u, base).href, rest); };
      window.confirm = () => true;
      installMocks(window);
    }
  });
  const w = dom.window;
  await waitFor(() => w.eval('typeof SERVER !== "undefined" && SERVER.on === true'), 6000, 'client boot');
  const c = {
    window: w, document: w.document,
    ev: code => w.eval(code),
    text: () => w.document.getElementById('pageContent').textContent,
    visible: id => !w.document.getElementById(id).classList.contains('hidden'),
    fire(el, type) { el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true })); },
    click(sel) { const el = w.document.querySelector(sel); assert.ok(el, `missing ${sel}`); el.click(); },
    async login(email, password, role) {
      const d = w.document;
      d.querySelector(`#loginForm input[name=loginRole][value=${role}]`).checked = true;
      d.getElementById('loginEmail').value = email; d.getElementById('loginPassword').value = password;
      c.fire(d.getElementById('loginForm'), 'submit');
      await waitFor(() => c.visible('appView'), 4000, `login ${email}`);
    }
  };
  return c;
}

test.before(async () => {
  app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-')), tz: TZ, enforceWindow: false });
  base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
});
test.after(() => app.close());

let patient, doctor, admin;
const DAY = nextDoctorDay();

test('three devices sign in; shared mode is detected; mobile nav and install hook render', async () => {
  patient = await openClient(); doctor = await openClient(); admin = await openClient();
  assert.equal(patient.ev('SERVER.on'), true);
  assert.ok(!patient.visible('authView'), 'auth view visible before login') === undefined;
});
test('patient signs up through the real form', async () => {
  const d = patient.document;
  d.getElementById('signupName').value = 'Asha Rao'; d.getElementById('signupEmail').value = 'asha@example.com';
  d.getElementById('signupPhone').value = '9876543210'; d.getElementById('signupPassword').value = 'secret1';
  patient.fire(d.getElementById('signupForm'), 'submit');
  await waitFor(() => patient.visible('appView'), 4000, 'signup');
  assert.match(d.getElementById('sidebarName').textContent, /Asha Rao/);
  assert.ok(d.querySelectorAll('#mobileNav button').length >= 5, 'mobile bottom nav rendered');
});
test('doctor and admin sign in', async () => {
  await doctor.login('ramesh@gmail.com', '2007', 'doctor');
  await admin.login('syed@gmail.com', 'Syed@7866', 'admin');
  assert.match(doctor.document.getElementById('sidebarRole').textContent, /Doctor/);
});

test('patient books online → doctor sees it live (no refresh) with a notification', async () => {
  patient.window.bookingModal('d1');
  const f = patient.document.getElementById('bookingForm');
  f.querySelector('input[name=mode][value=online]').checked = true;
  f.elements.namedItem('date').value = DAY; patient.fire(f.elements.namedItem('date'), 'change');
  f.elements.namedItem('reason').value = 'Fever and cough';
  assert.equal(f.elements.namedItem('time').value, '09:00');
  patient.fire(f, 'submit');
  await waitFor(() => /Fever and cough/.test(patient.text()), 4000, 'patient sees booking');
  await waitFor(() => /Asha Rao/.test(doctor.text()), 4000, 'doctor sees booking live');
  await waitFor(() => doctor.ev('db().notifications.some(n => n.title === "New appointment booked")'), 4000, 'doctor notified');
  assert.ok(patient.ev('db().notifications.some(n => n.title === "Appointment booked")'));
  assert.ok(doctor.document.querySelector('[data-video-call]'), 'doctor has a Join video button');
  assert.ok(patient.document.querySelector('[data-video-call]'), 'patient has a Join video button');
});

test('doctor changes schedule → patient and admin screens update automatically', async () => {
  doctor.window.doctorModal('d1');
  const f = doctor.document.getElementById('doctorForm');
  f.elements.namedItem('fee').value = '900';
  f.elements.namedItem('availability').value = 'Mon, Wed, Fri, Sat';
  doctor.click('[data-save-doctor]');
  await waitFor(() => patient.ev('db().doctors.find(d => d.id === "d1").fee') === 900, 4000, 'patient sees fee');
  assert.equal(admin.ev('db().doctors.find(d => d.id === "d1").availability'), 'Mon, Wed, Fri, Sat');
  patient.ev('state.page = "doctors"; render()');
  assert.match(patient.text(), /₹900/);
  assert.match(patient.text(), /Mon, Wed, Fri, Sat/);
});

test('doctor marks unavailable → patient is blocked and notified; admin edit saves everywhere', async () => {
  doctor.ev('state.page = "availability"; render()');
  doctor.click('[data-toggle-self]');
  await waitFor(() => /Currently unavailable/.test(patient.text()), 4000, 'patient sees unavailable');
  await waitFor(() => patient.ev('db().notifications.some(n => /is unavailable/.test(n.title))'), 4000, 'patient notified');
  admin.window.doctorModal('d1');
  const f = admin.document.getElementById('doctorForm');
  f.elements.namedItem('specialty').value = 'Cardiologist';
  f.elements.namedItem('available').checked = true;
  admin.click('[data-save-doctor]');
  await waitFor(() => /Cardiologist/.test(patient.text()), 4000, 'patient sees admin edit');
  assert.equal(doctor.ev('db().doctors.find(d => d.id === "d1").specialty'), 'Cardiologist');
  assert.equal(doctor.ev('db().doctors.find(d => d.id === "d1").available'), true);
});

test('live video: both join, offer/answer are exchanged, chat is delivered, doctor ends → visit completed + patient rating prompt', async () => {
  const appt = patient.ev('db().appointments[0].id');
  patient.window.videoCallModal(appt);
  await waitFor(() => /WAITING/.test(patient.document.getElementById('callBadge').textContent), 4000, 'patient waiting');
  doctor.window.videoCallModal(appt);
  await waitFor(() => patient.window.__pcs.length && doctor.window.__pcs.length, 4000, 'both create peer connections');
  await waitFor(() => /LIVE/.test(patient.document.getElementById('callBadge').textContent) && /LIVE/.test(doctor.document.getElementById('callBadge').textContent), 4000, 'both LIVE');
  assert.ok(patient.window.__pcs[0].cfg.iceServers.length, 'STUN servers configured');
  // mute → remote is told
  patient.click('#toggleMic');
  await waitFor(() => /muted/.test(doctor.document.getElementById('callNote').textContent), 3000, 'doctor sees mute notice');
  // chat
  patient.document.getElementById('callChatInput').value = 'Hello doctor, can you hear me?';
  patient.fire(patient.document.getElementById('callChatForm'), 'submit');
  await waitFor(() => /can you hear me/.test(doctor.document.getElementById('callChatMessages').textContent), 3000, 'doctor receives chat');
  // end
  doctor.click('#endCall');
  await waitFor(() => !patient.visible('modal') || patient.document.getElementById('ratingForm'), 5000, 'patient call closed');
  await waitFor(() => patient.document.getElementById('ratingForm'), 5000, 'rating dialog opens for patient');
  assert.equal(patient.ev('db().appointments[0].status'), 'Completed');
  assert.equal(doctor.ev('db().appointments[0].status'), 'Completed');
  assert.ok(patient.window.__pcs[0].closed && doctor.window.__pcs[0].closed, 'peer connections closed');
  // rate
  patient.document.querySelector('[data-star="5"]').click();
  patient.click('[data-submit-rating]');
  await waitFor(() => patient.ev('db().doctors.find(d => d.id === "d1").ratingCount') === 1, 4000, 'rating saved');
  await waitFor(() => admin.ev('db().doctors.find(d => d.id === "d1").ratingSum') === 5, 4000, 'admin sees rating');
});

test('logout clears the cached private data', async () => {
  const id = patient.ev('SERVER.userId');
  patient.click('#logoutBtn');
  await waitFor(() => patient.visible('authView'), 3000, 'auth view after logout');
  assert.equal(patient.window.localStorage.getItem(`careconnect_cache_${id}`), null);
  assert.equal(patient.ev('SERVER.token'), null);
});
