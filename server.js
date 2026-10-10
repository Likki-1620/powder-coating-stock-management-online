const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("JWT_SECRET is missing. Set it in Render Environment Variables.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   DEFAULT USERS
========================= */

const DEFAULT_USERS = {
  mainadmin: {
    password: process.env.MAIN_ADMIN_PASSWORD || "@MainAdmin123",
    name: "Main Admin"
  },
  pretreatment: {
    password: "@powdercoating123",
    name: "Pre Treatment"
  },
  powdercoating: {
    password: "@powdercoating123",
    name: "Powder Coating"
  }
};

/* =========================
   PRODUCTION DATE
   PRETREATMENT ONLY

   Before 8:00 AM India time:
   use the previous calendar date.

   From 8:00 AM onward:
   use today's date.

   Other users use the ordinary
   India calendar date.
========================= */

function getIndiaParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return result;
}

function formatDateParts(year, month, day) {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function getProductionDateIndia() {
  const parts = getIndiaParts();

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);

  // Build the date using UTC calendar arithmetic so
  // the result does not depend on the server's timezone.
  const date = new Date(Date.UTC(year, month - 1, day));

  if (hour < 8) {
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return formatDateParts(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate()
  );
}

function getIndiaCalendarDate() {
  const parts = getIndiaParts();

  return formatDateParts(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day)
  );
}

