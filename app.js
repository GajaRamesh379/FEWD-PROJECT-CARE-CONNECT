const KEY = 'careconnect_data_v6';            // single-device demo store (no server)
const CACHE_PREFIX = 'careconnect_cache_';    // cached copy of a signed-in user's server view
const SESSION_KEY = 'careconnect_session';
const ADMIN_DEMO = { email: 'syed@gmail.com', password: 'Syed@7866' };

// SERVER.on = true when the CareConnect server is reachable (shared data, live video).
// Otherwise the app runs as a single-device demo using Local Storage.
const SERVER = {
  on: false, token: null, userId: null, rev: 0, tz: null, skew: 0, enforce: true,
  ice: [{ urls: ['stun:stun.l.google.com:19302'] }],
  ws: null, wsReady: false, retry: 1000, rt: null, known: null, offline: false
};

function freshState() {
  return { page: 'dashboard', search: '', filter: 'All', chat: [], activeCall: null, callStream: null, callAudioOn: true, callVideoOn: true };
}
let state = freshState();

function nowMs() { return Date.now() + SERVER.skew; }
function clinicTZ() { return SERVER.on && SERVER.tz ? SERVER.tz : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'); }
function todayISO() { return CC.isoDateInTz(nowMs(), clinicTZ()); }

function emptyDb() { return { users: [], doctors: [], appointments: [], notifications: [], slotsTaken: [] }; }
function storeKey() { return SERVER.on ? (SERVER.userId ? CACHE_PREFIX + SERVER.userId : null) : KEY; }

function db() {
  const key = storeKey();
  if (!key) return emptyDb();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return emptyDb();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid stored data');
    return parsed;
  } catch (error) {
    console.error('CareConnect data read failed:', error);
    return emptyDb();
  }
}

// Demo mode only: in shared mode the server owns the data and the browser just caches its view.
function save(data) {
  try {
    const payload = JSON.stringify(data);
    localStorage.setItem(KEY, payload);
    if (localStorage.getItem(KEY) !== payload) throw new Error('Local Storage verification failed');
    return true;
  } catch (error) {
    console.error('CareConnect save failed:', error);
    showToast('Could not save changes. Please check browser storage permissions.');
    return false;
  }
}
function writeCache(view) {
  try { localStorage.setItem(CACHE_PREFIX + SERVER.userId, JSON.stringify(view)); }
  catch (error) { console.warn('Could not cache server data:', error); }
}

// Sessions are per browser tab (so a doctor and a patient can be open in two tabs),
// mirrored to Local Storage so reopening the installed app keeps you signed in.
function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) { return null; }
}
function writeSession(obj) {
  const raw = JSON.stringify(obj);
  try { sessionStorage.setItem(SESSION_KEY, raw); } catch (e) { /* private mode */ }
  try { localStorage.setItem(SESSION_KEY, raw); } catch (e) { /* ignore */ }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}
// Always resolves the LIVE user record, so edits made elsewhere show up immediately.
function session() {
  const s = SERVER.on ? (SERVER.userId ? { id: SERVER.userId } : null) : readSession();
  if (!s || !s.id) return null;
  return db().users.find(u => u.id === s.id) || null;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
}

function roleLabel(role) {
  return role === 'admin' ? 'Administrator' : role === 'doctor' ? 'Doctor portal' : 'Patient portal';
}

let toastTimer = null;
function showToast(message) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', {
    day:'numeric', month:'short', year:'numeric'
  });
}

function ensurePatientDefaults(user) {
  user.profileHistory = Array.isArray(user.profileHistory) ? user.profileHistory : [];
  user.age = user.age ?? '';
  user.gender = user.gender ?? '';
  user.bloodGroup = user.bloodGroup ?? '';
  user.address = user.address ?? '';
  user.emergencyContact = user.emergencyContact ?? '';
}

const localCtx = () => ({ tz: clinicTZ(), nowMs: nowMs(), setPassword: (u, pw) => { u.password = pw; } });

function normalizeData(data) {
  CC.normalize(data);
  if (!SERVER.on) {
    // Demo mode: every doctor needs a login, and ratings are derived from appointments.
    data.doctors.forEach((doctor, index) => {
      if (!data.users.some(u => u.role === 'doctor' && u.doctorId === doctor.id)) {
        data.users.push({
          id: `doctor-user-${doctor.id}`, name: doctor.name,
          email: `${doctor.name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}@careconnect.demo`,
          password: `Doctor@${1000 + index}`, phone: '0000000000', role: 'doctor', doctorId: doctor.id
        });
      }
    });
    CC.applyRatings(data.doctors, data.appointments);
  }
  data.users.filter(u => u.role === 'patient').forEach(ensurePatientDefaults);
  return data;
}

function safeParseRaw(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch (error) { console.warn('Ignoring invalid stored data:', error); return null; }
}

function seedLocal() {
  let current = safeParseRaw(localStorage.getItem(KEY));
  if (!current) {
    const old = safeParseRaw(
      localStorage.getItem('careconnect_data_v5') || localStorage.getItem('careconnect_data_v4') ||
      localStorage.getItem('careconnect_data_v3') || localStorage.getItem('careconnect_data_v2') ||
      localStorage.getItem('careconnect_data_v1')
    );
    if (old && Array.isArray(old.users) && Array.isArray(old.doctors)) {
      current = {
        users: old.users.map(u => ({ ...u })), doctors: old.doctors.map(d => ({ ...d })),
        appointments: Array.isArray(old.appointments) ? old.appointments.map(a => ({ ...a })) : [],
        notifications: Array.isArray(old.notifications) ? old.notifications.map(n => ({ ...n })) : []
      };
    }
  }
  if (!current || typeof current !== 'object') current = {};
  CC.seed(current, localCtx(), ADMIN_DEMO);
  normalizeData(current);
  save(current);
  const s = readSession();
  if (s && !current.users.some(u => u.id === s.id)) clearSession();
}

function nextOfflineToken(data, doctorId, date, ignoreId = '') {
  return CC.nextToken(data, doctorId, date, ignoreId);
}

function getDoctor(data, doctorId) {
  return data.doctors.find(d => d.id === doctorId);
}

// ---- Run a business action: on the server (shared mode) or locally (demo mode) ----
async function perform(type, payload) {
  if (!SERVER.on) {
    const d = normalizeData(db());
    const r = CC.run(type, d, session(), payload, localCtx());
    if (!r.ok) { showToast(r.error); return r; }
    if (!save(normalizeData(d))) return { ok: false, error: 'Could not save.' };
    render();
    return r;
  }
  try {
    const res = await apiFetch('POST', '/api/action', { type, payload });
    if (res.view) applyView(res);
    if (!res.ok) showToast(res.error || 'That did not work. Please try again.');
    return res;
  } catch (e) {
    const msg = e.network ? 'No connection to the CareConnect server. Please check your internet and try again.' : (e.message || 'Something went wrong.');
    if (e.status !== 401) showToast(msg);
    return { ok: false, error: msg };
  }
}

// ---- Ratings ---------------------------------------------------------
function ratingAvg(doctor) {
  const count = Number(doctor?.ratingCount) || 0;
  if (!count) return null;
  return (Number(doctor.ratingSum) || 0) / count;
}

function starGlyphs(value) {
  const rounded = Math.max(0, Math.min(5, Math.round(value)));
  return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
}

function ratingBadgeHTML(doctor) {
  const avg = ratingAvg(doctor);
  const count = Number(doctor.ratingCount) || 0;
  if (avg == null) return `<div class="doctor-rating no-rating"><span class="stars">☆☆☆☆☆</span> No ratings yet</div>`;
  return `<div class="doctor-rating"><span class="stars">${starGlyphs(avg)}</span> ${avg.toFixed(1)} <small>(${count} rating${count===1?'':'s'})</small></div>`;
}

async function submitRating(appointmentId, stars, comment) {
  stars = Number(stars);
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
    showToast('Please choose a star rating from 1 to 5.');
    return false;
  }
  const r = await perform('rate', { id: appointmentId, stars, comment });
  if (r.ok) {
    closeModal();
    render();
    showToast(r.updated ? 'Your rating has been updated. Thank you!' : 'Thanks for rating your doctor!');
  }
  return !!r.ok;
}

function rateModal(appointmentId) {
  const d = db();
  const a = d.appointments.find(x => x.id === appointmentId);
  if (!a) return showToast('Appointment not found.');
  const doctor = getDoctor(d, a.doctorId);
  const existingStars = a.rating ? Number(a.rating.stars) || 0 : 0;
  const existingComment = a.rating ? a.rating.comment || '' : '';
  openModal(`<h2>Rate Dr. ${esc(doctor?.name || 'your doctor')}</h2><p>Your rating helps other patients find well-reviewed doctors. Only ratings decide how doctors are suggested.</p>
    <form id="ratingForm">
      <input type="hidden" name="appointmentId" value="${esc(appointmentId)}">
      <input type="hidden" name="stars" value="${existingStars}">
      <div class="star-picker" data-star-picker>${[1,2,3,4,5].map(n => `<button type="button" class="star-btn ${n <= existingStars ? 'filled' : ''}" data-star="${n}" aria-label="${n} star${n>1?'s':''}">★</button>`).join('')}</div>
      <label class="field full">Comment (optional)<textarea name="comment" rows="3" placeholder="How was your consultation?">${esc(existingComment)}</textarea></label>
      <div class="modal-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button type="button" class="primary-btn" data-submit-rating>Submit rating</button></div>
    </form>`);
}

function getUnreadCount(userId) {
  return db().notifications.filter(n => n.userId === userId && !n.read).length;
}

function setAuth(mode) {
  document.getElementById('loginForm').classList.toggle('hidden', mode === 'signup');
  document.getElementById('signupForm').classList.toggle('hidden', mode !== 'signup');
  document.getElementById('authTitle').textContent = mode === 'signup' ? 'Create your CareConnect account' : 'Welcome back';
  document.getElementById('authSubtitle').textContent = mode === 'signup'
    ? 'Choose Patient or Doctor during signup. Admin access is kept separate.'
    : 'Sign in as a Patient, Doctor, or Admin.';
  window.scrollTo({top:0, behavior:'smooth'});
}

function appointmentHTML(a, doctor, extra='') {
  const mode = a.mode === 'online' ? 'Online video' : `Offline · Token #${a.tokenNumber || '-'}`;
  const statusClass = String(a.status).toLowerCase();
  return `<div class="appointment-row">
    <div class="date-badge"><small>${new Date(`${a.date}T12:00:00`).toLocaleString('en',{month:'short'}).toUpperCase()}</small><strong>${new Date(`${a.date}T12:00:00`).getDate()}</strong></div>
    <div>
      <h4>Dr. ${esc(doctor?.name || 'Removed doctor')}</h4>
      <p>${esc(doctor?.specialty || '')} · ${esc(a.time)} · ${esc(a.reason || 'General consultation')}</p>
      <div class="appointment-tags"><span>${mode}</span>${a.patientName ? `<span>Patient: ${esc(a.patientName)}</span>` : ''}</div>
    </div>
    <span class="status ${statusClass}">${esc(a.status)}</span>
    ${extra}
  </div>`;
}

function render() {
  const data = normalizeData(db());
  const user = session();
  document.getElementById('authView').classList.toggle('hidden', !!user);
  document.getElementById('appView').classList.toggle('hidden', !user);
  if (!user) return;

  const unread = getUnreadCount(user.id);
  const doctor = user.role === 'doctor' ? getDoctor(data, user.doctorId) : null;
  document.getElementById('sidebarName').textContent = user.name;
  document.getElementById('sidebarRole').textContent = roleLabel(user.role);
  document.getElementById('avatar').textContent = user.name?.[0]?.toUpperCase() || 'U';
  document.getElementById('topAvatar').textContent = user.name?.[0]?.toUpperCase() || 'U';
  document.getElementById('todayDate').textContent = new Date().toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'});
  const bell = document.getElementById('notificationBtn');
  if (bell) bell.innerHTML = `🔔 Notifications ${unread ? `<span class="notif-count">${unread}</span>` : ''}`;

  let items;
  if (user.role === 'admin') {
    items = [['dashboard','▦','Overview'],['appointments','▣','Appointments'],['doctors','♟','Manage doctors'],['patients','♧','Patients'],['notifications','🔔','Notifications'],['assistant','✦','AI Assistant']];
  } else if (user.role === 'doctor') {
    items = [['dashboard','▦','Dashboard'],['appointments','▣','Appointments'],['availability','◷','My availability'],['notifications','🔔','Notifications'],['assistant','✦','AI Assistant']];
  } else {
    items = [['dashboard','▦','Dashboard'],['doctors','♟','Find a doctor'],['appointments','▣','My appointments'],['history','◷','Appointment history'],['notifications','🔔','Notifications'],['assistant','✦','AI Assistant']];
  }

  document.getElementById('sideNav').innerHTML = items.map(x =>
    `<button data-page="${x[0]}" class="${state.page === x[0] ? 'active' : ''}"><span>${x[1]}</span>${x[2]}</button>`
  ).join('');

  const titleMap = {
    dashboard:'Dashboard', appointments:user.role === 'admin' ? 'All appointments' : 'Appointments',
    doctors:user.role === 'admin' ? 'Doctor management' : 'Find a doctor', patients:'Patients',
    history:'Appointment history', availability:'My availability', notifications:'Notifications', assistant:'CareConnect AI Assistant'
  };
  document.getElementById('pageTitle').textContent = titleMap[state.page] || 'Dashboard';
  document.getElementById('pageKicker').textContent = user.role === 'admin' ? 'ADMIN PORTAL' : user.role === 'doctor' ? 'DOCTOR PORTAL' : 'PATIENT PORTAL';
  // Don't wipe the assistant's input while someone is typing during a live update.
  if (!(state.page === 'assistant' && document.getElementById('chatForm'))) {
    document.getElementById('pageContent').innerHTML = user.role === 'admin' ? adminPage() : user.role === 'doctor' ? doctorPage(doctor) : patientPage();
  }
  const mnav = document.getElementById('mobileNav');
  if (mnav) {
    mnav.innerHTML = items.map(x => `<button data-page="${x[0]}" class="${state.page === x[0] ? 'active' : ''}"><span>${x[1]}</span><em>${x[2].replace('Appointment history', 'History').replace('My appointments', 'Visits').replace('Appointments', 'Visits').replace('Manage doctors', 'Doctors').replace('My availability', 'Schedule').replace('Find a doctor', 'Doctors').replace('AI Assistant', 'AI').replace('Notifications', 'Alerts')}</em></button>`).join('');
  }
  try { if (navigator.setAppBadge) { unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge(); } } catch (e) { /* optional */ }

  if (state.page === 'assistant') setTimeout(renderChat, 0);
  updateInstallButtons();
  updateNetStatus();
}

