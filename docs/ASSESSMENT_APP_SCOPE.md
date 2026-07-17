# Assessment App — Complete Product Scope

**Document purpose:** This document explains, in plain English, what the current Assessment App does and what a developer must preserve when rebuilding or extending it.

**Current implementation date:** 15 July 2026  
**Production platform:** Railway  
**Source control:** GitHub  
**Primary integrations:** Google Sheets and a persistent SQLite database

## 1. Product purpose

The Assessment App manages the complete workflow for student chess demo sessions. Operations staff assign demos in a Google Sheet. Tutors securely open their assigned demos, record a structured student assessment, and mark whether the demo happened. Administrators monitor completion, review assessment details, update lead outcomes, manage tutor access codes, and view conversion and performance analytics.

The app is not intended to replace the main operational Google Sheet. It is a controlled web interface on top of that sheet, with a local database for users, sessions, assessment details, and local status tracking.

## 2. User roles

### Administrator

The administrator can:

- Sign in with an email address and password.
- View all demos and assessments.
- Filter demos by tutor and other available filters.
- Open complete assessment details.
- Update lead and conversion statuses.
- View completed demos, conversions, analytics, tutor rankings, and incentives.
- View tutors and their access codes.
- Add tutors, delete tutors, and reset tutor codes.
- Manually run authorized synchronization and maintenance actions.
- Change the administrator password.

### Tutor

The tutor can:

- Select their name and enter their assigned access code.
- See only demos assigned to their tutor identity.
- View demo time, date, slot, student, and current demo status.
- Mark a demo as not completed.
- Open the assessment form for a new demo.
- Submit a structured assessment.
- View an assessment already submitted for their assigned demo.
- Clear an assessment for their own assigned demo when that existing workflow is used.

Tutor names are normalized so common spelling variants refer to the same person. Current examples include Yadu/Yadhu and Nitesh/Nitish/Nithish/Nithish Kumar.

### Operations team

Operations staff primarily work in the Google Sheet. They enter or maintain the demo assignment data that the application reads, including tutor, student, slot, date, time, language, age, phone number, and demo status.

## 3. Main screens

### Landing page

Provides entry points to the tutor assessment experience and the administrator area.

### Administrator login

Accepts administrator email and password. Successful login creates a secure server-side session. Tutor accounts cannot use the administrator login route.

### Tutor Demo Assessment page

Allows a tutor to choose their name, enter their code, view assigned demos, open or submit assessments, and mark a demo as not done.

### Administrator dashboard

Shows synchronized demo rows and their status. Administrators can filter the data, open details, and perform allowed status updates.

### Assessment form

Captures the tutor's structured evaluation of the student. It can be opened from an assigned demo row or used by an authenticated administrator.

### Completed demos

Shows demos that have been completed and supports tutor-level review.

### Conversion view

Shows converted or conversion-related records and summary information.

### Analytics

Shows completion, conversion, tutor performance, ranking, and incentive-related calculations based on synchronized demo data and local assessment/status data.

### Tutor management

Allows an administrator to review tutor names, codes, demo counts, completed demos, conversions, and reset codes. It also provides the administrator password-change action.

## 4. End-to-end business workflow

1. Operations staff add or update a demo assignment in the Trial 2.0 Google Sheet.
2. The application periodically reads the sheet and refreshes its in-memory cache.
3. The tutor opens the Railway web address and selects their normalized tutor name.
4. The tutor enters the code assigned to that tutor record.
5. The server verifies that the code belongs to the selected tutor identity.
6. The tutor sees only demo rows assigned to them.
7. If the demo did not happen, the tutor marks it as Demo Not Done.
8. If the demo happened, the tutor opens the assessment form and records the student's evaluation.
9. The server validates the submission and confirms that the sheet row belongs to the logged-in tutor.
10. The assessment is saved in SQLite and linked to the Google Sheet row.
11. The Trial 2.0 sheet is updated to Demo Done, and assessment feedback is written to the configured feedback columns.
12. A copy of the assessment is appended to the separate assessment sheet when that integration is configured.
13. Administrators review completed assessments and update lead or conversion statuses.
14. Dashboard, completion, conversion, tutor, and analytics views reflect the updated information.

