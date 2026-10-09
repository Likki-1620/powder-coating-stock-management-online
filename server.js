const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("ERROR: Set JWT_SECRET in Render Environment Variables.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   USERS
========================= */

const USERS = {
  mainadmin: {
    password: process.env.MAIN_ADMIN_PASSWORD || "@MainAdmin123",
    name: "Main Admin"
  },
  pretreatment: {
    password: process.env.PRETREATMENT_PASSWORD || "@powdercoating123",
    name: "Pre Treatment"
  },
  powdercoating: {
    password: process.env.POWDERCOATING_PASSWORD || "@powdercoating123",
    name: "Powder Coating"
  }
};

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
        REFERENCES items(item_code) ON DELETE CASCADE,
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
  `);

  console.log("Database tables ready.");
}

/* =========================
   AUTHENTICATION
========================= */

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Login required."
    });
  }

  try {
    req.user = jwt.verify(header.substring(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired login. Please log in again."
    });
  }
}

function allowUsers(...usernames) {
  return (req, res, next) => {
    if (!usernames.includes(req.user?.username)) {
      return res.status(403).json({
        error: "You do not have permission to perform this action."
      });
    }
    next();
  };
}

function validateItem(itemCode, itemName) {
  return (
    typeof itemCode === "string" &&
    itemCode.trim().length > 0 &&
    typeof itemName === "string" &&
    itemName.trim().length > 0
  );
}

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      database: false,
      error: "Database connection failed."
    });
  }
});

/* =========================
   LOGIN
========================= */

app.post(["/api/login", "/api/login/"], (req, res) => {
  const { username, password } = req.body || {};
  const user = USERS[username];

  if (
    !user ||
    typeof password !== "string" ||
    password !== user.password
  ) {
    return res.status(401).json({
      error: "Invalid username or password."
    });
  }

  const token = jwt.sign(
    {
      username,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    success: true,
    token,
    username,
    name: user.name
  });
});

/* =========================
   GET ALL STOCK DATA
========================= */

app.get("/api/data", auth, async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT
        i.item_code AS "itemCode",
        i.item_name AS "itemName",
        COALESCE(s.quantity, 0) AS quantity
      FROM items i
      LEFT JOIN stock s ON s.item_code = i.item_code
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
    console.error("Get data error:", error);
    res.status(500).json({ error: "Unable to load stock data." });
  }
});

/* =========================
   NOTIFICATIONS
========================= */

app.get("/api/notifications", auth, async (req, res) => {
  if (!["powdercoating", "mainadmin"].includes(req.user.username)) {
    return res.json({ notifications: [] });
  }

  const sinceRaw = String(req.query.since || "").trim();
  const since = sinceRaw ? new Date(sinceRaw) : new Date();

  if (Number.isNaN(since.getTime())) {
    return res.status(400).json({ error: "Invalid notification time." });
  }

  try {
    const result = await pool.query(`
      SELECT
        id,
        item_code AS "itemCode",
        item_name AS "itemName",
        quantity,
        created_at AS "createdAt"
      FROM transactions
      WHERE type = 'PENDING_RECEIPT'
        AND created_at > $1
      ORDER BY created_at ASC, id ASC
      LIMIT 100
    `, [since.toISOString()]);

    res.json({ notifications: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to load notifications." });
  }
});

/* =========================
   ADD ITEM CODE
========================= */

app.post(
  "/api/items",
  auth,
  allowUsers("mainadmin"),
  async (req, res) => {
    const { itemCode, itemName } = req.body || {};

    if (!validateItem(itemCode, itemName)) {
      return res.status(400).json({
        error: "Item code and item name are required."
      });
    }

    const code = itemCode.trim();
    const name = itemName.trim();

    try {
      const result = await pool.query(`
        INSERT INTO items (item_code, item_name)
        VALUES ($1, $2)
        ON CONFLICT (item_code) DO NOTHING
        RETURNING item_code AS "itemCode",
                  item_name AS "itemName"
      `, [code, name]);

      if (result.rowCount === 0) {
        return res.status(409).json({
          error: "Item code already exists."
        });
      }

      await pool.query(`
        INSERT INTO stock (item_code, quantity)
        VALUES ($1, 0)
        ON CONFLICT (item_code) DO NOTHING
      `, [code]);

      res.json({ success: true, ...result.rows[0] });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Unable to add item." });
    }
  }
);

/* =========================
   ADD PRE TREATMENT STOCK
========================= */

app.post(
  "/api/stock/add",
  auth,
  allowUsers("pretreatment", "mainadmin"),
  async (req, res) => {
    const { itemCode, itemName, quantity, remarks } = req.body || {};
    const qty = Number(quantity);

    if (
      !validateItem(itemCode, itemName) ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      return res.status(400).json({
        error: "Enter a valid item code, item name and quantity."
      });
    }

    const code = itemCode.trim();
    const name = itemName.trim();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(`
        INSERT INTO items (item_code, item_name)
        VALUES ($1, $2)
        ON CONFLICT (item_code)
        DO UPDATE SET item_name = EXCLUDED.item_name
      `, [code, name]);

      await client.query(`
        INSERT INTO stock (item_code, quantity)
        VALUES ($1, $2)
        ON CONFLICT (item_code)
        DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity
      `, [code, qty]);

      await client.query(`
        INSERT INTO transactions
          (item_code, item_name, quantity, type, remarks)
        VALUES ($1, $2, $3, 'ADD_STOCK', $4)
      `, [code, name, qty, remarks || ""]);

      await client.query("COMMIT");
      res.json({ success: true });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res.status(500).json({ error: "Unable to add stock." });
    } finally {
      client.release();
    }
  }
);

/* =========================
   SEND STOCK TO POWDER COATING
========================= */

app.post(
  "/api/stock/send",
  auth,
  allowUsers("pretreatment", "mainadmin"),
  async (req, res) => {
    const { itemCode, itemName, quantity, remarks } = req.body || {};
    const qty = Number(quantity);

    if (
      !validateItem(itemCode, itemName) ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      return res.status(400).json({
        error: "Enter a valid item and quantity."
      });
    }

    const code = itemCode.trim();
    const name = itemName.trim();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(`
        SELECT quantity FROM stock
        WHERE item_code = $1
        FOR UPDATE
      `, [code]);

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Item stock not found." });
      }

      const available = Number(result.rows[0].quantity);

      if (qty > available) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Insufficient stock. Available quantity: " + available
        });
      }

      await client.query(`
        UPDATE stock
        SET quantity = quantity - $1
        WHERE item_code = $2
      `, [qty, code]);

      await client.query(`
        INSERT INTO transactions
          (item_code, item_name, quantity, type, remarks)
        VALUES ($1, $2, $3, 'PENDING_RECEIPT', $4)
      `, [code, name, qty, remarks || ""]);

      await client.query("COMMIT");

      res.json({
        success: true,
        pending: true,
        balance: available - qty
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res.status(500).json({ error: "Unable to send stock." });
    } finally {
      client.release();
    }
  }
);

/* =========================
   ACCEPT PENDING RECEIPT
========================= */

app.post(
  "/api/stock/accept-receipt",
  auth,
  allowUsers("powdercoating", "mainadmin"),
  async (req, res) => {
    const transactionId = Number(req.body?.transactionId);

    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return res.status(400).json({
        error: "Valid pending receipt is required."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(`
        SELECT id, item_code, item_name, quantity, remarks
        FROM transactions
        WHERE id = $1 AND type = 'PENDING_RECEIPT'
        FOR UPDATE
      `, [transactionId]);

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Pending receipt not found or already accepted."
        });
      }

      const receipt = result.rows[0];

      await client.query(`
        UPDATE transactions
        SET type = 'RECEIVE_POWDER'
        WHERE id = $1
      `, [transactionId]);

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
      res.status(500).json({ error: "Unable to accept receipt." });
    } finally {
      client.release();
    }
  }
);

/* =========================
   EDIT POWDER COATING BALANCE
========================= */

app.post(
  "/api/stock/edit",
  auth,
  allowUsers("mainadmin"),
  async (req, res) => {
    const { itemCode, itemName, updatedQuantity, remarks } = req.body || {};
    const updated = Number(updatedQuantity);

    if (
      !validateItem(itemCode, itemName) ||
      !Number.isFinite(updated) ||
      updated < 0
    ) {
      return res.status(400).json({
        error: "Enter a valid item and updated stock quantity."
      });
    }

    const code = itemCode.trim();
    const name = itemName.trim();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const receivedResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM transactions
        WHERE item_code = $1 AND type = 'RECEIVE_POWDER'
      `, [code]);

      const completedResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM completed_stock
        WHERE item_code = $1
      `, [code]);

      const editedResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM transactions
        WHERE item_code = $1 AND type = 'EDIT_POWDER_STOCK'
      `, [code]);

      const received = Number(receivedResult.rows[0].total);
      const completed = Number(completedResult.rows[0].total);
      const edited = Number(editedResult.rows[0].total);
      const current = Math.max(0, received - completed + edited);
      const delta = updated - current;

      if (delta === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Updated stock is the same as current stock."
        });
      }

      await client.query(`
        INSERT INTO transactions
          (item_code, item_name, quantity, type, remarks)
        VALUES ($1, $2, $3, 'EDIT_POWDER_STOCK', $4)
      `, [code, name, delta, remarks || ""]);

      await client.query("COMMIT");

      res.json({
        success: true,
        previousQuantity: current,
        updatedQuantity: updated
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res.status(500).json({ error: "Unable to edit stock." });
    } finally {
      client.release();
    }
  }
);

