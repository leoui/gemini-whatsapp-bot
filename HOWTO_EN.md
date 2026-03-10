# 📊 Investment Manager v3 — User Guide (English)

## What Is It?

Your WhatsApp bot has **AI-powered stock analysis**! Send a message and it will:

- 📈 Fetch real-time price & technicals from **Yahoo Finance**
- 🏦 Fetch fundamental data (P/E, ROE, margins) from **FMP API**
- 🕵️ **Bandarmology** — detect smart money & whale movements
- 🧠 Analyze using **AI** (Gemini or Claude)
- 🎯 Give **BUY / HOLD / SELL** signals with confidence %
- 📋 Generate **trading plans** (entry, stop-loss, take-profit)

---

## 💰 Free vs Paid — Choose Your AI

| | `/gm` (Gemini) — **FREE** | `/cl` (Claude) — **PAID** |
|---|---|---|
| **Price** | Free | ~$0.01-0.03 per analysis |
| **Model** | Gemini 2.5 Flash | Claude Sonnet 4 |
| **Speed** | ⚡ Fast (~5s) | 🕐 Medium (~10-15s) |
| **Quality** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ Premium |
| **Bandarmology** | ✅ Yes | ✅ Yes |
| **Credit tracking** | ❌ No | ✅ Shows cost + balance |

### When to use `/gm`?
- Daily quick checks, routine analysis, cost-free usage

### When to use `/cl`?
- Important investment decisions, deep analysis. Every response shows credit used + remaining balance.

---

## Example Commands

### 📊 Stock Analysis
```
/gm analyze BBRI.JK
/cl analyze AAPL
```

### 🕵️ Bandarmology / Smart Money
```
/gm check bandarmology BBCA.JK
/cl is there whale activity in NVDA?
```

### 📋 Trading Plan / Scalping
```
/gm trading plan NVDA scalping
/cl create a trading plan for BBRI.JK
```

### 💰 Valuation / Comparison
```
/gm is BBCA.JK undervalued?
/cl compare AAPL and MSFT
```

---

## Reading the Report

### 📊 Quick Summary — One-line company description
### 💰 Valuation — P/E, P/B, PEG (if fundamental data available)
### 🏦 Fundamental Health — ROE, D/E, margins

### 🕵️ Bandar Analysis (Smart Money Tracking) — **NEW!**
- **OBV Trend** — RISING = accumulation, FALLING = distribution
- **Whale Activity** 🐋 — volume > 2x average
- **Smart Money Signals** — 🟢 ACC, 🔴 DIST, 🕵️ STEALTH, 💤 DRY-UP
- **Bandar Score (7d)** — positive = accumulation, negative = distribution

### ⚡ Scalping — RSI, SMA, S/R levels
### 🎯 Signal — 🟢 BUY / 🟡 HOLD / 🔴 SELL with confidence %
### 📋 Trading Plan — Entry, SL, TP1, TP2

### 💳 Credit Info (`/cl` only)
```
Credit used for this analysis:
$0.03

Claude Remaining Balance: ~$24.73
```

---

## Data Sources

| Source | Data | Cost |
|---|---|---|
| Yahoo Finance | Price, volume, RSI, SMA, S/R | Free |
| FMP API | P/E, P/B, ROE, margins, D/E, FCF | Free (25/day) |
| Bandarmology | OBV, whale, smart money, Bandar Score | Free (algorithm) |

---

## FAQ

**Q: Is `/gm` really free?** Yes, uses existing Gemini keys.

**Q: How much does `/cl` cost?** ~$0.01-0.03 per analysis. Balance shown in each response.

**Q: What is Bandarmology?** Tracks institutional ("bandar") movements via volume patterns. Detects accumulation, distribution, and whale activity.

**Q: Is Bandarmology accurate?** Based on actual volume data (⭐⭐⭐⭐/5). Great as an additional indicator.

---

> ⚠️ **Disclaimer:** For educational purposes only. Not financial advice. Always DYOR.
