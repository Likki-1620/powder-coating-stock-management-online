
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { promisify } = require("util");

const scryptAsync = promisify(crypto.scrypt);
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET || !DATABASE_URL) {
  console.error("ERROR: Set JWT_SECRET and DATABASE_URL in Render.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

/* DATABASE INITIALIZATION */

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
      booth_no TEXT DEFAULT '',
      colour TEXT DEFAULT '',
      operator_name TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_password_credentials (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS shift TEXT,
      ADD COLUMN IF NOT EXISTS send_date DATE,
      ADD COLUMN IF NOT EXISTS send_to TEXT,
      ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

    ALTER TABLE completed_stock
      ADD COLUMN IF NOT EXISTS booth_no TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS colour TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS operator_name TEXT DEFAULT '';
  `);

  console.log("Database tables ready.");
}

/* AUTHENTICATION */

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Login required." });
  }

  try {
    req.user = jwt.verify(header.substring(7), JWT_SECRET);

    if (!USERS[req.user.username]) {
      return res.status(401).json({ error: "Invalid user." });
    }

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

/*
 * PRE TREATMENT:
 * The stock table stores Pre Treatment balance only.
 *
 * POWDER COATING:
 * Accepted receipts
 * + direct additions
 * + stock adjustments
 * - completed stock
 * - dispatched stock
 *
 * Never add ADD_POWDER_STOCK quantities to the shared
 * Pre Treatment stock table.
 */

async function getPowderBalance(client, code) {
  const result = await client.query(
    `SELECT
       COALESCE(SUM(quantity) FILTER (
         WHERE type = 'RECEIVE_POWDER'
       ), 0) AS received,

       COALESCE(SUM(quantity) FILTER (
         WHERE type = 'ADD_POWDER_STOCK'
       ), 0) AS direct_add,

       COALESCE(SUM(quantity) FILTER (
         WHERE type = 'EDIT_POWDER_STOCK'
       ), 0) AS edited,

       COALESCE(SUM(quantity) FILTER (
         WHERE type = 'DISPATCH_STOCK'
       ), 0) AS dispatched

     FROM transactions
     WHERE item_code = $1`,
    [code]
  );

  const completedResult = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS total
     FROM completed_stock
     WHERE item_code = $1`,
    [code]
  );

  const row = result.rows[0];
  const received = Number(row.received) || 0;
  const directAdd = Number(row.direct_add) || 0;
  const edited = Number(row.edited) || 0;
  const dispatched = Number(row.dispatched) || 0;
  const completed = Number(completedResult.rows[0].total) || 0;

  const rawBalance =
    received + directAdd + edited - completed - dispatched;

  return {
    received,
    directAdd,
    edited,
    dispatched,
    completed,
    balance: Math.max(0, rawBalance),
    rawBalance
  };
}

/* HEALTH CHECK */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: true });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      ok: false,
      database: false,
      error: "Database connection failed."
    });
  }
});

/* LOGIN */

app.post(["/api/login", "/api/login/"], async (req, res) => {
  const username = String(req.body?.username || "")
    .trim()
    .toLowerCase();

  const password = req.body?.password;
  const user = USERS[username];

  if (!user || typeof password !== "string") {
    return res.status(401).json({
      error: "Invalid username or password."
    });
  }

  try {
    let valid = false;

    if (username === "mainadmin") {
      const stored = await pool.query(
        `SELECT password_hash, password_salt
         FROM admin_password_credentials
         WHERE username = $1`,
        [username]
      );

      if (stored.rows.length) {
        const row = stored.rows[0];
        const calculated = await scryptAsync(
          password,
          row.password_salt,
          64
        );
        const expected = Buffer.from(row.password_hash, "hex");

        valid =
          expected.length === calculated.length &&
          crypto.timingSafeEqual(expected, calculated);
      } else {
        valid = password === user.password;
      }
    } else {
      valid = password === user.password;
    }

    if (!valid) {
      return res.status(401).json({
        error: "Invalid username or password."
      });
    }

    const token = jwt.sign(
      { username, name: user.name },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      username,
      name: user.name
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      error: "Unable to log in right now."
    });
  }
});

/* MAIN ADMIN CHANGE PASSWORD */