function fmtWhen(ms) {
  const tz = clinicTZ();
  const t = new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const day = CC.isoDateInTz(ms, tz);
  return day === todayISO() ? t : `${formatDate(day)} ${t}`;
}

// The Join button follows the booked date & time: it opens 10 minutes before the slot.
function joinButtonHTML(a) {
  if (a.mode !== 'online' || a.status !== 'Confirmed') return '';
  if (!SERVER.on) return `<button class="action-btn call-btn" data-video-call="${a.id}">Join video (demo)</button>`;
  const live = `<button class="action-btn call-btn live" data-video-call="${a.id}">● Join video now</button>`;
  if (!SERVER.enforce) return live;
  const w = CC.joinWindow(a, nowMs(), clinicTZ());
  if (w.state === 'open') return live;
  if (w.state === 'early') return `<button class="action-btn call-btn" disabled title="The video room opens ${CC.OPEN_BEFORE_MIN} minutes before the appointment">Room opens ${fmtWhen(w.opens)}</button>`;
  return `<button class="action-btn" disabled>Room closed</button>`;
}

function liveBanner(list, role, d) {
  if (!SERVER.on) return '';
  const live = list.filter(a => a.status === 'Confirmed' && a.mode === 'online' &&
    (!SERVER.enforce || CC.joinWindow(a, nowMs(), clinicTZ()).state === 'open'));
  return live.map(a => {
    const doc = d.doctors.find(x => x.id === a.doctorId);
    const who = role === 'doctor' ? a.patientName : `Dr. ${doc ? doc.name : ''}`;
    return `<div class="notice-banner live-banner"><strong>● Video consultation ready</strong><span>${esc(who)} · ${esc(a.time)} — the video room is open. Doctor and patient can join now.</span><button class="primary-btn call-now" data-video-call="${a.id}">Join video now</button></div>`;
  }).join('');
}

function appointmentActions(a, context) {
  let out = '';
  if (context === 'patient' && a.status === 'Confirmed') {
    out += `<div class="row-actions"><button class="action-btn" data-edit="${a.id}">Reschedule</button><button class="action-btn danger" data-cancel="${a.id}">Cancel</button>${joinButtonHTML(a)}</div>`;
  }
  if (context === 'doctor' && a.status === 'Confirmed') {
    out += `<div class="row-actions">${joinButtonHTML(a)}<button class="action-btn" data-complete="${a.id}">Mark complete</button><button class="action-btn danger" data-cancel="${a.id}">Cancel</button></div>`;
  }
  if (context === 'patient' && a.status === 'Completed') {
    if (a.rating && Number.isFinite(Number(a.rating.stars))) {
      out += `<div class="row-actions"><span class="rating-given"><span class="stars">${starGlyphs(a.rating.stars)}</span> Your rating<button class="link-btn" data-rate="${a.id}">Edit</button></span></div>`;
    } else {
      out += `<div class="row-actions"><button class="action-btn rate-btn" data-rate="${a.id}">⭐ Rate this doctor</button></div>`;
    }
  }
  return out;
}

function patientPage() {
  const d = db(), u = session();
  const mine = d.appointments.filter(a => a.patientId === u.id);
  const upcoming = mine.filter(a => a.status === 'Confirmed' && a.date >= todayISO());

  if (state.page === 'dashboard') {
    const alertCount = d.notifications.filter(n => n.userId === u.id && !n.read && n.type === 'warning').length;
    const upcomingHtml = upcoming.length
      ? upcoming.sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).map(a => {
          const doctor = d.doctors.find(x=>x.id===a.doctorId);
          const join = joinButtonHTML(a);
          return appointmentHTML(a, doctor, join);
        }).join('')
      : '<div class="empty">No appointments booked yet. Find a doctor to get started.</div>';
    return `<div class="content">
      <div class="welcome-row"><div><h1>Hello, ${esc(u.name.split(' ')[0])}.</h1><p>Manage appointments, choose online/offline visits, and get help from CareConnect AI.</p></div><button class="primary-btn" data-action="book-first">Book an appointment →</button></div>
      ${liveBanner(upcoming, 'patient', d)}
      ${alertCount ? `<div class="notice-banner warning"><strong>⚠ ${alertCount} appointment alert${alertCount>1?'s':''}</strong><span>A booked doctor is currently unavailable. Check Notifications for details.</span><button class="link-btn" data-page="notifications">View alerts →</button></div>` : ''}
      <div class="stats-grid"><div class="stat"><span class="stat-icon">▣</span><b>${upcoming.length}</b><span>Upcoming appointments</span></div><div class="stat"><span class="stat-icon">✓</span><b>${mine.filter(a=>a.status==='Completed').length}</b><span>Completed visits</span></div><div class="stat"><span class="stat-icon">♟</span><b>${d.doctors.filter(x=>x.available!==false).length}</b><span>Doctors available</span></div></div>
      <div class="mode-info-grid"><div class="mode-card"><b>💻 Online consultation</b><span>Join a browser video room with mic, camera controls and chat.</span></div><div class="mode-card"><b>🏥 Offline visit</b><span>Get a token number while booking so your turn is tracked.</span></div></div>
      <div class="assistant-teaser"><div><span class="ai-badge">✦ AI</span><h3>CareConnect AI Assistant</h3><p>Ask naturally about a medicine, tablet, symptom, doctor, token, online visit, or appointment.</p></div><button class="secondary-btn" data-page="assistant">Open AI Assistant →</button></div>
      <div class="section-head"><h3>Upcoming appointments</h3><button class="link-btn" data-page="appointments">View all →</button></div>
      <div class="card">${upcomingHtml}</div>
    </div>`;
  }

  if (state.page === 'doctors') return doctorsPage(false);
  if (state.page === 'assistant') return assistantPage();
  if (state.page === 'notifications') return notificationsPage(u);

  const list = state.page === 'history' ? mine.filter(a => a.status !== 'Confirmed') : mine;
  const rows = list.length
    ? list.sort((a,b)=>`${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)).map(a => appointmentHTML(a, d.doctors.find(x=>x.id===a.doctorId), appointmentActions(a,'patient'))).join('')
    : '<div class="empty">Nothing to show here yet.</div>';
  return `<div class="content"><div class="section-head"><h3>${state.page==='history'?'Past and cancelled appointments':'Manage your bookings'}</h3>${state.page==='appointments'?'<button class="primary-btn" data-action="book-first">Book appointment →</button>':''}</div><div class="card">${rows}</div></div>`;
}

function doctorsPage(admin) {
  const d = db();
  const specs = [...new Set(d.doctors.map(x=>x.specialty))];
  const filtered = d.doctors.filter(x =>
    (!state.search || `${x.name} ${x.specialty}`.toLowerCase().includes(state.search.toLowerCase())) &&
    (state.filter === 'All' || x.specialty === state.filter)
  ).sort((a, b) => {
    // Recommend doctors to patients using ratings only: highest average first.
    const avgA = ratingAvg(a); const avgB = ratingAvg(b);
    if (avgA == null && avgB == null) return a.name.localeCompare(b.name);
    if (avgA == null) return 1;
    if (avgB == null) return -1;
    if (avgB !== avgA) return avgB - avgA;
    return (b.ratingCount||0) - (a.ratingCount||0);
  });
  const topRatedId = !admin && filtered[0] && ratingAvg(filtered[0]) != null ? filtered[0].id : null;
  const cards = filtered.length
    ? filtered.map(x => {
        const unavailable = x.available === false;
        let action = '';
        if (admin) {
          action = `<button class="secondary-btn" data-editdoctor="${x.id}">Edit doctor</button><button class="action-btn" data-toggle-doctor="${x.id}">${unavailable?'Set available':'Set unavailable'}</button><button class="action-btn danger" data-deletedoctor="${x.id}">Remove</button>`;
        } else {
          action = `<button class="primary-btn" data-book="${x.id}" ${unavailable?'disabled':''}>${unavailable?'Doctor unavailable':'Book appointment'}</button>`;
        }
        return `<article class="doctor-card ${unavailable?'doctor-unavailable':''}"><div class="doctor-head"><div class="doctor-icon">🩺</div><div><h3>Dr. ${esc(x.name)}</h3><p>${esc(x.specialty)}</p></div>${x.id===topRatedId?'<span class="top-badge">🏆 Top rated</span>':''}</div><div class="doctor-status ${unavailable?'offline':'online'}">● ${unavailable?'Currently unavailable':'Available for booking'}</div>${ratingBadgeHTML(x)}<div class="doctor-meta">${esc(x.experience)} experience<br>Available: ${esc(x.availability)}<br>Slots: ${esc(x.slots.join(', '))}<br><strong>₹${esc(x.fee)} consultation</strong></div>${action}</article>`;
      }).join('')
    : '<div class="empty">No doctors match your search.</div>';
  return `<div class="content"><div class="toolbar"><input class="search-input" data-search placeholder="Search by doctor or specialization" value="${esc(state.search)}"><select class="filter-select" data-filter><option>All</option>${specs.map(s=>`<option ${state.filter===s?'selected':''}>${esc(s)}</option>`).join('')}</select>${admin?'<button class="primary-btn" data-action="add-doctor">+ Add doctor</button>':''}</div>${!admin?'<p class="rating-note">Doctors are ordered by patient ratings — the best-reviewed doctors are suggested first.</p>':''}<div class="doctors-grid">${cards}</div></div>`;
}

function doctorPage(doctor) {
  const d = db();
  if (!doctor) return '<div class="content"><div class="empty">Doctor profile not found.</div></div>';
  const mine = d.appointments.filter(a=>a.doctorId===doctor.id).sort((a,b)=>`${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  if (state.page === 'availability') {
    return `<div class="content"><div class="welcome-row"><div><h1>My availability</h1><p>Patients see this status and schedule when booking.</p></div><button class="primary-btn" data-editdoctor="${doctor.id}">Edit schedule →</button></div><div class="card availability-card"><div><span class="ai-badge">DOCTOR PROFILE</span><h3>Dr. ${esc(doctor.name)}</h3><p>${esc(doctor.specialty)} · ${esc(doctor.experience)}</p></div><div class="availability-box"><strong>Current status</strong><span class="doctor-status ${doctor.available===false?'offline':'online'}">● ${doctor.available===false?'Unavailable':'Available for booking'}</span><button class="secondary-btn" data-toggle-self="${doctor.id}">${doctor.available===false?'Mark available':'Mark unavailable'}</button></div><div class="availability-box"><strong>Available days</strong><span>${esc(doctor.availability)}</span></div><div class="availability-box"><strong>Appointment slots</strong><span>${doctor.slots.map(esc).join(' · ')}</span></div></div></div>`;
  }
  if (state.page === 'assistant') return assistantPage();
  if (state.page === 'notifications') return notificationsPage(session());
  if (state.page === 'dashboard') {
    const today = mine.filter(a=>a.date===todayISO() && a.status==='Confirmed').length;
    const upcomingHtml = mine.filter(a=>a.status==='Confirmed'&&a.date>=todayISO()).slice(0,5).map(a=>appointmentHTML(a,doctor,appointmentActions(a,'doctor'))).join('') || '<div class="empty">No upcoming appointments.</div>';
    return `<div class="content"><div class="welcome-row"><div><h1>Good day, Dr. ${esc(doctor.name.split(' ')[0])}.</h1><p>Manage your schedule, appointments and online consultations.</p></div><button class="primary-btn" data-page="availability">Update availability →</button></div>${liveBanner(mine.filter(a=>a.status==='Confirmed'), 'doctor', d)}<div class="stats-grid"><div class="stat"><span class="stat-icon">▣</span><b>${today}</b><span>Appointments today</span></div><div class="stat"><span class="stat-icon">✓</span><b>${mine.filter(a=>a.status==='Completed').length}</b><span>Completed visits</span></div><div class="stat"><span class="stat-icon">♟</span><b>${mine.filter(a=>a.status==='Confirmed').length}</b><span>Confirmed appointments</span></div></div><div class="mode-info-grid"><div class="mode-card"><b>💻 Online</b><span>Join video consultations and use appointment chat.</span></div><div class="mode-card"><b>🏥 Offline</b><span>See each patient's token number and visit reason.</span></div></div><div class="assistant-teaser"><div><span class="ai-badge">✦ AI</span><h3>CareConnect AI Assistant</h3><p>Use the assistant for appointment workflows and general healthcare information.</p></div><button class="secondary-btn" data-page="assistant">Open AI Assistant →</button></div><div class="section-head"><h3>Upcoming appointments</h3><button class="link-btn" data-page="appointments">View all →</button></div><div class="card">${upcomingHtml}</div></div>`;
  }
  const rows=mine.length ? mine.map(a=>appointmentHTML(a,doctor,appointmentActions(a,'doctor'))).join('') : '<div class="empty">No appointments assigned yet.</div>';
  return `<div class="content"><div class="section-head"><h3>My patient appointments</h3></div><div class="card">${rows}</div></div>`;
}

function adminPage() {
  const d = db();
  if (state.page === 'assistant') return assistantPage();
  if (state.page === 'notifications') return notificationsPage(session());
  if (state.page === 'dashboard') {
    const today=todayISO();
    const unavailable=d.doctors.filter(x=>x.available===false).length;
    const recent=d.appointments.length ? d.appointments.slice(-5).reverse().map(a=>appointmentHTML(a,d.doctors.find(x=>x.id===a.doctorId))).join('') : '<div class="empty">No appointments have been booked yet.</div>';
    return `<div class="content"><div class="welcome-row"><div><h1>Good day, Admin.</h1><p>Manage doctors, patients, appointments and availability from one place.</p></div><button class="primary-btn" data-action="add-doctor">+ Add new doctor</button></div><div class="stats-grid"><div class="stat"><span class="stat-icon">▣</span><b>${d.appointments.filter(a=>a.date===today&&a.status==='Confirmed').length}</b><span>Appointments today</span></div><div class="stat"><span class="stat-icon">♟</span><b>${d.doctors.length}</b><span>Total doctors</span></div><div class="stat"><span class="stat-icon">♧</span><b>${d.users.filter(u=>u.role==='patient').length}</b><span>Registered patients</span></div></div><div class="notice-banner ${unavailable?'warning':'success'}"><strong>${unavailable?`⚠ ${unavailable} doctor${unavailable>1?'s are':' is'} unavailable`:'✓ All doctors currently marked available'}</strong><span>Changing a doctor's status automatically creates patient notifications for affected confirmed visits.</span></div><div class="assistant-teaser"><div><span class="ai-badge">✦ AI</span><h3>CareConnect AI for Admin</h3><p>Ask about doctors, patients, medicines or appointment workflows.</p></div><button class="secondary-btn" data-page="assistant">Open AI Assistant →</button></div><div class="section-head"><h3>Recent appointments</h3><button class="link-btn" data-page="appointments">View all →</button></div><div class="card">${recent}</div></div>`;
  }
  if (state.page === 'doctors') return doctorsPage(true);
  if (state.page === 'patients') return patientTable(d);
  return adminAppointments(d);
}

function adminAppointments(d) {
  return `<div class="content"><div class="toolbar"><input class="search-input" data-search placeholder="Search patient or doctor" value="${esc(state.search)}"></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Patient</th><th>Doctor</th><th>Mode</th><th>Date & time</th><th>Reason / Token</th><th>Status</th><th>Action</th></tr></thead><tbody>${d.appointments.filter(a=>!state.search||`${a.patientName} ${d.doctors.find(x=>x.id===a.doctorId)?.name||''}`.toLowerCase().includes(state.search.toLowerCase())).map(a=>{const doc=d.doctors.find(x=>x.id===a.doctorId);return `<tr><td>${esc(a.patientName)}</td><td>Dr. ${esc(doc?.name||'Removed')}</td><td>${a.mode==='online'?'Online video':'Offline'}</td><td>${formatDate(a.date)} · ${esc(a.time)}</td><td>${esc(a.reason)}${a.mode==='offline'?`<br><strong>Token #${esc(a.tokenNumber)}</strong>`:''}</td><td><span class="status ${String(a.status).toLowerCase()}">${esc(a.status)}</span></td><td>${a.status==='Confirmed'?`<button class="action-btn" data-complete="${a.id}">Complete</button><button class="action-btn danger" data-cancel="${a.id}">Cancel</button>`:'—'}</td></tr>`;}).join('')||'<tr><td colspan="7" class="empty">No appointments found.</td></tr>'}</tbody></table></div></div>`;
}

function patientTable(d) {
  const users=d.users.filter(u=>u.role==='patient');
  return `<div class="content"><div class="section-head"><div><h3>Registered patients</h3><p class="muted-copy">Edit any profile field when needed and view the previous saved versions.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Patient</th><th>Email</th><th>Phone</th><th>Age</th><th>Appointments</th><th>Action</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone)}</td><td>${esc(u.age||'—')}</td><td>${d.appointments.filter(a=>a.patientId===u.id).length}</td><td><button class="action-btn" data-editpatient="${u.id}">Edit & history</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">No patients have registered yet.</td></tr>'}</tbody></table></div></div>`;
}

function notificationsPage(user) {
  const d=db();
  const list=d.notifications.filter(n=>n.userId===user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return `<div class="content"><div class="section-head"><div><h3>Your notifications</h3><p class="muted-copy">Updates about doctor availability, appointments and CareConnect activity.</p></div><div class="head-actions">${('Notification' in window) && Notification.permission === 'default' ? '<button class="secondary-btn" data-enable-alerts>Enable device alerts</button>' : ''}<button class="secondary-btn" data-read-all>Mark all as read</button></div></div><div class="notification-list">${list.length ? list.map(n=>`<article class="notification-card ${n.type} ${n.read?'read':''}"><div class="notification-icon">${n.type==='warning'?'⚠':n.type==='success'?'✓':'🔔'}</div><div><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><small>${new Date(n.createdAt).toLocaleString('en-IN')}</small></div>${n.read?'':'<span class="unread-dot"></span>'}</article>`).join('') : '<div class="card empty">You have no notifications right now.</div>'}</div></div>`;
}

function openModal(html, wide=false) {
  const modal=document.getElementById('modal');
  const card=modal.querySelector('.modal-card');
  card.classList.toggle('modal-wide',wide);
  document.getElementById('modalContent').innerHTML=html;
  modal.classList.remove('hidden');

  // Bind Save actions directly to the freshly-created modal controls.
  // This is intentionally separate from the document-level delegation so
  // Save still works reliably even when a browser handles the dynamic form
  // activation differently.
  const doctorSave = modal.querySelector('[data-save-doctor]');
  if (doctorSave) {
    doctorSave.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      saveDoctorForm(document.getElementById('doctorForm'));
    });
  }
  const patientSave = modal.querySelector('[data-save-patient]');
  if (patientSave) {
    patientSave.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      savePatientForm(document.getElementById('patientForm'));
    });
  }
}

