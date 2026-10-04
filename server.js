
1000056839.jpg
Where is create new file 

Perfect. 👍 You are on the server.js screen.

The complete server.js is large because I have included your 723 existing item codes and names so your item master is not lost.

Easiest way on your phone
Instead of trying to copy 54,000+ characters:

1. Download the complete server.js file here:

Download server.js

2. Go back to your GitHub repository.

3. You don't need the Create new file screen anymore.

Tap:

Add file → Upload files

4. Select the downloaded server.js file.

5. Scroll down and tap:

Commit changes

You should then have:

powder-coating-stock-management
│
├── index.html
└── server.js
Important
The server.js I prepared includes:

Your 723 item codes

Your item names

Pre Treatment login

Powder Coating login

Add Stock

Send Stock

Received Stock

Powder Coating Balance

Completed Stock

Shared PostgreSQL database

Protection so two phones use the same stock

Automatic database table creation

I've also checked that the JavaScript syntax is valid.

After server.js is uploaded and committed, tell me server.js done.

Then we'll create Step 5: package.json.


server.js
Code


1000056840.jpg
After downloading it is showing like this not downloading 

Yes, I can see the problem. 👍

The download link from ChatGPT is failing on your phone (ERR_INVALID_RESPONSE). Don't keep trying that link.

Do this instead — much easier
We will create server.js directly inside GitHub, so you don't need to download anything.

You are already on the Create new file → server.js screen.

1. Stay on that screen.
2. In the large code box, I can give you the complete server.js code to copy and paste.
Because the file is long, I don't want to send you a huge code block that is difficult to copy on your phone.

Better option: I can create a smaller, complete server.js first that supports the shared stock system, and then we can add your full item master.

If you want that, reply:

Give server.js code

and I will send the complete code directly here for you to copy into GitHub.


Give code

Yes. 👍 Since the download isn't working on your phone, copy this directly into the GitHub server.js editor.

First
At the top of the GitHub page, make sure the filename is:

server.js
Then delete anything currently in the large code box and paste the code below.

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;
const JWT_SECRET =
  process.env.JWT_SECRET || "change-this-secret-before-production";

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* =====================================================
   USERS
===================================================== */

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


/* =====================================================
   LOGIN
===================================================== */

app.post("/api/login", (req, res) => {

  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");

  const user = USERS[username];

  if (!user || user.password !== password) {

    return res.status(401).json({
      message: "Invalid username or password"
    });

  }

  const token = jwt.sign(
    {
      username: username,
      name: user.name
    },
    JWT_SECRET,
    {
      expiresIn: "12h"
    }
  );

  res.json({
    token: token,

    user: {
      username: username,
      name: user.name
    }
  });

});


/* =====================================================
   AUTHENTICATION
===================================================== */

function authenticate(req, res, next) {

  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {

    return res.status(401).json({
      message: "Authentication required"
    });

  }

  const token = header.substring(7);

  try {

    req.user = jwt.verify(
      token,
      JWT_SECRET
    );

    next();

  } catch (error) {

    return res.status(401).json({
      message: "Invalid or expired session"
    });

  }

}


/* =====================================================
   ROLE CHECK
===================================================== */

function hasRole(req, allowedRoles) {

  return allowedRoles.includes(
    req.user.username
  );

}


/* =====================================================
   NUMBER HELPER
===================================================== */

function toNumber(value) {

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return number;

}


/* =====================================================
   DATE / TIME
===================================================== */

function getDateTime(date = new Date()) {

  return {

    date: date.toLocaleDateString(
      "en-IN",
      {
        timeZone: "Asia/Kolkata"
      }
    ),

    time: date.toLocaleTimeString(
      "en-IN",
      {
        timeZone: "Asia/Kolkata"
      }
    )

  };

}


/* =====================================================
   DATABASE INITIALIZATION
===================================================== */

