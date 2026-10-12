# CareConnect — Healthcare Appointment System

CareConnect is a responsive browser-based healthcare appointment system built for a BTech project review using only **HTML, CSS and JavaScript**.

## Main features

### Patient module
- Patient signup and login using Local Storage.
- Search/filter doctors and see the same doctor directory that Admin and Doctors use.
- Book appointments as either:
  - **Online video consultation** — opens a browser video room with camera/microphone controls and appointment chat.
  - **Offline clinic visit** — assigns a token number for the selected doctor and date.
- Reschedule and cancel confirmed appointments.
- View appointment history and tokens.
- Rate a doctor after a completed appointment (1–5 stars, optional comment); ending an online video call automatically marks the appointment complete and opens the rating dialog.
- Receive notifications when a booked doctor is marked unavailable.
- Use the **CareConnect AI Assistant** for general medicine/tablet information, symptom guidance, doctor discovery, appointment help, online/offline visit help, and call-control guidance.

### Doctor module
- Every doctor has a separate Doctor login linked to one doctor profile.
- Doctor dashboard with appointments and patient details.
- View offline token numbers.
- Join online consultations with camera, microphone and chat controls.
- Mark appointments complete/cancelled.
- Update public availability, working days and time slots.
- Mark self unavailable; affected booked patients receive notifications.
- New doctors created during signup are automatically added to the patient-visible directory and get their own login.

### Admin module
- Separate Admin login and dashboard.
- Add new doctors with login email/password; saving creates both the doctor directory profile and the matching Doctor login.
- Edit doctor details, schedule, availability and login credentials at any time.
- Remove doctors (blocked when they still have active confirmed appointments).
- View all appointments with online/offline mode and offline token details.
- Edit patient profile data at any time, including name, email, phone, age, gender, blood group, address and emergency contact.
- Every patient edit saves a **previous-data snapshot** so Admin can review earlier versions.
- Receive system notifications and use the AI assistant.

## AI Assistant

The assistant is intentionally designed like a natural, AI-style help panel rather than a single fixed FAQ response, and it **answers differently depending on who's signed in**:

- **Patient:** booking-oriented — how to book, reschedule, rate a doctor, understand tokens and online visits, and general medicine/symptom guidance with a live, rating-sorted doctor directory (with a **Book** button).
- **Doctor:** practice-oriented — how tokens and availability work from their side, their own current rating quoted back to them, and the same live doctor directory shown without booking buttons.
- **Admin:** management-oriented — how to add/edit/remove doctors, edit patient records, and how ratings and tokens work across the whole system.

Examples (answers differ by role):
- `What is paracetamol tablet used for?`
- `What is metformin?`
- `What is cetirizine?`
- `What is omeprazole?`
- `Which doctors are available?` — always reflects the current directory, including doctors added moments ago
- `How does an offline token work?`
- `How does the online video call work?`
- `How do ratings work?`
- `How do I add a doctor?` (Admin)

The project includes an embedded medicine guide for many commonly asked medicines. Unknown medicine names are not guessed; the assistant asks for the exact name. It provides general information only and does not prescribe or give personalized doses.

## Online consultation

For an **Online video** appointment, the patient or doctor can open the video room from the appointment card.

The video room supports:
- Local camera preview through the browser permission API.
- Microphone ON/OFF.
- Camera ON/OFF.
- Appointment chat stored with the appointment in Local Storage.
- End-call control. When a patient ends the call, the appointment is marked **Completed** and the **Rate this doctor** dialog opens right away so feedback can be captured while the visit is fresh.

## Doctor ratings

Patients rate a doctor (1–5 stars, optional comment) from a completed appointment's **⭐ Rate this doctor** button, or automatically right after ending an online video call. A rating can be edited later without double-counting toward the doctor's average.

Doctor suggestions to patients are driven **only by rating**: the "Find a doctor" list is always sorted by average rating (highest first, unrated doctors last), and the single best-rated doctor is marked **🏆 Top rated**. Admin's Manage Doctors view also shows each doctor's rating for reference.

## Offline tokens and doctor availability

When an offline appointment is booked, CareConnect assigns the next token number for that **doctor + date**. The token is shown to the patient, doctor and Admin.

When a doctor is set to unavailable:
- New patient booking is disabled.
- Existing confirmed appointments remain visible.
- A notification is created for each affected patient explaining that the doctor is unavailable and the appointment may need rescheduling.

## Admin control over doctor and patient data

Admin can update doctor or patient details whenever needed:
- **Manage Doctors → Edit** updates the doctor directory profile and the linked Doctor login together, so patients and the doctor's own login always show the same data.
- **Patients → Edit & history** updates the patient profile and any appointment display names, and keeps a previous-version snapshot so earlier data is never lost.

## Demo accounts

### Admin
- Email: `syed@gmail.com`
- Password: `Syed@7866`

### Doctor
- Email: `ramesh@gmail.com`
- Password: `2007`

Additional doctors already seeded in the demo also have separate logins. New doctors can create their own account from **Create an account → Doctor** or be added by Admin.