/* =========================
   POWDER COATING COMPLETED STOCK
========================= */

app.post(
  "/api/stock/complete",
  auth,
  allowUsers("powdercoating", "mainadmin"),
  async (req, res) => {
    const { itemCode, itemName, quantity, remarks } = req.body || {};
    const qty = Number(quantity);

    if (
      !validateItem(itemCode, itemName) ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      return res.status(400).json({
        error: "Enter a valid item and quantity."
      });
    }

    const code = itemCode.trim();
    const name = itemName.trim();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const receivedResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM transactions
        WHERE item_code = $1 AND type = 'RECEIVE_POWDER'
      `, [code]);

      const completedResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM completed_stock
        WHERE item_code = $1
      `, [code]);

      const editedResult = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM transactions
        WHERE item_code = $1 AND type = 'EDIT_POWDER_STOCK'
      `, [code]);

      const received = Number(receivedResult.rows[0].total);
      const completed = Number(completedResult.rows[0].total);
      const edited = Number(editedResult.rows[0].total);
      const balance = Math.max(0, received - completed + edited);

      if (qty > balance) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Insufficient balance. Available quantity: " + balance
        });
      }

      await client.query(`
        INSERT INTO completed_stock
          (item_code, item_name, quantity, remarks)
        VALUES ($1, $2, $3, $4)
      `, [code, name, qty, remarks || ""]);

      await client.query(`
        INSERT INTO transactions
          (item_code, item_name, quantity, type, remarks)
        VALUES ($1, $2, $3, 'POWDER_COMPLETED', $4)
      `, [code, name, qty, remarks || ""]);

      await client.query("COMMIT");

      res.json({
        success: true,
        balance: balance - qty
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(error);
      res.status(500).json({ error: "Unable to save completed stock." });
    } finally {
      client.release();
    }
  }
);

/* =========================
   SERVE WEBSITE
========================= */

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* Express 5 fallback: return index.html for website routes */
app.get("/{*splat}", (req, res, next) => {
  const indexFile = path.join(__dirname, "index.html");

  if (!fs.existsSync(indexFile)) {
    return res.status(404).send("index.html was not found.");
  }

  res.sendFile(indexFile, error => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
});

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Internal server error."
  });
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
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