async function initializeDatabase() {

  if (!process.env.DATABASE_URL) {

    throw new Error(
      "DATABASE_URL environment variable is missing."
    );

  }


  await pool.query(`

    CREATE TABLE IF NOT EXISTS items (

      code TEXT PRIMARY KEY,

      name TEXT NOT NULL,

      created_at TIMESTAMPTZ
      NOT NULL DEFAULT NOW()

    );

  `);


  await pool.query(`

    CREATE TABLE IF NOT EXISTS stock (

      item_code TEXT PRIMARY KEY
      REFERENCES items(code)
      ON UPDATE CASCADE,

      pre_quantity NUMERIC
      NOT NULL DEFAULT 0,

      powder_balance NUMERIC
      NOT NULL DEFAULT 0,

      updated_at TIMESTAMPTZ
      NOT NULL DEFAULT NOW()

    );

  `);


  await pool.query(`

    CREATE TABLE IF NOT EXISTS transactions (

      id BIGSERIAL PRIMARY KEY,

      type TEXT NOT NULL,

      item_code TEXT NOT NULL
      REFERENCES items(code),

      item_name TEXT NOT NULL,

      quantity NUMERIC NOT NULL,

      remarks TEXT DEFAULT '',

      from_department TEXT DEFAULT '',

      to_department TEXT DEFAULT '',

      username TEXT DEFAULT '',

      created_at TIMESTAMPTZ
      NOT NULL DEFAULT NOW()

    );

  `);


  await pool.query(`

    CREATE TABLE IF NOT EXISTS completed_stock (

      id BIGSERIAL PRIMARY KEY,

      item_code TEXT NOT NULL
      REFERENCES items(code),

      item_name TEXT NOT NULL,

      quantity NUMERIC NOT NULL,

      username TEXT DEFAULT '',

      created_at TIMESTAMPTZ
      NOT NULL DEFAULT NOW()

    );

  `);


  console.log("Database tables are ready.");

}


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/api/health", async (req, res) => {

  try {

    await pool.query("SELECT 1");

    res.json({

      ok: true,

      message: "Stock server is running"

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({

      ok: false,

      message: "Database connection failed"

    });

  }

});


/* =====================================================
   GET ALL DATA
===================================================== */

app.get(
  "/api/data",
  authenticate,
  async (req, res) => {

    try {

      const itemsResult = await pool.query(`

        SELECT
          code,
          name

        FROM items

        ORDER BY code

      `);


      const stockResult = await pool.query(`

        SELECT

          item_code,
          pre_quantity,
          powder_balance

        FROM stock

      `);


      const transactionsResult = await pool.query(`

        SELECT

          id,
          type,
          item_code,
          item_name,
          quantity,
          remarks,
          from_department,
          to_department,
          username,
          created_at

        FROM transactions

        ORDER BY id ASC

      `);


      const completedResult = await pool.query(`

        SELECT

          id,
          item_code,
          item_name,
          quantity,
          username,
          created_at

        FROM completed_stock

        ORDER BY id ASC

      `);


      const transactions =
        transactionsResult.rows.map(row => {

          const dt =
            getDateTime(
              new Date(row.created_at)
            );

          return {

            id: row.id,

            type: row.type,

            item_code: row.item_code,

            item_name: row.item_name,

            quantity:
              toNumber(row.quantity),

            remarks:
              row.remarks || "",

            from:
              row.from_department || "",

            to:
              row.to_department || "",

            username:
              row.username || "",

            date: dt.date,

            time: dt.time

          };

        });


      const completed =
        completedResult.rows.map(row => {

          const dt =
            getDateTime(
              new Date(row.created_at)
            );

          return {

            id: row.id,

            item_code: row.item_code,

            item_name: row.item_name,

            quantity:
              toNumber(row.quantity),

            username:
              row.username || "",

            date: dt.date,

            time: dt.time

          };

        });


      res.json({

        items:
          itemsResult.rows,

        stock:
          stockResult.rows.map(row => ({

            item_code:
              row.item_code,

            pre_quantity:
              toNumber(row.pre_quantity),

            powder_balance:
              toNumber(row.powder_balance)

          })),

        transactions:
          transactions,

        completed:
          completed

      });

    } catch (error) {

      console.error(
        "GET DATA ERROR:",
        error
      );

      res.status(500).json({

        message:
          "Unable to load stock data"

      });

    }

  }
);


/* =====================================================
   ADD NEW ITEM CODE
===================================================== */

