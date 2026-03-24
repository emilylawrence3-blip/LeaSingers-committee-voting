const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "LeaSingers2026";

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}
async function queryOne(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

// Initialize database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      display_order INTEGER NOT NULL,
      nominee_name TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      vote_type TEXT NOT NULL CHECK (vote_type IN ('yes', 'no', 'abstain')),
      voter_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Add nominee_name column if it doesn't exist (migration)
  try {
    await pool.query("ALTER TABLE positions ADD COLUMN IF NOT EXISTS nominee_name TEXT DEFAULT ''");
  } catch (e) { /* already exists */ }

  // Add vote_type column if it doesn't exist (migration from old schema)
  try {
    await pool.query("ALTER TABLE votes ADD COLUMN IF NOT EXISTS vote_type TEXT DEFAULT 'yes'");
  } catch (e) { /* already exists */ }

  // Seed default settings
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('voting_open', 'true')
    ON CONFLICT (key) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('results_public', 'true')
    ON CONFLICT (key) DO NOTHING
  `);

  // Seed default positions if empty
  const posCount = await queryOne("SELECT COUNT(*) as c FROM positions");
  if (parseInt(posCount.c) === 0) {
    await pool.query("INSERT INTO positions (name, display_order, nominee_name) VALUES ($1, $2, $3)", ["Chair", 1, ""]);
    await pool.query("INSERT INTO positions (name, display_order, nominee_name) VALUES ($1, $2, $3)", ["Treasurer", 2, ""]);
    await pool.query("INSERT INTO positions (name, display_order, nominee_name) VALUES ($1, $2, $3)", ["Secretary", 3, ""]);
    await pool.query("INSERT INTO positions (name, display_order, nominee_name) VALUES ($1, $2, $3)", ["Other Committee Member", 4, ""]);
  }

  console.log("Database initialized successfully");
}

app.use(express.json());
app.use(cookieParser());

// Prevent browser caching of HTML pages
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '/admin' || req.path === '/results') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

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

function requireAdmin(req, res, next) {
  const password = req.headers["x-admin-password"] || req.query.password;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password" });
  }
  next();
}

// --- Public API ---

// Get all positions for voting
app.get("/api/positions", async (req, res) => {
  try {
    const positions = await query("SELECT * FROM positions ORDER BY display_order");
    const token = getVoterToken(req, res);
    const votingOpen = await queryOne("SELECT value FROM settings WHERE key = 'voting_open'");

    // Get what this voter has already voted for
    const existingVotes = await query("SELECT position_id FROM votes WHERE voter_token = $1", [token]);
    const votedPositions = new Set(existingVotes.map((v) => v.position_id));

    const result = positions
      .filter((p) => p.nominee_name && p.nominee_name.trim() !== "") // Only show positions with a nominee
      .map((p) => ({
        id: p.id,
        name: p.name,
        nominee_name: p.nominee_name,
        hasVoted: votedPositions.has(p.id),
      }));

    res.json({
      positions: result,
      votingOpen: votingOpen?.value === "true",
    });
  } catch (err) {
    console.error("Error fetching positions:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Cast a vote of confidence for a position
app.post("/api/vote/:positionId", async (req, res) => {
  try {
    const votingOpen = await queryOne("SELECT value FROM settings WHERE key = 'voting_open'");
    if (votingOpen?.value !== "true") {
      return res.status(403).json({ error: "Voting is currently closed" });
    }

    const token = getVoterToken(req, res);
    const positionId = parseInt(req.params.positionId);
    const { voteType } = req.body;

    if (!["yes", "no", "abstain"].includes(voteType)) {
      return res.status(400).json({ error: "Vote must be yes, no, or abstain" });
    }

    // Check position exists and has a nominee
    const position = await queryOne("SELECT * FROM positions WHERE id = $1", [positionId]);
    if (!position || !position.nominee_name || position.nominee_name.trim() === "") {
      return res.status(404).json({ error: "Position not found" });
    }

    // Check if already voted
    const existing = await queryOne(
      "SELECT COUNT(*) as count FROM votes WHERE voter_token = $1 AND position_id = $2",
      [token, positionId]
    );
    if (parseInt(existing.count) > 0) {
      return res.status(403).json({ error: "You have already voted for this position" });
    }

    await pool.query(
      "INSERT INTO votes (position_id, vote_type, voter_token) VALUES ($1, $2, $3)",
      [positionId, voteType, token]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error casting vote:", err);
    res.status(500).json({ error: "Failed to record vote" });
  }
});

// Get results
app.get("/api/results", async (req, res) => {
  try {
    const resultsPublic = await queryOne("SELECT value FROM settings WHERE key = 'results_public'");
    const isAdmin = (req.headers["x-admin-password"] || req.query.password) === ADMIN_PASSWORD;

    if (resultsPublic?.value !== "true" && !isAdmin) {
      return res.status(403).json({ error: "Results are not yet public" });
    }

    const positions = await query("SELECT * FROM positions ORDER BY display_order");

    const results = [];
    for (const pos of positions) {
      if (!pos.nominee_name || pos.nominee_name.trim() === "") {
        results.push({
          position: pos,
          nominee_name: "",
          yes: 0,
          no: 0,
          abstain: 0,
          totalVoters: 0,
        });
        continue;
      }

      const yesCount = await queryOne(
        "SELECT COUNT(*) as c FROM votes WHERE position_id = $1 AND vote_type = 'yes'",
        [pos.id]
      );
      const noCount = await queryOne(
        "SELECT COUNT(*) as c FROM votes WHERE position_id = $1 AND vote_type = 'no'",
        [pos.id]
      );
      const abstainCount = await queryOne(
        "SELECT COUNT(*) as c FROM votes WHERE position_id = $1 AND vote_type = 'abstain'",
        [pos.id]
      );
      const totalVoters = await queryOne(
        "SELECT COUNT(DISTINCT voter_token) as c FROM votes WHERE position_id = $1",
        [pos.id]
      );

      results.push({
        position: pos,
        nominee_name: pos.nominee_name,
        yes: parseInt(yesCount.c),
        no: parseInt(noCount.c),
        abstain: parseInt(abstainCount.c),
        totalVoters: parseInt(totalVoters.c),
      });
    }

    res.json({ results });
  } catch (err) {
    console.error("Error fetching results:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Admin API ---

// Get all positions (admin view)
app.get("/api/admin/positions", requireAdmin, async (req, res) => {
  try {
    const positions = await query("SELECT * FROM positions ORDER BY display_order");
    res.json({ positions });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update nominee name for a position
app.post("/api/admin/positions/:id/nominee", requireAdmin, async (req, res) => {
  const { nomineeName } = req.body;
  try {
    await pool.query("UPDATE positions SET nominee_name = $1 WHERE id = $2", [nomineeName || "", req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Add a position
app.post("/api/admin/positions", requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  try {
    const maxOrder = await queryOne("SELECT COALESCE(MAX(display_order), 0) as m FROM positions");
    await pool.query(
      "INSERT INTO positions (name, display_order, nominee_name) VALUES ($1, $2, $3)",
      [name.trim(), parseInt(maxOrder.m) + 1, ""]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Delete a position
app.delete("/api/admin/positions/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM votes WHERE position_id = $1", [req.params.id]);
    await pool.query("DELETE FROM positions WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Update settings
app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const { votingOpen, resultsPublic } = req.body;
    if (votingOpen !== undefined) {
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ('voting_open', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [votingOpen ? "true" : "false"]
      );
    }
    if (resultsPublic !== undefined) {
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ('results_public', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [resultsPublic ? "true" : "false"]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error saving settings:", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// Get settings
app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const votingOpen = await queryOne("SELECT value FROM settings WHERE key = 'voting_open'");
    const resultsPublic = await queryOne("SELECT value FROM settings WHERE key = 'results_public'");
    res.json({
      votingOpen: votingOpen?.value === "true",
      resultsPublic: resultsPublic?.value === "true",
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Reset all votes
app.post("/api/admin/reset-votes", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM votes");
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Stats
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const totalVoters = await queryOne("SELECT COUNT(DISTINCT voter_token) as count FROM votes");
    res.json({ totalVoters: parseInt(totalVoters.count) });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Serve pages
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/results", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "results.html"));
});

// Start server
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Lea Singers Voting is running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
