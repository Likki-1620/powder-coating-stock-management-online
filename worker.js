import { Client } from "pg";
import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scryptCallback);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders
    }
  });
}

function base64url(input) {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;

  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);

  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);

  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function signToken(payload, secret) {
  const header = base64url(JSON.stringify({
    alg: "HS256",
    typ: "JWT"
  }));

  const now = Math.floor(Date.now() / 1000);

  const body = base64url(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + 7 * 24 * 60 * 60
  }));

  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data)
    )
  );

  return `${data}.${base64url(signature)}`;
}

async function verifyToken(token, secret) {
  const parts = String(token || "").split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid token");
  }

  const data = `${parts[0]}.${parts[1]}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64url(parts[2]),
    new TextEncoder().encode(data)
  );

  if (!valid) throw new Error("Invalid token");

  const payload = JSON.parse(
    new TextDecoder().decode(fromBase64url(parts[1]))
  );

  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Expired token");
  }

  return payload;
}

function validItem(code, name) {
  return (
    typeof code === "string" &&
    code.trim() &&
    typeof name === "string" &&
    name.trim()
  );
}

function parseDateDDMMYYYY(value) {
  const m = String(value || "").trim().match(
    /^(\d{2})\/(\d{2})\/(\d{4})$/
  );

  if (!m) return null;

  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);

  const date = new Date(Date.UTC(y, mo - 1, d));

  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }

  return `${m[3]}-${m[2]}-${m[1]}`;
}

// DATABASE INITIALIZATION

async function initDatabase(client) {
  await client.query(`
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

    ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS shift TEXT,
      ADD COLUMN IF NOT EXISTS send_date DATE,
      ADD COLUMN IF NOT EXISTS send_to TEXT,
      ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS batch_no TEXT;

    ALTER TABLE completed_stock
      ADD COLUMN IF NOT EXISTS pretreatment_date DATE,
      ADD COLUMN IF NOT EXISTS batch_no TEXT;
  `);
}

// POWDER COATING BALANCE

async function powderBalance(client, code) {
  const a = await client.query(`
    SELECT
      COALESCE(SUM(quantity) FILTER (
        WHERE type = 'RECEIVE_POWDER'
      ), 0) received,

      COALESCE(SUM(quantity) FILTER (
        WHERE type = 'ADD_POWDER_STOCK'
      ), 0) direct_add,

      COALESCE(SUM(quantity) FILTER (
        WHERE type = 'EDIT_POWDER_STOCK'
      ), 0) edited,

      COALESCE(SUM(quantity) FILTER (
        WHERE type = 'DISPATCH_STOCK'
      ), 0) dispatched

    FROM transactions
    WHERE item_code = $1
  `, [code]);

  const b = await client.query(`
    SELECT COALESCE(SUM(quantity), 0) completed
    FROM completed_stock
    WHERE item_code = $1
  `, [code]);

  const received = Number(a.rows[0].received);
  const directAdd = Number(a.rows[0].direct_add);
  const edited = Number(a.rows[0].edited);
  const dispatched = Number(a.rows[0].dispatched);
  const completed = Number(b.rows[0].completed);

  const rawBalance =
    received + directAdd + edited - completed - dispatched;

  return {
    received,
    directAdd,
    edited,
    dispatched,
    completed,
    rawBalance,
    balance: Math.max(0, rawBalance)
  };
}

async function withTransaction(client, work) {
  await client.query("BEGIN");

  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// CLOUDFLARE WORKER

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // FRONTEND ASSETS

    if (!url.pathname.startsWith("/api/")) {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response(
        "Frontend assets are not configured. Set ASSETS in wrangler.json.",
        { status: 404 }
      );
    }

    if (!env.HYPERDRIVE?.connectionString || !env.JWT_SECRET) {
      return json({
        error: "Worker secrets or Hyperdrive binding are missing."
      }, 500);
    }

    const client = new Client({
      connectionString: env.HYPERDRIVE.connectionString
    });

    let connected = false;

    try {
      await client.connect();
      connected = true;

      await initDatabase(client);

      const method = request.method;
      const path = url.pathname.replace(/\/+$/, "") || "/";

      const body = method === "POST"
        ? await request.json().catch(() => ({}))
        : {};

      // AUTHENTICATION

      const usernameFromToken = async () => {
        const h = request.headers.get("Authorization") || "";

        if (!h.startsWith("Bearer ")) {
          throw Object.assign(
            new Error("Login required."),
            { status: 401 }
          );
        }

        try {
          return await verifyToken(h.slice(7), env.JWT_SECRET);
        } catch {
          throw Object.assign(
            new Error("Invalid or expired login. Please log in again."),
            { status: 401 }
          );
        }
      };

      const requireUser = async (...allowed) => {
        const user = await usernameFromToken();

        if (allowed.length && !allowed.includes(user.username)) {
          throw Object.assign(
            new Error("You do not have permission to perform this action."),
            { status: 403 }
          );
        }

        return user;
      };

      // HEALTH CHECK

      if (method === "GET" && path === "/api/health") {
        await client.query("SELECT 1");

        return json({
          ok: true,
          database: true
        });
      }

      // LOGIN

      if (
        method === "POST" &&
        (path === "/api/login" || path === "/api/login/")
      ) {
        const username = String(body.username || "")
          .trim()
          .toLowerCase();

        const password = body.password;

        const users = {
          mainadmin: {
            password: env.MAIN_ADMIN_PASSWORD,
            name: "Main Admin"
          },
          pretreatment: {
            password: env.PRETREATMENT_PASSWORD,
            name: "Pre Treatment"
          },
          powdercoating: {
            password: env.POWDERCOATING_PASSWORD,
            name: "Powder Coating"
          }
        };

        const user = users[username];

        if (!user || typeof password !== "string") {
          return json({
            error: "Invalid username or password."
          }, 401);
        }

        let valid = false;

        if (username === "mainadmin") {
          const stored = await client.query(
            `SELECT password_hash, password_salt
             FROM admin_password_credentials
             WHERE username = $1`,
            [username]
          );

          if (stored.rowCount) {
            const row = stored.rows[0];

            const calculated = await scryptAsync(
              password,
              row.password_salt,
              64
            );

            const expected = Buffer.from(
              row.password_hash,
              "hex"
            );

            valid =
              expected.length === calculated.length &&
              timingSafeEqual(expected, calculated);
          } else {
            valid = password === user.password;
          }
        } else {
          valid = password === user.password;
        }

        if (!valid) {
          return json({
            error: "Invalid username or password."
          }, 401);
        }

        const token = await signToken(
          { username, name: user.name },
          env.JWT_SECRET
        );

        return json({
          success: true,
          token,
          username,
          name: user.name
        });
      }

      // ADMIN CHANGE PASSWORD

      if (method === "POST" && path === "/api/admin/change-password") {
        await requireUser("mainadmin");

        const { currentPassword, newPassword } = body;

        if (
          typeof currentPassword !== "string" ||
          typeof newPassword !== "string" ||
          newPassword.length < 8
        ) {
          return json({
            error: "Enter the current password and a new password of at least 8 characters."
          }, 400);
        }

        const stored = await client.query(
          `SELECT password_hash, password_salt
           FROM admin_password_credentials
           WHERE username = $1`,
          ["mainadmin"]
        );

        let valid = false;

        if (stored.rowCount) {
          const row = stored.rows[0];

          const calc = await scryptAsync(
            currentPassword,
            row.password_salt,
            64
          );

          const expected = Buffer.from(row.password_hash, "hex");

          valid =
            expected.length === calc.length &&
            timingSafeEqual(expected, calc);
        } else {
          valid = currentPassword === env.MAIN_ADMIN_PASSWORD;
        }

        if (!valid) {
          return json({
            error: "Current password is incorrect."
          }, 401);
        }

        const salt = randomBytes(16).toString("hex");

        const hash = (
          await scryptAsync(newPassword, salt, 64)
        ).toString("hex");

        await client.query(
          `INSERT INTO admin_password_credentials
            (username, password_hash, password_salt, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (username) DO UPDATE SET
             password_hash = EXCLUDED.password_hash,
             password_salt = EXCLUDED.password_salt,
             updated_at = NOW()`,
          ["mainadmin", hash, salt]
        );

        return json({
          success: true,
          message: "Password changed successfully."
        });
      }

      // GET ALL DATA

      if (method === "GET" && path === "/api/data") {
        const user = await requireUser();

        const ir = await client.query(`
          SELECT
            i.item_code AS "itemCode",
            i.item_name AS "itemName",
            COALESCE(s.quantity, 0) AS "pretreatmentQuantity"
          FROM items i
          LEFT JOIN stock s ON s.item_code = i.item_code
          ORDER BY i.item_code
        `);

        const items = [];

        for (const item of ir.rows) {
          const p = await powderBalance(client, item.itemCode);

          items.push({
            itemCode: item.itemCode,
            itemName: item.itemName,
            pretreatmentQuantity: Number(item.pretreatmentQuantity),
            powderQuantity: p.balance,
            quantity: user.username === "powdercoating"
              ? p.balance
              : Number(item.pretreatmentQuantity)
          });
        }

        const tr = await client.query(`
          SELECT
            id,
            item_code AS "itemCode",
            item_name AS "itemName",
            quantity,
            type,
            remarks,
            shift,
            batch_no AS "batchNo",
            send_to AS "sendTo",
            TO_CHAR(send_date, 'DD/MM/YYYY') AS date,
            created_at AS "createdAt",
            received_at AS "receivedAt"
          FROM transactions
          ORDER BY created_at DESC, id DESC
        `);

        const cr = await client.query(`
          SELECT
            id,
            item_code AS "itemCode",
            item_name AS "itemName",
            quantity,
            booth_no AS "boothNo",
            colour,
            operator_name AS "operatorName",
            remarks,
            batch_no AS "batchNo",
            TO_CHAR(pretreatment_date, 'DD/MM/YYYY') AS "pretreatmentDate",
            created_at AS "createdAt"
          FROM completed_stock
          ORDER BY created_at DESC, id DESC
        `);

        return json({
          items,
          transactions: tr.rows,
          completedStock: cr.rows
        });
      }

      // PENDING RECEIPT NOTIFICATIONS

      if (method === "GET" && path === "/api/notifications") {
        const user = await requireUser();

        if (!["powdercoating", "mainadmin"].includes(user.username)) {
          return json({ notifications: [] });
        }

        const sinceRaw = String(
          url.searchParams.get("since") || ""
        ).trim();

        const since = sinceRaw ? new Date(sinceRaw) : new Date();

        if (Number.isNaN(since.getTime())) {
          return json({
            error: "Invalid notification time."
          }, 400);
        }

        const r = await client.query(`
          SELECT
            id,
            item_code AS "itemCode",
            item_name AS "itemName",
            quantity,
            shift,
            batch_no AS "batchNo",
            TO_CHAR(send_date, 'DD/MM/YYYY') AS date,
            created_at AS "createdAt"
          FROM transactions
          WHERE type = 'PENDING_RECEIPT'
            AND created_at > $1
          ORDER BY created_at ASC, id ASC
          LIMIT 100
        `, [since.toISOString()]);

        return json({
          notifications: r.rows
        });
      }

      // ADD ITEM

      if (method === "POST" && path === "/api/items") {
        await requireUser(
          "pretreatment",
          "powdercoating",
          "mainadmin"
        );

        const { itemCode, itemName } = body;

        if (!validItem(itemCode, itemName)) {
          return json({
            error: "Item code and item name are required."
          }, 400);
        }

        const code = itemCode.trim();
        const name = itemName.trim();

        const result = await withTransaction(client, async () => {
          const r = await client.query(`
            INSERT INTO items (item_code, item_name)
            VALUES ($1, $2)
            ON CONFLICT (item_code) DO NOTHING
            RETURNING
              item_code AS "itemCode",
              item_name AS "itemName"
          `, [code, name]);

          if (!r.rowCount) {
            throw Object.assign(
              new Error("Item code already exists."),
              { status: 409 }
            );
          }

          await client.query(
            `INSERT INTO stock (item_code, quantity)
             VALUES ($1, 0)
             ON CONFLICT (item_code) DO NOTHING`,
            [code]
          );

          return r.rows[0];
        });

        return json({
          success: true,
          ...result
        });
      }

      // ADD STOCK

      if (method === "POST" && path === "/api/stock/add") {
        const user = await requireUser(
          "pretreatment",
          "powdercoating",
          "mainadmin"
        );

        const {
          itemCode,
          itemName,
          quantity,
          remarks = ""
        } = body;

        const qty = Number(quantity);

        if (
          !validItem(itemCode, itemName) ||
          !Number.isFinite(qty) ||
          qty <= 0
        ) {
          return json({
            error: "Enter a valid item code, item name and quantity."
          }, 400);
        }

        const code = itemCode.trim();
        const name = itemName.trim();
        const isPowder = user.username === "powdercoating";

        await withTransaction(client, async () => {
          await client.query(`
            INSERT INTO items (item_code, item_name)
            VALUES ($1, $2)
            ON CONFLICT (item_code)
            DO UPDATE SET item_name = EXCLUDED.item_name
          `, [code, name]);

          if (!isPowder) {
            await client.query(`
              INSERT INTO stock (item_code, quantity)
              VALUES ($1, $2)
              ON CONFLICT (item_code)
              DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity
            `, [code, qty]);
          }

          await client.query(`
            INSERT INTO transactions
              (item_code, item_name, quantity, type, remarks)
            VALUES ($1, $2, $3, $4, $5)
          `, [
            code,
            name,
            qty,
            isPowder ? "ADD_POWDER_STOCK" : "ADD_STOCK",
            String(remarks)
          ]);
        });

        const p = await powderBalance(client, code);

        return json({
          success: true,
          type: isPowder ? "ADD_POWDER_STOCK" : "ADD_STOCK",
          powderBalance: p.balance
        });
      }

      // SEND STOCK FROM PRE TREATMENT

      if (method === "POST" && path === "/api/stock/send") {
        await requireUser("pretreatment", "mainadmin");

        const {
          itemCode,
          itemName,
          quantity,
          remarks = "",
          shift,
          date
        } = body;

        const batchNo = String(
          body.batchNo ??
          body.batchNumber ??
          body.batch_no ??
          ""
        ).trim();

        const qty = Number(quantity);
        const sendDate = parseDateDDMMYYYY(date);

        if (!sendDate) {
          return json({
            error: "Select a valid date in DD/MM/YYYY format."
          }, 400);
        }

        if (!["Day Shift", "Night Shift"].includes(shift)) {
          return json({
            error: "Please select Day Shift or Night Shift."
          }, 400);
        }

        if (
          !validItem(itemCode, itemName) ||
          !Number.isFinite(qty) ||
          qty <= 0
        ) {
          return json({
            error: "Enter a valid item and quantity."
          }, 400);
        }

        const code = itemCode.trim();
        const name = itemName.trim();

        const transaction = await withTransaction(client, async () => {
          const r = await client.query(
            `SELECT quantity
             FROM stock
             WHERE item_code = $1
             FOR UPDATE`,
            [code]
          );

          if (!r.rowCount) {
            throw Object.assign(
              new Error("Item stock not found."),
              { status: 404 }
            );
          }

          const available = Number(r.rows[0].quantity);

          if (qty > available) {
            throw Object.assign(
              new Error(`Insufficient Pre Treatment stock. Available: ${available}`),
              { status: 400 }
            );
          }

          await client.query(
            `UPDATE stock
             SET quantity = quantity - $1
             WHERE item_code = $2`,
            [qty, code]
          );

          const t = await client.query(`
            INSERT INTO transactions
              (item_code, item_name, quantity, type, remarks,
               shift, send_date, batch_no)
            VALUES ($1, $2, $3, 'PENDING_RECEIPT', $4, $5, $6, $7)
            RETURNING id
          `, [
            code,
            name,
            qty,
            String(remarks),
            shift,
            sendDate,
            batchNo
          ]);

          return {
            id: t.rows[0].id,
            available
          };
        });

        return json({
          success: true,
          pending: true,
          transactionId: transaction.id,
          shift,
          batchNo,
          pretreatmentBalance: transaction.available - qty,
          message: "Stock sent. Waiting for Powder Coating acceptance."
        });
      }

      // ACCEPT RECEIPT

      if (method === "POST" && path === "/api/stock/accept-receipt") {
        await requireUser("powdercoating", "mainadmin");

        const id = Number(body.transactionId);

        if (!Number.isInteger(id) || id <= 0) {
          return json({
            error: "Valid pending receipt is required."
          }, 400);
        }

        const receipt = await withTransaction(client, async () => {
          const r = await client.query(`
            SELECT
              id,
              item_code,
              item_name,
              quantity,
              remarks,
              shift,
              batch_no,
              TO_CHAR(send_date, 'DD/MM/YYYY') AS date
            FROM transactions
            WHERE id = $1
              AND type = 'PENDING_RECEIPT'
            FOR UPDATE
          `, [id]);

          if (!r.rowCount) {
            throw Object.assign(
              new Error("Pending receipt not found or already accepted."),
              { status: 404 }
            );
          }

          await client.query(`
            UPDATE transactions
            SET type = 'RECEIVE_POWDER',
                received_at = NOW()
            WHERE id = $1
              AND type = 'PENDING_RECEIPT'
          `, [id]);

          return r.rows[0];
        });

        const p = await powderBalance(client, receipt.item_code);

        return json({
          success: true,
          itemCode: receipt.item_code,
          itemName: receipt.item_name,
          quantity: Number(receipt.quantity),
          shift: receipt.shift,
          batchNo: receipt.batch_no || "",
          date: receipt.date,
          powderBalance: p.balance
        });
      }

      // POWDER COATING BALANCE

      const balanceMatch = path.match(
        /^\/api\/stock\/powder-balance\/(.+)$/
      );

      if (method === "GET" && balanceMatch) {
        await requireUser("powdercoating", "mainadmin");

        const code = decodeURIComponent(balanceMatch[1]).trim();
        const p = await powderBalance(client, code);

        return json({
          itemCode: code,
          ...p
        });
      }

      // EDIT POWDER COATING BALANCE

      if (method === "POST" && path === "/api/stock/edit") {
        await requireUser("powdercoating", "mainadmin");

        const {
          itemCode,
          itemName,
          updatedQuantity,
          remarks = ""
        } = body;

        const code = String(itemCode || "").trim();
        const name = String(itemName || "").trim();
        const updated = Number(updatedQuantity);
        const note = String(remarks || "").trim();

        if (
          !code ||
          !name ||
          !Number.isFinite(updated) ||
          updated < 0
        ) {
          return json({
            error: "Enter a valid item and updated stock quantity."
          }, 400);
        }

        const previous = await withTransaction(client, async () => {
          const it = await client.query(
            `SELECT item_code
             FROM items
             WHERE item_code = $1
             FOR UPDATE`,
            [code]
          );

          if (!it.rowCount) {
            throw Object.assign(
              new Error("Item code not found."),
              { status: 404 }
            );
          }

          const p = await powderBalance(client, code);
          const delta = updated - p.balance;

          if (delta === 0) {
            throw Object.assign(
              new Error("Updated stock is the same as current stock."),
              { status: 400 }
            );
          }

          await client.query(`
            INSERT INTO transactions
              (item_code, item_name, quantity, type, remarks)
            VALUES ($1, $2, $3, 'EDIT_POWDER_STOCK', $4)
          `, [code, name, delta, note]);

          return p.balance;
        });

        const p = await powderBalance(client, code);

        return json({
          success: true,
          message: "Powder Coating stock updated successfully.",
          itemCode: code,
          previousQuantity: previous,
          updatedQuantity: updated,
          powderBalance: p.balance
        });
      }

      // POWDER COATING COMPLETED STOCK

      if (method === "POST" && path === "/api/stock/complete") {
        await requireUser("powdercoating", "mainadmin");

        const {
          itemCode,
          itemName,
          quantity,
          boothNo,
          colour,
          operatorName,
          remarks = "",
          pretreatmentDate,
          batchNo
        } = body;

        const code = String(itemCode || "").trim();
        const name = String(itemName || "").trim();
        const qty = Number(quantity);
        const booth = String(boothNo || "").trim();
        const selectedColour = String(colour || "").trim();
        const operator = String(operatorName || "").trim();
        const note = String(remarks || "").trim();
        const batch = String(batchNo || "").trim();

        const booths = ["1", "2", "3", "4", "5", "6", "DL"];

        const colours = [
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
          "Iron Mica",
          "IGP Green",
          "Ultra Marine Blue",
          "Brillux Black",
          "Beillix Black",
          "Dry Lubricant"
        ];

        const operators = [
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

        if (!code || !name || !Number.isFinite(qty) || qty <= 0) {
          return json({
            error: "Enter a valid item and quantity."
          }, 400);
        }

        if (!booths.includes(booth)) {
          return json({
            error: "Please select a valid Booth No. or DL."
          }, 400);
        }

        if (!colours.includes(selectedColour)) {
          return json({
            error: "Please select a valid colour."
          }, 400);
        }

        if (!operators.includes(operator)) {
          return json({
            error: "Please select a valid operator name."
          }, 400);
        }

        let pretreatmentDateISO = null;

        if (pretreatmentDate) {
          pretreatmentDateISO = parseDateDDMMYYYY(pretreatmentDate);

          if (!pretreatmentDateISO) {
            return json({
              error: "Pretreatment date must be DD/MM/YYYY."
            }, 400);
          }
        }

        await withTransaction(client, async () => {
          const it = await client.query(
            `SELECT item_code
             FROM items
             WHERE item_code = $1
             FOR UPDATE`,
            [code]
          );

          if (!it.rowCount) {
            throw Object.assign(
              new Error("Item code not found."),
              { status: 404 }
            );
          }

          const p = await powderBalance(client, code);

          if (qty > p.balance) {
            throw Object.assign(
              new Error(`Insufficient accepted Powder Coating stock. Available: ${p.balance}`),
              { status: 400 }
            );
          }

          await client.query(`
            INSERT INTO completed_stock
              (item_code, item_name, quantity, booth_no,
               colour, operator_name, remarks,
               pretreatment_date, batch_no)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [
            code,
            name,
            qty,
            booth,
            selectedColour,
            operator,
            note,
            pretreatmentDateISO,
            batch
          ]);

          await client.query(`
            INSERT INTO transactions
              (item_code, item_name, quantity, type, remarks)
            VALUES ($1, $2, $3, 'POWDER_COMPLETED', $4)
          `, [code, name, qty, note]);
        });

        const p = await powderBalance(client, code);

        return json({
          success: true,
          balance: p.balance
        });
      }

      // DISPATCH STOCK — POWDER COATING ONLY

      if (method === "POST" && path === "/api/stock/dispatch") {
        await requireUser("powdercoating");

        const {
          itemCode,
          itemName,
          quantity,
          sendTo,
          remarks = ""
        } = body;

        const code = String(itemCode || "").trim();
        const name = String(itemName || "").trim();
        const qty = Number(quantity);
        const destination = String(sendTo || "").trim();

        if (!code || !name || !Number.isFinite(qty) || qty <= 0) {
          return json({
            error: "Enter a valid item and dispatch quantity."
          }, 400);
        }

        if (!["305 store", "QC-1A"].includes(destination)) {
          return json({
            error: "Destination must be 305 store or QC-1A."
          }, 400);
        }

        await withTransaction(client, async () => {
          const it = await client.query(
            `SELECT item_code, item_name
             FROM items
             WHERE item_code = $1
             FOR UPDATE`,
            [code]
          );

          if (!it.rowCount) {
            throw Object.assign(
              new Error("Item not found."),
              { status: 404 }
            );
          }

          const p = await powderBalance(client, code);

          if (qty > p.balance) {
            throw Object.assign(
              new Error(`Insufficient Powder Coating balance. Available: ${p.balance}`),
              { status: 400 }
            );
          }

          await client.query(`
            INSERT INTO transactions
              (item_code, item_name, quantity, type, remarks, send_to)
            VALUES ($1, $2, $3, 'DISPATCH_STOCK', $4, $5)
          `, [
            code,
            it.rows[0].item_name || name,
            qty,
            String(remarks),
            destination
          ]);
        });

        const p = await powderBalance(client, code);

        return json({
          success: true,
          message: "Stock dispatched successfully.",
          dispatchedQuantity: qty,
          sendTo: destination,
          balance: p.balance
        });
      }

      // RESET STOCK DATA

      if (method === "POST" && path === "/api/admin/reset-stock") {
        await requireUser("powdercoating");

        if (body.confirmation !== "CLEAR ALL STOCK DATA") {
          return json({
            error: 'Confirmation text must be "CLEAR ALL STOCK DATA".'
          }, 400);
        }

        await withTransaction(client, async () => {
          await client.query("DELETE FROM transactions");
          await client.query("DELETE FROM completed_stock");

          await client.query(`
            INSERT INTO stock (item_code, quantity)
            SELECT item_code, 0 FROM items
            ON CONFLICT (item_code)
            DO UPDATE SET quantity = 0
          `);
        });

        return json({
          success: true,
          message: "Stock data cleared. Item codes and names are preserved."
        });
      }

      return json({
        error: "API route not found."
      }, 404);

    } catch (error) {
      console.error("Worker request error:", error);

      return json({
        error: error.message || "Internal server error."
      }, error.status || 500);

    } finally {
      if (connected) {
        await client.end().catch(e =>
          console.error("PostgreSQL close error:", e)
        );
      }
    }
  }
};
