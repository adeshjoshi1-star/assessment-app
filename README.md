# ETE Chess Assessment Portal

A web app for **Eight Times Eight (ETE)** chess coaches to evaluate students during demo classes. Tracks demo scheduling, student assessments, and admissions pipeline — synced with Google Sheets as the source of truth.

## Live URL

**https://assessment-app-production-74d9.up.railway.app**

## How It Works

### Core Workflow

1. **Operations team** enters demo assignments (student name, slot, date, time, tutor, etc.) into a Google Sheet called **"Trial 2.0"** (columns A–R).
2. The website syncs this sheet every **30 seconds** and displays demos on the **Dashboard** and **Tutor View**.
3. **Tutors** (no login needed) pick their name from a dropdown, see only their assigned demos, and fill an assessment form per demo.
4. Submitting an assessment writes **"Demo Done"** back to column A of that sheet row, and saves full assessment data to the local database.
5. **Admin** logs in to the Dashboard to track demo statuses, filter by tutor/date/slot, view assessment details, and update lead statuses.

### Key Pages

| Page | Auth | Purpose |
|------|------|---------|
| `index.html` | None | Landing page with links |
| `form.html` | None | Standalone assessment form (manual entry — appends new row to sheet) |
| `dashboard.html` | Admin | Demo tracking table with filters, status dropdowns, click-to-view assessments |
| `tutor-view.html` | None | Tutor name selector → per-tutor demo table → Assess / View buttons |
| `analytics.html` | Admin | KPI cards, pie/bar charts, submissions table with filters |
| `login.html` | — | Admin login form |

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3
- **Frontend:** Plain HTML/CSS/JS (no framework) — glassmorphism UI, Inter font
- **Auth:** bcrypt + express-session (single admin account)
- **Sheets API:** googleapis Node.js client (service account)
- **Deploy:** Railway (free tier)

## Admin Account

- **Email:** `admin@ete.com`
- **Password:** `chessislive`
- Seeded automatically on fresh deploy (no registration).

## Google Sheets Integration

### Sheet Details
- **ID:** `1nYvdZwZgqymw89waZXr1gyOVgPtmPN9CuAzQWx5y8Mg`
- **Tab:** `Trial 2.0`
- **Service Account:** `assessment-app@assessment-app-499705.iam.gserviceaccount.com`
- **Credential Env Var:** `GOOGLE_CREDENTIALS_JSON` (set on Railway)

### Column Mapping (A–R)

| Col | Field | Notes |
|-----|-------|-------|
| A | `demo_status` | Read on sync; written as "Demo Done" on assessment submit |
| C | `slot` | e.g. "Mon 4PM" |
| G | `date` | Various formats (DD/MM/YYYY, D/M/YY, DD.MM.YYYY, etc.) |
| H | `time` | Demo time |
| I | `tutor_name` | Used to assign demos to tutors |
| J | `student_name` | |
| L | `age` | |
| M | `language` | |
| N | `agent_name` | |
| R | `phone` | |

### Sheet Sync
- **Interval:** Every 30 seconds via `setInterval` in `server.js`.
- **Filter:** Only rows **2904+** (by row number) are included.
- **Retry:** On startup, retries at 5s and 15s if initial sync fails.
- **Cache:** Stored in memory (`sheetDataCache`), exposed at `GET /api/sheet-data`.
- **Skip condition:** Rows where column A is "ETE - please don't delete" or where both A and I are empty.

### Sheet Write-Back
- When a tutor submits an assessment with a `sheet_row` value, the server calls Google Sheets API `spreadsheets.values.update` to write **"Demo Done"** into column A of that row.
- Local status changes (dropdown on dashboard) are stored in SQLite only — **not** written back to the sheet.

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/login` | Login with email + password |
| POST | `/api/logout` | Destroy session |
| GET | `/api/me` | Check auth status |

### Sheet Data
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sheet-data` | All cached sheet entries (optional `?tutor=` filter). Auth required. |
| GET | `/api/sheet-tutors` | Unique tutor names from sheet. Public. |
| GET | `/api/sheet-tutor/:name` | Sheet entries for one tutor. Public. |
| PATCH | `/api/sheet-data/:row/status` | Update local status dropdown value. Auth required. |

### Assessments
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/assessments` | All submissions. Auth required. |
| GET | `/api/assessments/by-row/:row` | Single assessment by sheet row number. Public. |
| POST | `/api/assessments` | Create assessment. If `sheet_row` provided, also updates sheet column A to "Demo Done". Public. |
| GET | `/api/analytics/summary` | Aggregated stats (totals by level, language, interest, status). Auth required. |
| GET | `/api/analytics/over-time` | Submissions per day. Auth required. |

## Local Development

```bash
git clone https://github.com/juansimon712/assessment-app.git
cd assessment-app
npm install
```

Place your Google service account key as `google-credentials.json` in the project root (gitignored), or set `GOOGLE_CREDENTIALS_JSON` env var.

```bash
node server.js
# Runs on http://localhost:3000
```

## Deployment

Currently deployed on **Railway** at the live URL above. To deploy:

```bash
npm install
railway up --detach
```

### Auto-Deploy (if configured)
When GitHub repo is connected in Railway dashboard → Settings → GitHub → Auto Deploy on `main` branch, every push to `main` triggers a build automatically.

### Credentials on Railway
The `GOOGLE_CREDENTIALS_JSON` environment variable must be set:

```bash
cat google-credentials.json | railway var set GOOGLE_CREDENTIALS_JSON --stdin
```

## Database

Uses **better-sqlite3** stored locally as `data.db`.

### Tables
- `users` — Admin user (seeded on first run)
- `assessments` — All submitted assessments with full form data
- `sheet_statuses` — Local lead status overrides (row_number → status)

### ⚠️ Important
SQLite is stored on the Railway filesystem, which is **ephemeral**. Every deploy wipes `data.db`, losing:
- All submitted assessments
- All local status changes
- The admin account (re-seeded, but assessments are gone)

For production, switch to **PostgreSQL** (Railway provides it free).

## Sheet Rows Used

Rows **2904 through ~3554** are currently in use. The 2904 cut-off is hardcoded in `server.js`:

```js
if (i + 1 < 2904) continue;
```

Update this number if the sheet grows or the range needs to shift.

## CSS Architecture

- `public/style.css` — Shared styles (glassmorphism, mesh gradient bg, Inter font, status badge classes, dark mode, responsive layout)
- Each page has inline `<style>` blocks for page-specific overrides
- Status badge classes: `.New` (yellow), `.DemoDone` (teal), `.Converted` (teal), `.DemoNotDone` (red)
- Color palette: Primary `#156356` (teal), Background `#f6f4ef` (cream), Sidebar `rgba(28,25,23,0.9)` (charcoal)

## Multi-Language Support

Assessment form UI supports English, Arabic, and French via a language dropdown in `form.html`.

## Known Limitations & Future Work

- **No persistent database** — Switch to Railway PostgreSQL to survive deploys
- **No error alerting** — Sheet sync failures are silent
- **No rate limiting** — Public endpoints are unthrottled
- **Sheets API quota** — 60 req/min free tier; current usage is ~2/min
- **Session in memory** — Server restart logs out all users
- **Read-after-write** — No retry logic on sheet write-backs
- **Auto-deploy** — Pushes to `main` deploy automatically only if GitHub integration is configured in Railway dashboard
