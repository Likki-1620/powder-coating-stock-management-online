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

if (!process.env.DATABASE_URL || !JWT_SECRET) {
  console.error("DATABASE_URL or JWT_SECRET is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      item_code TEXT UNIQUE NOT NULL,
      item_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock (
      item_code TEXT PRIMARY KEY REFERENCES items(item_code)
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

  for (const [username, user] of Object.entries(DEFAULT_USERS)) {
    const hash = await bcrypt.hash(user.password, 12);

    await pool.query(
      `INSERT INTO app_users (username, name, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      [username, user.name, hash]
    );
  }

  console.log("Database tables ready");
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Login required" });
  }

  try {
    req.user = jwt.verify(header.substring(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired login"
    });
  }
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: false,
      error: error.message
    });
  }
});

app.post(["/api/login", "/api/login/"], async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  try {
    const result = await pool.query(
      `SELECT username, name, password_hash
       FROM app_users WHERE username = $1`,
      [username]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const token = jwt.sign(
      { username: user.username, name: user.name },
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
    res.status(500).json({ error: "Login service unavailable" });
  }
});

app.get("/api/data", auth, async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT i.item_code AS "itemCode",
             i.item_name AS "itemName",
             COALESCE(s.quantity, 0) AS quantity
      FROM items i
      LEFT JOIN stock s ON s.item_code = i.item_code
      ORDER BY i.item_code
    `);

    const transactions = await pool.query(`
      SELECT id,
             item_code AS "itemCode",
             item_name AS "itemName",
             quantity, type, remarks,
             created_at AS "createdAt"
      FROM transactions
      ORDER BY created_at DESC, id DESC
    `);

    const completed = await pool.query(`
      SELECT id,
             item_code AS "itemCode",
             item_name AS "itemName",
             quantity, remarks,
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
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/items", auth, async (req, res) => {
  if (req.user.username !== "mainadmin") {
    return res.status(403).json({
      error: "Only Main Admin can add item codes"
    });
  }

  const code = String(req.body?.itemCode || "").trim();
  const name = String(req.body?.itemName || "").trim();

  if (!code || !name) {
    return res.status(400).json({
      error: "Item code and item name are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO items (item_code, item_name)
       VALUES ($1, $2)`,
      [code, name]
    );

    await client.query(
      `INSERT INTO stock (item_code, quantity)
       VALUES ($1, 0)`,
      [code]
    );

    await client.query("COMMIT");
    res.json({ success: true, itemCode: code, itemName: name });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/* ADD STOCK */
app.post("/api/stock/add", auth, async (req, res) => {
  if (req.user.username !== "mainadmin") {
    return res.status(403).json({
      error: "Only Main Admin can add stock"
    });
  }

  const code = String(req.body?.itemCode || "").trim();
  const name = String(req.body?.itemName || "").trim();
  const qty = Number(req.body?.quantity);
  const remarks = String(req.body?.remarks || "");

  if (!code || !name || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO items (item_code, item_name)
       VALUES ($1, $2)
       ON CONFLICT (item_code)
       DO UPDATE SET item_name = EXCLUDED.item_name`,
      [code, name]
    );

    await client.query(
      `INSERT INTO stock (item_code, quantity)
       VALUES ($1, $2)
       ON CONFLICT (item_code)
       DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity`,
      [code, qty]
    );

    await client.query(
      `INSERT INTO transactions
       (item_code, item_name, quantity, type, remarks)
       VALUES ($1, $2, $3, 'ADD_STOCK', $4)`,
      [code, name, qty, remarks]
    );

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/* SEND STOCK TO POWDER COATING */
app.post("/api/stock/send", auth, async (req, res) => {
  const code = String(req.body?.itemCode || "").trim();
  const name = String(req.body?.itemName || "").trim();
  const qty = Number(req.body?.quantity);
  const remarks = String(req.body?.remarks || "");

  if (!code || !name || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT quantity FROM stock
       WHERE item_code = $1 FOR UPDATE`,
      [code]
    );

    const available = Number(result.rows[0]?.quantity || 0);

    if (qty > available) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Insufficient stock. Available quantity: ${available}`
      });
    }

    await client.query(
      `UPDATE stock SET quantity = quantity - $1
       WHERE item_code = $2`,
      [qty, code]
    );

    await client.query(
      `INSERT INTO transactions
       (item_code, item_name, quantity, type, remarks)
       VALUES ($1, $2, $3, 'PENDING_RECEIPT', $4)`,
      [code, name, qty, remarks]
    );

    await client.query("COMMIT");
    res.json({ success: true, pending: true, balance: available - qty });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/* DISPATCH PRE TREATMENT STOCK TO 305 STORE */
app.post("/api/stock/dispatch", auth, async (req, res) => {
  if (req.user.username !== "pretreatment") {
    return res.status(403).json({
      error: "Only Pre Treatment can dispatch stock to 305 Store"
    });
  }

  const code = String(req.body?.itemCode || "").trim();
  const name = String(req.body?.itemName || "").trim();
  const qty = Number(req.body?.quantity);
  const remarks = String(req.body?.remarks || "").trim();

  if (!code || !name || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({
      error: "Valid item and dispatch quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT quantity FROM stock
       WHERE item_code = $1 FOR UPDATE`,
      [code]
    );

    const available = Number(result.rows[0]?.quantity || 0);

    if (qty > available) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Insufficient stock. Available quantity: ${available}`
      });
    }

    await client.query(
      `UPDATE stock SET quantity = quantity - $1
       WHERE item_code = $2`,
      [qty, code]
    );

    await client.query(
      `INSERT INTO transactions
       (item_code, item_name, quantity, type, remarks)
       VALUES ($1, $2, $3, 'DISPATCH_305', $4)`,
      [code, name, qty, "To: 305 Store" + (remarks ? " | " + remarks : "")]
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
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/* ACCEPT POWDER COATING RECEIPT */
app.post("/api/stock/accept-receipt", auth, async (req, res) => {
  if (req.user.username !== "powdercoating") {
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
      `SELECT id, item_code, item_name, quantity
       FROM transactions
       WHERE id = $1 AND type = 'PENDING_RECEIPT'
       FOR UPDATE`,
      [transactionId]
    );

    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Pending receipt not found or already accepted"
      });
    }

    const receipt = result.rows[0];

    await client.query(
      `UPDATE transactions SET type = 'RECEIVE_POWDER'
       WHERE id = $1`,
      [transactionId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      itemCode: receipt.item_code,
      itemName: receipt.item_name,
      quantity: receipt.quantity
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/* EDIT POWDER COATING STOCK */
app.post("/api/stock/edit", auth, async (req, res) => {
  if (req.user.username !== "mainadmin") {
    return res.status(403).json({
      error: "Only Main Admin can edit stock quantities"
    });
  }

  const code = String(req.body?.itemCode || "").trim();
  const name = String(req.body?.itemName || "").trim();
  const updated = Number(req.body?.updatedQuantity);
  const remarks = String(req.body?.remarks || "");

  if (!code || !name || !Number.isFinite(updated) || updated < 0) {
    return res.status(400).json({
      error: "Valid item and updated stock quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receivedResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM transactions
       WHERE item_code = $1 AND type = 'RECEIVE_POWDER'`,
      [code]
    );

    const completedResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM completed_stock WHERE item_code = $1`,
      [code]
    );

    const editedResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM transactions
       WHERE item_code = $1 AND type = 'EDIT_POWDER_STOCK'`,
      [code]
    );

    const current =
      Number(receivedResult.rows[0].total) -
      Number(completedResult.rows[0].total) +
      Number(editedResult.rows[0].total);

    const delta = updated - Math.max(0, current);

    if (delta === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Updated stock is the same as current stock"
      });
    }

    await client.query(
      `INSERT INTO transactions
       (item_code, item_name, quantity, type, remarks)
       VALUES ($1, $2, $3, 'EDIT_POWDER_STOCK', $4)`,
      [code, name, delta, remarks]
    );

    await client.query("COMMIT");
    res.json({ success: true, updatedQuantity: updated });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/* MARK POWDER COATING STOCK AS COMPLETED */
app.post("/api/stock/complete", auth, async (req, res) => {
  const code = String(req.body?.itemCode || "").trim();
  const name = String(req.body?.itemName || "").trim();
  const qty = Number(req.body?.quantity);
  const remarks = String(req.body?.remarks || "");

  if (!code || !name || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receivedResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM transactions
       WHERE item_code = $1 AND type = 'RECEIVE_POWDER'`,
      [code]
    );

    const completedResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM completed_stock WHERE item_code = $1`,
      [code]
    );

    const editedResult = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM transactions
       WHERE item_code = $1 AND type = 'EDIT_POWDER_STOCK'`,
      [code]
    );

    const balance = Math.max(
      0,
      Number(receivedResult.rows[0].total) -
      Number(completedResult.rows[0].total) +
      Number(editedResult.rows[0].total)
    );

    if (qty > balance) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Insufficient powder coating balance. Available: ${balance}`
      });
    }

    await client.query(
      `INSERT INTO completed_stock
       (item_code, item_name, quantity, remarks)
       VALUES ($1, $2, $3, $4)`,
      [code, name, qty, remarks]
    );

    await client.query(
      `INSERT INTO transactions
       (item_code, item_name, quantity, type, remarks)
       VALUES ($1, $2, $3, 'POWDER_COMPLETED', $4)`,
      [code, name, qty, remarks]
    );

    await client.query("COMMIT");
    res.json({ success: true, balance: balance - qty });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

/* FRONTEND */
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* Express 5 fallback */
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* START SERVER */
initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log("Server running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
