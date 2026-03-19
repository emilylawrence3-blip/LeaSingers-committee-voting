const express = require("express");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "LeaSingers2026";

// Database setup
const db = new Database(process.env.DB_PATH || "votes.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS nominees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nominee_id INTEGER NOT NULL,
    voter_token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (nominee_id) REFERENCES nominees(id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  INSERT OR IGNORE INTO settings (key, value) VALUES ('voting_open', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('max_votes', '0');
`);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Assign each visitor a unique anonymous token via cookie
function getVoterToken(req, res) {
  let token = req.cookies.voter_token;
  if (!token) {
    token = crypto.randomUUID();
    res.cookie("voter_token", token, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    });
  }
  return token;
}

// Simple admin auth check
function requireAdmin(req, res, next) {
  const password =
    req.headers["x-admin-password"] || req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password" });
  }
  next();
}

// --- Public API ---

// Get nominees and voting status
app.get("/api/nominees", (req, res) => {
  const nominees = db.prepare("SELECT id, name FROM nominees ORDER BY name").all();
  const votingOpen = db.prepare("SELECT value FROM settings WHERE key = 'voting_open'").get();
  const maxVotes = db.prepare("SELECT value FROM settings WHERE key = 'max_votes'").get();
  const token = getVoterToken(req, res);
  const existingVotes = db
    .prepare("SELECT nominee_id FROM votes WHERE voter_token = ?")
    .all(token)
    .map((v) => v.nominee_id);

  res.json({
    nominees,
    votingOpen: votingOpen?.value === "true",
    maxVotes: parseInt(maxVotes?.value || "0"),
    myVotes: existingVotes,
  });
});

// Cast votes
app.post("/api/vote", (req, res) => {
  const votingOpen = db.prepare("SELECT value FROM settings WHERE key = 'voting_open'").get();
  if (votingOpen?.value !== "true") {
    return res.status(403).json({ error: "Voting is currently closed" });
  }

  const token = getVoterToken(req, res);
  const { nomineeIds } = req.body;

  if (!Array.isArray(nomineeIds) || nomineeIds.length === 0) {
    return res.status(400).json({ error: "Please select at least one nominee" });
  }

  const maxVotes = parseInt(
    db.prepare("SELECT value FROM settings WHERE key = 'max_votes'").get()?.value || "0"
  );
  if (maxVotes > 0 && nomineeIds.length > maxVotes) {
    return res.status(400).json({ error: `You can vote for up to ${maxVotes} nominees` });
  }

  // Check if already voted
  const existing = db.prepare("SELECT COUNT(*) as count FROM votes WHERE voter_token = ?").get(token);
  if (existing.count > 0) {
    return res.status(403).json({ error: "You have already voted" });
  }

  const insert = db.prepare("INSERT INTO votes (nominee_id, voter_token) VALUES (?, ?)");
  const insertMany = db.transaction((ids) => {
    for (const id of ids) {
      insert.run(id, token);
    }
  });

  try {
    insertMany(nomineeIds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to record vote" });
  }
});

// Get results (public)
app.get("/api/results", (req, res) => {
  const results = db
    .prepare(
      `SELECT n.id, n.name, COUNT(v.id) as vote_count
       FROM nominees n
       LEFT JOIN votes v ON v.nominee_id = n.id
       GROUP BY n.id
       ORDER BY vote_count DESC, n.name`
    )
    .all();
  const totalVoters = db.prepare("SELECT COUNT(DISTINCT voter_token) as count FROM votes").get();
  res.json({ results, totalVoters: totalVoters.count });
});

// --- Admin API ---

app.post("/api/admin/nominees", requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  try {
    db.prepare("INSERT INTO nominees (name) VALUES (?)").run(name.trim());
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "This name has already been added" });
    }
    res.status(500).json({ error: "Failed to add nominee" });
  }
});

app.delete("/api/admin/nominees/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM votes WHERE nominee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM nominees WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const { votingOpen, maxVotes } = req.body;
  if (votingOpen !== undefined) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'voting_open'").run(
      votingOpen ? "true" : "false"
    );
  }
  if (maxVotes !== undefined) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'max_votes'").run(String(maxVotes));
  }
  res.json({ success: true });
});

app.post("/api/admin/reset-votes", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM votes").run();
  res.json({ success: true });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const totalVoters = db.prepare("SELECT COUNT(DISTINCT voter_token) as count FROM votes").get();
  const totalVotes = db.prepare("SELECT COUNT(*) as count FROM votes").get();
  res.json({ totalVoters: totalVoters.count, totalVotes: totalVotes.count });
});

// Serve pages
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/results", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "results.html"));
});

app.listen(PORT, () => {
  console.log(`Lea Singers Voting is running at http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin`);
  console.log(`Results page: http://localhost:${PORT}/results`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
