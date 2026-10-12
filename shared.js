/* CareConnect shared logic.
 * One implementation of every booking / availability / notification rule,
 * used by the Node server (shared mode) AND by the browser (single-device
 * demo mode). Works as a browser global (window.CC) and a Node module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPEN_BEFORE_MIN = 10;   // video room opens 10 min before the slot
  const CLOSE_AFTER_MIN = 90;   // and stays open for 90 min after it starts
  const REMIND_BEFORE_MIN = 15;
  const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // ---------- time helpers (appointments are wall-clock times in the clinic timezone) ----------
  function tzOffsetMs(epoch, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    dtf.formatToParts(new Date(epoch)).forEach(x => { p[x.type] = x.value; });
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUTC - Math.floor(epoch / 1000) * 1000;
  }
  function zonedToEpoch(date, time, tz) {
    const [y, m, d] = String(date).split('-').map(Number);
    const [h, mi] = String(time).split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, h, mi);
    const t = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(t, tz);
  }
  function isoDateInTz(epoch, tz) {
    return new Date(epoch).toLocaleDateString('en-CA', { timeZone: tz });
  }
  function weekdayOf(date) { return new Date(`${date}T12:00:00Z`).getUTCDay(); }
  function isValidDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
  }
  function normTime(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  function normSlots(input) {
    const arr = Array.isArray(input) ? input : String(input || '').split(',');
    const out = [];
    for (const raw of arr) {
      const t = normTime(raw);
      if (t && !out.includes(t)) out.push(t);
    }
    return out.sort();
  }
  function parseDays(str) {
    const set = new Set();
    for (const rawTok of String(str || '').split(',')) {
      const tok = rawTok.trim().toLowerCase();
      if (!tok) continue;
      if (/^(daily|everyday|all|all days)$/.test(tok)) { for (let i = 0; i < 7; i++) set.add(i); continue; }
      if (tok.includes('-')) {
        const [a, b] = tok.split('-').map(s => DAY_NAMES.indexOf(s.trim().slice(0, 3)));
        if (a >= 0 && b >= 0) { for (let i = a; ; i = (i + 1) % 7) { set.add(i); if (i === b) break; } }
        continue;
      }
      const i = DAY_NAMES.indexOf(tok.slice(0, 3));
      if (i >= 0) set.add(i);
    }
    return set;
  }
  function dayAllowed(availability, date) { return parseDays(availability).has(weekdayOf(date)); }

  function uid(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  function formatDate(date) {
    return new Date(`${date}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ---------- data normalisation ----------
  function normalize(db) {
    db.users = Array.isArray(db.users) ? db.users : [];
    db.doctors = Array.isArray(db.doctors) ? db.doctors : [];
    db.appointments = Array.isArray(db.appointments) ? db.appointments : [];
    db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
    for (const d of db.doctors) {
      d.available = d.available !== false;
      d.availability = d.availability || 'Mon, Wed, Fri';
      const slots = normSlots(d.slots);
      d.slots = slots.length ? slots : ['09:00', '11:00', '16:00'];
      d.fee = Number(d.fee || 500);
      d.specialty = d.specialty || 'General Physician';
      d.experience = d.experience || 'Experienced practitioner';
      if (!d.updatedAt) d.updatedAt = new Date().toISOString();
    }
    for (const a of db.appointments) {
      a.mode = a.mode === 'online' ? 'online' : 'offline';
      a.chat = Array.isArray(a.chat) ? a.chat : [];
    }
    for (const a of db.appointments) {
      if (a.mode === 'offline' && !a.tokenNumber) a.tokenNumber = nextToken(db, a.doctorId, a.date, a.id);
    }
    return db;
  }

  // Ratings are always derived from the appointments (never stored on the doctor),
  // so a rating and a schedule edit can never overwrite each other.
  function applyRatings(doctors, appointments) {
    const stats = {};
    for (const a of appointments) {
      const s = Number(a.rating && a.rating.stars);
      if (!Number.isFinite(s) || s < 1 || s > 5) continue;
      const e = stats[a.doctorId] || (stats[a.doctorId] = { count: 0, sum: 0 });
      e.count++; e.sum += s;
    }
    for (const d of doctors) {
      const e = stats[d.id];
      d.ratingCount = e ? e.count : 0;
      d.ratingSum = e ? e.sum : 0;
    }
  }

  function nextToken(db, doctorId, date, ignoreId) {
    const all = [...(db.appointments || [])];
    const seen = new Set(all.map(a => a.id));
    for (const t of (db.slotsTaken || [])) if (!seen.has(t.id)) all.push(t);
    const used = all
      .filter(a => a.doctorId === doctorId && a.date === date && a.mode === 'offline' && a.status !== 'Cancelled' && a.id !== ignoreId)
      .map(a => Number(a.tokenNumber) || 0).filter(Boolean);
    return used.length ? Math.max(...used) + 1 : 1;
  }

  // ---------- notifications ----------
  function addNotification(db, userId, n) {
    if (!userId) return false;
    db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
    const key = n.key || uid('k');
    if (db.notifications.some(x => x.userId === userId && x.key === key)) return false;
    db.notifications.push({
      id: uid('n'), userId, title: n.title, message: n.message, type: n.type || 'info',
      key, appointmentId: n.appointmentId || null, read: false, createdAt: new Date().toISOString()
    });
    return true;
  }
  function doctorUserId(db, doctorId) {
    const u = db.users.find(x => x.role === 'doctor' && x.doctorId === doctorId);
    return u ? u.id : null;
  }
  function modeLabel(a) { return a.mode === 'online' ? 'online video consultation' : `offline visit (token #${a.tokenNumber || '-'})`; }

  // ---------- join window for video calls ----------
  function joinWindow(a, nowMs, tz) {
    const start = zonedToEpoch(a.date, a.time, tz);
    const opens = start - OPEN_BEFORE_MIN * 60000;
    const closes = start + CLOSE_AFTER_MIN * 60000;
    const state = nowMs < opens ? 'early' : nowMs > closes ? 'late' : 'open';
    return { state, start, opens, closes };
  }

  // Reminder notifications (15 min before, and when the room opens).
  function runReminders(db, nowMs, tz) {
    let created = 0;
    for (const a of db.appointments) {
      if (a.status !== 'Confirmed' || !isValidDate(a.date) || !normTime(a.time)) continue;
      const start = zonedToEpoch(a.date, a.time, tz);
      const doc = db.doctors.find(d => d.id === a.doctorId);
      const dUser = doctorUserId(db, a.doctorId);
      const soon = nowMs >= start - REMIND_BEFORE_MIN * 60000 && nowMs <= start + CLOSE_AFTER_MIN * 60000;
      if (!soon) continue;
      const live = nowMs >= start - OPEN_BEFORE_MIN * 60000;
      const when = `${formatDate(a.date)} at ${a.time}`;
      const kind = a.mode === 'online' ? (live ? 'Join the video room now.' : 'The video room opens 10 minutes before.') : `Please arrive for token #${a.tokenNumber || '-'}.`;
      const stage = live ? 'now' : 'soon';
      if (addNotification(db, a.patientId, {
        key: `remind:${a.id}:${stage}:p`, appointmentId: a.id, type: 'info',
        title: live ? 'Your appointment is starting' : 'Appointment starting soon',
        message: `Dr. ${doc ? doc.name : ''} · ${when}. ${kind}`
      })) created++;
      if (addNotification(db, dUser, {
        key: `remind:${a.id}:${stage}:d`, appointmentId: a.id, type: 'info',
        title: live ? 'Patient appointment is starting' : 'Appointment starting soon',
        message: `${a.patientName} · ${when} (${a.mode}). ${a.mode === 'online' && live ? 'Join the video room now.' : ''}`.trim()
      })) created++;
    }
    return created;
  }

  // ---------- validation ----------
  function validateSlot(db, doctor, date, time, ignoreId, ctx) {
    if (!doctor) return 'Doctor not found.';
    if (doctor.available === false) return 'This doctor is currently unavailable. Please choose another doctor.';
    if (!isValidDate(date)) return 'Please choose a valid date.';
    time = normTime(time);
    if (!time) return 'Please choose a valid time slot.';
    if (!doctor.slots.includes(time)) return 'That time is not one of the doctor\'s slots.';
    if (!dayAllowed(doctor.availability, date)) return `This doctor is available on ${doctor.availability}.`;
    if (zonedToEpoch(date, time, ctx.tz) <= ctx.nowMs) return 'That time has already passed. Please choose a later slot.';
    const taken = [...db.appointments, ...(db.slotsTaken || [])].some(a =>
      a.doctorId === doctor.id && a.date === date && a.time === time && a.status === 'Confirmed' && a.id !== ignoreId);
    if (taken) return 'That slot is already booked. Please choose another time.';
    return null;
  }

  const fail = error => ({ ok: false, error });
  const ok = extra => Object.assign({ ok: true }, extra || {});
  const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

  // ---------- doctor changes (shared by admin edit, doctor self-edit, toggle) ----------
  function applyDoctorChange(db, doctor, next, ctx) {
    const before = { available: doctor.available !== false, availability: doctor.availability, slots: [...doctor.slots] };
    Object.assign(doctor, next);
    doctor.updatedAt = new Date().toISOString();
    const stamp = doctor.updatedAt;
    const dUser = doctorUserId(db, doctor.id);
    const future = db.appointments.filter(a => a.doctorId === doctor.id && a.status === 'Confirmed' &&
      zonedToEpoch(a.date, a.time, ctx.tz) > ctx.nowMs - CLOSE_AFTER_MIN * 60000);
    const nowAvailable = doctor.available !== false;
    if (before.available && !nowAvailable) {
      for (const a of future) addNotification(db, a.patientId, {
        key: `unavail:${a.id}:${stamp}`, appointmentId: a.id, type: 'warning',
        title: `Dr. ${doctor.name} is unavailable`,
        message: `Your ${modeLabel(a)} on ${formatDate(a.date)} at ${a.time} is affected because the doctor is currently unavailable. Please reschedule or choose another doctor.`
      });
    } else if (!before.available && nowAvailable) {
      for (const a of future) addNotification(db, a.patientId, {
        key: `avail:${a.id}:${stamp}`, appointmentId: a.id, type: 'success',
        title: `Dr. ${doctor.name} is available again`,
        message: `Your ${modeLabel(a)} on ${formatDate(a.date)} at ${a.time} can go ahead as planned.`
      });
    }
    const schedChanged = before.availability !== doctor.availability || before.slots.join() !== doctor.slots.join();
    if (schedChanged) {
      for (const a of future) {
        if (dayAllowed(doctor.availability, a.date) && doctor.slots.includes(a.time)) continue;
        addNotification(db, a.patientId, {
          key: `sched:${a.id}:${stamp}`, appointmentId: a.id, type: 'warning',
          title: `Dr. ${doctor.name} changed their schedule`,
          message: `Your ${modeLabel(a)} on ${formatDate(a.date)} at ${a.time} no longer matches the doctor's available days (${doctor.availability}) or slots (${doctor.slots.join(', ')}). Please reschedule.`
        });
        addNotification(db, dUser, {
          key: `sched-d:${a.id}:${stamp}`, appointmentId: a.id, type: 'warning',
          title: 'Booked appointment outside new schedule',
          message: `${a.patientName} is booked on ${formatDate(a.date)} at ${a.time}, which is outside the updated schedule. The patient has been asked to reschedule.`
        });
      }
    }
  }

  // ---------- actions ----------
  const actions = {};

  actions.book = function (db, actor, p, ctx) {
    if (!actor || actor.role !== 'patient') return fail('Only patients can book appointments.');
    const doctor = db.doctors.find(d => d.id === p.doctorId);
    const mode = p.mode === 'online' ? 'online' : 'offline';
    const reason = clean(p.reason, 300);
    if (!reason) return fail('Please enter the reason for the visit.');
    const time = normTime(p.time);
    const err = validateSlot(db, doctor, p.date, time, '', ctx);
    if (err) return fail(err);
    const a = {
      id: p.id && /^[\w-]{3,80}$/.test(p.id) && !db.appointments.some(x => x.id === p.id) ? p.id : uid('a'),
      doctorId: doctor.id, date: p.date, time, reason, patientId: actor.id, patientName: actor.name,
      status: 'Confirmed', mode, tokenNumber: mode === 'offline' ? nextToken(db, doctor.id, p.date, '') : null,
      chat: [], createdAt: new Date().toISOString()
    };
    db.appointments.push(a);
    const when = `${formatDate(a.date)} at ${a.time}`;
    addNotification(db, actor.id, {
      key: `booked:${a.id}:p`, appointmentId: a.id, type: 'success',
      title: 'Appointment booked',
      message: `Your ${modeLabel(a)} with Dr. ${doctor.name} is confirmed for ${when}.${a.mode === 'online' ? ' Join the video room from My appointments at the scheduled time.' : ''}`
    });
    addNotification(db, doctorUserId(db, doctor.id), {
      key: `booked:${a.id}:d`, appointmentId: a.id, type: 'success',
      title: 'New appointment booked',
      message: `${a.patientName} booked a ${modeLabel(a)} on ${when}. Reason: ${a.reason}.${a.mode === 'online' ? ' Join the video room from Appointments at that time.' : ''}`
    });
    return ok({ appointment: a });
  };

  actions.reschedule = function (db, actor, p, ctx) {
    const a = db.appointments.find(x => x.id === p.id);
    if (!a) return fail('Appointment not found.');
    if (!actor || !(actor.role === 'admin' || (actor.role === 'patient' && a.patientId === actor.id))) return fail('You cannot change this appointment.');
    if (a.status !== 'Confirmed') return fail('Only confirmed appointments can be rescheduled.');
    const doctor = db.doctors.find(d => d.id === a.doctorId);
    const time = normTime(p.time);
    const err = validateSlot(db, doctor, p.date, time, a.id, ctx);
    if (err) return fail(err);
    const reason = clean(p.reason, 300);
    if (!reason) return fail('Please enter the reason for the visit.');
    const mode = p.mode === 'online' ? 'online' : 'offline';
    const sameOffline = mode === 'offline' && a.mode === 'offline' && a.date === p.date;
    a.mode = mode; a.date = p.date; a.time = time; a.reason = reason;
    a.tokenNumber = mode === 'offline' ? (sameOffline && a.tokenNumber ? a.tokenNumber : nextToken(db, a.doctorId, a.date, a.id)) : null;
    const when = `${formatDate(a.date)} at ${a.time}`;
    const stamp = `${a.date}${a.time}${a.mode}`;
    addNotification(db, a.patientId, {
      key: `resched:${a.id}:${stamp}:p`, appointmentId: a.id, type: 'info', title: 'Appointment rescheduled',
      message: `Your ${modeLabel(a)} with Dr. ${doctor.name} is now ${when}.`
    });
    addNotification(db, doctorUserId(db, a.doctorId), {
      key: `resched:${a.id}:${stamp}:d`, appointmentId: a.id, type: 'info', title: 'Appointment rescheduled',
      message: `${a.patientName} moved their ${modeLabel(a)} to ${when}.`
    });
    return ok({ appointment: a });
  };

  function canActOn(actor, a, db) {
    if (!actor) return false;
    if (actor.role === 'admin') return true;
    if (actor.role === 'patient') return a.patientId === actor.id;
    if (actor.role === 'doctor') return a.doctorId === actor.doctorId;
    return false;
  }

  actions.cancel = function (db, actor, p) {
    const a = db.appointments.find(x => x.id === p.id);
    if (!a) return fail('Appointment not found.');
    if (!canActOn(actor, a, db)) return fail('You cannot cancel this appointment.');
    if (a.status !== 'Confirmed') return fail('This appointment is already closed.');
    a.status = 'Cancelled';
    const doc = db.doctors.find(d => d.id === a.doctorId);
    const who = actor.role === 'patient' ? 'the patient' : actor.role === 'doctor' ? 'the doctor' : 'the administrator';
    const when = `${formatDate(a.date)} at ${a.time}`;
    addNotification(db, a.patientId, {
      key: `cancel:${a.id}:p`, appointmentId: a.id, type: 'warning', title: 'Appointment cancelled',
      message: `Your ${modeLabel(a)} with Dr. ${doc ? doc.name : ''} on ${when} was cancelled by ${who}.`
    });
    addNotification(db, doctorUserId(db, a.doctorId), {
      key: `cancel:${a.id}:d`, appointmentId: a.id, type: 'warning', title: 'Appointment cancelled',
      message: `${a.patientName}'s ${modeLabel(a)} on ${when} was cancelled by ${who}.`
    });
    return ok({ appointment: a });
  };

  actions.complete = function (db, actor, p) {
    const a = db.appointments.find(x => x.id === p.id);
    if (!a) return fail('Appointment not found.');
    if (!canActOn(actor, a, db)) return fail('You cannot update this appointment.');
    if (actor.role === 'patient' && a.mode !== 'online') return fail('Only your doctor can complete an offline visit.');
    if (a.status === 'Completed') return ok({ appointment: a });
    if (a.status !== 'Confirmed') return fail('This appointment is already closed.');
    a.status = 'Completed';
    const doc = db.doctors.find(d => d.id === a.doctorId);
    addNotification(db, a.patientId, {
      key: `done:${a.id}:p`, appointmentId: a.id, type: 'success', title: 'Visit completed',
      message: `Your visit with Dr. ${doc ? doc.name : ''} is complete. You can rate your doctor from Appointment history.`
    });
    return ok({ appointment: a });
  };

  actions.rate = function (db, actor, p) {
    const a = db.appointments.find(x => x.id === p.id);
    if (!a) return fail('Appointment not found.');
    if (!actor || actor.role !== 'patient' || a.patientId !== actor.id) return fail('Only the patient can rate this visit.');
    if (a.status !== 'Completed') return fail('You can rate a doctor after the appointment is completed.');
    const stars = Math.round(Number(p.stars));
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) return fail('Please choose a star rating from 1 to 5.');
    const existed = !!a.rating;
    a.rating = { stars, comment: clean(p.comment, 500), ratedAt: new Date().toISOString() };
    return ok({ appointment: a, updated: existed });
  };

  actions.saveDoctor = function (db, actor, p, ctx) {
    if (!actor || (actor.role !== 'admin' && actor.role !== 'doctor')) return fail('Not allowed.');
    const id = clean(p.id, 80);
    const self = actor.role === 'doctor';
    let doctor = id ? db.doctors.find(d => d.id === id) : null;
    if (id && !doctor) return fail('Doctor record not found.');
    if (self && (!doctor || doctor.id !== actor.doctorId)) return fail('You can only edit your own profile.');

    const slots = normSlots(p.slots);
    const availability = clean(p.availability, 100);
    const fee = Number(p.fee);
    if (!availability || !parseDays(availability).size) return fail('Enter available days like "Mon, Wed, Fri".');
    if (!slots.length) return fail('Enter time slots like "09:00, 11:00, 16:00".');
    if (!Number.isFinite(fee) || fee < 0) return fail('Enter a valid consultation fee.');
    const available = p.available !== false && p.available !== 'false' && p.available !== 0;

    if (self) {
      applyDoctorChange(db, doctor, { fee, availability, slots, available }, ctx);
      return ok({ doctor });
    }

    const name = clean(p.name, 80), specialty = clean(p.specialty, 80), experience = clean(p.experience, 80);
    if (!name || !specialty || !experience) return fail('Please fill all required doctor details.');
    const loginEmail = clean(p.loginEmail, 120).toLowerCase();
    const loginPassword = String(p.loginPassword || '');
    let dUser = doctor ? db.users.find(u => u.role === 'doctor' && u.doctorId === doctor.id) : null;
    if (!loginEmail && !dUser) return fail('Doctor login email is required.');
    if (loginEmail && !/^\S+@\S+\.\S+$/.test(loginEmail)) return fail('Enter a valid login email.');
    if (loginEmail && db.users.some(u => (!dUser || u.id !== dUser.id) && String(u.email).toLowerCase() === loginEmail)) return fail('That login email is already in use.');
    if (!dUser && loginPassword.length < 4) return fail('Doctor login password is required (min 4 characters).');
    if (loginPassword && loginPassword.length < 4) return fail('Password must be at least 4 characters.');

    if (!doctor) {
      doctor = { id: uid('d'), name, specialty, experience, fee, availability, slots, available, updatedAt: new Date().toISOString() };
      db.doctors.push(doctor);
    } else {
      applyDoctorChange(db, doctor, { name, specialty, experience, fee, availability, slots, available }, ctx);
    }
    if (!dUser) {
      dUser = { id: uid('doctor-user'), name, email: loginEmail, phone: '0000000000', role: 'doctor', doctorId: doctor.id };
      db.users.push(dUser);
    }
    dUser.name = name;
    if (loginEmail) dUser.email = loginEmail;
    if (loginPassword) ctx.setPassword(dUser, loginPassword);
    return ok({ doctor });
  };

  actions.toggleDoctor = function (db, actor, p, ctx) {
    if (!actor || (actor.role !== 'admin' && actor.role !== 'doctor')) return fail('Not allowed.');
    const doctor = db.doctors.find(d => d.id === p.id);
    if (!doctor) return fail('Doctor record not found.');
    if (actor.role === 'doctor' && actor.doctorId !== doctor.id) return fail('You can only change your own status.');
    applyDoctorChange(db, doctor, { available: doctor.available === false }, ctx);
    return ok({ doctor });
  };

  actions.deleteDoctor = function (db, actor, p) {
    if (!actor || actor.role !== 'admin') return fail('Only Admin can remove doctors.');
    const doctor = db.doctors.find(d => d.id === p.id);
    if (!doctor) return fail('Doctor record not found.');
    if (db.appointments.some(a => a.doctorId === doctor.id && a.status === 'Confirmed')) return fail('Cannot remove a doctor with active appointments.');
    db.doctors = db.doctors.filter(d => d.id !== doctor.id);
    db.users = db.users.filter(u => !(u.role === 'doctor' && u.doctorId === doctor.id));
    return ok({});
  };

  const PATIENT_FIELDS = ['name', 'email', 'phone', 'age', 'gender', 'bloodGroup', 'address', 'emergencyContact'];
  actions.savePatient = function (db, actor, p) {
    const user = db.users.find(u => u.id === p.id && u.role === 'patient');
    if (!user) return fail('Patient record not found.');
    if (!actor || !(actor.role === 'admin' || actor.id === user.id)) return fail('Not allowed.');
    const name = clean(p.name, 80), email = clean(p.email, 120).toLowerCase(), phone = clean(p.phone, 30);
    if (!name || !email || !phone) return fail('Name, email, and phone are required.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email.');
    if (db.users.some(q => q.id !== user.id && String(q.email).toLowerCase() === email)) return fail('That email is already in use.');
    const snap = { changedAt: new Date().toISOString() };
    PATIENT_FIELDS.forEach(f => { snap[f] = user[f] || ''; });
    user.profileHistory = Array.isArray(user.profileHistory) ? user.profileHistory : [];
    user.profileHistory.push(snap);
    Object.assign(user, {
      name, email, phone, age: clean(p.age, 3), gender: clean(p.gender, 20), bloodGroup: clean(p.bloodGroup, 10),
      address: clean(p.address, 200), emergencyContact: clean(p.emergencyContact, 30)
    });
    db.appointments.filter(a => a.patientId === user.id).forEach(a => { a.patientName = user.name; });
    return ok({ user });
  };

  actions.markRead = function (db, actor) {
    if (!actor) return fail('Not signed in.');
    db.notifications.filter(n => n.userId === actor.id).forEach(n => { n.read = true; });
    return ok({});
  };

  actions.chat = function (db, actor, p) {
    const a = db.appointments.find(x => x.id === p.appointmentId);
    if (!a) return fail('Appointment not found.');
    const isParticipant = actor && ((actor.role === 'patient' && a.patientId === actor.id) || (actor.role === 'doctor' && a.doctorId === actor.doctorId));
    if (!isParticipant) return fail('Not allowed.');
    const text = clean(p.text, 1000);
    if (!text) return fail('Empty message.');
    a.chat = Array.isArray(a.chat) ? a.chat : [];
    const m = { id: p.id && /^[\w-]{3,80}$/.test(p.id) ? p.id : uid('m'), text, senderId: actor.id, senderName: actor.name, senderRole: actor.role, createdAt: new Date().toISOString() };
    if (!a.chat.some(x => x.id === m.id)) a.chat.push(m);
    return ok({ message: m });
  };

  // Account creation (patients & doctors). ctx.setPassword stores the password
  // (hashed on the server, plain text in single-device demo mode).
  actions.signup = function (db, _actor, p, ctx) {
    const role = p.role === 'doctor' ? 'doctor' : p.role === 'patient' ? 'patient' : null;
    if (!role) return fail('Choose Patient or Doctor.');
    const name = clean(p.name, 80), email = clean(p.email, 120).toLowerCase(), phone = clean(p.phone, 30);
    const password = String(p.password || '');
    if (!name || !email || !phone) return fail('Name, email and phone are required.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
    if (password.length < 6) return fail('Password must be at least 6 characters.');
    if (db.users.some(u => String(u.email).toLowerCase() === email)) return fail('An account already exists with this email.');
    let user;
    if (role === 'doctor') {
      const slots = normSlots(p.slots || '09:00, 11:00, 16:00');
      const availability = clean(p.availability, 100) || 'Mon, Wed, Fri';
      if (!parseDays(availability).size) return fail('Enter available days like "Mon, Wed, Fri".');
      const doctor = {
        id: uid('d'), name, specialty: clean(p.specialty, 80) || 'General Physician',
        experience: clean(p.experience, 80) || 'New practitioner', fee: Math.max(0, Number(p.fee) || 500),
        availability, slots: slots.length ? slots : ['09:00', '11:00', '16:00'], available: true, updatedAt: new Date().toISOString()
      };
      db.doctors.push(doctor);
      user = { id: uid('doctor-user'), name, email, phone, role: 'doctor', doctorId: doctor.id };
    } else {
      user = {
        id: uid('p'), name, email, phone, role: 'patient', age: clean(p.age, 3), gender: clean(p.gender, 20),
        bloodGroup: clean(p.bloodGroup, 10), address: clean(p.address, 200), emergencyContact: clean(p.emergencyContact, 30), profileHistory: []
      };
    }
    ctx.setPassword(user, password);
    db.users.push(user);
    return ok({ user });
  };

  function run(type, db, actor, payload, ctx) {
    const fn = actions[type];
    if (!fn) return fail('Unknown action.');
    try { return fn(db, actor, payload || {}, ctx); }
    catch (e) { return fail(`Unexpected error: ${e.message}`); }
  }

  // ---------- seed data ----------
  function seed(db, ctx, adminCreds) {
    normalize(db);
    if (!db.users.some(u => u.role === 'admin')) {
      const admin = { id: 'admin-1', name: 'CareConnect Admin', email: adminCreds.email, phone: '0000000000', role: 'admin' };
      ctx.setPassword(admin, adminCreds.password);
      db.users.unshift(admin);
    }
    if (!db.doctors.length) {
      const now = new Date().toISOString();
      const docs = [
        { id: 'd1', name: 'Ramesh Kumar', specialty: 'General Physician', experience: '10 years', fee: 500, availability: 'Mon, Wed, Fri', slots: ['09:00', '10:00', '11:00', '16:00'], email: 'ramesh@gmail.com', pw: '2007' },
        { id: 'd2', name: 'Rahul Mehta', specialty: 'Dermatologist', experience: '8 years', fee: 500, availability: 'Tue, Thu, Sat', slots: ['10:00', '11:30', '14:00', '17:00'], email: 'rahul.mehta@careconnect.demo', pw: 'Doctor@1001' },
        { id: 'd3', name: 'Priya Nair', specialty: 'Pediatrician', experience: '10 years', fee: 600, availability: 'Mon, Tue, Thu', slots: ['09:30', '11:00', '15:00', '17:30'], email: 'priya.nair@careconnect.demo', pw: 'Doctor@1002' },
        { id: 'd4', name: 'Vikram Singh', specialty: 'Orthopedic', experience: '15 years', fee: 800, availability: 'Wed, Fri, Sat', slots: ['09:00', '12:00', '15:30', '18:00'], email: 'vikram.singh@careconnect.demo', pw: 'Doctor@1003' }
      ];
      for (const d of docs) {
        db.doctors.push({ id: d.id, name: d.name, specialty: d.specialty, experience: d.experience, fee: d.fee, availability: d.availability, slots: d.slots, available: true, updatedAt: now });
        const u = { id: `doctor-user-${d.id}`, name: d.name, email: d.email, phone: '0000000000', role: 'doctor', doctorId: d.id };
        ctx.setPassword(u, d.pw);
        db.users.push(u);
      }
    }
    return db;
  }

  return {
    OPEN_BEFORE_MIN, CLOSE_AFTER_MIN, REMIND_BEFORE_MIN,
    zonedToEpoch, isoDateInTz, weekdayOf, normTime, normSlots, parseDays, dayAllowed, isValidDate,
    uid, formatDate, normalize, applyRatings, nextToken, addNotification, doctorUserId,
    joinWindow, runReminders, validateSlot, actions, run, seed
  };
});