## 5. Assessment information captured

Each assessment can contain:

- Tutor name.
- Student phone number when available.
- Demo slot, date, and time.
- Student name and age.
- Language.
- Assessed chess level.
- Topics already known by the student.
- Topics covered during the demo.
- Recommended starting topic.
- Topics requiring revision.
- Written tutor feedback.
- Interest level from 1 to 5.
- Additional remarks.
- Linked Google Sheet row number.
- Local lead status and submission timestamp.

The supported learning levels are Beginner, Intermediate, Advanced, and the topic checklists defined by the application for each level.

## 6. Status model

### Demo status

Demo status describes whether the assigned demo occurred. Important values include New, Demo Done, Demo Not Done, Assessment Pending, Demo Cancelled, and Converted where applicable.

### Lead or conversion status

Administrators can track the follow-up outcome independently from demo completion. Current status families include New, In Conversation, CNR, Hot, Converted, Contacted, CNR and Messaged, CNR 1, CNR 2, CNR 3, Hot/Potential, Not Interested, and Converted, depending on the screen and underlying record.

A future rebuild should consolidate these overlapping status lists into one documented status model without changing historical meaning.

## 7. Google Sheets integration

### Trial 2.0 sheet

This is the operational source for assigned demos. The current application reads columns A through R beginning after the header row. Important mapped fields include demo status, slot, date, time, tutor name, student name, age, language, agent name, and phone number.

The app also writes:

- Demo completion status back to the source row.
- Demo Not Done status when selected by the assigned tutor.
- Assessment feedback fields into the configured feedback columns.
- Tutor access-code information only through an explicitly authorized administrative synchronization action.

### Assessment sheet

The application can append a complete assessment record to a separate Google Sheet. It also contains authorized maintenance routines for reconciling phone numbers, feedback, and row links.

### Synchronization behavior

- Sheet reads run at startup and on a recurring interval.
- Production startup reads are designed not to rewrite existing database records.
- Automatic destructive cleanup and recovery routines do not run during startup.
- Data-writing synchronization and maintenance operations require authenticated user actions.
- Google API failures are logged and should not expose credentials to the browser.

## 8. Local database scope

The production SQLite database is stored on the Railway volume at `/data/data.db`.

### Users

Stores administrator and tutor identities, password hashes where applicable, role, tutor code, and creation time.

### Assessments

Stores the full structured assessment, tutor and student details, status, linked sheet row, submitting user, and timestamp.

### Sheet statuses

Stores local status and demo-status overrides by Google Sheet row.

### Sessions

Stores server-side login sessions. Browser cookies contain only the protected session identifier.

No existing production records should be migrated, cleaned, reset, or deleted without explicit owner approval and a verified backup.

## 9. Access and security rules

- Administrator routes require an authenticated administrator session.
- Tutor data routes require an authenticated tutor session.
- A tutor can access only rows and assessments assigned to the same normalized tutor identity.
- Assessment creation, reading, deletion, and Demo Not Done actions are no longer public.
- Login attempts are rate-limited.
- Cross-origin state-changing browser requests are rejected.
- Session cookies are HTTP-only, secure in Railway, same-site restricted, and time-limited.
- Production requires a Railway `SESSION_SECRET`; there is no production fallback secret in source code.
- Administrator credentials are not hard-coded or automatically reset by deployment.
- Sensitive Google credentials remain in Railway environment variables and never go to the browser.
- Input payload size and assessment field lengths are limited.
- Security headers and a content security policy are returned by the server.

## 10. Background behavior

The app periodically reads the Google Sheet to refresh the displayed assignment data. These reads should preserve current user-facing behavior while avoiding unapproved production database migrations or cleanup.

Maintenance actions such as phone reconciliation, feedback repair, wrong-link cleanup, recovery, or garbage cleanup must remain administrator-only and must never run automatically against production data.

## 11. Railway deployment and storage

The application runs as a Node.js service on Railway. A persistent Railway volume is mounted at `/data`. Railway deploys from the GitHub `main` branch.

