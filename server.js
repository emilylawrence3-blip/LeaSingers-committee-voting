const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "LeaSingers2026";

// PostgreSQL connection — uses DATABASE_URL from Render environment
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Helper to run queries
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
      max_winners INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS nominees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      UNIQUE(name, position_id)
    );
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      nominee_id INTEGER REFERENCES nominees(id),
      voter_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS winners (
      id SERIAL PRIMARY KEY,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      nominee_name TEXT NOT NULL
    );
  `);

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
    await pool.query("INSERT INTO positions (name, display_order, max_winners) VALUES ($1, $2, $3)", ["Chair", 1, 1]);
    await pool.query("INSERT INTO positions (name, display_order, max_winners) VALUES ($1, $2, $3)", ["Treasurer", 2, 1]);
    await pool.query("INSERT INTO positions (name, display_order, max_winners) VALUES ($1, $2, $3)", ["Secretary", 3, 1]);
    await pool.query("INSERT INTO positions (name, display_order, max_winners) VALUES ($1, $2, $3)", ["Other Committee Member", 4, 4]);
  }

  console.log("Database initialized successfully");
}

app.use(express.json());
app.use(cookieParser());

// Prevent browser caching of HTML pages so updates are always seen
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '/admin' || req.path === '/results') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
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
app.get("/api/positions", async (req, res) => {
  try {
    const positions = await query("SELECT * FROM positions ORDER BY display_order");
    const token = getVoterToken(req, res);
    const votingOpen = await queryOne("SELECT value FROM settings WHERE key = 'voting_open'");

    // Get what this voter has already voted for
    const existingVotes = await query("SELECT position_id, nominee_id FROM votes WHERE voter_token = $1", [token]);
    const votedPositions = new Set(existingVotes.map((v) => v.position_id));

    // Get winners (people already elected to a position)
    const winners = await query("SELECT * FROM winners");
    const winnerNames = new Set(winners.map((w) => w.nominee_name.toLowerCase()));

    const result = [];
    for (const pos of positions) {
      let nominees = await query("SELECT id, name FROM nominees WHERE position_id = $1 ORDER BY name", [pos.id]);
      // Filter out winners of previous positions
      nominees = nominees.filter((n) => !winnerNames.has(n.name.toLowerCase()));

      result.push({
        ...pos,
        nominees,
        hasVoted: votedPositions.has(pos.id),
      });
    }

    res.json({
      positions: result,
      votingOpen: votingOpen?.value === "true",
      winners,
    });
  } catch (err) {
    console.error("Error fetching positions:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Cast vote(s) for a specific position
app.post("/api/vote/:positionId", async (req, res) => {
  try {
    const votingOpen = await queryOne("SELECT value FROM settings WHERE key = 'voting_open'");
    if (votingOpen?.value !== "true") {
      return res.status(403).json({ error: "Voting is currently closed" });
    }

    const token = getVoterToken(req, res);
    const positionId = parseInt(req.params.positionId);

    // Accept multiple formats
    let nomineeIds;
    if (Array.isArray(req.body.nomineeIds)) {
      nomineeIds = req.body.nomineeIds;
    } else if (typeof req.body.nomineeIds === "number") {
      nomineeIds = [req.body.nomineeIds];
    } else if (req.body.nomineeId !== undefined) {
      nomineeIds = req.body.nomineeId != null ? [req.body.nomineeId] : [];
    } else if (req.body.nomineeIds !== undefined && req.body.nomineeIds === null) {
      nomineeIds = [];
    } else {
      nomineeIds = [];
    }

    // Check position exists
    const position = await queryOne("SELECT * FROM positions WHERE id = $1", [positionId]);
    if (!position) {
      return res.status(404).json({ error: "Position not found" });
    }

    // Check if already voted for this position
    const existing = await queryOne(
      "SELECT COUNT(*) as count FROM votes WHERE voter_token = $1 AND position_id = $2",
      [token, positionId]
    );
    if (parseInt(existing.count) > 0) {
      return res.status(403).json({ error: "You have already voted for this position" });
    }

    if (nomineeIds.length > position.max_winners) {
      return res.status(400).json({ error: `You can select up to ${position.max_winners} nominees` });
    }

    // Validate all nominees
    for (const nid of nomineeIds) {
      const nominee = await queryOne(
        "SELECT * FROM nominees WHERE id = $1 AND position_id = $2",
        [nid, positionId]
      );
      if (!nominee) {
        return res.status(400).json({ error: "Invalid nominee for this position" });
      }
    }

    // Insert votes in a transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (nomineeIds.length === 0) {
        // "No vote" — record one row with null nominee
        await client.query(
          "INSERT INTO votes (position_id, nominee_id, voter_token) VALUES ($1, $2, $3)",
          [positionId, null, token]
        );
      } else {
        for (const nid of nomineeIds) {
          await client.query(
            "INSERT INTO votes (position_id, nominee_id, voter_token) VALUES ($1, $2, $3)",
            [positionId, nid, token]
          );
        }
      }
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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
    const winners = await query("SELECT * FROM winners");

    const results = [];
    for (const pos of positions) {
      const nominees = await query("SELECT id, name FROM nominees WHERE position_id = $1 ORDER BY name", [pos.id]);

      const voteCounts = [];
      for (const n of nominees) {
        const count = await queryOne(
          "SELECT COUNT(*) as c FROM votes WHERE position_id = $1 AND nominee_id = $2",
          [pos.id, n.id]
        );
        voteCounts.push({ ...n, votes: parseInt(count.c) });
      }

      // Sort by votes descending
      voteCounts.sort((a, b) => b.votes - a.votes);

      const noVoteCount = await queryOne(
        "SELECT COUNT(*) as c FROM votes WHERE position_id = $1 AND nominee_id IS NULL",
        [pos.id]
      );

      const totalVoters = await queryOne(
        "SELECT COUNT(DISTINCT voter_token) as c FROM votes WHERE position_id = $1",
        [pos.id]
      );

      const posWinners = winners.filter((w) => w.position_id === pos.id);

      results.push({
        position: pos,
        nominees: voteCounts,
        noVotes: parseInt(noVoteCount.c),
        totalVoters: parseInt(totalVoters.c),
        winners: posWinners,
      });
    }

    res.json({ results });
  } catch (err) {
    console.error("Error fetching results:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Admin API ---

// Get all positions with nominees (admin view)
app.get("/api/admin/positions", requireAdmin, async (req, res) => {
  try {
    const positions = await query("SELECT * FROM positions ORDER BY display_order");
    const result = [];
    for (const pos of positions) {
      const nominees = await query("SELECT id, name FROM nominees WHERE position_id = $1 ORDER BY name", [pos.id]);
      result.push({ ...pos, nominees });
    }
    res.json({ positions: result });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Add a nominee to a position
app.post("/api/admin/nominees", requireAdmin, async (req, res) => {
  const { name, positionId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  if (!positionId) {
    return res.status(400).json({ error: "Position is required" });
  }
  try {
    await pool.query("INSERT INTO nominees (name, position_id) VALUES ($1, $2)", [name.trim(), positionId]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === "23505") { // unique_violation
      return res.status(400).json({ error: "This person is already nominated for this position" });
    }
    console.error("Error:", err);
    res.status(500).json({ error: "Failed to add nominee" });
  }
});

// Remove a nominee
app.delete("/api/admin/nominees/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM votes WHERE nominee_id = $1", [req.params.id]);
    await pool.query("DELETE FROM nominees WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Add a position
app.post("/api/admin/positions", requireAdmin, async (req, res) => {
  const { name, maxWinners } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  try {
    const maxOrder = await queryOne("SELECT COALESCE(MAX(display_order), 0) as m FROM positions");
    await pool.query(
      "INSERT INTO positions (name, display_order, max_winners) VALUES ($1, $2, $3)",
      [name.trim(), parseInt(maxOrder.m) + 1, maxWinners || 1]
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
    const posId = req.params.id;
    await pool.query("DELETE FROM votes WHERE position_id = $1", [posId]);
    await pool.query("DELETE FROM nominees WHERE position_id = $1", [posId]);
    await pool.query("DELETE FROM winners WHERE position_id = $1", [posId]);
    await pool.query("DELETE FROM positions WHERE id = $1", [posId]);
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

// Set a winner for a position
app.post("/api/admin/winners", requireAdmin, async (req, res) => {
  const { positionId, nomineeName } = req.body;
  if (!positionId || !nomineeName) {
    return res.status(400).json({ error: "Position and nominee name are required" });
  }
  try {
    await pool.query("INSERT INTO winners (position_id, nominee_name) VALUES ($1, $2)", [positionId, nomineeName]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Failed to set winner" });
  }
});

// Remove a winner
app.delete("/api/admin/winners/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM winners WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Reset all votes
app.post("/api/admin/reset-votes", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM votes");
    await pool.query("DELETE FROM winners");
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
    const totalVotes = await queryOne("SELECT COUNT(*) as count FROM votes");
    res.json({ totalVoters: parseInt(totalVoters.count), totalVotes: parseInt(totalVotes.count) });
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

// Start server after DB is ready
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Lea Singers Voting is running at http://localhost:${PORT}`);
      console.log(`Admin page: http://localhost:${PORT}/admin`);
      console.log(`Results page: http://localhost:${PORT}/results`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
