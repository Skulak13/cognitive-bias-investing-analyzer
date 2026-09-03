# Cognitive Bias Investing Analyzer  
**A personal project combining software engineering with cognitive psychology and behavioral finance.**

This repository contains the early-stage development of **Cognitive Bias Investing Analyzer** — a backend application designed to help investors understand how **cognitive biases** influence their real-world trading decisions.

The project is currently in its initial setup phase.  
New features, documentation, and code will appear here as development progresses.

---

## 🎯 Purpose of the Project

Investment decisions are rarely purely rational.  
Even experienced investors fall prey to cognitive biases such as:

- loss aversion  
- confirmation bias  
- anchoring  
- sunk cost fallacy  
- herd behavior  
- overconfidence  

This application aims to **identify these biases automatically** by analyzing:

- the user’s stated motivation for a trade,  
- the detailed reasoning behind the decision,  
- the actual price movement after a chosen follow-up period.

The goal is to provide **clear, psychologically grounded feedback** that helps users recognize patterns in their thinking and improve future decision-making.

---

## 🧠 Why This Project Exists

I created this project to combine two areas of expertise:

- **Software development** — Node.js, Express, MongoDB, API design  
- **Formal education in sociology and psychology** — especially cognitive psychology and behavioral finance  

The result is a tool that not only tracks investment decisions, but also **explains the hidden psychological mechanisms** behind them.

This is not a trading bot.  
It is a **self-reflection and learning tool**.

---

## 🏗️ Current Status

The project is in the **initial setup stage**:

- Repository created  
- Architecture and development plan prepared  
- MongoDB Atlas cluster configured  
- API design drafted  
- Work on backend structure is beginning  

As development continues, this README will be updated with:

- installation instructions  
- API documentation  
- example requests  
- demo endpoints  
- deployment links  
- screenshots of the frontend (later stage)

---

## 🧩 Planned Architecture (Backend)

The backend will follow a clean, modular structure:

server.js
config/
controllers/
routes/
middleware/
services/
models/
utils/
scripts/


Key technologies:

- **Node.js + Express** — server and routing  
- **MongoDB + Mongoose** — database and schema  
- **Finnhub API** — real-time stock prices  
- **Google Gemini API** — cognitive bias analysis  
- **JWT authentication** — secure access  
- **Aggregation pipelines** — statistical summaries  

---

## 🔍 What the App Will Do (Planned Features)

### ✔ Record investment decisions  
Users log:
- ticker  
- decision type (buy/sell/hold)  
- conscious motivation  
- detailed reasoning  
- price at decision time  

### ✔ Quick AI analysis  
Immediate feedback based only on the reasoning.

### ✔ Full AI analysis  
After a follow-up period, the app:
- fetches the new price  
- compares it with the original  
- asks AI to identify cognitive biases  
- stores the full analysis  

### ✔ Statistics  
Aggregations showing:
- which biases appear most often  
- how biases correlate with gains/losses  
- patterns between stated motivation and actual behavior  

### ✔ Public demo mode  
A safe, anonymized dataset for recruiters and non-technical viewers.

---

## 🚀 Roadmap

1. **Backend skeleton**  
2. CRUD for decisions  
3. Authentication  
4. Stock price integration  
5. AI analysis integration  
6. Statistics  
7. Demo mode  
8. Simple frontend  
9. Deployment (Render + MongoDB Atlas)

---

## 📬 Contact

If you’re interested in the project or want to follow its progress, feel free to reach out.

---

## 📌 Note

This repository is intentionally public at an early stage.  
The goal is to document the full development process — from empty folder to fully functional application — as part of my learning journey and portfolio.

More updates coming soon.