The health endpoint checks that SQLite can be read and reports whether free volume space is below 10 percent. Railway should use `/api/health` as its healthcheck.

The current 500 MB volume is approximately 90 percent used. To reduce crash risk:

1. Resize the volume to at least 2 GB before it reaches capacity.
2. Enable Railway volume backups after confirming the backup cost.
3. Keep automatic database cleanup disabled until a backup has been tested.
4. Monitor the health endpoint and Railway volume usage.
5. Investigate the database and session-table sizes using read-only tools.
6. Plan a migration to managed PostgreSQL if data size or concurrent usage grows substantially.

## 12. Required environment configuration

Production requires:

- `SESSION_SECRET` for secure sessions.
- `GOOGLE_CREDENTIALS_JSON` for Google API authentication.
- `SOURCE_SPREADSHEET_ID` for the spreadsheet containing the `Trial 2.0` operational source tab.
- `ASSESSMENTS_SHEET_ID` when the separate assessment sheet is used.
- Railway-provided service and volume variables.
- `ALLOW_DB_BOOTSTRAP=false` to prevent deployment from bootstrapping or migrating the existing production database.

The source Google spreadsheet identifier and tab names must also remain correctly configured in the application.

## 13. Functional compatibility requirements for a rebuild

A developer rebuilding the application must preserve:

- All current administrator and tutor screens.
- Tutor-code login and name selection.
- Tutor spelling normalization, including Yadu and Nitesh variants.
- Per-tutor assignment filtering and authorization.
- Demo Not Done and Demo Done workflows.
- Complete assessment capture and review.
- Google Sheet read and write behavior.
- Assessment-to-sheet-row linking.
- Dashboard filtering and assessment detail viewing.
- Completed, conversion, analytics, ranking, and incentive views.
- Tutor management and code reset.
- Administrator password change.
- Manual administrator maintenance tools.
- Persistent database and session behavior.
- Railway healthchecking and storage monitoring.

Security improvements may add authentication or confirmation steps, but they must not remove the underlying business capability.

## 14. Acceptance criteria

Before a new version replaces the current app, it should demonstrate:

1. Administrator login, logout, and password change work.
2. Tutor login succeeds for the correct selected name and code and fails for mismatched names.
3. Yadu/Yadhu and Nitesh/Nitish/Nithish variants resolve correctly without rewriting existing records.
4. Tutors cannot view another tutor's rows or assessments.
5. Operations sheet changes appear in the app after synchronization.
6. Demo Not Done updates the correct source row.
7. A submitted assessment is stored once, linked to the correct row, and appears in administrator and tutor views.
8. Demo Done and feedback values reach the correct Google Sheet row.
9. Dashboard filters, completed view, conversion view, analytics, tutor ranking, and incentives return expected results.
10. Unauthorized create, read, update, and delete requests are rejected.
11. Deployment does not migrate or clean existing production data.
12. The Railway healthcheck passes and warns when storage is low.
13. A tested backup and rollback procedure exists before any database migration.

## 15. Recommended future improvements

- Consolidate the large single server file into modules for authentication, tutors, assessments, sheets, analytics, and maintenance.
- Replace SQLite with managed PostgreSQL when growth justifies it.
- Add a shared, persistent login-rate limiter before using multiple Railway replicas.
- Add automated API integration tests with a disposable database and mocked Google Sheets.
- Add audit logging for status changes, deletions, code resets, and maintenance actions.
- Add structured monitoring and alerts for sheet failures, health degradation, and low storage.
- Replace browser prompt dialogs for password changes with dedicated forms.
- Document one authoritative demo and lead status state machine.
- Add a staging environment that uses separate test sheets and a disposable database.

## 16. Explicitly out of scope without separate approval

- Editing, deleting, cleaning, or migrating existing production database records.
- Changing historical Google Sheet data in bulk.
- Rotating existing user credentials automatically.
- Resizing paid Railway storage or enabling paid backups.
- Replacing Google Sheets as the operations source of truth.
- Migrating production data from SQLite to another database.

These actions require a separate approval, backup, change plan, and production verification checklist.
