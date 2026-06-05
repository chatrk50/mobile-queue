# Mobile Queue — Feature Roadmap & Design

Derived from the competitive research (see git history). Built to extend the current low-cost LINE stack without breaking the registration-free flow.

## ⚠️ The one structural decision: data persistence
The app uses Node `node:sqlite` at `data/queue.db`. On **Render free the disk is ephemeral** (wiped on restart) and the **daily reset deletes tickets** — so *anything that needs history* (weekly/monthly analytics, rating trends) only survives until the next restart.

**Design rule:** everything is built to work **today-scoped on Render free now**, and **history-ready** for later. `db.js` already honours `QUEUE_DATA_DIR`, so moving to **Fly.io with a persistent volume** later is a config change, not a rewrite. The midnight reset will **archive a daily summary row before clearing**, so once storage is persistent, history accrues automatically.

## Data model (additions)
```
tickets   + called_count INTEGER DEFAULT 0   -- for no-show auto-handling
          + rating       INTEGER             -- 1..5, set after 'served'
          (already have created_at, called_at, closed_at -> wait & serve times)
status values: waiting | called | served | skipped | cancelled | no_show (new)

daily_stats (NEW, written at midnight reset before DELETE)
   date TEXT, zone_id INT, issued INT, served INT, no_shows INT,
   avg_wait_sec INT, avg_rating REAL          -- persistent history source

bookings (NEW, Phase 3 — advance booking)
   id, zone_id, line_user_id, customer_name, slot_date, slot_time,
   status (booked|arrived|cancelled|no_show), created_at
```

## API (additions)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/tickets/:id/noshow` | PIN | mark a called ticket no-show |
| POST | `/api/tickets/:id/rate` | — | customer rating `{stars:1..5}` |
| GET | `/api/report?range=today\|week\|month` | PIN | metrics (today live; week/month from `daily_stats`) |
| POST/GET | `/api/bookings...` | mixed | Phase 3 advance booking |

## Behaviour
- **No-show:** cashier "No-show" button on called tickets → status `no_show`; counts in report. (Optional later: auto-no-show after N further calls.)
- **Rating:** when the LIFF sees `status='served'`, show ⭐×5 → `POST /rate` → "Thanks!". Report shows avg rating.
- **Analytics:** report returns issued / served / no-shows / avg wait / avg serve / avg rating + per-zone + (history) week/month.

## Phasing
- **Phase 1 — cheap wins (NOW, no persistence needed):** no-show button + count · one-tap rating after served · today-analytics in the report (issued/served/no-show/avg wait/avg rating). ← *building now*
- **Phase 2 — history:** `daily_stats` archiving at reset + week/month report. *Needs a persistent disk (Fly.io volume via `QUEUE_DATA_DIR`).*
- **Phase 3 — differentiator:** advance booking (LIFF time-slots + cashier bookings view).
- **Phase 4 — optional:** PromptPay deposit, multi-language LIFF, POS/menu.