app.post(
  "/api/admin/change-password",
  auth,
  allowUsers("mainadmin"),
  async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      newPassword.length < 8
    ) {
      return res.status(400).json({
        error:
          "Enter current password and a new password of at least 8 characters."
      });
    }

    try {
      const stored = await pool.query(
        `SELECT password_hash, password_salt
         FROM admin_password_credentials
         WHERE username = $1`,
        ["mainadmin"]
      );

      let currentValid = false;

      if (stored.rows.length) {
        const row = stored.rows[0];
        const calculated = await scryptAsync(
          currentPassword,
          row.password_salt,
          64
        );
        const expected = Buffer.from(row.password_hash, "hex");

        currentValid =
          expected.length === calculated.length &&
          crypto.timingSafeEqual(expected, calculated);
      } else {
        currentValid =
          currentPassword === USERS.mainadmin.password;
      }

      if (!currentValid) {
        return res.status(401).json({
          error: "Current password is incorrect."
        });
      }

      const salt = crypto.randomBytes(16).toString("hex");
      const hash = (
        await scryptAsync(newPassword, salt, 64)
      ).toString("hex");

      await pool.query(
        `INSERT INTO admin_password_credentials
           (username, password_hash, password_salt, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (username) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           password_salt = EXCLUDED.password_salt,
           updated_at = NOW()`,
        ["mainadmin", hash, salt]
      );

      res.json({
        success: true,
        message: "Password changed successfully."
      });
    } catch (error) {
      console.error("Change password error:", error);
      res.status(500).json({
        error: "Unable to change password."
      });
    }
  }
);

/* LOAD ITEMS, TRANSACTIONS AND COMPLETED STOCK */

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
        shift,
        send_to AS "sendTo",
        TO_CHAR(send_date, 'DD/MM/YYYY') AS date,
        created_at AS "createdAt",
        received_at AS "receivedAt"
      FROM transactions
      ORDER BY created_at DESC, id DESC
    `);

    const completed = await pool.query(`
      SELECT
        id,
        item_code AS "itemCode",
        item_name AS "itemName",
        quantity,
        booth_no AS "boothNo",
        colour,
        operator_name AS "operatorName",
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
    res.status(500).json({
      error: "Unable to load stock data."
    });
  }
});

/* PENDING RECEIPT NOTIFICATIONS */