/* =========================
   DATABASE
========================= */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      item_code TEXT UNIQUE NOT NULL,
      item_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock (
      item_code TEXT PRIMARY KEY
        REFERENCES items(item_code)
        ON DELETE CASCADE,
      quantity NUMERIC NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL,
      type TEXT NOT NULL,
      remarks TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS completed_stock (
      id SERIAL PRIMARY KEY,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL,
      remarks TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_users (
      username TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Safe migration for an existing PostgreSQL database.
  // Existing transactions are retained.
  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS production_date DATE;
  `);

  // Add a production date to older records that do not have one.
  // This does not alter their created_at timestamps.
  await pool.query(`
    UPDATE transactions
    SET production_date =
      (created_at AT TIME ZONE 'Asia/Kolkata')::date
    WHERE production_date IS NULL;
  `);

  // Create default accounts only when they do not already exist.
  for (const [username, user] of Object.entries(DEFAULT_USERS)) {
    const existing = await pool.query(
      `SELECT username FROM app_users WHERE username = $1`,
      [username]
    );

    if (existing.rowCount === 0) {
      const hash = await bcrypt.hash(user.password, 12);

      await pool.query(
        `INSERT INTO app_users
          (username, name, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (username) DO NOTHING`,
        [username, user.name, hash]
      );
    }
  }

  console.log("Database tables ready");
}

/* =========================
   AUTHENTICATION
========================= */

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Login required"
    });
  }

  const token = header.substring(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired login"
    });
  }
}

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      database: false,
      error: error.message
    });
  }
});

/* =========================
   LOGIN
========================= */

app.post(["/api/login", "/api/login/"], async (req, res) => {
  const username = String(req.body?.username || "")
    .trim()
    .toLowerCase();

  const password = String(req.body?.password || "");

  try {
    const result = await pool.query(
      `SELECT username, name, password_hash
       FROM app_users
       WHERE username = $1`,
      [username]
    );

    const user = result.rows[0];

    if (
      !user ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const token = jwt.sign(
      {
        username: user.username,
        name: user.name
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      username: user.username,
      name: user.name
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Login service unavailable"
    });
  }
});

/* =========================
   MAIN ADMIN PASSWORD CHANGE
========================= */

app.post("/api/admin/change-password", auth, async (req, res) => {
  if (req.user?.username !== "mainadmin") {
    return res.status(403).json({
      error: "Only Main Admin can change passwords"
    });
  }

  const username = String(req.body?.username || "")
    .trim()
    .toLowerCase();

  const password = String(req.body?.password || "");

  if (!["pretreatment", "powdercoating"].includes(username)) {
    return res.status(400).json({
      error: "Invalid department user"
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "Password must be at least 6 characters"
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `UPDATE app_users
       SET password_hash = $1, updated_at = NOW()
       WHERE username = $2`,
      [hash, username]
    );

    if (result.rowCount !== 1) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to change password"
    });
  }
});

/* =========================
   GET ALL DATA
========================= */

app.get("/api/data", auth, async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT
        i.item_code AS "itemCode",
        i.item_name AS "itemName",
        COALESCE(s.quantity, 0) AS quantity
      FROM items i
      LEFT JOIN stock s
        ON s.item_code = i.item_code
      ORDER BY i.item_code
    `);

    const transactions = await pool.query(`
      SELECT
        id,
        item_code AS "itemCode",
        item_name AS "itemName",
        quantity,
        type,
        remarks,
        production_date AS "productionDate",
        created_at AS "createdAt"
      FROM transactions
      ORDER BY created_at DESC, id DESC
    `);

    const completed = await pool.query(`
      SELECT
        id,
        item_code AS "itemCode",
        item_name AS "itemName",
        quantity,
        remarks,
        created_at AS "createdAt"
      FROM completed_stock
      ORDER BY created_at DESC, id DESC
    `);

    res.json({
      items: items.rows,
      transactions: transactions.rows,
      completedStock: completed.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   LIVE STOCK NOTIFICATIONS
========================= */

app.get("/api/notifications", auth, async (req, res) => {
  if (req.user?.username !== "powdercoating") {
    return res.json({ notifications: [] });
  }

  const sinceRaw = String(req.query?.since || "").trim();
  const since = sinceRaw ? new Date(sinceRaw) : new Date();

  if (Number.isNaN(since.getTime())) {
    return res.status(400).json({
      error: "Invalid notification time"
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        item_code AS "itemCode",
        item_name AS "itemName",
        quantity,
        production_date AS "productionDate",
        created_at AS "createdAt"
      FROM transactions
      WHERE type = 'PENDING_RECEIPT'
        AND created_at > $1
      ORDER BY created_at ASC, id ASC
      LIMIT 100
      `,
      [since.toISOString()]
    );

    res.json({
      notifications: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   ADD NEW ITEM
========================= */

app.post("/api/items", auth, async (req, res) => {
  if (req.user?.username !== "mainadmin") {
    return res.status(403).json({
      error: "Only Main Admin can add item codes"
    });
  }

  const { itemCode, itemName } = req.body || {};

  if (!itemCode || !itemName) {
    return res.status(400).json({
      error: "Item code and item name are required"
    });
  }

  const code = String(itemCode).trim();
  const name = String(itemName).trim();

  try {
    const result = await pool.query(
      `
      INSERT INTO items (item_code, item_name)
      VALUES ($1, $2)
      ON CONFLICT (item_code) DO NOTHING
      RETURNING
        item_code AS "itemCode",
        item_name AS "itemName"
      `,
      [code, name]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        error: "Item code already exists"
      });
    }

    await pool.query(
      `
      INSERT INTO stock (item_code, quantity)
      VALUES ($1, 0)
      ON CONFLICT (item_code) DO NOTHING
      `,
      [code]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   ADD STOCK
========================= */

app.post("/api/stock/add", auth, async (req, res) => {
  if (req.user?.username !== "mainadmin") {
    return res.status(403).json({
      error: "Only Main Admin can add or change stock quantities"
    });
  }

  const { itemCode, itemName, quantity, remarks } = req.body || {};
  const qty = Number(quantity);

  if (
    !itemCode ||
    !itemName ||
    !Number.isFinite(qty) ||
    qty <= 0
  ) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const code = String(itemCode).trim();
  const name = String(itemName).trim();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO items (item_code, item_name)
      VALUES ($1, $2)
      ON CONFLICT (item_code)
      DO UPDATE SET item_name = EXCLUDED.item_name
      `,
      [code, name]
    );

    await client.query(
      `
      INSERT INTO stock (item_code, quantity)
      VALUES ($1, $2)
      ON CONFLICT (item_code)
      DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity
      `,
      [code, qty]
    );

    await client.query(
      `
      INSERT INTO transactions
        (item_code, item_name, quantity, type, remarks, production_date)
      VALUES ($1, $2, $3, 'ADD_STOCK', $4, $5)
      `,
      [code, name, qty, remarks || "", getIndiaCalendarDate()]
    );

    await client.query("COMMIT");

    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   SEND STOCK TO POWDER COATING
   PRETREATMENT SENDS USE
   PRODUCTION DATE LOGIC
========================= */

app.post("/api/stock/send", auth, async (req, res) => {
  const { itemCode, itemName, quantity, remarks } = req.body || {};
  const qty = Number(quantity);

  if (
    !itemCode ||
    !itemName ||
    !Number.isFinite(qty) ||
    qty <= 0
  ) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const code = String(itemCode).trim();
  const name = String(itemName).trim();
  const client = await pool.connect();

  // Only Pretreatment uses the 8 AM production-day cutoff.
  // Other users retain ordinary India calendar-date behavior.
  const productionDate =
    req.user?.username === "pretreatment"
      ? getProductionDateIndia()
      : getIndiaCalendarDate();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT quantity
      FROM stock
      WHERE item_code = $1
      FOR UPDATE
      `,
      [code]
    );

    const available = Number(result.rows[0]?.quantity || 0);

    if (qty > available) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Insufficient stock. Available quantity: " + available
      });
    }

    await client.query(
      `
      UPDATE stock
      SET quantity = quantity - $1
      WHERE item_code = $2
      `,
      [qty, code]
    );

    await client.query(
      `
      INSERT INTO transactions
        (item_code, item_name, quantity, type, remarks, production_date)
      VALUES ($1, $2, $3, 'PENDING_RECEIPT', $4, $5)
      `,
      [code, name, qty, remarks || "", productionDate]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      pending: true,
      balance: available - qty,
      productionDate
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   DISPATCH PRETREATMENT STOCK
   TO 305 STORE
========================= */

app.post("/api/stock/dispatch", auth, async (req, res) => {
  if (req.user?.username !== "pretreatment") {
    return res.status(403).json({
      error: "Only Pre Treatment can dispatch stock to 305 Store"
    });
  }

  const { itemCode, itemName, quantity, remarks } = req.body || {};
  const code = String(itemCode || "").trim();
  const name = String(itemName || "").trim();
  const qty = Number(quantity);

  if (!code || !name || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({
      error: "Valid item and dispatch quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT quantity FROM stock WHERE item_code = $1 FOR UPDATE`,
      [code]
    );

    const available = Number(result.rows[0]?.quantity || 0);

    if (qty > available) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Insufficient stock. Available quantity: " + available
      });
    }

    await client.query(
      `UPDATE stock SET quantity = quantity - $1 WHERE item_code = $2`,
      [qty, code]
    );

    await client.query(
      `
      INSERT INTO transactions
        (item_code, item_name, quantity, type, remarks, production_date)
      VALUES ($1, $2, $3, 'DISPATCH_305', $4, $5)
      `,
      [
        code,
        name,
        qty,
        "To: 305 Store" +
          (remarks ? " | " + String(remarks).trim() : ""),
        getProductionDateIndia()
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      destination: "305 Store",
      balance: available - qty
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   ACCEPT PENDING RECEIPT
========================= */

app.post("/api/stock/accept-receipt", auth, async (req, res) => {
  if (req.user?.username !== "powdercoating") {
    return res.status(403).json({
      error: "Only Powder Coating can accept receipts"
    });
  }

  const transactionId = Number(req.body?.transactionId);

  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return res.status(400).json({
      error: "Valid pending receipt is required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT
        id,
        item_code,
        item_name,
        quantity,
        remarks,
        production_date
      FROM transactions
      WHERE id = $1
        AND type = 'PENDING_RECEIPT'
      FOR UPDATE
      `,
      [transactionId]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Pending receipt not found or already accepted"
      });
    }

    const receipt = result.rows[0];

    await client.query(
      `
      UPDATE transactions
      SET type = 'RECEIVE_POWDER'
      WHERE id = $1
      `,
      [transactionId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      itemCode: receipt.item_code,
      itemName: receipt.item_name,
      quantity: receipt.quantity,
      productionDate: receipt.production_date
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   EDIT POWDER COATING BALANCE
========================= */

app.post("/api/stock/edit", auth, async (req, res) => {
  if (req.user?.username !== "mainadmin") {
    return res.status(403).json({
      error: "Only Main Admin can edit stock quantities"
    });
  }

  const { itemCode, itemName, updatedQuantity, remarks } = req.body || {};
  const updated = Number(updatedQuantity);

  if (
    !itemCode ||
    !itemName ||
    !Number.isFinite(updated) ||
    updated < 0
  ) {
    return res.status(400).json({
      error: "Valid item and updated stock quantity are required"
    });
  }

  const code = String(itemCode).trim();
  const name = String(itemName).trim();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receivedResult = await client.query(
      `
      SELECT COALESCE(SUM(quantity), 0) AS total
      FROM transactions
      WHERE item_code = $1 AND type = 'RECEIVE_POWDER'
      `,
      [code]
    );

    const completedResult = await client.query(
      `
      SELECT COALESCE(SUM(quantity), 0) AS total
      FROM completed_stock
      WHERE item_code = $1
      `,
      [code]
    );

    const editedResult = await client.query(
      `
      SELECT COALESCE(SUM(quantity), 0) AS total
      FROM transactions
      WHERE item_code = $1 AND type = 'EDIT_POWDER_STOCK'
      `,
      [code]
    );

    const received = Number(receivedResult.rows[0].total);
    const completed = Number(completedResult.rows[0].total);
    const edited = Number(editedResult.rows[0].total);
    const current = Math.max(0, received - completed + edited);
    const delta = updated - current;

    if (delta === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Updated Stock is the same as current stock"
      });
    }

    await client.query(
      `
      INSERT INTO transactions
        (item_code, item_name, quantity, type, remarks, production_date)
      VALUES ($1, $2, $3, 'EDIT_POWDER_STOCK', $4, $5)
      `,
      [code, name, delta, remarks || "", getIndiaCalendarDate()]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      previousQuantity: current,
      updatedQuantity: updated
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   POWDER COATING COMPLETED
========================= */

app.post("/api/stock/complete", auth, async (req, res) => {
  if (req.user?.username !== "powdercoating") {
    return res.status(403).json({
      error: "Only Powder Coating can complete stock"
    });
  }

  const { itemCode, itemName, quantity, remarks } = req.body || {};
  const qty = Number(quantity);

  if (
    !itemCode ||
    !itemName ||
    !Number.isFinite(qty) ||
    qty <= 0
  ) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const code = String(itemCode).trim();
  const name = String(itemName).trim();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receivedResult = await client.query(
      `
      SELECT COALESCE(SUM(quantity), 0) AS total
      FROM transactions
      WHERE item_code = $1
        AND type = 'RECEIVE_POWDER'
      `,
      [code]
    );

    const completedResult = await client.query(
      `
      SELECT COALESCE(SUM(quantity), 0) AS total
      FROM completed_stock
      WHERE item_code = $1
      `,
      [code]
    );

    const editedResult = await client.query(
      `
      SELECT COALESCE(SUM(quantity), 0) AS total
      FROM transactions
      WHERE item_code = $1
        AND type = 'EDIT_POWDER_STOCK'
      `,
      [code]
    );

    const received = Number(receivedResult.rows[0].total);
    const completed = Number(completedResult.rows[0].total);
    const edited = Number(editedResult.rows[0].total);
    const balance = Math.max(0, received - completed + edited);

    if (qty > balance) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error:
          "Insufficient powder coating balance. Available quantity: " +
          balance
      });
    }

    await client.query(
      `
      INSERT INTO completed_stock
        (item_code, item_name, quantity, remarks)
      VALUES ($1, $2, $3, $4)
      `,
      [code, name, qty, remarks || ""]
    );

    await client.query(
      `
      INSERT INTO transactions
        (item_code, item_name, quantity, type, remarks, production_date)
      VALUES ($1, $2, $3, 'POWDER_COMPLETED', $4, $5)
      `,
      [code, name, qty, remarks || "", getIndiaCalendarDate()]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      balance: balance - qty
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   FRONTEND
========================= */

const FRONTEND_FILE = "index.html";

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, FRONTEND_FILE));
});

/* Express 5 fallback */
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, FRONTEND_FILE));
});

/* =========================
   START SERVER
========================= */

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log("Server running on port " + PORT);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