## How to run

1. Keep these files in the same folder:
   - `index.html`
   - `style.css`
   - `manifest.webmanifest`
   - `app.js`
   - `sw.js`
   - `icon-64.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`
2. Serve the folder over `http://localhost` or `https://` (installing as an app and the service worker both require a secure context — opening the file directly with `file://` will run the app fine but will skip installability). A quick way: `npx serve .` or any static file server.
3. Create a Patient or Doctor account, or use the demo credentials above.
4. Test the Patient, Doctor and Admin flows.
5. For camera/microphone testing, allow browser permissions when the video room opens.
6. Look for the **Install CareConnect app** / **Install app** button (sign-in screen or sidebar) to add it to your home screen or desktop like a native app.

## Suggested review/demo flow

1. Explain the problem statement and role-based login.
2. Create a Patient account and show the AI Assistant answering a medicine question.
3. Open Find a Doctor and show the shared doctor directory, sorted by rating.
4. Book one **Offline** appointment and demonstrate the token number.
5. Book one **Online** appointment, open the video room, toggle mic/camera, send a chat message, then end the call and show the rating dialog opening automatically.
6. Log in as Doctor and show the same doctor/appointments data, including the new rating.
7. Mark the doctor unavailable and log back in as the Patient to show the notification.
8. Log in as Admin, edit a doctor's details and a patient's details, save each, and open the patient's previous-data history.
9. Add a new doctor, save, then verify the new doctor is visible to patients and can log in with the created credentials.

## Technology compliance

- HTML5
- CSS3
- Vanilla JavaScript
- CSS Grid and Flexbox
- Browser Local Storage
- No framework, backend, database, API, Node.js or React is required

## Requirement checklist

| Requirement | Implementation |
|---|---|
| 1. Understand problem | Healthcare appointment workflow documented in this README |
| 2. Minimum two modules | Patient, Doctor and Admin modules |
| 3. HTML/CSS/JS only | Static browser application |
| 4. Grid/Flexbox | Responsive layouts and cards use CSS Grid/Flexbox |
| 5. Signup/Login + Local Storage | Role-based login and signup stored in browser Local Storage |
| 6. JavaScript navigation | Role-specific navigation and rendered dashboards |
| 7. Working functionality | Booking, rescheduling, cancellation, tokens, notifications, AI, ratings, doctor management, patient history and video-room demo |
| 8. GitHub | Ready to push as a static project repository |
| 9. Demonstration | Suggested review flow included above |

## v11 changes — role-aware AI Assistant & installable app
- **Role-aware AI Assistant:** Patient, Doctor and Admin now get different quick-prompt chips, a different greeting, and different answers to the same question (e.g. asking about tokens, availability, "which doctors", ratings, or booking gives a patient-facing, doctor-facing, or admin-facing answer). Doctors also get their own live rating quoted back to them.
- **Live doctor directory in the assistant:** "Which doctors are available?" (and the symptom-based doctor suggestions) now always reads the current doctor list from Local Storage, sorted by rating, so a doctor added seconds ago by Admin or via doctor signup shows up immediately — no stale/hardcoded list.
- **Ratings shown inside the assistant's doctor cards**, not just on the Find a Doctor page.
- **Installable app:** added a full PWA icon set, an enhanced `manifest.webmanifest`, and a real service worker (`sw.js`) for app-shell caching, so CareConnect meets browser install criteria. A branded **Install CareConnect app** button appears on the sign-in screen and an **Install app** button appears in the sidebar once signed in — both call the native install prompt directly, so patients/doctors/admin can add CareConnect to their home screen or desktop like a professional app.
- `index.html` now loads `app.js?v=11`.

## v10 changes
- Removed the on-screen note about video calls being a browser-only preview.
- Ending an online video call as a patient now automatically marks the appointment **Completed** and opens the **Rate this doctor** dialog.
- `index.html` now loads `app.js?v=10` to force browsers to drop any stale cached copy of the previous script.

## Save reliability note
The Doctor and Patient edit dialogs use explicit Save buttons handled directly by JavaScript and Local Storage. Doctor Save updates the doctor directory and linked Doctor login together; Patient Save updates the patient record, linked appointment names, and stores a previous-version snapshot. The app migrates older CareConnect Local Storage data from previous builds. Invalid old JSON/session data is ignored and safely rebuilt instead of crashing the app.

### Demo test checklist
1. Login as Admin: `syed@gmail.com` / `Syed@7866`.
2. Open **Manage doctors → Edit** a doctor, change the fee/availability, press **Save doctor**, then reopen the same doctor to confirm the saved values.
3. Open **Patients → Edit & history**, change a value, press **Save patient changes**, then reopen to confirm the current value and previous version are both shown.
4. Add a new doctor and save. The doctor appears in the patient directory and receives a separate Doctor login.
5. As a Patient, book an online appointment, open the video room, and end the call — confirm the rating dialog opens automatically and the appointment shows as Completed.