app.get("/api/notifications", auth, async (req, res) => {
  if (!["powdercoating", "mainadmin"].includes(req.user.username)) {
    return res.json({ notifications: [] });
  }

  const sinceRaw = String(req.query.since || "").trim();
  const since = sinceRaw ? new Date(sinceRaw) : new Date();

  if (Number.isNaN(since.getTime())) {
    return res.status(400).json({
      error: "Invalid notification time."
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         id,
         item_code AS "itemCode",
         item_name AS "itemName",
         quantity,
         shift,
         created_at AS "createdAt"
       FROM transactions
       WHERE type = 'PENDING_RECEIPT'
         AND created_at > $1
       ORDER BY created_at ASC, id ASC
       LIMIT 100`,
      [since.toISOString()]
    );

    res.json({ notifications: result.rows });
  } catch (error) {
    console.error("Notification error:", error);
    res.status(500).json({
      error: "Unable to load notifications."
    });
  }
});

/* ADD NEW ITEM CODE */

app.post(
  "/api/items",
  auth,
  allowUsers("pretreatment", "powdercoating", "mainadmin"),
  async (req, res) => {
    const { itemCode, itemName } = req.body || {};

    if (!validateItem(itemCode, itemName)) {
      return res.status(400).json({
        error: "Item code and item name are required."
      });
    }

    const code = itemCode.trim();
    const name = itemName.trim();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `INSERT INTO items (item_code, item_name)
         VALUES ($1, $2)
         ON CONFLICT (item_code) DO NOTHING
         RETURNING
           item_code AS "itemCode",
           item_name AS "itemName"`,
        [code, name]
      );

      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Item code already exists."
        });
      }

      // New item starts with zero Pre Treatment stock.
      await client.query(
        `INSERT INTO stock (item_code, quantity)
         VALUES ($1, 0)
         ON CONFLICT (item_code) DO NOTHING`,
        [code]
      );

      await client.query("COMMIT");

      res.json({ success: true, ...result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Add item error:", error);
      res.status(500).json({
        error: "Unable to add item."
      });
    } finally {
      client.release();
    }
  }
);

/*
 * ADD STOCK — DEPARTMENT SEPARATION FIX
 *
 * Pre Treatment:
 *   Increases stock.quantity and records ADD_STOCK.
 *
 * Powder Coating:
 *   Does NOT increase stock.quantity.
 *   Records ADD_POWDER_STOCK only.
 *
 * The department comes from the authenticated login, not
 * from a client-supplied department field.
 */

app.post(
  "/api/stock/add",
  auth,
  allowUsers("pretreatment", "powdercoating"),
  async (req, res) => {
    const { itemCode, itemName, quantity, remarks } = req.body || {};
    const qty = Number(quantity);
    const department = req.user.username;

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
    const note = String(remarks || "");
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

      // This table is reserved for Pre Treatment balance.
      if (department === "pretreatment") {
        await client.query(
          `INSERT INTO stock (item_code, quantity)
           VALUES ($1, $2)
           ON CONFLICT (item_code)
           DO UPDATE SET
             quantity = stock.quantity + EXCLUDED.quantity`,
          [code, qty]
        );
      } else {
        // Ensure the stock row exists but leave its quantity unchanged.
        await client.query(
          `INSERT INTO stock (item_code, quantity)
           VALUES ($1, 0)
           ON CONFLICT (item_code) DO NOTHING`,
          [code]
        );
      }

      const transactionType =
        department === "powdercoating"
          ? "ADD_POWDER_STOCK"
          : "ADD_STOCK";

      await client.query(
        `INSERT INTO transactions
           (item_code, item_name, quantity, type, remarks)
         VALUES ($1, $2, $3, $4, $5)`,
        [code, name, qty, transactionType, note]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        department,
        itemCode: code,
        itemName: name,
        quantity: qty,
        message:
          department === "powdercoating"
            ? "Stock added to Powder Coating only."
            : "Stock added to Pre Treatment only."
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Add stock error:", error);

      res.status(500).json({
        error: "Unable to add stock."
      });
    } finally {
      client.release();
    }
  }
);

/* SEND STOCK FROM PRE TREATMENT TO POWDER COATING */

app.post(
  "/api/stock/send",
  auth,
  allowUsers("pretreatment", "mainadmin"),
  async (req, res) => {
    const {
      itemCode,
      itemName,
      quantity,
      remarks,
      shift,
      date
    } = req.body || {};

    const qty = Number(quantity);
    const dateText = String(date || "").trim();
    const dateMatch = dateText.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    let sendDateISO = null;

    if (dateMatch) {
      const day = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const year = Number(dateMatch[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));

      if (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
      ) {
        sendDateISO =
          `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
      }
    }

    if (!sendDateISO) {
      return res.status(400).json({
        error: "Select a valid Send Date in DD/MM/YYYY format."
      });
    }

    if (!["Day Shift", "Night Shift"].includes(shift)) {
      return res.status(400).json({
        error: "Please select Day Shift or Night Shift."
      });
    }

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

      const result = await client.query(
        `SELECT quantity
         FROM stock
         WHERE item_code = $1
         FOR UPDATE`,
        [code]
      );

      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Pre Treatment stock not found."
        });
      }

      const available = Number(result.rows[0].quantity);

      if (qty > available) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Insufficient Pre Treatment stock. Available quantity: " + available
        });
      }

      await client.query(
        `UPDATE stock
         SET quantity = quantity - $1
         WHERE item_code = $2`,
        [qty, code]
      );

      await client.query(
        `INSERT INTO transactions
           (item_code, item_name, quantity, type, remarks, shift, send_date)
         VALUES ($1, $2, $3, 'PENDING_RECEIPT', $4, $5, $6)`,
        [code, name, qty, String(remarks || ""), shift, sendDateISO]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        pending: true,
        shift,
        balance: available - qty
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Send stock error:", error);
      res.status(500).json({
        error: "Unable to send stock."
      });
    } finally {
      client.release();
    }
  }
);

