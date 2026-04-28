/**
 * ATM Transaction System - Server
 * ACID-compliant backend using SQLite with better-sqlite3 (synchronous, true transactions)
 */

const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");

const app = express();
const PORT = 3000;
const JWT_SECRET = "atm_fintech_secret_2024_highly_secure_key";

// ─── Security Middleware ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Rate limiting - protect against brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: "Too many requests, please try again later." },
});

const txLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: "Transaction rate limit exceeded." },
});

// ─── Database Initialization ────────────────────────────────────────────────
const db = new Database(path.join(__dirname, "atm.db"));

// Enable WAL mode for better concurrency & durability
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = FULL"); // Maximum durability

// Create schema inside a transaction (atomic DDL)
db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      card_number TEXT UNIQUE NOT NULL,
      pin_hash    TEXT NOT NULL,
      full_name   TEXT NOT NULL,
      balance     REAL NOT NULL DEFAULT 0 CHECK(balance >= 0),
      account_type TEXT NOT NULL DEFAULT 'savings',
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_login  TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      account_id    TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('deposit','withdrawal','transfer_in','transfer_out','balance_check')),
      amount        REAL,
      balance_before REAL NOT NULL,
      balance_after  REAL NOT NULL,
      status        TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed','rolled_back')),
      description   TEXT,
      reference_id  TEXT,
      ip_address    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      is_active  INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_card_number ON accounts(card_number);
  `);
})();

// ─── Seed Demo Accounts ─────────────────────────────────────────────────────
const seedAccounts = db.transaction(() => {
  const count = db.prepare("SELECT COUNT(*) as cnt FROM accounts").get();
  if (count.cnt === 0) {
    const demoUsers = [
      {
        card: "4532 1234 5678 9012",
        pin: "1234",
        name: "Amruta Patil",
        balance: 25000.5,
        type: "savings",
      },
      {
        card: "4532 9876 5432 1000",
        pin: "5678",
        name: "Priya Sharma",
        balance: 85750.0,
        type: "current",
      },
      {
        card: "4532 1111 2222 3333",
        pin: "9999",
        name: "Rupali Taware",
        balance: 5200.75,
        type: "savings",
      },
    ];
    const insert = db.prepare(
      `INSERT INTO accounts (card_number, pin_hash, full_name, balance, account_type)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const u of demoUsers) {
      const hash = bcrypt.hashSync(u.pin, 10);
      insert.run(u.card, hash, u.name, u.balance, u.type);
    }
    console.log("✅ Demo accounts seeded");
  }
});
seedAccounts();

// ─── Auth Middleware ────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Authentication required" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify session is still active in DB
    const session = db
      .prepare(
        `SELECT * FROM sessions WHERE id = ? AND is_active = 1 AND expires_at > datetime('now')`,
      )
      .get(decoded.sessionId);

    if (!session)
      return res
        .status(401)
        .json({ error: "Session expired. Please login again." });

    const account = db
      .prepare("SELECT * FROM accounts WHERE id = ? AND is_active = 1")
      .get(decoded.accountId);
    if (!account)
      return res.status(401).json({ error: "Account not found or disabled." });

    req.account = account;
    req.sessionId = decoded.sessionId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post("/api/auth/login", authLimiter, (req, res) => {
  const { cardNumber, pin } = req.body;
  if (!cardNumber || !pin)
    return res.status(400).json({ error: "Card number and PIN required" });

  const account = db
    .prepare("SELECT * FROM accounts WHERE card_number = ? AND is_active = 1")
    .get(cardNumber.trim());
  if (!account)
    return res
      .status(401)
      .json({ error: "Card not recognized. Please try again." });

  const pinValid = bcrypt.compareSync(String(pin), account.pin_hash);
  if (!pinValid)
    return res.status(401).json({ error: "Incorrect PIN. Please try again." });

  // Atomic login: update last_login + create session in one transaction
  const loginTx = db.transaction(() => {
    db.prepare(
      `UPDATE accounts SET last_login = datetime('now') WHERE id = ?`,
    ).run(account.id);

    // Invalidate existing sessions
    db.prepare(`UPDATE sessions SET is_active = 0 WHERE account_id = ?`).run(
      account.id,
    );

    const sessionId = uuidv4();
    db.prepare(
      `INSERT INTO sessions (id, account_id, expires_at)
       VALUES (?, ?, datetime('now', '+30 minutes'))`,
    ).run(sessionId, account.id);

    return sessionId;
  });

  const sessionId = loginTx();
  const token = jwt.sign({ accountId: account.id, sessionId }, JWT_SECRET, {
    expiresIn: "30m",
  });

  return res.json({
    token,
    account: {
      id: account.id,
      fullName: account.full_name,
      cardNumber: account.card_number,
      accountType: account.account_type,
      balance: account.balance,
      lastLogin: account.last_login,
    },
  });
});