function closeModal() {
  if (state.activeCall || call.sid) leaveCallLocal(true);
  document.getElementById('modal').classList.add('hidden');
  const card = document.querySelector('.modal-card');
  card?.classList.remove('modal-wide');
  state.activeCall = null;
}

function doctorModal(id) {
  const d=db(), user=session();
  const doc=id?d.doctors.find(x=>x.id===id):{};
  const doctorSelf=user.role==='doctor';
  const existingAccount=id ? d.users.find(u=>u.role==='doctor'&&u.doctorId===id) : null;
  if (doctorSelf && (!doc || doc.id !== user.doctorId)) return showToast('You can only edit your own profile.');
  const title=doctorSelf?'Update my availability':id?'Edit doctor & login':'Add a doctor';
  openModal(`<h2>${title}</h2><p>${doctorSelf?'Update the schedule/status patients will see.':'Saving this form updates the doctor directory and creates/updates the matching Doctor login at the same time.'}</p><form id="doctorForm"><input type="hidden" name="id" value="${esc(id||'')}"><div class="form-grid">
    <label class="field">Doctor name<input name="name" ${doctorSelf?'readonly':''} required value="${esc(doc.name||'')}"></label>
    <label class="field">Specialty<input name="specialty" ${doctorSelf?'readonly':''} required value="${esc(doc.specialty||'')}"></label>
    <label class="field">Experience<input name="experience" ${doctorSelf?'readonly':''} required value="${esc(doc.experience||'')}"></label>
    <label class="field">Consultation fee (₹)<input name="fee" type="number" min="0" required value="${esc(doc.fee||500)}"></label>
    ${!doctorSelf ? `<label class="field">Doctor login email<input name="loginEmail" type="email" required value="${esc(existingAccount?.email||'')}"></label><label class="field">Doctor login password<input name="loginPassword" type="text" ${id?'placeholder="Leave blank to keep current password"':'required'} value=""></label>` : ''}
    <label class="field full">Available days<input name="availability" required value="${esc(doc.availability||'Mon, Wed, Fri')}" placeholder="e.g. Mon, Wed, Fri"></label>
    <label class="field full">Time slots<input name="slots" required value="${esc((doc.slots||['09:00','11:00','16:00']).join(', '))}" placeholder="09:00, 11:00, 16:00"></label>
    <label class="field full availability-toggle"><span>Booking status</span><label class="toggle"><input type="checkbox" name="available" ${doc.available!==false?'checked':''}><span></span></label><small>When unavailable, patients cannot book this doctor and affected confirmed appointments generate notifications.</small></label>
  </div><div class="modal-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button type="submit" class="primary-btn" data-save-doctor>Save ${doctorSelf?'changes':'doctor'}</button></div></form>`);
}