/* DISPATCH STOCK: POWDER COATING ONLY */

app.post(
  "/api/stock/dispatch",
  auth,
  allowUsers("powdercoating"),
  async (req, res) => {
    const { itemCode, itemName, quantity, sendTo, remarks } =
      req.body || {};

    const code = String(itemCode || "").trim();
    const name = String(itemName || "").trim();
    const qty = Number(quantity);
    const destination = String(sendTo || "").trim();

    if (
      !validateItem(code, name) ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      !["305 store", "QC-1A"].includes(destination)
    ) {
      return res.status(400).json({
        error:
          "Enter a valid item, quantity and destination (305 store or QC-1A)."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const itemResult = await client.query(
        `SELECT item_code
         FROM items
         WHERE item_code = $1
         FOR UPDATE`,
        [code]
      );

      if (!itemResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Item code not found."
        });
      }

      const powder = await getPowderBalance(client, code);

      if (powder.rawBalance < 0 || qty > powder.balance) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "Insufficient Powder Coating stock. Available quantity: " +
            powder.balance,
          balance: powder.balance
        });
      }

      await client.query(
        `INSERT INTO transactions
           (item_code, item_name, quantity, type, remarks, send_to)
         VALUES ($1, $2, $3, 'DISPATCH_STOCK', $4, $5)`,
        [code, name, qty, String(remarks || "").trim(), destination]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        itemCode: code,
        itemName: name,
        quantity: qty,
        sendTo: destination,
        balance: powder.balance - qty
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Powder Coating dispatch error:", error);
      res.status(500).json({
        error: "Unable to dispatch Powder Coating stock."
      });
    } finally {
      client.release();
    }
  }
);

/* ACCEPT PENDING RECEIPT */

