# Investment Decision Journal

**A personal project combining software engineering with cognitive psychology and behavioral finance.**

This repository contains the backend of **Investment Decision Journal** — an application that helps investors understand how **cognitive biases** shape their real-world trading decisions.

---

## 🎯 Purpose of the Project

Investment decisions are rarely purely rational. Even experienced investors fall prey to cognitive biases such as:

- loss aversion
- confirmation bias
- anchoring
- sunk cost fallacy
- herd behavior
- overconfidence

This application identifies these biases by analyzing, for every investment decision:

- the user's stated motivation for the trade,
- the detailed reasoning behind it,
- the actual price movement that followed.

The goal is clear, psychologically grounded feedback that helps users recognize patterns in their own thinking and make better decisions over time.

---

## 🧠 Why This Project Exists

This project combines two areas of expertise:

- **Software development** — Node.js, Express, MongoDB, API design
- **Formal education in sociology and psychology** — especially cognitive psychology and behavioral finance

The result is a tool that doesn't just log investment decisions, but explains the psychological mechanisms behind them.

This is not a trading bot. It's a **self-reflection and learning tool** for swing/position traders — investors who hold positions for days to months, not day traders.

---

## 🏗️ How It Works

```
Browser / Postman
   ↓
server.js       → starts the server, wires everything together
   ↓
routes/         → matches the URL and HTTP method
   ↓
middleware/     → auth checks, disclaimer gate, error handling
   ↓
controllers/    → business logic and validation
   ↓
services/       → Finnhub (price, news), Twelve Data (history), Gemini (AI) —
                   all mediated through a cache layer and an AI usage limiter
   ↓
models/         → User, Position, Action, CacheEntry (Mongoose)
   ↓
MongoDB
```

A position moves through a lifecycle — **open → add / hold / reduce → close → AI analysis** — with every step logged as a separate, timestamped `Action`.

---

## 🧩 Tech Stack

- **Node.js + Express** — server and routing
- **MongoDB + Mongoose** — database and schema, with ACID transactions on multi-document writes
- **JWT (jsonwebtoken) + bcryptjs** — authentication
- **Finnhub** — real-time stock price and company news
- **Twelve Data** — daily historical OHLCV price data
- **Google Gemini** (`gemini-2.5-flash`) — structured-output AI analysis of behavioral biases

---

## 📂 Project Structure

```
investment-journal/
│
├── server.js
├── config/
│   └── db.js
├── models/
│   ├── User.js
│   ├── Position.js
│   ├── Action.js
│   └── CacheEntry.js
├── controllers/
│   ├── positionsController.js
│   ├── analysisController.js
│   ├── authController.js
│   ├── statsController.js
│   └── adminController.js
├── routes/
│   ├── positions.routes.js
│   ├── auth.routes.js
│   ├── stats.routes.js
│   └── admin.routes.js
├── middleware/
│   ├── auth.js
│   ├── ensureAiAccessible.js
│   ├── adminOnly.js
│   └── errorHandler.js
├── services/
│   ├── currentPriceService.js
│   ├── historyPriceService.js
│   ├── aiAnalysisService.js
│   ├── cacheService.js
│   └── aiRateLimiter.js
└── utils/
    ├── motivationOptions.js
    ├── biasList.js
    ├── validateAiResponse.js
    └── tradingCalendar.js
```

---

## 🔍 Features

### ✔ Investment decision logging

Every position tracks its full history: ticker, action type (open/add/hold/reduce/close), stated motivation, detailed reasoning, and the price at the moment of the decision — with reasoning allowed to be added after the fact, since real reflection doesn't always happen instantly.

### ✔ Quick AI check

Fast feedback based on the reasoning alone, available at any point in a position's life.

### ✔ Full AI analysis

After a follow-up period, the app fetches the current price, compares it against the original decision, and asks the AI to identify which cognitive biases were likely at play — storing a full snapshot of the market context and inputs used, so every analysis stays reproducible.

### ✔ Statistics

Aggregations across all of a user's decisions:

- which biases appear most often
- how biases correlate with gains and losses
- patterns between stated motivation and actual behavior

---

## 🔒 Data Integrity & Security

- JWT-based authentication; every request is scoped to its owner (`req.userId`)
- A disclaimer must be accepted before any AI feature is accessible
- Position/Action writes use MongoDB transactions, so a partial failure can never leave a position and its action history out of sync
- A dedicated, atomic daily usage limiter protects the AI quota per user
- A guard prevents an action from one position being referenced through another position's ID
- Positions are soft-deleted, never destroyed outright

---

## 📡 API Overview

| Endpoint                                                | Auth | Description                     |
| ------------------------------------------------------- | ---- | ------------------------------- |
| `POST /api/auth/register`                               | —    | Create an account               |
| `POST /api/auth/login`                                  | —    | Get a JWT                       |
| `POST /api/auth/accept-disclaimer`                      | JWT  | Unlock AI features              |
| `POST /api/positions`                                   | JWT  | Open a new position             |
| `GET /api/positions`                                    | JWT  | List your positions             |
| `GET /api/positions/:id`                                | JWT  | Position detail                 |
| `POST /api/positions/:id/actions`                       | JWT  | Log add / hold / reduce / close |
| `PATCH /api/positions/:id/actions/:actionId/reasoning`  | JWT  | Add or edit reasoning           |
| `POST /api/positions/:id/actions/:actionId/quick-check` | JWT  | Quick AI check                  |
| `POST /api/positions/:id/analyze`                       | JWT  | Full AI analysis                |
| `GET /api/positions/:id/analyses`                       | JWT  | Analysis history                |
| `POST/GET /api/positions/:id/outcome-checks`            | JWT  | Post-close outcome check-ins    |
| `GET /api/positions/needing-checkin`                    | JWT  | Positions due for follow-up     |
| `GET /api/stats`                                        | JWT  | Aggregated statistics           |

---

## 🚀 Roadmap

1. Backend skeleton
2. Position/Action data model and transactional writes
3. Authentication
4. Market price integration (current + historical)
5. AI analysis integration (quick-check + full analysis)
6. Statistics module
7. Simple frontend
8. Deployment (Render + MongoDB Atlas)

---

## 📌 Status

Architecture and data model are finalized; backend implementation is in progress, following the staged build order above.

More updates as development continues.