function bookingModal(doctorId, appointmentId) {
  const d = db(), doc = getDoctor(d, doctorId), a = appointmentId ? d.appointments.find(x => x.id === appointmentId) : null;
  if (!doc) return showToast('Doctor is no longer available.');
  if (doc.available === false) return showToast('This doctor is currently unavailable. Please choose another doctor.');
  const defaultMode = a?.mode || 'offline';
  const tokenPreview = defaultMode === 'offline' ? nextOfflineToken(d, doctorId, a?.date || todayISO(), appointmentId || '') : null;
  openModal(`<h2>${appointmentId ? 'Reschedule' : 'Book'} with Dr. ${esc(doc.name)}</h2><p>${esc(doc.specialty)} · ₹${esc(doc.fee)} consultation · Schedule: ${esc(doc.availability)}</p>
    <form id="bookingForm"><input type="hidden" name="doctorId" value="${esc(doc.id)}"><input type="hidden" name="appointmentId" value="${esc(appointmentId || '')}" />
    <div class="mode-picker"><label class="mode-option"><input type="radio" name="mode" value="online" ${defaultMode === 'online' ? 'checked' : ''}><span>💻 <strong>Online video</strong><small>Live video + voice + chat</small></span></label><label class="mode-option"><input type="radio" name="mode" value="offline" ${defaultMode === 'offline' ? 'checked' : ''}><span>🏥 <strong>Offline visit</strong><small>Token number assigned</small></span></label></div>
    <div class="form-grid"><label class="field">Appointment date<input name="date" type="date" min="${todayISO()}" required value="${esc(a?.date || '')}"></label><label class="field">Time slot<select name="time" required>${doc.slots.map(s => `<option ${a?.time === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label><label class="field full">Reason for visit<input name="reason" required maxlength="300" value="${esc(a?.reason || '')}" placeholder="e.g. Fever, skin check-up, routine consultation"></label></div>
    <p id="dayHint" class="day-hint hidden"></p>
    <div id="tokenPreview" class="token-preview ${defaultMode === 'online' ? 'hidden' : ''}">🎟 <strong>Offline token:</strong> #${tokenPreview}</div>
    <div class="booking-note">Online visits: both you and the doctor get a Join button that opens 10 minutes before the booked time. Offline visits get a token number.</div>
    <div class="modal-actions"><button type="button" class="secondary-btn" data-close>Cancel</button><button class="primary-btn">${appointmentId ? 'Save changes' : 'Confirm appointment'}</button></div></form>`);
  const form = document.getElementById('bookingForm');
  if (form) refreshSlots(form);
}

// Greys out slots that are already booked / already passed and warns about non-working days.
function refreshSlots(form) {
  const sel = form.querySelector('select[name=time]');
  if (!sel) return;
  const doctorId = form.querySelector('input[name=doctorId]').value;
  const date = form.querySelector('input[name=date]').value;
  const apptId = form.querySelector('input[name=appointmentId]').value;
  const d = db(), doc = getDoctor(d, doctorId);
  if (!doc) return;
  const taken = new Set([...d.appointments, ...(d.slotsTaken || [])]
    .filter(a => a.doctorId === doctorId && a.date === date && a.status === 'Confirmed' && a.id !== apptId).map(a => a.time));
  const passed = t => !!date && CC.zonedToEpoch(date, t, clinicTZ()) <= nowMs();
  const prev = sel.value;
  sel.innerHTML = doc.slots.map(s => {
    const label = taken.has(s) ? ' (booked)' : (date && passed(s) ? ' (passed)' : '');
    return `<option value="${esc(s)}" ${label ? 'disabled' : ''}>${esc(s)}${label}</option>`;
  }).join('');
  const usable = [...sel.options].filter(o => !o.disabled);
  const keep = usable.find(o => o.value === prev) || usable[0];
  if (keep) sel.value = keep.value; else sel.selectedIndex = -1;
  const hint = form.querySelector('#dayHint');
  if (hint) {
    const bad = date && !CC.dayAllowed(doc.availability, date);
    hint.textContent = bad ? `Dr. ${doc.name} is only available on ${doc.availability}. Please pick one of those days.` : '';
    hint.classList.toggle('hidden', !bad);
  }
}

function patientEditModal(id) {
  const d=db(), u=d.users.find(x=>x.id===id);
  if(!u)return;
  ensurePatientDefaults(u);
  const history=(u.profileHistory||[]).slice().reverse();
  const historyHtml=history.length ? history.map((h,i)=>`<details class="history-item" ${i===0?'open':''}><summary>Previous version · ${new Date(h.changedAt).toLocaleString('en-IN')}</summary><div class="history-grid"><span>Name<strong>${esc(h.name)}</strong></span><span>Email<strong>${esc(h.email)}</strong></span><span>Phone<strong>${esc(h.phone)}</strong></span><span>Age<strong>${esc(h.age||'—')}</strong></span><span>Gender<strong>${esc(h.gender||'—')}</strong></span><span>Blood group<strong>${esc(h.bloodGroup||'—')}</strong></span><span>Address<strong>${esc(h.address||'—')}</strong></span><span>Emergency contact<strong>${esc(h.emergencyContact||'—')}</strong></span></div></details>`).join('') : '<div class="empty compact">No previous edits are stored yet.</div>';
  openModal(`<h2>Edit patient & view previous data</h2><p>Every saved change stores a snapshot of the previous patient profile for review.</p><form id="patientForm"><input type="hidden" name="id" value="${esc(u.id)}"><div class="form-grid"><label class="field full">Full name<input name="name" required value="${esc(u.name)}"></label><label class="field">Email<input name="email" type="email" required value="${esc(u.email)}"></label><label class="field">Phone<input name="phone" required value="${esc(u.phone)}"></label><label class="field">Age<input name="age" type="number" min="0" max="120" value="${esc(u.age)}"></label><label class="field">Gender<select name="gender"><option value="">Select</option><option ${u.gender==='Male'?'selected':''}>Male</option><option ${u.gender==='Female'?'selected':''}>Female</option><option ${u.gender==='Other'?'selected':''}>Other</option></select></label><label class="field">Blood group<input name="bloodGroup" value="${esc(u.bloodGroup)}" placeholder="e.g. B+"></label><label class="field">Emergency contact<input name="emergencyContact" value="${esc(u.emergencyContact)}"></label><label class="field full">Address<input name="address" value="${esc(u.address)}"></label></div><div class="modal-actions"><button type="button" class="secondary-btn" data-close>Close</button><button type="submit" class="primary-btn" data-save-patient>Save patient changes</button></div></form><div class="history-section"><h3>Previous patient data</h3>${historyHtml}</div>`);
}

const MEDICINES = {
  paracetamol:{aliases:['acetaminophen','dolo 650','dolo','crocin','calpol'],use:'commonly used to reduce fever and relieve mild-to-moderate pain.',notes:'Follow the label or clinician instructions. Too much can seriously harm the liver.',specialty:'General Physician'},
  ibuprofen:{aliases:['brufen','ibuprofen tablet','ibuprofen'],use:'an anti-inflammatory medicine commonly used for pain, fever and inflammation.',notes:'It can irritate the stomach and is not suitable for everyone. Ask a professional if you have health conditions or take other medicines.',specialty:'General Physician'},
  cetirizine:{aliases:['cetirizine tablet','zyrtec'],use:'an antihistamine commonly used for allergy symptoms such as sneezing, itching and a runny nose.',notes:'Some people feel drowsy. Follow label or professional advice.',specialty:'General Physician'},
  levocetirizine:{aliases:['levocetirizine tablet','levocet'],use:'an antihistamine commonly used for allergy symptoms such as sneezing, itching and a runny nose.',notes:'It can cause drowsiness in some people. Follow professional or label directions.',specialty:'General Physician'},
  amoxicillin:{aliases:['amoxycillin','amoxicillin tablet'],use:'an antibiotic used for certain bacterial infections.',notes:'It does not treat viral illnesses such as a common cold. Use antibiotics only when prescribed and complete the course as directed.',specialty:'General Physician'},
  azithromycin:{aliases:['azithro','azithromycin tablet'],use:'an antibiotic used for some bacterial infections.',notes:'It is prescription medicine and is not appropriate for every infection. Take it only as directed by a clinician.',specialty:'General Physician'},
  omeprazole:{aliases:['omez','omeprazole tablet'],use:'a proton-pump inhibitor that reduces stomach acid and is commonly used for acid reflux and some ulcer-related conditions.',notes:'Persistent or severe stomach symptoms should be assessed by a clinician.',specialty:'General Physician'},
  pantoprazole:{aliases:['pantoprazole tablet','pantop','pantocid'],use:'a proton-pump inhibitor that reduces stomach acid and is commonly used for acid reflux and related conditions.',notes:'Use according to professional advice, especially when symptoms keep returning.',specialty:'General Physician'},
  metformin:{aliases:['metformin tablet','glycomet'],use:'a medicine commonly used to help control blood sugar in type 2 diabetes.',notes:'It requires clinician guidance and blood-sugar monitoring. Do not change the dose yourself.',specialty:'General Physician'},
  amlodipine:{aliases:['amlodipine tablet','amlodipine besylate'],use:'a medicine commonly used to help control high blood pressure and certain heart-related conditions.',notes:'Take blood-pressure medicines according to the prescribed plan. Do not stop them without medical advice.',specialty:'Cardiologist'},
  atorvastatin:{aliases:['atorvastatin tablet','atorva'],use:'a statin medicine used to lower cholesterol and reduce cardiovascular risk.',notes:'It is prescription medicine and usually needs clinical follow-up.',specialty:'Cardiologist'},
  ondansetron:{aliases:['ondansetron tablet','ondem'],use:'a medicine commonly used to help prevent nausea and vomiting.',notes:'The cause of repeated vomiting should be assessed by a healthcare professional.',specialty:'General Physician'},
  domperidone:{aliases:['domperidone tablet','domstal'],use:'a medicine that may be prescribed for certain nausea or stomach-motility problems.',notes:'It is not suitable for everyone and can have heart-related risks, so use it only with professional advice.',specialty:'General Physician'},
  diclofenac:{aliases:['diclofenac tablet','voveran'],use:'an anti-inflammatory pain medicine used for some types of pain and inflammation.',notes:'It can affect the stomach, kidneys and cardiovascular system, so professional guidance is important.',specialty:'Orthopedic'},
  montelukast:{aliases:['montelukast tablet','montair'],use:'a medicine used in some people with asthma or allergies to help control symptoms.',notes:'It is not a rescue medicine for a sudden asthma attack. Follow the prescribed plan.',specialty:'General Physician'},
  albendazole:{aliases:['albendazole tablet','zentel'],use:'an antiparasitic medicine used for certain worm infections.',notes:'The correct treatment depends on the type of infection, age and other factors; professional advice is recommended.',specialty:'General Physician'},
  calcium:{aliases:['calcium tablet','calcium carbonate'],use:'a mineral supplement used when dietary calcium intake is inadequate or supplementation is advised.',notes:'More is not always better. Some supplements interact with other medicines.',specialty:'General Physician'},
  iron:{aliases:['iron tablet','ferrous sulfate','ferrous fumarate'],use:'an iron supplement commonly used to prevent or treat iron deficiency when advised.',notes:'Iron should be used when deficiency is suspected or confirmed, because excess iron can be harmful.',specialty:'General Physician'},
  aspirin:{aliases:['aspirin tablet','asa'],use:'a medicine with pain-relieving and antiplatelet effects; low doses are used for some cardiovascular conditions under medical advice.',notes:'It can increase bleeding risk and is not appropriate for everyone. Do not start it for heart protection without a clinician.',specialty:'Cardiologist'},
  losartan:{aliases:['losartan tablet'],use:'a medicine commonly used to treat high blood pressure and some heart or kidney-related conditions.',notes:'Blood-pressure medicines need professional guidance, especially during pregnancy or with kidney problems.',specialty:'Cardiologist'},
  metoprolol:{aliases:['metoprolol tablet','metolar'],use:'a beta-blocker commonly used for certain heart conditions and high blood pressure.',notes:'Do not stop a beta-blocker suddenly without medical advice.',specialty:'Cardiologist'},
  furosemide:{aliases:['furosemide tablet','frusemide','lasix'],use:'a diuretic (water tablet) used for fluid retention and certain heart, liver or kidney conditions.',notes:'It can change fluid and electrolyte levels, so it should be used as prescribed.',specialty:'Cardiologist'},
  fluconazole:{aliases:['fluconazole tablet','fluka'],use:'an antifungal medicine used for certain fungal infections.',notes:'It can interact with other medicines and is not suitable for every infection. Use professional advice.',specialty:'General Physician'},
  doxycycline:{aliases:['doxycycline tablet'],use:'an antibiotic used for certain bacterial infections and some skin conditions.',notes:'Take only when prescribed. It can interact with some minerals and medicines and can increase sun sensitivity.',specialty:'Dermatologist'},
  clotrimazole:{aliases:['clotrimazole tablet','clotrimazole'],use:'an antifungal medicine used for certain fungal infections; dosage form matters because creams and tablets are used differently.',notes:'Use the exact form prescribed or recommended because different products are used for different conditions.',specialty:'Dermatologist'},
  prednisolone:{aliases:['prednisolone tablet','wysolone'],use:'a corticosteroid used to reduce inflammation in certain medical conditions.',notes:'It should be taken only under professional guidance because stopping or changing it suddenly can be unsafe in some situations.',specialty:'General Physician'},
  levothyroxine:{aliases:['levothyroxine tablet','thyronorm'],use:'a thyroid hormone replacement medicine used to treat hypothyroidism.',notes:'The dose is individualized and usually monitored with blood tests. Take it exactly as prescribed.',specialty:'General Physician'},
  vitamin_d:{aliases:['vitamin d tablet','vit d3','cholecalciferol','calcirol'],use:'a vitamin D supplement used when vitamin D intake or levels are low, when supplementation is advised.',notes:'Very high doses can be harmful. Follow the recommended product or professional guidance.',specialty:'General Physician'},
  vitamin_b12:{aliases:['vitamin b12 tablet','methylcobalamin','mecobalamin'],use:'a vitamin supplement used to prevent or treat vitamin B12 deficiency.',notes:'The right treatment depends on the cause of deficiency; persistent symptoms should be assessed by a clinician.',specialty:'General Physician'},
  azelastine:{aliases:['azelastine tablet'],use:'an antihistamine mainly used in certain allergy conditions, although dosage form and indication depend on the product.',notes:'Check the exact formulation because the same ingredient may come in different forms.',specialty:'General Physician'},
  buspirone:{aliases:['buspirone tablet'],use:'a prescription medicine used for certain anxiety disorders.',notes:'It requires clinician supervision and is not a quick-relief medicine for every type of anxiety.',specialty:'General Physician'},
  gabapentin:{aliases:['gabapentin tablet','gabapin'],use:'a prescription medicine commonly used for certain nerve pain and some seizure disorders.',notes:'It can cause dizziness or sleepiness and should be used under medical supervision.',specialty:'General Physician'},
  pregabalin:{aliases:['pregabalin tablet','pregaba'],use:'a prescription medicine used for certain nerve pain and some seizure-related conditions.',notes:'It may cause dizziness or sleepiness and should be taken only as prescribed.',specialty:'General Physician'},
  naproxen:{aliases:['naproxen tablet'],use:'an anti-inflammatory medicine used for pain and inflammation.',notes:'It can affect the stomach, kidneys and cardiovascular system, so professional advice is important.',specialty:'Orthopedic'},
  mefenamic_acid:{aliases:['mefenamic acid tablet','meftal'],use:'an anti-inflammatory pain medicine used for certain types of pain.',notes:'It can affect the stomach and should be used according to professional advice.',specialty:'General Physician'},
  ondansetron_odt:{aliases:['ondansetron odt','ondansetron mouth dissolving'],use:'a dissolving form of ondansetron used to help prevent nausea and vomiting.',notes:'Follow the product instructions and seek care if vomiting is persistent or severe.',specialty:'General Physician'}
};

function normalizeMedicineQuery(text) {
  const cleaned=text.toLowerCase().replace(/[^a-z0-9\s.-]/g,' ');
  for (const [name,info] of Object.entries(MEDICINES)) {
    const names=[name,...(info.aliases||[])];
    if(names.some(alias=>cleaned.includes(alias.toLowerCase()))) return {name,info};
  }
  return null;
}

function sortDoctorsByRating(list) {
  return [...list].sort((a, b) => {
    const avgA = ratingAvg(a); const avgB = ratingAvg(b);
    if (avgA == null && avgB == null) return a.name.localeCompare(b.name);
    if (avgA == null) return 1;
    if (avgB == null) return -1;
    if (avgB !== avgA) return avgB - avgA;
    return (b.ratingCount||0) - (a.ratingCount||0);
  });
}

// Always reads live from storage, so a doctor added moments ago (by Admin
// or via doctor signup) shows up immediately, sorted best-rated first.
function availableDoctorsText(specialty, allowBooking=true, selfDoctorId=null) {
  const all=db().doctors;
  const doctors=sortDoctorsByRating(all.filter(d => !specialty || d.specialty.toLowerCase().includes(specialty.toLowerCase())));
  if (!doctors.length) {
    const fallback=sortDoctorsByRating(all.filter(d=>d.available!==false)).slice(0,3);
    if (!fallback.length) return '<div class="ai-empty">No doctors are currently available in the CareConnect directory.</div>';
    return `<div class="ai-fallback">No exact ${esc(specialty)} match was found. Here are currently listed doctors:</div>${fallback.map(d=>aiDoctorCard(d,allowBooking,selfDoctorId)).join('')}`;
  }
  return doctors.map(d=>aiDoctorCard(d,allowBooking,selfDoctorId)).join('');
}

function aiDoctorCard(d, allowBooking=true, selfDoctorId=null) {
  const isSelf = selfDoctorId && d.id===selfDoctorId;
  let action = '<span class="ai-offline">Unavailable</span>';
  if (isSelf) action = '<span class="ai-offline">This is you</span>';
  else if (allowBooking && d.available!==false) action = `<button class="action-btn" data-ai-book="${esc(d.id)}">Book</button>`;
  else if (d.available!==false) action = '';
  return `<div class="ai-doctor ${d.available===false?'unavailable':''}"><span>🩺</span><div><strong>Dr. ${esc(d.name)}${isSelf?' (You)':''}</strong><small>${esc(d.specialty)} · ${esc(d.availability)} · ₹${esc(d.fee)} · ${d.available===false?'Unavailable':'Available'}</small>${ratingBadgeHTML(d)}</div>${action}</div>`;
}

function medicineReply(text) {
  const match=normalizeMedicineQuery(text);
  if(!match){
    const requested=text.match(/(?:what is|about|uses of|use of|tell me about|information on|what does|why is)\s+([a-z][a-z0-9 .-]{1,50})/i)?.[1]?.trim();
    return `<strong>CareConnect AI Assistant</strong><br>I can explain a medicine’s <strong>common purpose, general precautions, and relevant CareConnect doctors</strong>. I won't guess an unknown tablet because different medicines can have similar names.<br><br>${requested?`I couldn't verify <strong>${esc(requested)}</strong> in this offline medicine guide. `:''}Type the exact medicine name printed on the strip, for example <strong>Paracetamol</strong>, <strong>Metformin</strong>, <strong>Omeprazole</strong>, or <strong>Amoxicillin</strong>. For personal treatment or dosage, consult a qualified doctor or pharmacist.`;
  }
  const {name,info}=match;
  const role=session()?.role;
  return `<div class="medicine-answer"><div class="medicine-title"><span>💊</span><div><strong>${esc(name.split('_').map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(' '))}</strong><small>General medicine information</small></div></div><p><strong>What it is used for:</strong> ${esc(info.use)}</p><p><strong>Important to know:</strong> ${esc(info.notes)}</p><div class="ai-note">🤖 I’m the <strong>CareConnect AI Assistant</strong>. I can explain medicines in general, but I do not diagnose, prescribe, or provide personalized doses.</div><div class="ai-doctors-title">👨‍⚕️ Relevant doctors in CareConnect</div>${availableDoctorsText(info.specialty, role==='patient', role==='doctor'?selfDoctorId():null)}</div>`;
}

// The doctor's own doctor-record id, when the signed-in user is a doctor.
function selfDoctorId() {
  const u=session();
  return u && u.role==='doctor' ? u.doctorId : null;
}

// Each role gets a distinct voice and distinct actions from the assistant:
// patients get booking-oriented help, doctors get their own-practice info,
// admin gets directory/records-management guidance.
function aiReply(message) {
  const user=session();
  const role=user?.role || 'patient';
  const text=message.toLowerCase().trim();
  if(!text)return 'Please type a question and I’ll try to help.';

  if(/\b(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(text)) {
    if(role==='doctor') return `Hi Dr. ${esc(user.name.split(' ')[0])} 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about your appointments, your availability, patient tokens, or a medicine you want a quick refresher on.`;
    if(role==='admin') return 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about managing doctors or patients, viewing appointments and tokens, or how ratings and notifications work.';
    return 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. I can explain common medicines/tablets, guide you about symptoms in general, find doctors, explain online vs offline visits, and help with appointments. I’m not a replacement for a qualified doctor.';
  }

  if(/\b(tablet|medicine|capsule|syrup|drug|medication)\b/.test(text) || normalizeMedicineQuery(text)) return medicineReply(text);

  if(/\b(token|offline visit|clinic visit|in person)\b/.test(text)) {
    if(role==='doctor') return `<strong>Offline tokens:</strong> when a patient books an <strong>Offline visit</strong> with you, CareConnect assigns them the next token number for that date automatically. You'll see each patient's token on their appointment card.`;
    if(role==='admin') return `<strong>Offline tokens:</strong> CareConnect assigns the next token number per <strong>doctor + date</strong> when a patient books an offline visit. Open <strong>All Appointments</strong> to see every token across doctors and dates.`;
    return `<strong>Offline appointment:</strong> choose <strong>Offline visit</strong> while booking. CareConnect assigns a token number for that doctor and date, which appears in My Appointments and on the admin/doctor side.`;
  }

  if(/\b(online|video call|video consultation|teleconsult|virtual)\b/.test(text)) {
    if(role==='doctor') return `<strong>Online consultations:</strong> when a patient books an <strong>Online video</strong> visit with you, open it from your Appointments list — the Join button turns on 10 minutes before the booked time — to start live video, voice and appointment chat with the patient.`;
    if(role==='admin') return `<strong>Online consultations:</strong> appointments booked as Online show that mode in <strong>All Appointments</strong>. Admin doesn't join the call — that happens directly between the patient and doctor from their own appointment cards.`;
    return `<strong>Online appointment:</strong> choose <strong>Online video</strong> while booking. At the booked time (the Join button turns on 10 minutes before), you and the doctor open the same video room with <strong>live video, voice, camera/microphone controls and chat</strong>. Ending the call will ask you to rate your doctor.`;
  }

  if(/\b(unavailable|not available|doctor absent|doctor not available)\b/.test(text)) {
    if(role==='doctor') return `<strong>Marking yourself unavailable:</strong> use the availability toggle on your own profile. Patients with confirmed upcoming visits are notified automatically so they know to expect a reschedule.`;
    if(role==='admin') return `<strong>Doctor availability:</strong> toggle any doctor's status from <strong>Manage Doctors</strong>. Marking a doctor unavailable blocks new bookings and automatically notifies patients with affected confirmed visits.`;
    return `<strong>Doctor unavailable:</strong> when a doctor is marked unavailable, new booking is blocked and affected confirmed patients receive a CareConnect notification. Check the <strong>Notifications</strong> page for details.`;
  }

  if(/(rating|review|stars|rate my|rate a doctor|rate the doctor)/.test(text)) {
    if(role==='doctor') {
      const doc=getDoctor(db(), user.doctorId);
      const avg=doc?ratingAvg(doc):null;
      const summary=doc && avg!=null ? `Your current rating is <strong>${avg.toFixed(1)}★</strong> from ${doc.ratingCount} patient${doc.ratingCount===1?'':'s'}.` : `You don't have any patient ratings yet.`;
      return `<strong>Doctor ratings:</strong> patients can rate you (1–5 stars) after a completed appointment, or automatically when they end an online video call with you. ${summary} Ratings decide how patients see doctors suggested in <strong>Find a doctor</strong>, and can't be edited by you or Admin.`;
    }
    if(role==='admin') return `<strong>Doctor ratings:</strong> patients rate a doctor (1–5 stars, optional comment) after a completed appointment. The <strong>Find a doctor</strong> list patients see is always sorted by average rating, and the top-rated doctor gets a 🏆 badge. Open <strong>Manage Doctors</strong> to see each doctor's current rating — ratings are patient feedback and aren't editable by Admin.`;
    return `<strong>Rating your doctor:</strong> from a completed appointment, use the <strong>⭐ Rate this doctor</strong> button — or if it was an online visit, ending the video call opens the rating dialog automatically. You can edit your rating later from <strong>My Appointments</strong>, and it always counts once toward the doctor's average.`;
  }

  if(/(add doctor|new doctor|remove doctor|delete doctor|manage doctor)/.test(text)) {
    if(role==='admin') return `<strong>Managing doctors:</strong> open <strong>Manage Doctors → + Add doctor</strong> to create a doctor profile and login together. Use <strong>Edit doctor</strong> to update details, fee or schedule, and <strong>Remove</strong> to delete a doctor (blocked while they still have active confirmed appointments).`;
    if(role==='doctor') return `Only Admin can add or remove doctors from the CareConnect directory. If you need your own profile or fee updated, ask Admin, or update your own availability and time slots from your profile.`;
    return `Doctors are added by CareConnect Admin, or a doctor can create their own account from <strong>Create an account → Doctor</strong> on the sign-in screen.`;
  }

  if(/(edit patient|patient record|patient data|patient profile)/.test(text)) {
    if(role==='admin') return `<strong>Editing patient records:</strong> open <strong>Patients → Edit & history</strong> to update a patient's name, contact, age, gender, blood group, address or emergency contact. Every save keeps a previous-version snapshot you can review.`;
    if(role==='doctor') return `You can see a patient's contact details on their appointment card. Detailed profile edits (address, blood group, emergency contact) are managed by CareConnect Admin.`;
    return `Your own detailed profile fields (address, blood group, emergency contact, etc.) are currently managed by CareConnect Admin on request. You're always able to see your own info from your account.`;
  }

  if(/(skin|rash|acne|itch|eczema|allergy)/.test(text)) return roleDoctorListReply(role, 'Dermatologist', `<strong>For skin-related concerns:</strong> a dermatologist can assess many skin problems.`);
  if(/(chest pain|heart|palpitation|blood pressure|\bbp\b)/.test(text)) return roleDoctorListReply(role, 'Cardiologist', `<strong>For heart or blood-pressure concerns:</strong> a cardiologist or general physician can assess the issue. Sudden severe chest pain or severe breathing difficulty needs urgent medical care.`);
  if(/(bone|joint|back pain|knee|fracture|shoulder|muscle)/.test(text)) return roleDoctorListReply(role, 'Orthopedic', `<strong>For bone, joint or muscle problems:</strong> an orthopedic doctor can evaluate many musculoskeletal concerns.`);
  if(/(child|baby|kid|pediatric)/.test(text)) return roleDoctorListReply(role, 'Pediatrician', `<strong>For children's health:</strong> a pediatrician specializes in healthcare for children.`);
  if(/(fever|cold|cough|headache|stomach pain|vomiting|weakness|general health)/.test(text)) return roleDoctorListReply(role, 'General Physician', `<strong>General health concern:</strong> a General Physician can assess common symptoms and decide whether a specialist is needed.`);

  if(/(available doctors|which doctors|doctor available|find a doctor|specialist|who can i see|show doctors)/.test(text)) {
    const list=availableDoctorsText('', role==='patient', role==='doctor'?selfDoctorId():null);
    if(role==='doctor') return `<strong>Here's the current CareConnect doctor directory</strong> (this updates immediately whenever Admin or a new doctor adds a profile):${list}`;
    if(role==='admin') return `<strong>Full doctor directory</strong>, sorted by rating — the same list new doctors join the moment they're added. Edit any of them from <strong>Manage Doctors</strong>:${list}`;
    return `<strong>Here are the doctors currently listed in CareConnect</strong>, best-rated first — this always includes doctors added just now:${list}`;
  }

  if(/(book|appointment|schedule|reschedule|cancel)/.test(text)) {
    if(role==='doctor') return `As a doctor, appointments are booked by patients — you don't book them yourself. From <strong>My Appointments</strong> you can view visits, mark them <strong>Complete</strong> or <strong>Cancelled</strong>, and join online video visits. To change what patients can book, update your availability, days and time slots from your profile.`;
    if(role==='admin') return `Admin doesn't book appointments directly. Open <strong>All Appointments</strong> to view every booking with its online/offline mode and token, or use <strong>Manage Doctors</strong> / <strong>Patients</strong> to edit records.`;
    return 'To book an appointment, open <strong>Find a Doctor</strong>, select a doctor, choose <strong>Online video</strong> or <strong>Offline visit</strong>, pick a date and slot, then confirm. Reschedule and cancel are available from <strong>My Appointments</strong>.';
  }

  if(/(mic|microphone|camera|cam|chat)/.test(text)) {
    if(role==='doctor') return `<strong>Online call controls:</strong> when you join a patient's video visit, you'll have separate buttons for <strong>microphone</strong> and <strong>camera</strong> on/off, plus the appointment <strong>chat box</strong> alongside the call.`;
    return '<strong>Online call controls:</strong> the video room includes separate buttons to turn your <strong>microphone</strong> and <strong>camera</strong> on/off, plus a live appointment <strong>chat box</strong>.';
  }

  if(/(emergency|urgent|breathing|unconscious|severe bleeding)/.test(text)) return 'This assistant is not an emergency service. For severe, sudden, or life-threatening symptoms, seek immediate medical care or contact your local emergency service.';

  if(role==='doctor') return `I’m the <strong>CareConnect AI Assistant</strong>. Try asking <strong>“Which doctors are available?”</strong> to see the live directory, <strong>“How do ratings work?”</strong>, <strong>“How does an offline token work?”</strong>, or <strong>“What is metformin?”</strong> for a quick medicine refresher.`;
  if(role==='admin') return `I’m the <strong>CareConnect AI Assistant</strong>. Try asking <strong>“How do I add a doctor?”</strong>, <strong>“How do ratings work?”</strong>, <strong>“Which doctors are available?”</strong>, or <strong>“How do I edit a patient record?”</strong>.`;
  return `I’m the <strong>CareConnect AI Assistant</strong>. Try asking <strong>“What is paracetamol tablet used for?”</strong>, <strong>“What is metformin?”</strong>, <strong>“Which doctors are available?”</strong>, <strong>“How does an offline token work?”</strong>, or <strong>“How does the online video call work?”</strong>.`;
}

function roleDoctorListReply(role, specialty, intro) {
  const list=availableDoctorsText(specialty, role==='patient', role==='doctor'?selfDoctorId():null);
  if(role==='doctor') return `${intro} Here are the currently listed ${esc(specialty)} doctors in CareConnect:${list}`;
  if(role==='admin') return `${intro} Here are the currently listed ${esc(specialty)} doctors — edit any from Manage Doctors:${list}`;
  return `${intro} CareConnect can show the doctors currently listed:${list}`;
}

function assistantChips(role) {
  if(role==='doctor') return [
    ['👨‍⚕️ Doctor directory','Which doctors are available?'],
    ['⭐ My rating','How do ratings work?'],
    ['🎟 Offline tokens','How does an offline token work?'],
    ['💻 Online visit','How does the online video call work?'],
    ['💊 Metformin','What is metformin tablet used for?'],
  ];
  if(role==='admin') return [
    ['👨‍⚕️ Doctor directory','Which doctors are available?'],
    ['➕ Add a doctor','How do I add a doctor?'],
    ['✎ Edit a patient','How do I edit a patient record?'],
    ['⭐ Ratings','How do ratings work?'],
    ['🎟 Offline tokens','How does an offline token work?'],
  ];
  return [
    ['💊 Paracetamol','What is paracetamol tablet used for?'],
    ['💊 Metformin','What is metformin tablet used for?'],
    ['👨‍⚕️ Available doctors','Which doctors are available?'],
    ['🎟 Offline token','How does an offline token work?'],
    ['💻 Online visit','How does the online video call work?'],
  ];
}

function assistantPage() {
  const user=session();
  const roleTag = user.role==='doctor' ? 'CareConnect AI · Doctor view' : user.role==='admin' ? 'CareConnect AI · Admin view' : 'CareConnect AI · Patient view';
  const intro = user.role==='doctor'
    ? 'Ask about your appointments, availability, patient tokens, your rating, or a quick medicine refresher.'
    : user.role==='admin'
    ? 'Ask about managing doctors and patients, appointments, tokens, or ratings.'
    : 'Ask naturally about medicines, tablets, symptoms, doctors, online/offline visits or appointments.';
  const chips=assistantChips(user.role).map(([label,prompt])=>`<button type="button" class="ai-chip" data-ai-prompt="${esc(prompt)}">${label}</button>`).join('');
  const starter=`<div class="ai-chat"><div class="ai-chat-head"><div><span class="ai-badge">✦ AI ASSISTANT</span><h2>CareConnect Assistant</h2><p>${intro}</p></div><span class="ai-mode">${roleTag}</span></div><div class="ai-quick">${chips}</div><div id="chatMessages" class="chat-messages"></div><form id="chatForm" class="chat-input"><input id="chatInput" autocomplete="off" placeholder="Ask about a medicine, doctor or appointment…"><button class="primary-btn" type="submit">➤</button></form><p class="ai-disclaimer">I’m an AI assistant for general information and CareConnect navigation. I do not diagnose or prescribe. For personal treatment decisions, consult a qualified doctor or pharmacist.${user.role==='patient'?' You can book a listed doctor directly from the suggestions.':''}</p></div>`;
  return `<div class="content">${starter}</div>`;
}

function renderChat() {
  const box=document.getElementById('chatMessages');
  if(!box)return;
  if(!state.chat.length) {
    const user=session(); const role=user?.role;
    const greet = role==='doctor'
      ? `Hi Dr. ${esc(user.name.split(' ')[0])} 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about your appointments, availability, patient tokens, your rating, or a medicine.`
      : role==='admin'
      ? 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about managing doctors or patients, appointments, tokens, or ratings.'
      : 'Hi 👋 I’m the <strong>CareConnect AI Assistant</strong>. Ask me about a common medicine/tablet, a symptom, a doctor, an online video consultation, an offline token, or an appointment.';
    state.chat.push({who:'ai',html:greet});
  }
  box.innerHTML=state.chat.map(m=>`<div class="chat-message ${m.who==='user'?'user':'ai'}"><div>${m.html}</div></div>`).join('');
  box.scrollTop=box.scrollHeight;
}

// ======================================================================
// Live video consultation: WebRTC (peer-to-peer audio/video) with the CareConnect
// server relaying only the connection set-up messages.
// ======================================================================
const call = {
  sid: 0, id: null, pc: null, stream: null, remoteStream: null, joined: false, peerId: null, polite: false,
  makingOffer: false, ignoreOffer: false, queue: [], chain: Promise.resolve(), ending: false, endTimer: null,
  wake: null, remoteVideoOn: true, remoteAudioOn: true, peerName: '', live: false
};
let callSeq = 0;
const $id = id => document.getElementById(id);

function resetCall() {
  clearTimeout(call.endTimer);
  Object.assign(call, {
    id: null, pc: null, stream: null, remoteStream: null, joined: false, peerId: null, makingOffer: false, ignoreOffer: false,
    queue: [], chain: Promise.resolve(), ending: false, endTimer: null, wake: null, remoteVideoOn: true, remoteAudioOn: true, live: false
  });
  call.sid = 0;
}

function setBadge(text, cls = '') {
  const b = $id('callBadge');
  if (b) { b.textContent = `● ${text}`; b.className = `call-live ${cls}`; }
}
function setCallNote(text) { const n = $id('callNote'); if (n) n.textContent = text || ''; }
function setRemoteStatus(text) { const s = $id('remoteStatus'); if (s) s.textContent = text; }

function updateRemoteOverlay() {
  const overlay = $id('remoteOverlay');
  if (!overlay) return;
  const hasVideo = !!call.remoteStream && call.remoteStream.getVideoTracks().length > 0;
  const showVideo = call.live && hasVideo && call.remoteVideoOn;
  overlay.classList.toggle('hidden', showVideo);
  if (call.live && !showVideo) setRemoteStatus(hasVideo ? `${call.peerName}'s camera is off` : `${call.peerName} joined with audio only`);
}

function videoCallModal(appointmentId) {
  const d = db(), a = d.appointments.find(x => x.id === appointmentId), user = session();
  if (!a || a.mode !== 'online') return showToast('This is not an online appointment.');
  const doctor = getDoctor(d, a.doctorId);
  if (!doctor) return showToast('Doctor not found.');
  if (a.status !== 'Confirmed') return showToast(`This appointment is ${String(a.status).toLowerCase()}.`);
  if (SERVER.on && SERVER.enforce) {
    const w = CC.joinWindow(a, nowMs(), clinicTZ());
    if (w.state === 'early') return showToast(`The video room opens ${fmtWhen(w.opens)} (${CC.OPEN_BEFORE_MIN} minutes before the appointment).`);
    if (w.state === 'late') return showToast('The video room for this appointment has closed.');
  }
  const remoteName = user.role === 'doctor' ? a.patientName : `Dr. ${doctor.name}`;
  state.activeCall = appointmentId;
  openModal(`<div class="call-room-enhanced"><div class="call-top"><div><span id="callBadge" class="call-live">● STARTING</span><strong>CareConnect Video Consultation</strong><small>${esc(remoteName)} · ${formatDate(a.date)} · ${esc(a.time)}</small></div><span class="call-mode-pill">ONLINE</span></div><div class="call-grid"><section class="video-panel"><div class="video-stage"><div class="remote-feed"><video id="remoteVideo" autoplay playsinline></video><div id="remoteOverlay" class="remote-overlay"><div class="remote-avatar">🩺</div><strong>${esc(remoteName)}</strong><small id="remoteStatus">Connecting…</small></div><button id="soundPrompt" class="sound-prompt hidden" type="button">🔊 Tap to start video &amp; sound</button></div><div class="local-feed"><video id="localVideo" autoplay playsinline muted></video><div id="cameraFallback" class="camera-fallback">Starting camera…</div><span>You</span></div></div><div class="call-controls"><button class="call-control" id="toggleMic" type="button">🎤 Mic ON</button><button class="call-control" id="toggleCam" type="button">📷 Camera ON</button><button class="end-call" id="endCall" type="button">End call</button></div><p class="call-demo-note" id="callNote"></p></section><aside class="call-chat-panel"><div class="call-chat-head"><strong>Appointment chat</strong><span>${esc(doctor.specialty)}</span></div><div id="callChatMessages" class="call-chat-messages"></div><form id="callChatForm" class="call-chat-input"><input id="callChatInput" placeholder="Type a message…" autocomplete="off" maxlength="1000"><button>Send</button></form></aside></div></div>`, true);
  startCall(a, remoteName);
}

async function acquireMedia(sid) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' };
  let stream = null, problem = '';
  if (navigator.mediaDevices?.getUserMedia) {
    for (const constraints of [{ audio, video }, { audio, video: false }]) {
      try { stream = await navigator.mediaDevices.getUserMedia(constraints); break; }
      catch (e) { problem = e && e.name ? e.name : 'error'; }
    }
  } else {
    problem = 'insecure';
  }
  if (call.sid !== sid) { if (stream) stream.getTracks().forEach(t => t.stop()); return false; }
  call.stream = stream; state.callStream = stream;
  const hasVideo = !!stream && stream.getVideoTracks().length > 0;
  const hasAudio = !!stream && stream.getAudioTracks().length > 0;
  state.callVideoOn = hasVideo; state.callAudioOn = hasAudio;
  if (stream) {
    stream.getAudioTracks().forEach(t => { t.contentHint = 'speech'; });
    stream.getVideoTracks().forEach(t => { t.contentHint = 'motion'; });
  }
  const lv = $id('localVideo'), fb = $id('cameraFallback');
  if (lv && stream) lv.srcObject = stream;
  if (fb) {
    if (hasVideo) fb.classList.add('hidden');
    else { fb.textContent = stream ? 'Camera unavailable — audio only' : 'No camera / microphone'; fb.classList.remove('hidden'); }
  }
  if (!stream) {
    setCallNote(problem === 'insecure'
      ? 'Camera and microphone need a secure (https) connection. You can still see and hear the other person and use chat.'
      : 'Camera/microphone access was blocked. Allow access in your browser settings and rejoin to be seen and heard. You can still see/hear the other person and chat.');
  } else if (!hasVideo) {
    setCallNote('No camera detected — you are joining with audio only.');
  }
  updateCallButtons();
  return true;
}

async function startCall(a, remoteName) {
  resetCall();
  const sid = ++callSeq;
  call.sid = sid; call.id = a.id; call.peerName = remoteName;
  call.polite = session()?.role === 'patient';
  renderCallChat();
  if (!SERVER.on) {
    await acquireMedia(sid);
    setBadge('DEMO');
    setRemoteStatus('Demo mode: no other participant');
    setCallNote('Single-device demo: live two-way calls need the CareConnect server (see README). Camera/mic preview and chat work here.');
    return;
  }
  setBadge('CONNECTING');
  setRemoteStatus(`Waiting for ${remoteName} to join…`);
  if (!(await acquireMedia(sid))) return;
  try { await ensureWS(); }
  catch (e) { setBadge('OFFLINE', 'bad'); setCallNote('Could not reach the CareConnect server. Check your connection and reopen the call.'); return; }
  if (call.sid !== sid) return;
  wsSend({ type: 'join-call', appointmentId: a.id });
  try { if ('wakeLock' in navigator) call.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
}

function sendMediaState() { wsSend({ type: 'call-state', data: { audio: state.callAudioOn, video: state.callVideoOn } }); }

function createPC() {
  closePC();
  const pc = new RTCPeerConnection({ iceServers: SERVER.ice });
  call.pc = pc; call.makingOffer = false; call.ignoreOffer = false;
  call.remoteStream = new MediaStream();
  const rv = $id('remoteVideo');
  if (rv) rv.srcObject = call.remoteStream;
  if (call.stream) call.stream.getTracks().forEach(t => pc.addTrack(t, call.stream));
  if (!call.stream || !call.stream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
  if (!call.stream || !call.stream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });

  pc.ontrack = e => {
    if (!call.remoteStream.getTracks().includes(e.track)) call.remoteStream.addTrack(e.track);
    const v = $id('remoteVideo');
    if (v) { v.srcObject = call.remoteStream; v.play().then(() => $id('soundPrompt')?.classList.add('hidden')).catch(() => $id('soundPrompt')?.classList.remove('hidden')); }
    updateRemoteOverlay();
  };
  pc.onicecandidate = e => { if (e.candidate) wsSend({ type: 'signal', data: { candidate: e.candidate } }); };
  pc.onnegotiationneeded = async () => {
    try {
      call.makingOffer = true;
      await pc.setLocalDescription();
      wsSend({ type: 'signal', data: { description: pc.localDescription } });
    } catch (e) { console.error('negotiation failed', e); } finally { call.makingOffer = false; }
  };
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      call.live = true; setBadge('LIVE', 'ok'); setCallNote(''); updateRemoteOverlay();
      const v = $id('remoteVideo'); if (v && v.paused) v.play().catch(() => $id('soundPrompt')?.classList.remove('hidden'));
    } else if (s === 'disconnected') {
      setBadge('RECONNECTING', 'warn'); setCallNote('Connection is unstable — trying to reconnect…');
    } else if (s === 'failed') {
      setBadge('RECONNECTING', 'warn');
      setCallNote('Connection failed. Retrying… If this keeps happening, the network may block direct calls (a TURN server is needed — see README).');
      try { pc.restartIce(); } catch (e) { /* ignore */ }
    }
  };
  // flush any signals that arrived before the connection object existed
  const queued = call.queue.splice(0);
  queued.forEach(data => { call.chain = call.chain.then(() => handleSignal(data)).catch(console.error); });
}

