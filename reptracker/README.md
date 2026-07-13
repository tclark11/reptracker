# Rep Tracker

A tiny family app for logging push-ups and sit-ups. Counts roll up by day,
week, month, year, and all-time, per person. Data lives in a Postgres database
so it survives any phone.

- **Frontend** — one static `index.html`, hosted free on GitHub Pages.
- **Backend** — Node/Express API on Railway, with a Railway Postgres database.
- GitHub holds the code; the database holds the data.

```
reptracker/
├─ backend/           # Express API -> deploy to Railway
│  ├─ server.js
│  ├─ package.json
│  └─ railway.json
├─ frontend/          # static site -> deploy to GitHub Pages
│  └─ index.html
└─ .github/workflows/
   └─ pages.yml       # auto-publishes frontend/ to Pages
```

---

## 1. Put it on GitHub

```bash
cd reptracker
git init
git add .
git commit -m "Rep tracker: backend + frontend"
git branch -M main
git remote add origin https://github.com/<you>/reptracker.git
git push -u origin main
```

## 2. Deploy the backend on Railway

1. Go to railway.app → **New Project → Deploy from GitHub repo** → pick this repo.
2. When it asks for the service root/directory, set it to **`backend`**
   (Settings → Root Directory = `backend`). This makes Railway build only the API.
3. In the same project: **New → Database → Add PostgreSQL**. Railway
   automatically injects a `DATABASE_URL` variable into your service.
4. Optional variables (Service → Variables):
   - `PEOPLE` = `You,Kassian,Emerson`  (change the names/order here anytime)
   - `REP_TOKEN` = any secret string, if you want to require a token to write
5. Deploy. Under **Settings → Networking → Generate Domain** to get a public URL
   like `https://reptracker-production.up.railway.app`.
6. Test it: open `<that-url>/health` — you should see `{"ok":true}`.

The `entries` table is created automatically on first boot.

## 3. Turn on GitHub Pages

1. Repo → **Settings → Pages → Build and deployment → Source = GitHub Actions**.
2. The included workflow publishes the `frontend/` folder on every push.
   Your site lands at `https://<you>.github.io/reptracker/`.

## 4. Connect the app

Open the Pages URL on your phone. On first launch it asks for the **Backend URL** —
paste the Railway domain from step 2.6 (and the token if you set one). That's stored
on the device. Add the page to your home screen and it opens full-screen like an app.

Everyone who opens the site and points it at the same backend shares the same counts,
so you, Kassian, and Emerson can each log from your own phones.

---

## Backups

The database is the source of truth, and Railway Postgres is durable. For an extra
copy, hit **Export CSV** in the app footer (or visit `<backend>/export.csv`) to
download the full history any time.

## Changing the roster

Edit the `PEOPLE` variable in Railway and redeploy — the frontend reads the list
from the backend's `/config`, so the tabs update automatically. Existing data for a
name is preserved as long as the name string stays the same.

## API reference

| Method | Path                     | Purpose                          |
|--------|--------------------------|----------------------------------|
| GET    | `/health`                | health check                     |
| GET    | `/config`               | `{ people, exercises }`          |
| POST   | `/entries`              | body `{person, ex, n}` add reps  |
| DELETE | `/entries/last/:person` | undo last entry                  |
| DELETE | `/entries/:person`      | reset a person                   |
| GET    | `/totals/:person?tz=`   | day/week/month/year/all totals + streak |
| GET    | `/history/:person?tz=&days=` | daily reps for the chart    |
| GET    | `/export.csv`           | full history export              |

`ex` is `push` or `sit`. Pass `tz` (e.g. `Australia/Melbourne`) so day/week
boundaries match your phone; the frontend sends this automatically.