app.post(
  "/api/items",
  authenticate,
  async (req, res) => {

    if (
      !hasRole(
        req,
        ["pretreatment"]
      )
    ) {

      return res.status(403).json({

        message:
          "Only Pre Treatment can add item codes"

      });

    }


    const code =
      String(
        req.body?.code || ""
      ).trim();

    const name =
      String(
        req.body?.name || ""
      ).trim();


    if (!code || !name) {

      return res.status(400).json({

        message:
          "Item Code and Item Name are required"

      });

    }


    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );


      const existing =
        await client.query(

          `

          SELECT code

          FROM items

          WHERE LOWER(code)
          = LOWER($1)

          `,

          [code]

        );


      if (existing.rowCount > 0) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(409).json({

          message:
            "This Item Code already exists"

        });

      }


      await client.query(

        `

        INSERT INTO items
        (
          code,
          name
        )

        VALUES
        (
          $1,
          $2
        )

        `,

        [
          code,
          name
        ]

      );


      await client.query(

        `

        INSERT INTO stock
        (
          item_code,
          pre_quantity,
          powder_balance
        )

        VALUES
        (
          $1,
          0,
          0
        )

        `,

        [code]

      );


      await client.query(
        "COMMIT"
      );


      res.json({

        message:
          "Item added successfully",

        item: {
          code: code,
          name: name
        }

      });

    } catch (error) {

      await client.query(
        "ROLLBACK"
      );

      console.error(error);

      res.status(500).json({

        message:
          "Unable to add item"

      });

    } finally {

      client.release();

    }

  }
);


/* =====================================================
   ADD PRE TREATMENT STOCK
===================================================== */

app.post(
  "/api/stock/add",
  authenticate,
  async (req, res) => {

    if (
      !hasRole(
        req,
        ["pretreatment"]
      )
    ) {

      return res.status(403).json({

        message:
          "Only Pre Treatment can add stock"

      });

    }


    const itemCode =
      String(
        req.body?.itemCode || ""
      ).trim();

    const quantity =
      toNumber(
        req.body?.quantity
      );


    if (
      !itemCode ||
      quantity <= 0
    ) {

      return res.status(400).json({

        message:
          "Valid item and quantity are required"

      });

    }


    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );


      const itemResult =
        await client.query(

          `

          SELECT
            code,
            name

          FROM items

          WHERE code = $1

          FOR UPDATE

          `,

          [itemCode]

        );


      if (
        itemResult.rowCount === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          message:
            "Item not found"

        });

      }


      const item =
        itemResult.rows[0];


      await client.query(

        `

        INSERT INTO stock
        (
          item_code,
          pre_quantity,
          powder_balance
        )

        VALUES
        (
          $1,
          $2,
          0
        )

        ON CONFLICT(item_code)

        DO UPDATE SET

          pre_quantity =
            stock.pre_quantity
            + EXCLUDED.pre_quantity,

          updated_at = NOW()

        `,

        [
          itemCode,
          quantity
        ]

      );


      await client.query(

        `

        INSERT INTO transactions
        (
          type,
          item_code,
          item_name,
          quantity,
          username
        )

        VALUES
        (
          'ADD',
          $1,
          $2,
          $3,
          $4
        )

        `,

        [
          itemCode,
          item.name,
          quantity,
          req.user.username
        ]

      );


      await client.query(
        "COMMIT"
      );


      res.json({

        message:
          "Stock added successfully"

      });

    } catch (error) {

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "ADD STOCK ERROR:",
        error
      );

      res.status(500).json({

        message:
          "Unable to add stock"

      });

    } finally {

      client.release();

    }

  }
);


/* =====================================================
   SEND STOCK TO POWDER COATING
===================================================== */