function closePC() {
  if (call.pc) {
    call.pc.onicecandidate = call.pc.ontrack = call.pc.onnegotiationneeded = call.pc.oniceconnectionstatechange = null;
    try { call.pc.close(); } catch (e) { /* ignore */ }
    call.pc = null;
  }
  call.live = false; call.remoteStream = null;
  const rv = $id('remoteVideo'); if (rv) rv.srcObject = null;
}

async function handleSignal(data) {
  const pc = call.pc;
  if (!pc) { call.queue.push(data); return; }
  try {
    if (data.description) {
      const desc = data.description;
      const collision = desc.type === 'offer' && (call.makingOffer || pc.signalingState !== 'stable');
      call.ignoreOffer = !call.polite && collision;
      if (call.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        wsSend({ type: 'signal', data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); }
      catch (e) { if (!call.ignoreOffer) throw e; }
    }
  } catch (e) { console.error('signal handling failed', e); }
}

function onPeerPresent(peer) {
  call.peerId = peer.userId;
  call.peerName = peer.role === 'doctor' ? `Dr. ${peer.name}` : peer.name;
  setBadge('CONNECTING');
  setRemoteStatus(`Connecting to ${call.peerName}…`);
  createPC();
  sendMediaState();
}

function handleCallMessage(msg) {
  if (!call.sid) return;
  switch (msg.type) {
    case 'call-joined':
      call.joined = true;
      if (msg.peers.length) onPeerPresent(msg.peers[0]);
      else { setBadge('WAITING'); setRemoteStatus(`Waiting for ${call.peerName} to join…`); }
      break;
    case 'peer-joined': onPeerPresent(msg.peer); break;
    case 'peer-left':
      closePC(); setBadge('WAITING');
      $id('remoteOverlay')?.classList.remove('hidden');
      setRemoteStatus(`${call.peerName} left. Waiting for them to rejoin…`);
      break;
    case 'signal': call.chain = call.chain.then(() => handleSignal(msg.data)).catch(console.error); break;
    case 'call-state':
      call.remoteAudioOn = msg.data.audio !== false; call.remoteVideoOn = msg.data.video !== false;
      updateRemoteOverlay();
      if (!call.remoteAudioOn) setCallNote(`${call.peerName} has muted their microphone.`); else if (call.live) setCallNote('');
      break;
    case 'call-ended': finishCall(!!msg.completed, true); break;
    case 'call-end-ack': finishCall(!!msg.completed, false); break;
    case 'call-error': {
      const text = msg.error || 'Could not join the call.';
      leaveCallLocal(false); closeModal(); showToast(text); break;
    }
    case 'call-replaced': leaveCallLocal(false); closeModal(); showToast('You joined this call from another window.'); break;
  }
}

function endCallClicked() {
  if (!call.sid) return closeModal();
  if (!SERVER.on) {
    const aid = state.activeCall, user = session();
    closeModal();
    perform('complete', { id: aid }).then(r => { if (r.ok && user?.role === 'patient') setTimeout(() => rateModal(aid), 150); });
    return;
  }
  if (!call.joined) return closeModal();
  call.ending = true;
  wsSend({ type: 'end-call' });
  call.endTimer = setTimeout(() => finishCall(false, false), 2500);
}

async function finishCall(completed, byPeer) {
  const aid = call.id || state.activeCall, user = session();
  call.ending = true; // the server already removed us from the room
  leaveCallLocal(false);
  closeModal();
  showToast(byPeer ? `${user?.role === 'doctor' ? 'The patient' : 'The doctor'} ended the consultation.` : 'Video consultation ended.');
  await pull(true);
  render();
  if (completed && user && user.role === 'patient' && aid) setTimeout(() => rateModal(aid), 150);
}

function leaveCallLocal(sendLeave) {
  if (call.sid && call.joined && sendLeave && !call.ending) wsSend({ type: 'leave-call' });
  closePC(); stopCallMedia();
  try { call.wake?.release(); } catch (e) { /* ignore */ }
  resetCall();
  state.activeCall = null;
}

function stopCallMedia() {
  const s = call.stream || state.callStream;
  if (s) s.getTracks().forEach(track => track.stop());
  call.stream = null; state.callStream = null;
}

function updateCallButtons() {
  const mic = $id('toggleMic'), cam = $id('toggleCam');
  const hasA = !!state.callStream && state.callStream.getAudioTracks().length > 0;
  const hasV = !!state.callStream && state.callStream.getVideoTracks().length > 0;
  if (mic) { mic.textContent = `🎤 Mic ${state.callAudioOn ? 'ON' : 'OFF'}`; mic.disabled = !hasA; mic.classList.toggle('off', !state.callAudioOn); }
  if (cam) { cam.textContent = `📷 Camera ${state.callVideoOn ? 'ON' : 'OFF'}`; cam.disabled = !hasV; cam.classList.toggle('off', !state.callVideoOn); }
}

function renderCallChat() {
  const box = $id('callChatMessages'), d = db(), a = d.appointments.find(x => x.id === state.activeCall), me = session();
  if (!box || !a) return;
  const chat = Array.isArray(a.chat) ? a.chat : [];
  box.innerHTML = chat.length ? chat.map(m => `<div class="call-chat-message ${m.senderRole === 'doctor' ? 'doctor' : 'patient'} ${me && m.senderId === me.id ? 'mine' : ''}"><strong>${esc(m.senderName)}</strong><span>${esc(m.text)}</span><small>${new Date(m.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</small></div>`).join('') : '<div class="chat-empty">No messages yet. Start the appointment chat.</div>';
  box.scrollTop = box.scrollHeight;
}

function appendChat(appointmentId, msg) {
  const key = storeKey();
  if (!key) return;
  const d = db(), a = d.appointments.find(x => x.id === appointmentId);
  if (!a) return;
  a.chat = Array.isArray(a.chat) ? a.chat : [];
  if (a.chat.some(m => m.id === msg.id)) return;
  a.chat.push(msg);
  try { localStorage.setItem(key, JSON.stringify(d)); } catch (e) { /* ignore */ }
  if (state.activeCall === appointmentId) renderCallChat();
}

async function storeCallMessage(text) {
  const aid = state.activeCall, user = session();
  text = String(text || '').trim();
  if (!aid || !user || !text) return;
  if (!SERVER.on) {
    const d = normalizeData(db());
    const r = CC.run('chat', d, user, { appointmentId: aid, text }, localCtx());
    if (r.ok) { save(d); renderCallChat(); } else showToast(r.error);
    return;
  }
  try {
    const res = await apiFetch('POST', '/api/action', { type: 'chat', payload: { appointmentId: aid, text } });
    if (res.ok && res.result?.message) appendChat(aid, res.result.message);
    else if (!res.ok) showToast(res.error || 'Message not sent.');
  } catch (e) { showToast(e.network ? 'Message not sent — you appear to be offline.' : (e.message || 'Message not sent.')); }
}

async function saveDoctorForm(form) {
  if (!form) return false;
  const field = n => form.elements.namedItem(n);
  const v = n => String(field(n)?.value ?? '').trim();
  const availableEl = field('available');
  const payload = {
    id: v('id'), name: v('name'), specialty: v('specialty'), experience: v('experience'), fee: v('fee'),
    availability: v('availability'), slots: v('slots'), available: availableEl ? !!availableEl.checked : true,
    loginEmail: v('loginEmail'), loginPassword: v('loginPassword')
  };
  if (!payload.name || !payload.specialty || !payload.experience || !payload.availability || !payload.slots || payload.fee === '') {
    showToast('Please fill all required doctor details.');
    return false;
  }
  const btn = form.querySelector('[data-save-doctor]');
  if (btn) btn.disabled = true;
  const r = await perform('saveDoctor', payload);
  if (btn) btn.disabled = false;
  if (r.ok) {
    closeModal(); render();
    showToast('Doctor details saved. Patient, Doctor and Admin views are all updated.');
  }
  return !!r.ok;
}

async function savePatientForm(form) {
  if (!form) return false;
  const v = n => String(form.elements.namedItem(n)?.value ?? '').trim();
  const payload = {
    id: v('id'), name: v('name'), email: v('email'), phone: v('phone'), age: v('age'), gender: v('gender'),
    bloodGroup: v('bloodGroup'), address: v('address'), emergencyContact: v('emergencyContact')
  };
  const btn = form.querySelector('[data-save-patient]');
  if (btn) btn.disabled = true;
  const r = await perform('savePatient', payload);
  if (btn) btn.disabled = false;
  if (r.ok) {
    closeModal(); render();
    showToast('Patient details saved. Previous data is available in history.');
  }
  return !!r.ok;
}

// ======================================================================
// Server connection: API, sign-in, live updates (WebSocket)
// ======================================================================
async function apiFetch(method, url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let r;
  try {
    r = await fetch(url, {
      method, cache: 'no-store', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(SERVER.token ? { Authorization: `Bearer ${SERVER.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    SERVER.offline = true; updateNetStatus();
    const err = new Error('network'); err.network = true; throw err;
  } finally { clearTimeout(timer); }
  SERVER.offline = false; updateNetStatus();
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-json */ }
  if (r.status === 401 && SERVER.token && !url.startsWith('/api/login')) {
    sessionExpired();
    const err = new Error(data.error || 'Session expired.'); err.status = 401; throw err;
  }
  if (!r.ok) { data.ok = false; if (!data.error) data.error = `Server error (${r.status}).`; }
  return data;
}

async function detectServer() {
  if (!/^https?:$/.test(location.protocol)) return;
  const remembered = safeParseRaw(localStorage.getItem('careconnect_server_cfg'));
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const h = await (await fetch('/api/health', { cache: 'no-store', signal: ctl.signal })).json();
    clearTimeout(t);
    if (!h || h.app !== 'careconnect') throw new Error('not a CareConnect server');
    const c = await (await fetch('/api/config', { cache: 'no-store' })).json();
    SERVER.on = true; SERVER.tz = c.tz; SERVER.skew = c.now - Date.now(); SERVER.enforce = c.enforceCallWindow !== false;
    if (Array.isArray(c.iceServers) && c.iceServers.length) SERVER.ice = c.iceServers;
    try { localStorage.setItem('careconnect_server_cfg', JSON.stringify({ tz: c.tz, enforce: SERVER.enforce, ice: SERVER.ice })); } catch (e) { /* ignore */ }
  } catch (e) {
    // Installed app opened with no connection: stay in shared mode and use the cached view.
    if (remembered && remembered.tz) {
      SERVER.on = true; SERVER.offline = true; SERVER.tz = remembered.tz; SERVER.enforce = remembered.enforce !== false;
      if (Array.isArray(remembered.ice)) SERVER.ice = remembered.ice;
    }
  }
}

let pulling = null;
function pull(force) {
  if (!SERVER.on || !SERVER.token) return Promise.resolve();
  if (pulling) return pulling;
  pulling = (async () => {
    try {
      const res = await apiFetch('GET', `/api/sync?rev=${force ? 0 : SERVER.rev}`);
      if (res.view) applyView(res);
    } catch (e) { /* offline or session expired: handled in apiFetch */ }
    finally { pulling = null; updateNetStatus(); }
  })();
  return pulling;
}

function applyView(res) {
  SERVER.rev = res.rev;
  writeCache(res.view);
  notifyNew(res.view);
  scheduleRender();
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderIfIdle, 30);
}
function renderIfIdle() {
  const ae = document.activeElement;
  if (ae && ae.matches && ae.matches('[data-search],[data-filter]') && ae.closest('#pageContent')) { state.dirty = true; return; }
  render();
}

// New notifications → toast, and a system notification when the app is in the background.
function ownNotifs() {
  const u = session();
  return u ? db().notifications.filter(n => n.userId === u.id) : [];
}
function notifyNew(view) {
  const list = view.notifications || [];
  if (SERVER.known) {
    const fresh = list.filter(n => !SERVER.known.has(n.id) && !n.read);
    if (fresh.length) {
      const last = fresh[fresh.length - 1];
      showToast(`🔔 ${last.title}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`);
      if (document.hidden) fresh.slice(-3).forEach(n => deviceNotify(n.title, n.message));
    }
  }
  SERVER.known = new Set(list.map(n => n.id));
}
function deviceNotify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body, icon: 'icon-192.png', badge: 'icon-64.png', tag: `cc-${title}` };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => { if (reg) reg.showNotification(title, opts); else new Notification(title, opts); });
    } else new Notification(title, opts);
  } catch (e) { /* ignore */ }
}

function startSession(res, welcome) {
  SERVER.token = res.token; SERVER.userId = res.userId; SERVER.rev = res.rev; SERVER.known = null;
  writeSession({ id: res.userId, token: res.token });
  writeCache(res.view);
  notifyNew(res.view);
  state = freshState();
  connectWS();
  render();
  const u = session();
  if (u) showToast(welcome || `Welcome back, ${u.name.split(' ')[0]}!`);
}

function sessionExpired() {
  if (!SERVER.token) return;
  try { localStorage.removeItem(CACHE_PREFIX + SERVER.userId); } catch (e) { /* ignore */ }
  leaveCallLocal(false);
  closeWS();
  SERVER.token = null; SERVER.userId = null; SERVER.known = null; SERVER.rev = 0;
  clearSession();
  state = freshState();
  document.getElementById('modal')?.classList.add('hidden');
  render();
  showToast('Your session has ended. Please sign in again.');
}

async function logout() {
  if (SERVER.on && SERVER.token) { try { await apiFetch('POST', '/api/logout'); } catch (e) { /* ignore */ } }
  if (!SERVER.token && SERVER.on) return; // already handled by sessionExpired
  closeModal();
  if (SERVER.on) {
    try { localStorage.removeItem(CACHE_PREFIX + SERVER.userId); } catch (e) { /* ignore */ }
    closeWS();
    SERVER.token = null; SERVER.userId = null; SERVER.known = null; SERVER.rev = 0;
  }
  clearSession();
  state = freshState();
  render();
  showToast('You have been logged out.');
}

function wsSend(obj) {
  if (SERVER.ws && SERVER.ws.readyState === 1) { SERVER.ws.send(JSON.stringify(obj)); return true; }
  return false;
}
function closeWS() {
  clearTimeout(SERVER.rt);
  const ws = SERVER.ws; SERVER.ws = null; SERVER.wsReady = false;
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
}
function connectWS() {
  if (!SERVER.on || !SERVER.token) return;
  if (SERVER.ws && SERVER.ws.readyState <= 1) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  SERVER.ws = ws; SERVER.wsReady = false;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: SERVER.token }));
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onWsMessage(m); };
  ws.onclose = () => {
    if (SERVER.ws !== ws) return;
    SERVER.ws = null; SERVER.wsReady = false;
    if (call.sid && call.joined) { call.joined = false; setBadge('RECONNECTING', 'warn'); setCallNote('Connection to the server was lost. Reconnecting…'); }
    clearTimeout(SERVER.rt);
    if (SERVER.token) { SERVER.retry = Math.min(SERVER.retry * 1.6, 15000); SERVER.rt = setTimeout(connectWS, SERVER.retry); }
  };
  ws.onerror = () => {};
}
function ensureWS() {
  if (SERVER.wsReady) return Promise.resolve();
  connectWS();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (SERVER.wsReady) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 8000) { clearInterval(timer); reject(new Error('ws timeout')); }
    }, 100);
  });
}
function onWsMessage(m) {
  switch (m.type) {
    case 'ready':
      SERVER.wsReady = true; SERVER.retry = 1000;
      if (m.rev !== SERVER.rev) pull();
      if (call.sid && !call.joined && call.id) wsSend({ type: 'join-call', appointmentId: call.id }); // rejoin after a dropped connection
      updateNetStatus();
      break;
    case 'auth-failed': sessionExpired(); break;
    case 'changed': if (m.rev !== SERVER.rev) pull(); break;
    case 'chat': appendChat(m.appointmentId, m.message); break;
    default: handleCallMessage(m);
  }
}

function updateNetStatus() {
  const el = document.getElementById('netBanner');
  if (!el) return;
  const off = SERVER.on && (SERVER.offline || !navigator.onLine);
  el.textContent = off ? "You're offline — showing saved data. Booking and calls need a connection." : '';
  el.classList.toggle('hidden', !off);
}
function setModeNote() {
  const el = document.getElementById('modeNote');
  if (!el) return;
  el.textContent = SERVER.on
    ? ''
    : 'Single-device demo mode: data is stored only in this browser. Run the CareConnect server (see README) so doctors, patients and admins on different devices share data and can video-call.';
  el.classList.toggle('hidden', SERVER.on);
}

// ======================================================================
// UI events
// ======================================================================
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;

  if (b.dataset.auth) { setAuth(b.dataset.auth); return; }
  if (b.dataset.saveDoctor) { e.preventDefault(); saveDoctorForm(document.getElementById('doctorForm')); return; }
  if (b.dataset.savePatient) { e.preventDefault(); savePatientForm(document.getElementById('patientForm')); return; }
  if (b.dataset.page) { state.page = b.dataset.page; state.search = ''; render(); return; }
  if (b.dataset.action === 'book-first') { state.page = 'doctors'; state.search = ''; render(); return; }
  if (b.dataset.action === 'add-doctor') { doctorModal(); return; }
  if (b.dataset.book) { bookingModal(b.dataset.book); return; }
  if (b.dataset.editdoctor) { doctorModal(b.dataset.editdoctor); return; }
  if (b.dataset.aiBook) { state.page = 'doctors'; state.search = ''; render(); setTimeout(() => bookingModal(b.dataset.aiBook), 50); return; }
  if (b.dataset.aiPrompt) { const input = document.getElementById('chatInput'); if (input) { input.value = b.dataset.aiPrompt; document.getElementById('chatForm')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } return; }
  if (b.dataset.videoCall) { videoCallModal(b.dataset.videoCall); return; }
  if (b.dataset.edit) { const a = db().appointments.find(x => x.id === b.dataset.edit); if (a) bookingModal(a.doctorId, a.id); return; }
  if (b.dataset.editpatient) { patientEditModal(b.dataset.editpatient); return; }
  if (b.dataset.cancel) {
    if (!window.confirm('Cancel this appointment? The other party will be notified.')) return;
    perform('cancel', { id: b.dataset.cancel }).then(r => { if (r.ok) showToast('Appointment cancelled.'); });
    return;
  }
  if (b.dataset.complete) {
    perform('complete', { id: b.dataset.complete }).then(r => { if (r.ok) showToast('Appointment marked as completed.'); });
    return;
  }
  if (b.dataset.rate) { rateModal(b.dataset.rate); return; }
  if (b.dataset.star) {
    const picker = b.closest('[data-star-picker]');
    const form = b.closest('form');
    const n = Number(b.dataset.star);
    if (form) form.elements.namedItem('stars').value = n;
    if (picker) [...picker.querySelectorAll('[data-star]')].forEach(btn => btn.classList.toggle('filled', Number(btn.dataset.star) <= n));
    return;
  }
  if (b.hasAttribute('data-submit-rating')) {
    const form = document.getElementById('ratingForm');
    if (form) {
      const stars = Number(form.elements.namedItem('stars').value || 0);
      submitRating(form.elements.namedItem('appointmentId').value, stars, form.elements.namedItem('comment').value);
    }
    return;
  }
  if (b.dataset.deletedoctor) {
    if (!window.confirm('Remove this doctor and their login?')) return;
    perform('deleteDoctor', { id: b.dataset.deletedoctor }).then(r => { if (r.ok) showToast('Doctor removed from directory and login list.'); });
    return;
  }
  if (b.dataset.toggleDoctor || b.dataset.toggleSelf) {
    const id = b.dataset.toggleDoctor || b.dataset.toggleSelf;
    perform('toggleDoctor', { id }).then(r => {
      if (!r.ok) return;
      const doc = getDoctor(db(), id);
      showToast(doc && doc.available === false ? 'Marked unavailable. Affected patients were notified.' : 'Marked available. Patients can book again.');
    });
    return;
  }
  if (b.hasAttribute('data-read-all')) { perform('markRead', {}).then(r => { if (r.ok) showToast('Notifications marked as read.'); }); return; }
  if (b.hasAttribute('data-enable-alerts')) {
    if ('Notification' in window) Notification.requestPermission().then(p => { showToast(p === 'granted' ? 'Alerts enabled on this device.' : 'Alerts were not enabled.'); render(); });
    return;
  }
  if (b.id === 'notificationBtn') { state.page = 'notifications'; render(); return; }
  if (b.id === 'soundPrompt') { document.getElementById('remoteVideo')?.play().then(() => b.classList.add('hidden')).catch(() => {}); return; }
  if (b.id === 'toggleMic') {
    state.callAudioOn = !state.callAudioOn;
    state.callStream?.getAudioTracks().forEach(t => { t.enabled = state.callAudioOn; });
    updateCallButtons(); sendMediaState(); return;
  }
  if (b.id === 'toggleCam') {
    state.callVideoOn = !state.callVideoOn;
    state.callStream?.getVideoTracks().forEach(t => { t.enabled = state.callVideoOn; });
    const fallback = document.getElementById('cameraFallback');
    if (fallback) { if (state.callVideoOn) fallback.classList.add('hidden'); else { fallback.textContent = 'Camera is turned off'; fallback.classList.remove('hidden'); } }
    updateCallButtons(); sendMediaState(); return;
  }
  if (b.id === 'endCall') { endCallClicked(); return; }
  if (b.hasAttribute('data-close') || b.id === 'closeModal') { closeModal(); return; }
  if (b.id === 'logoutBtn' || b.id === 'mobileLogout') { logout(); }
});

document.addEventListener('input', e => {
  if (e.target.matches('[data-search]')) {
    const value = e.target.value; state.search = value; render();
    const input = document.querySelector('[data-search]'); if (input) { input.focus(); input.setSelectionRange(value.length, value.length); }
  }
});

document.addEventListener('focusout', () => {
  if (state.dirty) { state.dirty = false; setTimeout(renderIfIdle, 200); }
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-filter]')) { state.filter = e.target.value; render(); return; }
  if (e.target.matches('input[name=signupRole]')) {
    const doctorFields = document.getElementById('doctorSignupFields');
    const patientFields = document.getElementById('patientSignupFields');
    const isDoctor = e.target.value === 'doctor';
    doctorFields?.classList.toggle('hidden', !isDoctor);
    patientFields?.classList.toggle('hidden', isDoctor);
    const hint = document.getElementById('signupRoleHint');
    if (hint) hint.textContent = isDoctor ? 'Doctor accounts are added to the directory and can log in separately.' : 'Patient accounts can find doctors, book visits and use the AI assistant.';
    ['signupSpecialty', 'signupExperience', 'signupFee', 'signupAvailability', 'signupSlots'].forEach(id => { const el = document.getElementById(id); if (el) el.required = isDoctor; });
    return;
  }
  const form = e.target.closest && e.target.closest('#bookingForm');
  if (form && (e.target.matches('input[name=mode]') || e.target.matches('input[name=date]'))) {
    if (e.target.matches('input[name=date]')) refreshSlots(form);
    const mode = form.querySelector('input[name=mode]:checked')?.value;
    const preview = form.querySelector('#tokenPreview');
    if (preview) {
      preview.classList.toggle('hidden', mode !== 'offline');
      if (mode === 'offline') {
        const doctorId = form.querySelector('input[name=doctorId]').value;
        const date = form.querySelector('input[name=date]').value || todayISO();
        const appointmentId = form.querySelector('input[name=appointmentId]').value;
        preview.innerHTML = `🎟 <strong>Offline token:</strong> #${nextOfflineToken(db(), doctorId, date, appointmentId)}`;
      }
    }
  }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;

  if (f.id === 'loginForm') {
    const role = f.loginRole.value, email = f.loginEmail.value.trim().toLowerCase(), password = f.loginPassword.value;
    if (SERVER.on) {
      try {
        const res = await apiFetch('POST', '/api/login', { email, password, role });
        if (!res.ok) { showToast(res.error); return; }
        startSession(res);
      } catch (err) { showToast(err.network ? 'Cannot reach the CareConnect server. Check your connection.' : err.message); }
      return;
    }
    const d = normalizeData(db());
    const u = d.users.find(x => String(x.email).toLowerCase() === email && x.password === password && x.role === role);
    if (!u) { showToast('Incorrect role, email, or password.'); return; }
    if (role === 'doctor' && !getDoctor(d, u.doctorId)) { showToast('Doctor profile not found. Contact Admin.'); return; }
    writeSession({ id: u.id }); state = freshState(); SERVER.known = null; render(); notifyNew({ notifications: ownNotifs() });
    showToast(`Welcome back, ${u.name.split(' ')[0]}!`);
    return;
  }

  if (f.id === 'signupForm') {
    const role = f.signupRole.value;
    const payload = { role, name: f.signupName.value, email: f.signupEmail.value, phone: f.signupPhone.value, password: f.signupPassword.value };
    if (role === 'doctor') {
      Object.assign(payload, { specialty: f.signupSpecialty.value, experience: f.signupExperience.value, fee: f.signupFee.value, availability: f.signupAvailability.value, slots: f.signupSlots.value });
    } else {
      Object.assign(payload, { age: f.signupAge?.value, gender: f.signupGender?.value, bloodGroup: f.signupBloodGroup?.value, address: f.signupAddress?.value, emergencyContact: f.signupEmergency?.value });
    }
    const msg = role === 'doctor' ? 'Doctor account created. You are now visible to patients and can log in separately.' : 'Patient account created successfully!';
    if (SERVER.on) {
      try {
        const res = await apiFetch('POST', '/api/signup', payload);
        if (!res.ok) { showToast(res.error); return; }
        startSession(res, msg);
      } catch (err) { showToast(err.network ? 'Cannot reach the CareConnect server. Check your connection.' : err.message); }
      return;
    }
    const d = normalizeData(db());
    const r = CC.run('signup', d, null, payload, localCtx());
    if (!r.ok) { showToast(r.error); return; }
    save(normalizeData(d));
    writeSession({ id: r.user.id }); state = freshState(); SERVER.known = null; render(); notifyNew({ notifications: ownNotifs() });
    showToast(msg);
    return;
  }

  if (f.id === 'doctorForm') { saveDoctorForm(f); return; }
  if (f.id === 'patientForm') { savePatientForm(f); return; }

  if (f.id === 'bookingForm') {
    const x = Object.fromEntries(new FormData(f));
    if (!x.date) { showToast('Please choose a date.'); return; }
    if (!x.time) { showToast('Please choose an available time slot.'); return; }
    const btn = f.querySelector('.primary-btn');
    if (btn) btn.disabled = true;
    const payload = { doctorId: x.doctorId, date: x.date, time: x.time, mode: x.mode, reason: x.reason };
    const r = x.appointmentId ? await perform('reschedule', { id: x.appointmentId, ...payload }) : await perform('book', payload);
    if (btn) btn.disabled = false;
    if (!r.ok) return;
    closeModal(); state.page = 'appointments'; render();
    showToast(x.appointmentId ? 'Appointment updated. Doctor and patient have been notified.'
      : (x.mode === 'online' ? 'Online appointment confirmed. The doctor has been notified — join from this page at the booked time.' : 'Offline appointment confirmed with token number. The doctor has been notified.'));
    return;
  }

  if (f.id === 'chatForm') {
    const input = document.getElementById('chatInput'), message = input.value.trim();
    if (!message) return;
    state.chat.push({ who: 'user', html: esc(message) }); state.chat.push({ who: 'ai', html: aiReply(message) });
    input.value = ''; renderChat(); input.focus(); return;
  }

  if (f.id === 'callChatForm') {
    const input = document.getElementById('callChatInput'), message = input.value.trim();
    if (!message) return;
    input.value = ''; input.focus(); storeCallMessage(message); return;
  }
});

// ======================================================================
// Installable app (PWA)
// ======================================================================
let deferredInstallPrompt = null;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function isStandaloneDisplay() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function updateInstallButtons() {
  const show = !isStandaloneDisplay() && (!!deferredInstallPrompt || isIOS());
  document.querySelectorAll('[data-install]').forEach(el => el.classList.toggle('hidden', !show));
}
async function promptInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    try {
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') showToast('CareConnect is installing…');
    } catch (e) { /* dismissed */ }
    deferredInstallPrompt = null;
    updateInstallButtons();
  } else if (isIOS()) {
    openModal('<h2>Install CareConnect</h2><p>On iPhone / iPad: tap the <strong>Share</strong> button in Safari, then choose <strong>Add to Home Screen</strong>. CareConnect will then open full-screen like a normal app.</p><div class="modal-actions"><button type="button" class="primary-btn" data-close>Got it</button></div>');
  }
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstallPrompt = event; updateInstallButtons(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; updateInstallButtons(); showToast('CareConnect installed! Open it from your home screen or app list.'); });
document.addEventListener('click', e => { if (e.target.closest('[data-install]')) promptInstall(); });

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(() => {}); });
}

