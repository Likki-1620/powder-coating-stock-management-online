const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "powder-stock-secret-2026";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const USERS = {
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
   DATABASE SETUP
========================= */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      item_code TEXT PRIMARY KEY,
      item_name TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock (
      item_code TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      pre_treatment NUMERIC DEFAULT 0,
      powder_coating NUMERIC DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL,
      type TEXT NOT NULL,
      remarks TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS completed_stock (
      id SERIAL PRIMARY KEY,
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL,
      remarks TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("Database initialized");
}

/* =========================
   AUTH
========================= */

function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    const token = header.substring(7);

    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired token"
    });
  }
}

/* =========================
   LOGIN
========================= */

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  let userKey = null;

  if (
    username.toLowerCase() === "pre treatment" ||
    username.toLowerCase() === "pretreatment"
  ) {
    userKey = "pretreatment";
  }

  if (
    username.toLowerCase() === "powder coating" ||
    username.toLowerCase() === "powdercoating"
  ) {
    userKey = "powdercoating";
  }

  if (!userKey || USERS[userKey].password !== password) {
    return res.status(401).json({
      error: "Invalid username or password"
    });
  }

  const token = jwt.sign(
    {
      username: userKey,
      name: USERS[userKey].name
    },
    JWT_SECRET,
    {
      expiresIn: "24h"
    }
  );

  res.json({
    success: true,
    token,
    username: userKey,
    name: USERS[userKey].name
  });
});

/* =========================
   CURRENT USER
========================= */

