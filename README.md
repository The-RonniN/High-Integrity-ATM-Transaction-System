# 🏧 NexBank — High-Integrity ATM Transaction System

> A full-stack ATM simulation with **ACID-compliant transactions**, **JWT authentication**, and a modern FinTech UI — built for the PREMICA Project.

![Stack](https://img.shields.io/badge/Stack-Node.js%20%7C%20Express%20%7C%20SQLite-blue?style=flat-square)
![License](https://img.shields.io/badge/License-ISC-green?style=flat-square)
![Version](https://img.shields.io/badge/Version-1.0.0-orange?style=flat-square)

---

## 📌 Overview

NexBank ATM is a full-stack banking simulation that solves two major flaws found in most ATM simulations:

| Problem | Solution |
|---|---|
| Data corruption on crash | ACID SQLite transactions via `better-sqlite3` |
| Negative balances | `CHECK(balance >= 0)` SQL constraint at DB level |
| Brute force attacks | `express-rate-limit` on all auth endpoints |
| Session hijacking | JWT tokens with 30-minute expiry |
| Password leaks | `bcryptjs` PIN hashing (cost factor 10) |
| Insecure HTTP headers | `helmet` middleware |

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v18+

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/The-RonniN/High-Integrity-ATM-Transaction-System.git
cd High-Integrity-ATM-Transaction-System

# 2. Install dependencies
npm install

# 3. Start the server
node server.js

# 4. Open in browser
# http://localhost:3000
```

> **Note:** The SQLite database (`atm.db`) is created automatically on first run with 3 pre-seeded demo accounts.

---

## 🗂️ Project Structure

```
atm/
├── server.js          ← Express backend: all API routes + DB logic
├── package.json       ← NPM config & dependencies
├── .gitignore
└── public/
    ├── index.html     ← Full SPA: login screen + dashboard
    ├── style.css      ← Dark theme design system
    └── app.js         ← Frontend logic (auth, transactions, UI)
```

---

## 🎮 Demo Accounts

Three accounts are pre-seeded on first run:

| Name | Card Number | PIN | Type | Balance |
|---|---|---|---|---|
| Alex Johnson | `4532 1234 5678 9012` | `1234` | Savings | ₹25,000.50 |
| Priya Sharma | `4532 9876 5432 1000` | `5678` | Current | ₹85,750.00 |
| Marcus Lee | `4532 1111 2222 3333` | `9999` | Savings | ₹5,200.75 |

---

## ✨ Features

| # | Feature | Details |
|---|---|---|
| 1 | **ACID Transactions** | All financial ops use SQLite transaction blocks |
| 2 | **WAL Mode** | Crash-safe DB journaling |
| 3 | **bcrypt PIN hashing** | Cost factor 10, never reversible |
| 4 | **JWT Sessions** | 30-min tokens, server-side verification |
| 5 | **Rate Limiting** | Auth: 20/15min · Transactions: 30/min |
| 6 | **Helmet Security** | HSTS, X-Frame-Options, CSP headers |
| 7 | **Cash Withdrawal** | ₹100 multiples, ₹50K max, ACID-safe |
| 8 | **Cash Deposit** | ₹2L max, ACID-safe |
| 9 | **Fund Transfer** | Dual atomic debit+credit, same reference ID |
| 10 | **Transaction History** | Paginated, immutable audit trail |
| 11 | **Account Registration** | Self-register, card number auto-generated |
| 12 | **Session Timer** | 30-min countdown with colour warnings |
| 13 | **Auto-Logout** | Session cleared in DB on expiry |
| 14 | **Copy Card Number** | 1-click clipboard copy on dashboard |
| 15 | **Animated Balance** | Smooth number animation on load/refresh |

---

## 🔐 ACID Compliance

`better-sqlite3` is **synchronous** — all DB operations are serialized, giving true ACID guarantees:

| Property | How It's Achieved |
|---|---|
| **Atomicity** | Balance update + audit log written together or not at all |
| **Consistency** | `CHECK(balance >= 0)` always enforced by SQLite |
| **Isolation** | SQLite serializes all writes — no concurrent conflicts |
| **Durability** | WAL journal + `FULL` synchronous pragma — survives crashes |

---

## 📡 API Reference

**Base URL:** `http://localhost:3000/api`

### Public Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/auth/register` | Create a new account |
| `POST` | `/auth/login` | Login with card + PIN, returns JWT |
| `GET` | `/accounts/list` | List registered accounts |
| `GET` | `/health` | Server health check |

### Protected Endpoints *(require `Authorization: Bearer <token>`)*

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/auth/logout` | Invalidate current session |
| `GET` | `/account/balance` | Get live balance (logged to audit trail) |
| `POST` | `/transaction/withdraw` | Withdraw cash (ACID) |
| `POST` | `/transaction/deposit` | Deposit cash (ACID) |
| `POST` | `/transaction/transfer` | Transfer to another card (dual-atomic) |
| `GET` | `/transactions/history` | Paginated transaction history |
| `GET` | `/account/mini-statement` | Last 5 transactions |

---

## 🛠️ Tech Stack

| Package | Purpose |
|---|---|
| `express` | HTTP server & routing |
| `better-sqlite3` | Synchronous SQLite (true ACID transactions) |
| `bcryptjs` | PIN hashing |
| `jsonwebtoken` | JWT session tokens |
| `uuid` | Unique reference IDs per transaction |
| `cors` | Cross-origin resource sharing |
| `express-rate-limit` | Brute-force protection |
| `helmet` | Secure HTTP headers |

---

## 🗄️ Viewing the Database

**Option A — DB Browser for SQLite** *(recommended)*
1. Download: [sqlitebrowser.org](https://sqlitebrowser.org/dl/)
2. Open `atm.db` from the project folder

**Option B — VS Code Extension**
- Install **SQLite Viewer** by Florian Klampfer

**Option C — Terminal Quick Check**
```bash
node -e "
  const db = require('better-sqlite3')('./atm.db');
  console.table(db.prepare('SELECT card_number, full_name, balance FROM accounts').all());
"
```

---

## 📄 License

ISC — Built for **PREMICA Project · April 2026**
