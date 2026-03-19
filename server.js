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
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_order INTEGER NOT NULL,
    max_winners INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS nominees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position_id INTEGER NOT NULL,
    FOREIGN KEY (position_id) REFERENCES positions(id),
    UNIQUE(name, position_id)
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL,
    nominee_id INTEGER,
    voter_token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (position_id) REFERENCES positions(id),
    FOREIGN KEY (nominee_id) REFERENCES nominees(id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL,
    nominee_name TEXT NOT NULL,
    FOREIGN KEY (position_id) REFERENCES positions(id)
  );
  INSERT OR IGNORE INTO settings (key, value) VALUES ('voting_open', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('results_public', 'true');
`);

// Seed default positions if empty
const posCount = db.prepare("SELECT COUNT(*) as c FROM positions").get().c;
if (posCount === 0) {
  const insertPos = db.prepare("INSERT INTO positions (name, display_order, max_winners) VALUES (?, ?, ?)");
  insertPos.run("Chair", 1, 1);
  insertPos.run("Treasurer", 2, 1);
  insertPos.run("Secretary", 3, 1);
  insertPos.run("Other Committee Member", 4, 4);
}

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
  const password = req.headers["x-admin-password"] || req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password" });
  }
  next();
}

// --- Public API ---

// Get all positions with their nominees
app.get("/api/positions", (req, res) => {
  const positions = db.prepare("SELECT * FROM positions ORDER BY display_order").all();
  const token = getVoterToken(req, res);
  const votingOpen = db.prepare("SELECT value FROM settings WHERE key = 'voting_open'").get();

  // Get what this voter has already voted for
  const existingVotes = db
    .prepare("SELECT position_id, nominee_id FROM votes WHERE voter_token = ?")
    .all(token);
  const votedPositions = new Set(existingVotes.map((v) => v.position_id));

  // Get winners (people already elected to a position)
  const winners = db.prepare("SELECT * FROM winners").all();
  const winnerNames = new Set(winners.map((w) => w.nominee_name.toLowerCase()));

  const result = positions.map((pos) => {
    // Get nominees for this position, excluding anyone who already won a previous position
    let nominees = db
      .prepare("SELECT id, name FROM nominees WHERE position_id = ? ORDER BY name")
      .all(pos.id);

    // Filter out winners of previous positions
    nominees = nominees.filter(
      (n) => !winnerNames.has(n.name.toLowerCase())
    );

    return {
      ...pos,
      nominees,
      hasVoted: votedPositions.has(pos.id),
    };
  });

  res.json({
    positions: result,
    votingOpen: votingOpen?.value === "true",
    winners,
  });
});

// Cast vote(s) for a specific position
// Accepts { nomineeIds: [1,2,3] } for multi-winner positions
// or { nomineeIds: [5] } for single-winner
// or { nomineeIds: [] } for "no vote"
app.post("/api/vote/:positionId", (req, res) => {
  const votingOpen = db.prepare("SELECT value FROM settings WHERE key = 'voting_open'").get();
  if (votingOpen?.value !== "true") {
    return res.status(403).json({ error: "Voting is currently closed" });
  }

  const token = getVoterToken(req, res);
  const positionId = parseInt(req.params.positionId);
  const { nomineeIds } = req.body; // empty array means "no vote"

  // Check position exists
  const position = db.prepare("SELECT * FROM positions WHERE id = ?").get(positionId);
  if (!position) {
    return res.status(404).json({ error: "Position not found" });
  }

  // Check if already voted for this position
  const existing = db
    .prepare("SELECT COUNT(*) as count FROM votes WHERE voter_token = ? AND position_id = ?")
    .get(token, positionId);
  if (existing.count > 0) {
    return res.status(403).json({ error: "You have already voted for this position" });
  }

  // Validate nominee IDs
  if (!Array.isArray(nomineeIds)) {
    return res.status(400).json({ error: "nomineeIds must be an array" });
  }

  if (nomineeIds.length > position.max_winners) {
    return res.status(400).json({ error: `You can select up to ${position.max_winners} nominees` });
  }

  for (const nid of nomineeIds) {
    const nominee = db
      .prepare("SELECT * FROM nominees WHERE id = ? AND position_id = ?")
      .get(nid, positionId);
    if (!nominee) {
      return res.status(400).json({ error: "Invalid nominee for this position" });
    }
  }

  try {
    const insertVote = db.prepare("INSERT INTO votes (position_id, nominee_id, voter_token) VALUES (?, ?, ?)");
    const castVotes = db.transaction(() => {
      if (nomineeIds.length === 0) {
        // "No vote" — record one row with null nominee
        insertVote.run(positionId, null, token);
      } else {
        for (const nid of nomineeIds) {
          insertVote.run(positionId, nid, token);
        }
      }
    });
    castVotes();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to record vote" });
  }
});

// Get results
app.get("/api/results", (req, res) => {
  const resultsPublic = db.prepare("SELECT value FROM settings WHERE key = 'results_public'").get();
  const isAdmin = (req.headers["x-admin-password"] || req.query.password) === ADMIN_PASSWORD;

  if (resultsPublic?.value !== "true" && !isAdmin) {
    return res.status(403).json({ error: "Results are not yet public" });
  }

  const positions = db.prepare("SELECT * FROM positions ORDER BY display_order").all();
  const winners = db.prepare("SELECT * FROM winners").all();

  const results = positions.map((pos) => {
    const nominees = db
      .prepare("SELECT id, name FROM nominees WHERE position_id = ? ORDER BY name")
      .all(pos.id);

    const voteCounts = nominees.map((n) => {
      const count = db
        .prepare("SELECT COUNT(*) as c FROM votes WHERE position_id = ? AND nominee_id = ?")
        .get(pos.id, n.id);
      return { ...n, votes: count.c };
    });

    // Sort by votes descending
    voteCounts.sort((a, b) => b.votes - a.votes);

    const noVoteCount = db
      .prepare("SELECT COUNT(*) as c FROM votes WHERE position_id = ? AND nominee_id IS NULL")
      .get(pos.id);

    const totalVoters = db
      .prepare("SELECT COUNT(DISTINCT voter_token) as c FROM votes WHERE position_id = ?")
      .get(pos.id);

    const posWinners = winners.filter((w) => w.position_id === pos.id);

    return {
      position: pos,
      nominees: voteCounts,
      noVotes: noVoteCount.c,
      totalVoters: totalVoters.c,
      winners: posWinners,
    };
  });

  res.json({ results });
});

// --- Admin API ---

// Get all positions with nominees (admin view)
app.get("/api/admin/positions", requireAdmin, (req, res) => {
  const positions = db.prepare("SELECT * FROM positions ORDER BY display_order").all();
  const result = positions.map((pos) => {
    const nominees = db
      .prepare("SELECT id, name FROM nominees WHERE position_id = ? ORDER BY name")
      .all(pos.id);
    return { ...pos, nominees };
  });
  res.json({ positions: result });
});

// Add a nominee to a position
app.post("/api/admin/nominees", requireAdmin, (req, res) => {
  const { name, positionId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  if (!positionId) {
    return res.status(400).json({ error: "Position is required" });
  }
  try {
    db.prepare("INSERT INTO nominees (name, position_id) VALUES (?, ?)").run(name.trim(), positionId);
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "This person is already nominated for this position" });
    }
    res.status(500).json({ error: "Failed to add nominee" });
  }
});

// Remove a nominee
app.delete("/api/admin/nominees/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM votes WHERE nominee_id = ?").run(req.params.id);
  db.prepare("DELETE FROM nominees WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Add a position
app.post("/api/admin/positions", requireAdmin, (req, res) => {
  const { name, maxWinners } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  const maxOrder = db.prepare("SELECT MAX(display_order) as m FROM positions").get().m || 0;
  db.prepare("INSERT INTO positions (name, display_order, max_winners) VALUES (?, ?, ?)").run(
    name.trim(),
    maxOrder + 1,
    maxWinners || 1
  );
  res.json({ success: true });
});

// Delete a position
app.delete("/api/admin/positions/:id", requireAdmin, (req, res) => {
  const posId = req.params.id;
  db.prepare("DELETE FROM votes WHERE position_id = ?").run(posId);
  db.prepare("DELETE FROM nominees WHERE position_id = ?").run(posId);
  db.prepare("DELETE FROM winners WHERE position_id = ?").run(posId);
  db.prepare("DELETE FROM positions WHERE id = ?").run(posId);
  res.json({ success: true });
});

// Update settings
app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const { votingOpen, resultsPublic } = req.body;
  if (votingOpen !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voting_open', ?)").run(
      votingOpen ? "true" : "false"
    );
  }
  if (resultsPublic !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('results_public', ?)").run(
      resultsPublic ? "true" : "false"
    );
  }
  res.json({ success: true });
});

// Get settings
app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const votingOpen = db.prepare("SELECT value FROM settings WHERE key = 'voting_open'").get();
  const resultsPublic = db.prepare("SELECT value FROM settings WHERE key = 'results_public'").get();
  res.json({
    votingOpen: votingOpen?.value === "true",
    resultsPublic: resultsPublic?.value === "true",
  });
});

// Set a winner for a position
app.post("/api/admin/winners", requireAdmin, (req, res) => {
  const { positionId, nomineeName } = req.body;
  if (!positionId || !nomineeName) {
    return res.status(400).json({ error: "Position and nominee name are required" });
  }
  try {
    db.prepare("INSERT INTO winners (position_id, nominee_name) VALUES (?, ?)").run(
      positionId,
      nomineeName
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to set winner" });
  }
});

// Remove a winner
app.delete("/api/admin/winners/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM winners WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Reset all votes
app.post("/api/admin/reset-votes", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM votes").run();
  db.prepare("DELETE FROM winners").run();
  res.json({ success: true });
});

// Stats
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