app.post(
  "/api/stock/accept-receipt",
  auth,
  allowUsers("powdercoating", "mainadmin"),
  async (req, res) => {
    const transactionId = Number(
      req.body?.transactionId ?? req.body?.id
    );

    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return res.status(400).json({
        error: "Valid pending receipt is required."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT
           id,
           item_code,
           item_name,
           quantity,
           remarks,
           shift,
           TO_CHAR(send_date, 'DD/MM/YYYY') AS date
         FROM transactions
         WHERE id = $1 AND type = 'PENDING_RECEIPT'
         FOR UPDATE`,
        [transactionId]
      );

      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Pending receipt not found or already accepted."
        });
      }

      const receipt = result.rows[0];

      await client.query(
        `UPDATE transactions
         SET type = 'RECEIVE_POWDER',
             received_at = NOW()
         WHERE id = $1`,
        [transactionId]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        itemCode: receipt.item_code,
        itemName: receipt.item_name,
        quantity: receipt.quantity,
        shift: receipt.shift,
        date: receipt.date,
        receivedAt: new Date().toISOString()
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Accept receipt error:", error);
      res.status(500).json({
        error: "Unable to accept stock."
      });
    } finally {
      client.release();
    }
  }
);

/* EDIT POWDER COATING BALANCE */

app.post(
  "/api/stock/edit",
  auth,
  allowUsers("powdercoating", "mainadmin"),
  async (req, res) => {
    const { itemCode, itemName, updatedQuantity, remarks } =
      req.body || {};

    const code = String(itemCode || "").trim();
    const name = String(itemName || "").trim();
    const updated = Number(updatedQuantity);

    if (
      !validateItem(code, name) ||
      !Number.isFinite(updated) ||
      updated < 0
    ) {
      return res.status(400).json({
        error: "Enter a valid item and updated stock quantity."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const itemResult = await client.query(
        `SELECT item_code
         FROM items
         WHERE item_code = $1
         FOR UPDATE`,
        [code]
      );

      if (!itemResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Item code not found."
        });
      }

      const powder = await getPowderBalance(client, code);
      const current = powder.balance;
      const delta = updated - current;

      if (delta === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Updated stock is the same as current stock.",
          currentQuantity: current
        });
      }

      await client.query(
        `INSERT INTO transactions
           (item_code, item_name, quantity, type, remarks)
         VALUES ($1, $2, $3, 'EDIT_POWDER_STOCK', $4)`,
        [code, name, delta, String(remarks || "").trim()]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "Powder Coating stock updated successfully.",
        itemCode: code,
        previousQuantity: current,
        updatedQuantity: updated
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Edit Powder Coating stock error:", error);
      res.status(500).json({
        error: "Unable to edit stock."
      });
    } finally {
      client.release();
    }
  }
);

/* POWDER COATING COMPLETED STOCK */

app.post(
  "/api/stock/complete",
  auth,
  allowUsers("powdercoating", "mainadmin"),
  async (req, res) => {
    const {
      itemCode,
      itemName,
      quantity,
      boothNo,
      colour,
      operatorName,
      remarks
    } = req.body || {};

    const code = String(itemCode || "").trim();
    const name = String(itemName || "").trim();
    const qty = Number(quantity);
    const booth = String(boothNo || "").trim();
    const selectedColour = String(colour || "").trim();
    const operator = String(operatorName || "").trim();
    const note = String(remarks || "").trim();

    const validBooths = ["1", "2", "3", "4", "5", "6", "DL"];

    const validColours = [
      "IGP Blue",
      "IGP Grey",
      "Sky Blue",
      "White",
      "Black",
      "Mint Green",
      "ABB Grey",
      "GP Black",
      "Sparkle Silver",
      "Strom Grey",
      "Ral 7001",
      "Ral 7044",
      "Dry Lubricant"
    ];

    const validOperators = [
      "Suresh",
      "Anji",
      "Rajiv",
      "Sonu",
      "Gobinda",
      "Ranjan",
      "Bikas",
      "Noor Islam",
      "Tiwari"
    ];

    if (
      !validateItem(code, name) ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      return res.status(400).json({
        error: "Enter a valid item and quantity."
      });
    }

    if (!validBooths.includes(booth)) {
      return res.status(400).json({
        error: "Please select a valid Booth No. or DL."
      });
    }

    if (!validColours.includes(selectedColour)) {
      return res.status(400).json({
        error: "Please select a valid colour."
      });
    }

    if (!validOperators.includes(operator)) {
      return res.status(400).json({
        error: "Please select a valid operator name."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const itemResult = await client.query(
        `SELECT item_code
         FROM items
         WHERE item_code = $1
         FOR UPDATE`,
        [code]
      );

      if (!itemResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Item code not found."
        });
      }

      const powder = await getPowderBalance(client, code);
      const balance = powder.balance;

      if (powder.rawBalance < 0 || qty > balance) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Insufficient balance. Available quantity: " + balance
        });
      }

      await client.query(
        `INSERT INTO completed_stock
           (
             item_code,
             item_name,
             quantity,
             booth_no,
             colour,
             operator_name,
             remarks
           )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [code, name, qty, booth, selectedColour, operator, note]
      );

      await client.query(
        `INSERT INTO transactions
           (item_code, item_name, quantity, type, remarks)
         VALUES ($1, $2, $3, 'POWDER_COMPLETED', $4)`,
        [code, name, qty, note]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        balance: balance - qty
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Complete stock error:", error);
      res.status(500).json({
        error: "Unable to save completed stock."
      });
    } finally {
      client.release();
    }
  }
);

/* CLEAR ALL STOCK
 * Destructive endpoint. Use only after a deliberate backup
 * and explicit confirmation from the website.
 */

app.post(
  "/api/admin/reset-stock",
  auth,
  allowUsers("powdercoating"),
  async (req, res) => {
    if (req.body?.confirmation !== "CLEAR ALL STOCK DATA") {
      return res.status(400).json({
        error: 'Confirmation text must be "CLEAR ALL STOCK DATA".'
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query("DELETE FROM transactions");
      await client.query("DELETE FROM completed_stock");

      await client.query(
        `INSERT INTO stock (item_code, quantity)
         SELECT item_code, 0
         FROM items
         ON CONFLICT (item_code)
         DO UPDATE SET quantity = 0`
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message:
          "All stock data cleared. Item codes and names are preserved."
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Stock reset error:", error);
      res.status(500).json({
        error: "Unable to clear stock data."
      });
    } finally {
      client.release();
    }
  }
);

/* SERVE WEBSITE */

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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

/* ERROR HANDLER */

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Internal server error."
  });
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