// POST /api/auth/register
app.post("/api/auth/register", authLimiter, (req, res) => {
  const { fullName, pin, confirmPin, accountType } = req.body;

  if (!fullName || !fullName.trim())
    return res.status(400).json({ error: "Full name is required." });
  if (fullName.trim().split(" ").length < 2)
    return res
      .status(400)
      .json({ error: "Please enter your full name (first and last)." });
  if (!pin || String(pin).length !== 4 || isNaN(pin))
    return res.status(400).json({ error: "PIN must be exactly 4 digits." });
  if (pin !== confirmPin)
    return res.status(400).json({ error: "PINs do not match." });
  if (!["savings", "current"].includes(accountType))
    return res.status(400).json({ error: "Invalid account type." });

  // Generate a unique 16-digit card number (Visa-style starting with 4532)
  const generateCardNumber = () => {
    const part = () => String(Math.floor(1000 + Math.random() * 9000));
    return `4532 ${part()} ${part()} ${part()}`;
  };

  const registerTx = db.transaction(() => {
    let cardNumber;
    let attempts = 0;
    do {
      cardNumber = generateCardNumber();
      attempts++;
      if (attempts > 10)
        throw new Error("Could not generate a unique card number. Try again.");
    } while (
      db
        .prepare("SELECT id FROM accounts WHERE card_number = ?")
        .get(cardNumber)
    );

    const pinHash = bcrypt.hashSync(String(pin), 10);

    db.prepare(
      `INSERT INTO accounts (card_number, pin_hash, full_name, balance, account_type)
       VALUES (?, ?, ?, 0, ?)`,
    ).run(cardNumber, pinHash, fullName.trim(), accountType);

    return { cardNumber };
  });

  try {
    const result = registerTx();
    return res.status(201).json({
      success: true,
      message: "Account created successfully!",
      cardNumber: result.cardNumber,
      accountType,
      fullName: fullName.trim(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
app.post("/api/auth/logout", authenticateToken, (req, res) => {
  db.prepare("UPDATE sessions SET is_active = 0 WHERE id = ?").run(
    req.sessionId,
  );
  return res.json({ message: "Logged out successfully" });
});

// GET /api/account/balance
app.get("/api/account/balance", authenticateToken, (req, res) => {
  // Log balance check as a transaction (audit trail)
  const balanceTx = db.transaction(() => {
    const fresh = db
      .prepare("SELECT balance FROM accounts WHERE id = ?")
      .get(req.account.id);
    db.prepare(
      `INSERT INTO transactions (account_id, type, balance_before, balance_after, description, ip_address)
       VALUES (?, 'balance_check', ?, ?, 'Balance enquiry', ?)`,
    ).run(req.account.id, fresh.balance, fresh.balance, req.ip);
    return fresh.balance;
  });

  const balance = balanceTx();
  return res.json({ balance, timestamp: new Date().toISOString() });
});

// POST /api/transaction/withdraw
app.post(
  "/api/transaction/withdraw",
  authenticateToken,
  txLimiter,
  (req, res) => {
    const { amount } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0)
      return res.status(400).json({ error: "Invalid withdrawal amount" });
    if (parsedAmount > 50000)
      return res
        .status(400)
        .json({ error: "Exceeds single transaction limit of ₹50,000" });
    if (parsedAmount % 100 !== 0)
      return res
        .status(400)
        .json({ error: "Amount must be in multiples of ₹100" });

    // ─── ACID TRANSACTION ───────────────────────────────────────────────────
    // Atomicity: either all steps succeed or none do
    // Consistency: CHECK(balance >= 0) enforced by SQLite constraint
    // Isolation: better-sqlite3 runs synchronously; SQLite serializes writes
    // Durability: WAL + FULL synchronous pragma ensures committed data survives crash
    const withdrawTx = db.transaction(() => {
      // SELECT FOR UPDATE equivalent: lock the row by reading inside the transaction
      const account = db
        .prepare("SELECT balance FROM accounts WHERE id = ? AND is_active = 1")
        .get(req.account.id);

      if (!account) throw new Error("Account not found");
      if (account.balance < parsedAmount)
        throw new Error(
          `Insufficient funds. Available balance: ₹${account.balance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
        );

      const newBalance = parseFloat(
        (account.balance - parsedAmount).toFixed(2),
      );
      const refId = "WD-" + uuidv4().slice(0, 8).toUpperCase();

      // Update balance
      db.prepare("UPDATE accounts SET balance = ? WHERE id = ?").run(
        newBalance,
        req.account.id,
      );

      // Immutable audit log entry
      db.prepare(
        `INSERT INTO transactions (account_id, type, amount, balance_before, balance_after, description, reference_id, ip_address)
       VALUES (?, 'withdrawal', ?, ?, ?, ?, ?, ?)`,
      ).run(
        req.account.id,
        parsedAmount,
        account.balance,
        newBalance,
        `Cash withdrawal`,
        refId,
        req.ip,
      );

      return { newBalance, refId, balanceBefore: account.balance };
    });

    try {
      const result = withdrawTx();
      return res.json({
        success: true,
        message: `₹${parsedAmount.toLocaleString("en-IN")} withdrawn successfully`,
        referenceId: result.refId,
        newBalance: result.newBalance,
        amountDispensed: parsedAmount,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  },
);

// POST /api/transaction/deposit
app.post(
  "/api/transaction/deposit",
  authenticateToken,
  txLimiter,
  (req, res) => {
    const { amount } = req.body;
    const parsedAmount = parseFloat(amount);

    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0)
      return res.status(400).json({ error: "Invalid deposit amount" });
    if (parsedAmount > 200000)
      return res
        .status(400)
        .json({ error: "Exceeds single deposit limit of ₹2,00,000" });

    const depositTx = db.transaction(() => {
      const account = db
        .prepare("SELECT balance FROM accounts WHERE id = ?")
        .get(req.account.id);
      const newBalance = parseFloat(
        (account.balance + parsedAmount).toFixed(2),
      );
      const refId = "DP-" + uuidv4().slice(0, 8).toUpperCase();

      db.prepare("UPDATE accounts SET balance = ? WHERE id = ?").run(
        newBalance,
        req.account.id,
      );
      db.prepare(
        `INSERT INTO transactions (account_id, type, amount, balance_before, balance_after, description, reference_id, ip_address)
       VALUES (?, 'deposit', ?, ?, ?, 'Cash deposit', ?, ?)`,
      ).run(
        req.account.id,
        parsedAmount,
        account.balance,
        newBalance,
        refId,
        req.ip,
      );

      return { newBalance, refId, balanceBefore: account.balance };
    });

    try {
      const result = depositTx();
      return res.json({
        success: true,
        message: `₹${parsedAmount.toLocaleString("en-IN")} deposited successfully`,
        referenceId: result.refId,
        newBalance: result.newBalance,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  },
);

// POST /api/transaction/transfer
app.post(
  "/api/transaction/transfer",
  authenticateToken,
  txLimiter,
  (req, res) => {
    const { toCardNumber, amount } = req.body;
    const parsedAmount = parseFloat(amount);

    if (
      !toCardNumber ||
      !parsedAmount ||
      isNaN(parsedAmount) ||
      parsedAmount <= 0
    )
      return res.status(400).json({ error: "Invalid transfer details" });
    if (toCardNumber.trim() === req.account.card_number)
      return res
        .status(400)
        .json({ error: "Cannot transfer to your own account" });
    if (parsedAmount > 100000)
      return res
        .status(400)
        .json({ error: "Exceeds transfer limit of ₹1,00,000" });

    const transferTx = db.transaction(() => {
      const sender = db
        .prepare("SELECT balance FROM accounts WHERE id = ?")
        .get(req.account.id);
      const recipient = db
        .prepare(
          "SELECT * FROM accounts WHERE card_number = ? AND is_active = 1",
        )
        .get(toCardNumber.trim());

      if (!recipient) throw new Error("Recipient account not found");
      if (sender.balance < parsedAmount)
        throw new Error(
          `Insufficient funds. Available: ₹${sender.balance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
        );

      const senderNewBal = parseFloat(
        (sender.balance - parsedAmount).toFixed(2),
      );
      const recipientNewBal = parseFloat(
        (recipient.balance + parsedAmount).toFixed(2),
      );
      const refId = "TF-" + uuidv4().slice(0, 8).toUpperCase();

      // Debit sender
      db.prepare("UPDATE accounts SET balance = ? WHERE id = ?").run(
        senderNewBal,
        req.account.id,
      );
      // Credit recipient
      db.prepare("UPDATE accounts SET balance = ? WHERE id = ?").run(
        recipientNewBal,
        recipient.id,
      );

      // Dual audit trail
      db.prepare(
        `INSERT INTO transactions (account_id, type, amount, balance_before, balance_after, description, reference_id, ip_address)
       VALUES (?, 'transfer_out', ?, ?, ?, ?, ?, ?)`,
      ).run(
        req.account.id,
        parsedAmount,
        sender.balance,
        senderNewBal,
        `Transfer to ${recipient.full_name}`,
        refId,
        req.ip,
      );

      db.prepare(
        `INSERT INTO transactions (account_id, type, amount, balance_before, balance_after, description, reference_id, ip_address)
       VALUES (?, 'transfer_in', ?, ?, ?, ?, ?, ?)`,
      ).run(
        recipient.id,
        parsedAmount,
        recipient.balance,
        recipientNewBal,
        `Transfer from ${req.account.full_name}`,
        refId,
        req.ip,
      );

      return { senderNewBal, refId, recipientName: recipient.full_name };
    });

    try {
      const result = transferTx();
      return res.json({
        success: true,
        message: `₹${parsedAmount.toLocaleString("en-IN")} transferred to ${result.recipientName}`,
        referenceId: result.refId,
        newBalance: result.senderNewBal,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  },
);

// GET /api/transactions/history
app.get("/api/transactions/history", authenticateToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = parseInt(req.query.offset) || 0;

  const transactions = db
    .prepare(
      `SELECT id, type, amount, balance_before, balance_after, status, description, reference_id, created_at
     FROM transactions
     WHERE account_id = ? AND type != 'balance_check'
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    )
    .all(req.account.id, limit, offset);

  const total = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM transactions WHERE account_id = ? AND type != 'balance_check'`,
    )
    .get(req.account.id);

  return res.json({ transactions, total: total.cnt });
});

// GET /api/account/mini-statement
app.get("/api/account/mini-statement", authenticateToken, (req, res) => {
  const txs = db
    .prepare(
      `SELECT type, amount, balance_after, description, created_at
     FROM transactions WHERE account_id = ? AND type != 'balance_check'
     ORDER BY created_at DESC LIMIT 5`,
    )
    .all(req.account.id);
  return res.json({ transactions: txs });
});

// GET /api/accounts/list  — public, returns non-demo registered accounts for quick-fill
const DEMO_CARDS = [
  "4532 1234 5678 9012",
  "4532 9876 5432 1000",
  "4532 1111 2222 3333",
];
app.get("/api/accounts/list", (req, res) => {
  const accounts = db
    .prepare(
      `SELECT full_name, card_number, account_type, created_at
     FROM accounts
     WHERE is_active = 1
     ORDER BY created_at DESC`,
    )
    .all();
  // Separate demo vs registered
  const registered = accounts.filter(
    (a) => !DEMO_CARDS.includes(a.card_number),
  );
  return res.json({ accounts: registered });
});

// Health check
app.get("/api/health", (req, res) => {
  const dbStatus = db.prepare("SELECT COUNT(*) as cnt FROM accounts").get();
  res.json({
    status: "ok",
    accounts: dbStatus.cnt,
    timestamp: new Date().toISOString(),
  });
});

// Serve frontend for all other routes
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🏦 ATM System running at http://localhost:${PORT}`);
  console.log("─────────────────────────────────────────");
  console.log("Demo Cards:");
  console.log("  Card: 4532 1234 5678 9012  PIN: 1234  (Amruta patil)");
  console.log("  Card: 4532 9876 5432 1000  PIN: 5678  (Priya Sharma)");
  console.log("  Card: 4532 1111 2222 3333  PIN: 9999  (Rupali Taware)");
  console.log("─────────────────────────────────────────\n");
});
