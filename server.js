const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const JWT_SECRET =
  process.env.JWT_SECRET || "powder-stock-secret-2026";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
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
  `);

  console.log("Database tables ready");
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Login required"
    });
  }

  try {
    req.user = jwt.verify(
      header.substring(7),
      JWT_SECRET
    );
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired login"
    });
  }
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: false,
      error: error.message
    });
  }
});

app.post(["/api/login", "/api/login/"], (req, res) => {
  const username = String(
    req.body?.username || ""
  ).trim().toLowerCase();

  const password = String(
    req.body?.password || ""
  );

  let userKey = null;

  if (
    username === "pre treatment" ||
    username === "pretreatment"
  ) {
    userKey = "pretreatment";
  }

  if (
    username === "powder coating" ||
    username === "powdercoating"
  ) {
    userKey = "powdercoating";
  }

  if (
    !userKey ||
    USERS[userKey].password !== password
  ) {
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
      expiresIn: "7d"
    }
  );

  res.json({
    token,
    username: userKey,
    name: USERS[userKey].name
  });
});

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
   NOTIFICATIONS
========================= */

app.get("/api/notifications", auth, async (req, res) => {
  if (req.user?.username !== "powdercoating") {
    return res.json({
      notifications: []
    });
  }

  const sinceRaw = String(
    req.query?.since || ""
  ).trim();

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
   ADD ITEM
========================= */

app.post("/api/items", auth, async (req, res) => {
  const itemCode = String(
    req.body?.itemCode || ""
  ).trim();

  const itemName = String(
    req.body?.itemName || ""
  ).trim();

  if (!itemCode || !itemName) {
    return res.status(400).json({
      error: "Item code and item name are required"
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO items
        (item_code, item_name)
      VALUES
        ($1, $2)
      ON CONFLICT (item_code)
      DO NOTHING
      RETURNING
        item_code AS "itemCode",
        item_name AS "itemName"
      `,
      [itemCode, itemName]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        error: "Item code already exists"
      });
    }

    await pool.query(
      `
      INSERT INTO stock
        (item_code, quantity)
      VALUES
        ($1, 0)
      ON CONFLICT (item_code)
      DO NOTHING
      `,
      [itemCode]
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
  const itemCode = String(
    req.body?.itemCode || ""
  ).trim();

  const itemName = String(
    req.body?.itemName || ""
  ).trim();

  const quantity = Number(
    req.body?.quantity
  );

  const remarks = String(
    req.body?.remarks || ""
  ).trim();

  if (
    !itemCode ||
    !itemName ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO items
        (item_code, item_name)
      VALUES
        ($1, $2)
      ON CONFLICT (item_code)
      DO UPDATE SET
        item_name = EXCLUDED.item_name
      `,
      [itemCode, itemName]
    );

    await client.query(
      `
      INSERT INTO stock
        (item_code, quantity)
      VALUES
        ($1, $2)
      ON CONFLICT (item_code)
      DO UPDATE SET
        quantity =
          stock.quantity + EXCLUDED.quantity
      `,
      [itemCode, quantity]
    );

    await client.query(
      `
      INSERT INTO transactions
        (item_code, item_name, quantity, type, remarks)
      VALUES
        ($1, $2, $3, 'ADD_STOCK', $4)
      `,
      [
        itemCode,
        itemName,
        quantity,
        remarks
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
   SEND STOCK
========================= */

app.post("/api/stock/send", auth, async (req, res) => {
  const itemCode = String(
    req.body?.itemCode || ""
  ).trim();

  const itemName = String(
    req.body?.itemName || ""
  ).trim();

  const quantity = Number(
    req.body?.quantity
  );

  const remarks = String(
    req.body?.remarks || ""
  ).trim();

  if (
    !itemCode ||
    !itemName ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return res.status(400).json({
      error: "Valid item and quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT quantity
      FROM stock
      WHERE item_code = $1
      FOR UPDATE
      `,
      [itemCode]
    );

    const available = Number(
      result.rows[0]?.quantity || 0
    );

    if (quantity > available) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error:
          "Insufficient stock. Available quantity: " +
          available
      });
    }

    await client.query(
      `
      UPDATE stock
      SET quantity = quantity - $1
      WHERE item_code = $2
      `,
      [quantity, itemCode]
    );

    await client.query(
      `
      INSERT INTO transactions
        (item_code, item_name, quantity, type, remarks)
      VALUES
        ($1, $2, $3, 'PENDING_RECEIPT', $4)
      `,
      [
        itemCode,
        itemName,
        quantity,
        remarks
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      pending: true,
      balance: available - quantity
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
   ACCEPT RECEIPT
========================= */

app.post(
  "/api/stock/accept-receipt",
  auth,
  async (req, res) => {
    if (
      req.user?.username !==
      "powdercoating"
    ) {
      return res.status(403).json({
        error:
          "Only Powder Coating can accept receipts"
      });
    }

    const transactionId = Number(
      req.body?.transactionId
    );

    if (
      !Number.isInteger(transactionId) ||
      transactionId <= 0
    ) {
      return res.status(400).json({
        error:
          "Valid pending receipt is required"
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
          remarks
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
          error:
            "Pending receipt not found or already accepted"
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
        quantity: receipt.quantity
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
  }
);

/* =========================
   EDIT POWDER STOCK
========================= */

app.post("/api/stock/edit", auth, async (req, res) => {
  if (
    req.user?.username !==
    "powdercoating"
  ) {
    return res.status(403).json({
      error:
        "Only Powder Coating can edit Powder Coating stock"
    });
  }

  const itemCode = String(
    req.body?.itemCode || ""
  ).trim();

  const itemName = String(
    req.body?.itemName || ""
  ).trim();

  const updated = Number(
    req.body?.updatedQuantity
  );

  const remarks = String(
    req.body?.remarks || ""
  ).trim();

  if (
    !itemCode ||
    !itemName ||
    !Number.isFinite(updated) ||
    updated < 0
  ) {
    return res.status(400).json({
      error:
        "Valid item and updated stock quantity are required"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receivedResult =
      await client.query(
        `
        SELECT
          COALESCE(SUM(quantity), 0) AS total
        FROM transactions
        WHERE item_code = $1
          AND type = 'RECEIVE_POWDER'
        `,
        [itemCode]
      );

    const completedResult =
      await client.query(
        `
        SELECT
          COALESCE(SUM(quantity), 0) AS total
        FROM completed_stock
        WHERE item_code = $1
        `,
        [itemCode]
      );

    const editedResult =
      await client.query(
        `
        SELECT
          COALESCE(SUM(quantity), 0) AS total
        FROM transactions
        WHERE item_code = $1
          AND type = 'EDIT_POWDER_STOCK'
        `,
        [itemCode]
      );

    const received = Number(
      receivedResult.rows[0].total
    );

    const completed = Number(
      completedResult.rows[0].total
    );

    const edited = Number(
      editedResult.rows[0].total
    );

    const current = Math.max(
      0,
      received - completed + edited
    );

    const delta = updated - current;

    if (delta === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error:
          "Updated Stock is the same as current stock"
      });
    }

    await client.query(
      `
      INSERT INTO transactions
        (
          item_code,
          item_name,
          quantity,
          type,
          remarks
        )
      VALUES
        (
          $1,
          $2,
          $3,
          'EDIT_POWDER_STOCK',
          $4
        )
      `,
      [
        itemCode,
        itemName,
        delta,
        remarks
      ]
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
   COMPLETE POWDER STOCK
========================= */

app.post(
  "/api/stock/complete",
  auth,
  async (req, res) => {
    const itemCode = String(
      req.body?.itemCode || ""
    ).trim();

    const itemName = String(
      req.body?.itemName || ""
    ).trim();

    const quantity = Number(
      req.body?.quantity
    );

    const remarks = String(
      req.body?.remarks || ""
    ).trim();

    if (
      !itemCode ||
      !itemName ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      return res.status(400).json({
        error:
          "Valid item and quantity are required"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const receivedResult =
        await client.query(
          `
          SELECT
            COALESCE(SUM(quantity), 0) AS total
          FROM transactions
          WHERE item_code = $1
            AND type = 'RECEIVE_POWDER'
          `,
          [itemCode]
        );

      const completedResult =
        await client.query(
          `
          SELECT
            COALESCE(SUM(quantity), 0) AS total
          FROM completed_stock
          WHERE item_code = $1
          `,
          [itemCode]
        );

      const editedResult =
        await client.query(
          `
          SELECT
            COALESCE(SUM(quantity), 0) AS total
          FROM transactions
          WHERE item_code = $1
            AND type = 'EDIT_POWDER_STOCK'
          `,
          [itemCode]
        );

      const received = Number(
        receivedResult.rows[0].total
      );

      const completed = Number(
        completedResult.rows[0].total
      );

      const edited = Number(
        editedResult.rows[0].total
      );

      const balance = Math.max(
        0,
        received - completed + edited
      );

      if (quantity > balance) {
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
          (
            item_code,
            item_name,
            quantity,
            remarks
          )
        VALUES
          ($1, $2, $3, $4)
        `,
        [
          itemCode,
          itemName,
          quantity,
          remarks
        ]
      );

      await client.query(
        `
        INSERT INTO transactions
          (
            item_code,
            item_name,
            quantity,
            type,
            remarks
          )
        VALUES
          (
            $1,
            $2,
            $3,
            'POWDER_COMPLETED',
            $4
          )
        `,
        [
          itemCode,
          itemName,
          quantity,
          remarks
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        balance: balance - quantity
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
  }
);

/* =========================
   FRONTEND
========================= */

const FRONTEND_FILE =
  "Powder_Coating_Item_Code_Name_Width_Updated.html";

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      FRONTEND_FILE
    )
  );
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      FRONTEND_FILE
    )
  );
});

/* =========================
   START
========================= */

initDatabase()
  .then(() => {
    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "Server running on port " + PORT
        );
      }
    );
  })
  .catch((error) => {
    console.error(
      "Database initialization failed:",
      error
    );

    process.exit(1);
  });