app.post(
  "/api/stock/send",
  authenticate,
  async (req, res) => {

    if (
      !hasRole(
        req,
        ["pretreatment"]
      )
    ) {

      return res.status(403).json({

        message:
          "Only Pre Treatment can send stock"

      });

    }


    const itemCode =
      String(
        req.body?.itemCode || ""
      ).trim();

    const quantity =
      toNumber(
        req.body?.quantity
      );

    const remarks =
      String(
        req.body?.remarks || ""
      ).trim();


    if (
      !itemCode ||
      quantity <= 0
    ) {

      return res.status(400).json({

        message:
          "Valid item and quantity are required"

      });

    }


    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );


      const result =
        await client.query(

          `

          SELECT

            i.code,

            i.name,

            s.pre_quantity,

            s.powder_balance

          FROM items i

          JOIN stock s

          ON s.item_code = i.code

          WHERE i.code = $1

          FOR UPDATE

          `,

          [itemCode]

        );


      if (
        result.rowCount === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          message:
            "Item not found"

        });

      }


      const row =
        result.rows[0];


      const available =
        toNumber(
          row.pre_quantity
        );


      if (
        quantity > available
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          message:
            `Insufficient stock. Available: ${available}`

        });

      }


      await client.query(

        `

        UPDATE stock

        SET

          pre_quantity =
            pre_quantity - $1,

          powder_balance =
            powder_balance + $1,

          updated_at = NOW()

        WHERE item_code = $2

        `,

        [
          quantity,
          itemCode
        ]

      );


      await client.query(

        `

        INSERT INTO transactions
        (
          type,
          item_code,
          item_name,
          quantity,
          remarks,
          from_department,
          to_department,
          username
        )

        VALUES
        (
          'SEND_TO_POWDER',
          $1,
          $2,
          $3,
          $4,
          'Pre Treatment',
          'Powder Coating',
          $5
        )

        `,

        [
          itemCode,
          row.name,
          quantity,
          remarks,
          req.user.username
        ]

      );


      await client.query(
        "COMMIT"
      );


      res.json({

        message:
          "Stock sent to Powder Coating successfully"

      });

    } catch (error) {

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "SEND STOCK ERROR:",
        error
      );

      res.status(500).json({

        message:
          "Unable to send stock"

      });

    } finally {

      client.release();

    }

  }
);


/* =====================================================
   COMPLETE POWDER COATING STOCK
===================================================== */

app.post(
  "/api/stock/complete",
  authenticate,
  async (req, res) => {

    if (
      !hasRole(
        req,
        ["powdercoating"]
      )
    ) {

      return res.status(403).json({

        message:
          "Only Powder Coating can complete stock"

      });

    }


    const itemCode =
      String(
        req.body?.itemCode || ""
      ).trim();

    const quantity =
      toNumber(
        req.body?.quantity
      );


    if (
      !itemCode ||
      quantity <= 0
    ) {

      return res.status(400).json({

        message:
          "Valid item and quantity are required"

      });

    }


    const client =
      await pool.connect();

    try {

      await client.query(
        "BEGIN"
      );


      const result =
        await client.query(

          `

          SELECT

            i.code,

            i.name,

            s.powder_balance

          FROM items i

          JOIN stock s

          ON s.item_code = i.code

          WHERE i.code = $1

          FOR UPDATE

          `,

          [itemCode]

        );


      if (
        result.rowCount === 0
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({

          message:
            "Item not found"

        });

      }


      const row =
        result.rows[0];


      const available =
        toNumber(
          row.powder_balance
        );


      if (
        quantity > available
      ) {

        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({

          message:
            `Insufficient Powder Coating stock. Available: ${available}`

        });

      }


      await client.query(

        `

        UPDATE stock

        SET

          powder_balance =
            powder_balance - $1,

          updated_at = NOW()

        WHERE item_code = $2

        `,

        [
          quantity,
          itemCode
        ]

      );


      await client.query(

        `

        INSERT INTO completed_stock
        (
          item_code,
          item_name,
          quantity,
          username
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4
        )

        `,

        [
          itemCode,
          row.name,
          quantity,
          req.user.username
        ]

      );


      await client.query(

        `

        INSERT INTO transactions
        (
          type,
          item_code,
          item_name,
          quantity,
          username
        )

        VALUES
        (
          'POWDER_COMPLETED',
          $1,
          $2,
          $3,
          $4
        )

        `,

        [
          itemCode,
          row.name,
          quantity,
          req.user.username
        ]

      );


      await client.query(
        "COMMIT"
      );


      res.json({

        message:
          "Completed stock saved successfully"

      });

    } catch (error) {

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "COMPLETE STOCK ERROR:",
        error
      );

      res.status(500).json({

        message:
          "Unable to save completed stock"

      });

    } finally {

      client.release();

    }

  }
);


/* =====================================================
   SERVE INDEX.HTML
===================================================== */

app.get(
  "*",
  (req, res) => {

    if (
      req.path.startsWith("/api/")
    ) {

      return res.status(404).json({

        message:
          "API endpoint not found"

      });

    }

    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );

  }
);


/* =====================================================
   START SERVER
===================================================== */

async function startServer() {

  try {

    await initializeDatabase();

    app.listen(
      PORT,
      () => {

        console.log(
          `Stock Management Server running on port ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "DATABASE INITIALIZATION FAILED:"
    );

    console.error(error);

    process.exit(1);

  }

}

startServer();