app.get("/api/me", auth, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

/* =========================
   ITEMS
========================= */

app.get("/api/items", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        item_code AS "itemCode",
        item_name AS "itemName"
      FROM items
      ORDER BY item_code
    `);

    res.json({
      items: result.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message
    });
  }
});

app.post("/api/items", auth, async (req, res) => {
  try {
    const itemCode = String(req.body?.itemCode || "").trim();
    const itemName = String(req.body?.itemName || "").trim();

    if (!itemCode || !itemName) {
      return res.status(400).json({
        error: "Item code and item name are required"
      });
    }

    await pool.query(
      `
      INSERT INTO items (item_code, item_name)
      VALUES ($1, $2)
      ON CONFLICT (item_code)
      DO UPDATE SET item_name = EXCLUDED.item_name
      `,
      [itemCode, itemName]
    );

    await pool.query(
      `
      INSERT INTO stock (
        item_code,
        item_name,
        pre_treatment,
        powder_coating
      )
      VALUES ($1, $2, 0, 0)
      ON CONFLICT (item_code)
      DO UPDATE SET item_name = EXCLUDED.item_name
      `,
      [itemCode, itemName]
    );

    res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   STOCK
========================= */

app.get("/api/stock", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        item_code AS "itemCode",
        item_name AS "itemName",
        pre_treatment AS "preTreatment",
        powder_coating AS "powderCoating"
      FROM stock
      ORDER BY item_code
    `);

    res.json({
      stock: result.rows
    });
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
  if (req.user?.username !== "pretreatment") {
    return res.status(403).json({
      error: "Only Pre Treatment can add stock"
    });
  }

  const client = await pool.connect();

  try {
    const itemCode = String(req.body?.itemCode || "").trim();
    const itemName = String(req.body?.itemName || "").trim();
    const quantity = Number(req.body?.quantity);
    const remarks = String(req.body?.remarks || "").trim();

    if (!itemCode || !itemName || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({
        error: "Invalid stock details"
      });
    }

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO items (item_code, item_name)
      VALUES ($1, $2)
      ON CONFLICT (item_code)
      DO UPDATE SET item_name = EXCLUDED.item_name
      `,
      [itemCode, itemName]
    );

    await client.query(
      `
      INSERT INTO stock (
        item_code,
        item_name,
        pre_treatment,
        powder_coating
      )
      VALUES ($1, $2, $3, 0)
      ON CONFLICT (item_code)
      DO UPDATE SET
        item_name = EXCLUDED.item_name,
        pre_treatment = stock.pre_treatment + EXCLUDED.pre_treatment
      `,
      [itemCode, itemName, quantity]
    );

    await client.query(
      `
      INSERT INTO transactions (
        item_code,
        item_name,
        quantity,
        type,
        remarks
      )
      VALUES ($1, $2, $3, 'ADD_STOCK', $4)
      `,
      [itemCode, itemName, quantity, remarks]
    );

    await client.query("COMMIT");

    res.json({
      success: true
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
   SEND STOCK
   PRE TREATMENT -> POWDER COATING
========================= */

app.post("/api/stock/send", auth, async (req, res) => {
  if (req.user?.username !== "pretreatment") {
    return res.status(403).json({
      error: "Only Pre Treatment can send stock"
    });
  }

  const client = await pool.connect();

  try {
    const itemCode = String(req.body?.itemCode || "").trim();
    const itemName = String(req.body?.itemName || "").trim();
    const quantity = Number(req.body?.quantity);
    const remarks = String(req.body?.remarks || "").trim();

    if (!itemCode || !itemName || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({
        error: "Invalid stock details"
      });
    }

    await client.query("BEGIN");

    const stockResult = await client.query(
      `
      SELECT pre_treatment
      FROM stock
      WHERE item_code = $1
      FOR UPDATE
      `,
      [itemCode]
    );

    if (stockResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Item stock not found"
      });
    }

    const available = Number(stockResult.rows[0].pre_treatment || 0);

    if (quantity > available) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Insufficient Pre Treatment stock"
      });
    }

    await client.query(
      `
      UPDATE stock
      SET
        pre_treatment = pre_treatment - $1,
        item_name = $2
      WHERE item_code = $3
      `,
      [quantity, itemName, itemCode]
    );

    await client.query(
      `
      INSERT INTO transactions (
        item_code,
        item_name,
        quantity,
        type,
        remarks
      )
      VALUES ($1, $2, $3, 'PENDING_RECEIPT', $4)
      `,
      [itemCode, itemName, quantity, remarks]
    );

    await client.query("COMMIT");

    res.json({
      success: true
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
   NOTIFICATIONS
   POWDER COATING ONLY
========================= */

app.get("/api/notifications", auth, async (req, res) => {
  if (req.user?.username !== "powdercoating") {
    return res.json({
      notifications: []
    });
  }

  const sinceRaw = String(req.query?.since || "").trim();

  const since = sinceRaw
    ? new Date(sinceRaw)
    : new Date();

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
   PENDING RECEIPTS
========================= */

app.get("/api/stock/pending", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        item_code AS "itemCode",
        item_name AS "itemName",
        quantity,
        remarks,
        created_at AS "createdAt"
      FROM transactions
      WHERE type = 'PENDING_RECEIPT'
      ORDER BY created_at DESC, id DESC
    `);

    res.json({
      pending: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   RECEIVE STOCK
   POWDER COATING
========================= */

app.post("/api/stock/receive", auth, async (req, res) => {
  if (req.user?.username !== "powdercoating") {
    return res.status(403).json({
      error: "Only Powder Coating can receive stock"
    });
  }

  const client = await pool.connect();

  try {
    const transactionId = Number(req.body?.transactionId);
    const quantity = Number(req.body?.quantity);

    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return res.status(400).json({
        error: "Invalid transaction"
      });
    }

    await client.query("BEGIN");

    const pendingResult = await client.query(
      `
      SELECT
        id,
        item_code,
        item_name,
        quantity,
        remarks
      FROM transactions
      WHERE id = $1
        AND type = 'PENDING_RECEIPT'
      FOR UPDATE
      `,
      [transactionId]
    );

    if (pendingResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Pending receipt not found"
      });
    }

    const pending = pendingResult.rows[0];

    const receiveQty =
      Number.isFinite(quantity) && quantity > 0
        ? quantity
        : Number(pending.quantity);

    if (receiveQty > Number(pending.quantity)) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Received quantity cannot exceed pending quantity"
      });
    }

    await client.query(
      `
      INSERT INTO stock (
        item_code,
        item_name,
        pre_treatment,
        powder_coating
      )
      VALUES ($1, $2, 0, $3)
      ON CONFLICT (item_code)
      DO UPDATE SET
        item_name = EXCLUDED.item_name,
        powder_coating =
          stock.powder_coating + EXCLUDED.powder_coating
      `,
      [
        pending.item_code,
        pending.item_name,
        receiveQty
      ]
    );

    if (receiveQty === Number(pending.quantity)) {
      await client.query(
        `
        DELETE FROM transactions
        WHERE id = $1
        `,
        [transactionId]
      );
    } else {
      await client.query(
        `
        UPDATE transactions
        SET quantity = quantity - $1
        WHERE id = $2
        `,
        [receiveQty, transactionId]
      );
    }

    await client.query(
      `
      INSERT INTO transactions (
        item_code,
        item_name,
        quantity,
        type,
        remarks
      )
      VALUES ($1, $2, $3, 'RECEIVE_POWDER', $4)
      `,
      [
        pending.item_code,
        pending.item_name,
        receiveQty,
        pending.remarks || ""
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true
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

  const client = await pool.connect();

  try {
    const itemCode = String(req.body?.itemCode || "").trim();
    const itemName = String(req.body?.itemName || "").trim();
    const quantity = Number(req.body?.quantity);
    const remarks = String(req.body?.remarks || "").trim();

    if (!itemCode || !itemName || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({
        error: "Invalid stock details"
      });
    }

    await client.query("BEGIN");

    const stockResult = await client.query(
      `
      SELECT powder_coating
      FROM stock
      WHERE item_code = $1
      FOR UPDATE
      `,
      [itemCode]
    );

    if (stockResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Item stock not found"
      });
    }

    const available = Number(stockResult.rows[0].powder_coating || 0);

    if (quantity > available) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Insufficient Powder Coating stock"
      });
    }

    await client.query(
      `
      UPDATE stock
      SET powder_coating = powder_coating - $1
      WHERE item_code = $2
      `,
      [quantity, itemCode]
    );

    await client.query(
      `
      INSERT INTO completed_stock (
        item_code,
        item_name,
        quantity,
        remarks
      )
      VALUES ($1, $2, $3, $4)
      `,
      [itemCode, itemName, quantity, remarks]
    );

    await client.query(
      `
      INSERT INTO transactions (
        item_code,
        item_name,
        quantity,
        type,
        remarks
      )
      VALUES ($1, $2, $3, 'POWDER_COATED', $4)
      `,
      [itemCode, itemName, quantity, remarks]
    );

    await client.query("COMMIT");

    res.json({
      success: true
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
   TRANSACTIONS
========================= */

app.get("/api/transactions", auth, async (req, res) => {
  try {
    const result = await pool.query(`
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

    res.json({
      transactions: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   COMPLETED STOCK
========================= */

app.get("/api/completed-stock", auth, async (req, res) => {
  try {
    const result = await pool.query(`
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
      completed: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      status: "Server is running"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================
   SERVE HTML
========================= */

app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "Powder_Coating_Item_Code_Name_Width_Updated.html"
    )
  );
});

/* =========================
   START SERVER
========================= */

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