// ======================================================================
// Start-up
// ======================================================================
function startTimers() {
  setInterval(() => {
    if (!session()) return;
    if (!SERVER.on) {
      const d = normalizeData(db());
      if (CC.runReminders(d, nowMs(), clinicTZ())) save(d);
      notifyNew({ notifications: ownNotifs() });
    } else if (!SERVER.wsReady) { pull(); connectWS(); }
    renderIfIdle();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (SERVER.on) { pull(); connectWS(); } else if (session()) notifyNew({ notifications: ownNotifs() });
    renderIfIdle();
  });
  window.addEventListener('online', () => { SERVER.offline = false; if (SERVER.on) { pull(); connectWS(); } updateNetStatus(); });
  window.addEventListener('offline', updateNetStatus);
  window.addEventListener('storage', e => { if (!SERVER.on && e.key === KEY) renderIfIdle(); });
}

async function boot() {
  await detectServer();
  if (SERVER.on) {
    const s = readSession();
    if (s && s.token && s.id) {
      SERVER.token = s.token; SERVER.userId = s.id; SERVER.known = null;
      await pull(true);
      if (SERVER.token) connectWS();
    } else clearSession(); // also drops sessions left over from single-device demo mode
  } else {
    seedLocal();
    SERVER.known = new Set(ownNotifs().map(n => n.id));
  }
  setModeNote();
  render();
  startTimers();
  updateInstallButtons();
  updateNetStatus();
}
boot();
