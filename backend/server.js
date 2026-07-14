import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

// ---- Config -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const PEOPLE = (process.env.PEOPLE || "You,Kassian,Emerson")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const EXERCISES = ["push", "sit"];

// Optional shared secret. If REP_TOKEN is set, every request must send
// header  x-rep-token: <that value>. Leave unset for an open family tool.
const REP_TOKEN = process.env.REP_TOKEN || null;

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. Add a Postgres plugin in Railway.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---- Schema -----------------------------------------------------------------
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id     BIGSERIAL PRIMARY KEY,
      person TEXT      NOT NULL,
      ex     TEXT      NOT NULL,
      n      INTEGER   NOT NULL CHECK (n > 0),
      ts     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_entries_person_ts ON entries (person, ts);
  `);
  console.log("DB ready. People:", PEOPLE.join(", "));
}

// ---- App --------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// simple auth gate
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (REP_TOKEN && req.get("x-rep-token") !== REP_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/config", (_req, res) => res.json({ people: PEOPLE, exercises: EXERCISES }));

function validate(person, ex, n) {
  if (!PEOPLE.includes(person)) return "Unknown person";
  if (!EXERCISES.includes(ex)) return "Unknown exercise";
  const num = parseInt(n, 10);
  if (!Number.isFinite(num) || num < 1) return "Invalid rep count";
  return null;
}

// Add the same rep entry to multiple people at once (e.g. a set done together).
// body: { people: ["You","Kassian"], ex: "push", n: 20 }
app.post("/entries/batch", async (req, res) => {
  const { people, ex, n } = req.body || {};
  if (!Array.isArray(people) || people.length === 0)
    return res.status(400).json({ error: "No people selected" });
  const bad = people.find((p) => !PEOPLE.includes(p));
  if (bad) return res.status(400).json({ error: "Unknown person: " + bad });
  if (!EXERCISES.includes(ex)) return res.status(400).json({ error: "Unknown exercise" });
  const num = parseInt(n, 10);
  if (!Number.isFinite(num) || num < 1) return res.status(400).json({ error: "Invalid rep count" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = [];
    for (const person of people) {
      const { rows } = await client.query(
        "INSERT INTO entries (person, ex, n) VALUES ($1,$2,$3) RETURNING id, person, ex, n, ts",
        [person, ex, num]
      );
      inserted.push(rows[0]);
    }
    await client.query("COMMIT");
    res.json({ added: inserted });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Batch insert failed" });
  } finally {
    client.release();
  }
});

// Add a rep entry
app.post("/entries", async (req, res) => {
  const { person, ex, n } = req.body || {};
  const err = validate(person, ex, n);
  if (err) return res.status(400).json({ error: err });
  try {
    const { rows } = await pool.query(
      "INSERT INTO entries (person, ex, n) VALUES ($1,$2,$3) RETURNING id, person, ex, n, ts",
      [person, ex, parseInt(n, 10)]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Insert failed" });
  }
});

// Undo the most recent entry for a person
app.delete("/entries/last/:person", async (req, res) => {
  const { person } = req.params;
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: "Unknown person" });
  try {
    const { rows } = await pool.query(
      `DELETE FROM entries
       WHERE id = (SELECT id FROM entries WHERE person = $1 ORDER BY ts DESC, id DESC LIMIT 1)
       RETURNING id, person, ex, n, ts`,
      [person]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Undo failed" });
  }
});

// Reset a person
app.delete("/entries/:person", async (req, res) => {
  const { person } = req.params;
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: "Unknown person" });
  try {
    await pool.query("DELETE FROM entries WHERE person = $1", [person]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Reset failed" });
  }
});

// Totals for one person, bucketed by period, split by exercise.
// Buckets are computed in the client's timezone (passed as ?tz=Area/City)
// so "today" and "this week" line up with the phone.
app.get("/totals/:person", async (req, res) => {
  const { person } = req.params;
  const tz = req.query.tz || "UTC";
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: "Unknown person" });
  try {
    // date_trunc in the requested timezone via AT TIME ZONE round-trip
    const { rows } = await pool.query(
      `
      WITH e AS (
        SELECT ex, n, (ts AT TIME ZONE $2) AS local_ts, now() AT TIME ZONE $2 AS local_now
        FROM entries WHERE person = $1
      )
      SELECT ex,
        SUM(n) FILTER (WHERE date_trunc('day',   local_ts) = date_trunc('day',   local_now)) AS day,
        SUM(n) FILTER (WHERE date_trunc('week',  local_ts) = date_trunc('week',  local_now)) AS week,
        SUM(n) FILTER (WHERE date_trunc('month', local_ts) = date_trunc('month', local_now)) AS month,
        SUM(n) FILTER (WHERE date_trunc('year',  local_ts) = date_trunc('year',  local_now)) AS year,
        SUM(n) AS all_time
      FROM e GROUP BY ex
      `,
      [person, tz]
    );
    const out = {
      push: { day: 0, week: 0, month: 0, year: 0, all_time: 0 },
      sit:  { day: 0, week: 0, month: 0, year: 0, all_time: 0 },
    };
    for (const r of rows) {
      out[r.ex] = {
        day: Number(r.day) || 0,
        week: Number(r.week) || 0,
        month: Number(r.month) || 0,
        year: Number(r.year) || 0,
        all_time: Number(r.all_time) || 0,
      };
    }

    // Streaks: consecutive days with at least one rep (any exercise), in local tz.
    // Pull the distinct active days, most recent first, and walk them.
    const { rows: dayRows } = await pool.query(
      `SELECT DISTINCT (date_trunc('day', ts AT TIME ZONE $2))::date AS d
       FROM entries WHERE person = $1 ORDER BY d DESC`,
      [person, tz]
    );
    const days = dayRows.map((r) => r.d); // Date objects, desc
    const DAY = 86400000;
    const toKey = (dt) => dt.toISOString().slice(0, 10);

    // "today" in the person's timezone
    const nowLocal = new Date(
      new Date().toLocaleString("en-US", { timeZone: tz })
    );
    const todayKey = toKey(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate()));
    const yesterdayKey = toKey(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate() - 1));

    // current streak: only "live" if the most recent active day is today or yesterday
    let current = 0;
    if (days.length) {
      const mostRecent = toKey(days[0]);
      if (mostRecent === todayKey || mostRecent === yesterdayKey) {
        current = 1;
        let prev = days[0];
        for (let i = 1; i < days.length; i++) {
          const gap = Math.round((prev.getTime() - days[i].getTime()) / DAY);
          if (gap === 1) { current++; prev = days[i]; }
          else break;
        }
      }
    }

    // best streak ever: longest run of consecutive days anywhere in history
    let best = 0, run = 0, prevBest = null;
    // walk ascending for clarity
    const asc = [...days].reverse();
    for (const d of asc) {
      if (prevBest && Math.round((d.getTime() - prevBest.getTime()) / DAY) === 1) run++;
      else run = 1;
      if (run > best) best = run;
      prevBest = d;
    }

    out.streak = { current, best, active_today: days.length ? toKey(days[0]) === todayKey : false };
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Totals failed" });
  }
});

// Daily history for the chart: reps per day over the last N days (default 14),
// split by exercise, bucketed in the client's timezone. Days with no reps
// come back as zeros so the chart has a continuous axis.
app.get("/history/:person", async (req, res) => {
  const { person } = req.params;
  const tz = req.query.tz || "UTC";
  let days = parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days < 1) days = 14;
  if (days > 366) days = 366;
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: "Unknown person" });
  try {
    const { rows } = await pool.query(
      `
      WITH days AS (
        SELECT generate_series(
          (date_trunc('day', now() AT TIME ZONE $2))::date - ($3::int - 1),
          (date_trunc('day', now() AT TIME ZONE $2))::date,
          '1 day'
        ) AS d
      ),
      e AS (
        SELECT ex, n, (date_trunc('day', ts AT TIME ZONE $2))::date AS d
        FROM entries WHERE person = $1
      )
      SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
        COALESCE(SUM(e.n) FILTER (WHERE e.ex = 'push'), 0) AS push,
        COALESCE(SUM(e.n) FILTER (WHERE e.ex = 'sit'),  0) AS sit
      FROM days LEFT JOIN e ON e.d = days.d
      GROUP BY days.d ORDER BY days.d ASC
      `,
      [person, tz, days]
    );
    res.json(
      rows.map((r) => ({ day: r.day, push: Number(r.push), sit: Number(r.sit) }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "History failed" });
  }
});

// Raw history export (CSV) for backup / safekeeping
app.get("/export.csv", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, person, ex, n, ts FROM entries ORDER BY ts ASC, id ASC"
    );
    const lines = ["id,person,exercise,reps,timestamp"];
    for (const r of rows) {
      lines.push(`${r.id},${r.person},${r.ex},${r.n},${r.ts.toISOString()}`);
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="reptracker-export.csv"');
    res.send(lines.join("\n"));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Export failed" });
  }
});

init()
  .then(() => app.listen(PORT, () => console.log("Listening on " + PORT)))
  .catch((e) => {
    console.error("Startup failed:", e);
    process.exit(1);
  });
