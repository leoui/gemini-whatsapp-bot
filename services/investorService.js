'use strict';
/**
 * Investment Analysis Service v3
 * Yahoo Finance chart API (no crumb, EU VPS compatible) + FMP fundamentals.
 * Features: Bandarmology (volume-based smart money tracking),
 * Claude credit tracking, scalping analysis.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const Config = require('./config');

// Credit usage file path (persisted to disk)
const USAGE_FILE = path.join(__dirname, '..', '.claude_usage.json');

// ── HTTP helper ─────────────────────────────────────────────
function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const opts = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...headers,
            },
            timeout: 15000,
        };
        https.get(url, opts, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return httpGet(res.headers.location, headers).then(resolve).catch(reject);
            }
            const cookies = res.headers['set-cookie'] || [];
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ data, cookies, statusCode: res.statusCode }));
        }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    });
}

// ── Yahoo Finance Crumb (optional, may fail on EU VPS) ──────
let _cookies = '', _crumb = '', _crumbExpiry = 0, _crumbFailed = false;

async function tryGetCrumb() {
    if (_crumbFailed) return false;
    if (_crumb && Date.now() < _crumbExpiry) return true;
    try {
        const cookieResp = await httpGet('https://fc.yahoo.com/');
        _cookies = cookieResp.cookies.map(c => c.split(';')[0]).join('; ');
        const crumbResp = await httpGet('https://query2.finance.yahoo.com/v1/test/getcrumb', { Cookie: _cookies });
        const crumb = crumbResp.data.trim();
        if (crumb.includes('error') || crumb.includes('{')) {
            _crumbFailed = true;
            console.log('[Investor] Crumb auth unavailable (EU/blocked IP). Using chart-only mode.');
            return false;
        }
        _crumb = crumb;
        _crumbExpiry = Date.now() + 3600000;
        console.log('[Investor] Crumb refreshed');
        return true;
    } catch {
        _crumbFailed = true;
        console.log('[Investor] Crumb auth failed. Using chart-only mode.');
        return false;
    }
}

// ── Primary: Chart API (works everywhere, no crumb) ─────────
async function fetchChartData(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d&includePrePost=false`;
    const resp = await httpGet(url);
    const json = JSON.parse(resp.data);
    const result = json.chart?.result?.[0];
    if (!result) {
        const err = json.chart?.error?.description || 'Ticker not found';
        throw new Error(`Yahoo Finance: ${err} (${ticker})`);
    }

    const meta = result.meta || {};
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const prices = ts.map((t, i) => ({
        d: new Date(t * 1000).toISOString().split('T')[0],
        o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
    })).filter(p => p.c != null);

    const closes = prices.map(p => p.c);
    const volumes = prices.map(p => p.v || 0);
    const last = prices[prices.length - 1];
    const s20 = sma(closes, 20), s50 = sma(closes, 50), r14 = rsi(closes, 14);
    const lows20 = prices.slice(-20).map(p => p.l).filter(Boolean).sort((a, b) => a - b);
    const highs20 = prices.slice(-20).map(p => p.h).filter(Boolean).sort((a, b) => b - a);
    const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length);

    // Price performance calculations
    const priceNow = meta.regularMarketPrice || last?.c;
    const price1m = closes.length > 21 ? closes[closes.length - 22] : null;
    const price3m = closes[0] || null;

    return {
        // Stock identity
        ticker: meta.symbol || ticker,
        name: meta.longName || meta.shortName || ticker,
        exchange: meta.exchangeName || meta.fullExchangeName || '?',
        currency: meta.currency || 'USD',

        // Current price data from meta
        currentPrice: priceNow,
        previousClose: meta.chartPreviousClose || meta.previousClose,
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        volume: meta.regularMarketVolume,
        avgVolume: Math.round(avgVol),
        w52High: meta.fiftyTwoWeekHigh,
        w52Low: meta.fiftyTwoWeekLow,

        // Performance
        change1m: price1m ? ((priceNow - price1m) / price1m * 100).toFixed(2) + '%' : 'N/A',
        change3m: price3m ? ((priceNow - price3m) / price3m * 100).toFixed(2) + '%' : 'N/A',
        distFrom52High: meta.fiftyTwoWeekHigh ? ((priceNow - meta.fiftyTwoWeekHigh) / meta.fiftyTwoWeekHigh * 100).toFixed(1) + '%' : 'N/A',
        distFrom52Low: meta.fiftyTwoWeekLow ? ((priceNow - meta.fiftyTwoWeekLow) / meta.fiftyTwoWeekLow * 100).toFixed(1) + '%' : 'N/A',

        // Technicals
        sma20: s20?.toFixed(2), sma50: s50?.toFixed(2), rsi14: r14?.toFixed(1),
        support: lows20[0]?.toFixed(2), resistance: highs20[0]?.toFixed(2),
        vsSMA20: s20 ? ((priceNow - s20) / s20 * 100).toFixed(2) : null,
        vsSMA50: s50 ? ((priceNow - s50) / s50 * 100).toFixed(2) : null,
        last5: prices.slice(-5),
        _prices: prices, // raw OHLCV for bandarmology computation

        // Fundamental placeholders (filled by quoteSummary if available)
        pe: null, forwardPE: null, pb: null, ps: null, peg: null,
        evEbitda: null, profitMargin: null, opMargin: null, grossMargin: null,
        roe: null, roa: null, revGrowth: null, earnGrowth: null,
        debtEquity: null, currentRatio: null, totalCash: null, totalDebt: null,
        fcf: null, opCF: null, divYield: null, payoutRatio: null,
        eps: null, fwdEps: null, beta: null, marketCap: null,
        targetLow: null, targetMean: null, targetHigh: null,
        recKey: null, recMean: null, numAnalysts: null,
    };
}

// ── Enrich with FMP (Financial Modeling Prep) fundamentals ───
async function enrichWithFundamentals(stock) {
    const fmpKey = Config.get('fmpApiKey') || process.env.FMP_API_KEY;
    if (!fmpKey) {
        console.log('[Investor] No FMP_API_KEY — skipping fundamentals');
        return stock;
    }

    // FMP uses plain tickers for US, and the same .JK suffix for IDX
    const ticker = encodeURIComponent(stock.ticker);

    try {
        // Fetch key metrics + profile in parallel
        const [profileResp, ratiosResp] = await Promise.all([
            httpGet(`https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${fmpKey}`),
            httpGet(`https://financialmodelingprep.com/api/v3/ratios-ttm/${ticker}?apikey=${fmpKey}`),
        ]);

        const profile = JSON.parse(profileResp.data)?.[0];
        const ratios = JSON.parse(ratiosResp.data)?.[0];

        if (profile) {
            stock.name = profile.companyName || stock.name;
            stock.marketCap = profile.mktCap || stock.marketCap;
            stock.pe = profile.pe || null;
            stock.beta = profile.beta || stock.beta;
            stock.divYield = profile.lastDiv ? profile.lastDiv / stock.currentPrice : null;
            stock.eps = profile.eps || null;
            stock.targetMean = profile.dcf || null;
        }

        if (ratios) {
            stock.pe = ratios.peRatioTTM || stock.pe;
            stock.forwardPE = ratios.priceEarningsToGrowthRatioTTM ? stock.pe / ratios.priceEarningsToGrowthRatioTTM : null;
            stock.pb = ratios.priceToBookRatioTTM || null;
            stock.ps = ratios.priceToSalesRatioTTM || null;
            stock.peg = ratios.priceEarningsToGrowthRatioTTM || null;
            stock.evEbitda = ratios.enterpriseValueOverEBITDATTM || null;
            stock.profitMargin = ratios.netProfitMarginTTM || null;
            stock.opMargin = ratios.operatingProfitMarginTTM || null;
            stock.grossMargin = ratios.grossProfitMarginTTM || null;
            stock.roe = ratios.returnOnEquityTTM || null;
            stock.roa = ratios.returnOnAssetsTTM || null;
            stock.debtEquity = ratios.debtEquityRatioTTM || null;
            stock.currentRatio = ratios.currentRatioTTM || null;
            stock.fcf = ratios.freeCashFlowPerShareTTM || null;
            stock.divYield = ratios.dividendYielTTM || ratios.dividendYieldTTM || stock.divYield;
            stock.payoutRatio = ratios.payoutRatioTTM || null;
        }

        console.log(`[Investor] Enriched ${stock.ticker} with FMP fundamentals (P/E: ${stock.pe}, ROE: ${stock.roe})`);
    } catch (err) {
        console.log(`[Investor] FMP enrichment failed for ${stock.ticker}: ${err.message}`);
    }

    return stock;
}


// ── Helpers ─────────────────────────────────────────────────
function sma(d, p) { if (d.length < p) return null; return d.slice(-p).reduce((s, v) => s + v, 0) / p; }
function rsi(d, p) {
    if (d.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = d.length - p; i < d.length; i++) { const diff = d[i] - d[i - 1]; if (diff > 0) g += diff; else l -= diff; }
    if (l === 0) return 100;
    return 100 - (100 / (1 + (g / p) / (l / p)));
}
function pct(n) { return n != null ? (n * 100).toFixed(1) + '%' : 'N/A'; }
function cap(n) { if (!n) return 'N/A'; if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T'; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; return n.toLocaleString(); }

// ── Bandarmology (Volume-Based Smart Money Analysis) ────────
function computeBandarmology(stock) {
    const prices = stock._prices; // raw price array from fetchChartData
    if (!prices || prices.length < 10) return null;

    const volumes = prices.map(p => p.v || 0);
    const closes = prices.map(p => p.c);
    const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length);

    // On-Balance Volume (OBV)
    const obv = [0];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
        else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
        else obv.push(obv[i - 1]);
    }
    const obv5 = obv.slice(-5);
    const obvSlope = obv5.length >= 2 ? obv5[obv5.length - 1] - obv5[0] : 0;
    const obvTrend = obvSlope > 0 ? 'RISING (accumulation)' : 'FALLING (distribution)';

    // Smart money detection (last 10 days)
    const smartMoney = [];
    for (let i = Math.max(1, prices.length - 10); i < prices.length; i++) {
        const prev = prices[i - 1], curr = prices[i];
        const priceChg = ((curr.c - prev.c) / prev.c * 100);
        const volRatio = curr.v / avgVol;
        const bodyRatio = (curr.h - curr.l) > 0 ? Math.abs(curr.c - curr.o) / (curr.h - curr.l) : 0;

        const signals = [];
        if (volRatio > 1.5 && bodyRatio < 0.3) signals.push('🕵️ STEALTH');
        if (volRatio > 2.0) signals.push('🐋 WHALE');
        if (volRatio > 1.3 && curr.c > prev.c) signals.push('🟢 ACC');
        else if (volRatio > 1.3 && curr.c < prev.c) signals.push('🔴 DIST');
        else if (volRatio < 0.5) signals.push('💤 DRY-UP');

        if (signals.length > 0) {
            smartMoney.push(`${curr.d}: ${priceChg > 0 ? '+' : ''}${priceChg.toFixed(1)}% Vol=${(curr.v / 1e6).toFixed(1)}M (${volRatio.toFixed(1)}x) → ${signals.join(', ')}`);
        }
    }

    // Bandar Score (7-day)
    let accDays = 0, distDays = 0;
    for (let i = Math.max(1, prices.length - 7); i < prices.length; i++) {
        const volRatio = prices[i].v / avgVol;
        if (volRatio > 1.0 && prices[i].c > prices[i - 1].c) accDays++;
        else if (volRatio > 1.0 && prices[i].c < prices[i - 1].c) distDays++;
    }
    const bandarScore = accDays - distDays;
    const bandarLabel = bandarScore > 0 ? '🟢 NET ACCUMULATION' : bandarScore < 0 ? '🔴 NET DISTRIBUTION' : '⚪ NEUTRAL';

    // Volume trend (last 5 days as bar chart)
    const volBars = prices.slice(-5).map(p => {
        const ratio = p.v / avgVol;
        const bar = '█'.repeat(Math.min(10, Math.round(ratio * 5)));
        const flag = ratio > 2 ? ' 🐋' : ratio > 1.5 ? ' 🚨' : ratio > 1.2 ? ' ⚠️' : ratio < 0.5 ? ' 💤' : '';
        return `${p.d}: ${bar} ${(p.v / 1e6).toFixed(1)}M (${ratio.toFixed(1)}x)${flag}`;
    }).join('\n');

    return {
        obvTrend, obvSlope: (obvSlope / 1e6).toFixed(1) + 'M',
        smartMoney, bandarScore, bandarLabel,
        accDays, distDays, volBars, avgVol,
    };
}

// ── Claude Credit Tracking (Persistent) ─────────────────────────
function loadUsageData() {
    try {
        if (fs.existsSync(USAGE_FILE)) {
            return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
        }
    } catch { }
    return { totalSpent: 0, totalInputTokens: 0, totalOutputTokens: 0, requests: 0 };
}

function saveUsageData(data) {
    try {
        fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.log(`[Investor] Failed to save usage data: ${err.message}`);
    }
}

function estimateClaudeCost(usage) {
    if (!usage) return 0;
    // Claude Sonnet 4 pricing: $3/M input, $15/M output
    const inputCost = (usage.input_tokens || 0) / 1e6 * 3;
    const outputCost = (usage.output_tokens || 0) / 1e6 * 15;
    return inputCost + outputCost;
}

function getStartingBalance() {
    const envVal = process.env.CLAUDE_STARTING_BALANCE;
    if (envVal && !isNaN(parseFloat(envVal))) return parseFloat(envVal);
    return 0; // no balance configured
}

// ── Build Analysis Prompt ───────────────────────────────────
function buildPrompt(stock, query) {
    const now = new Date();
    const dateStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' });
    const isoDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

    const hasFundamentals = stock.pe != null || stock.roe != null || stock.profitMargin != null;

    return `You are an expert investment analyst specializing in fundamental analysis, value investing, and scalping techniques. You provide data-driven, grounded recommendations — NO hallucination, NO assumptions.

**CRITICAL RULES:**
1. Today is: ${dateStr} (${isoDate}). Use ONLY this date.
2. ONLY use the data provided below. Do NOT invent or estimate any numbers.
3. All analysis must cite actual data points.
${!hasFundamentals ? '4. Fundamental ratios (P/E, P/B etc.) are NOT available. Focus your analysis on PRICE ACTION, TECHNICALS, and PERFORMANCE data.' : ''}

**STOCK: ${stock.name} (${stock.ticker})**
Exchange: ${stock.exchange} | Currency: ${stock.currency}

PRICE DATA:
Current=${stock.currentPrice} | PrevClose=${stock.previousClose}
DayRange=${stock.dayLow || '?'}-${stock.dayHigh || '?'}
52W Range: ${stock.w52Low}-${stock.w52High}
Volume=${stock.volume?.toLocaleString() || 'N/A'} | AvgVol20d=${stock.avgVolume?.toLocaleString() || 'N/A'}
${stock.marketCap ? `MarketCap=${cap(stock.marketCap)}` : ''}

PERFORMANCE:
1-Month: ${stock.change1m} | 3-Month: ${stock.change3m}
Distance from 52W High: ${stock.distFrom52High} | from 52W Low: ${stock.distFrom52Low}

TECHNICALS (3-month daily):
SMA20=${stock.sma20} (${stock.vsSMA20}% vs price) | SMA50=${stock.sma50} (${stock.vsSMA50}%)
RSI14=${stock.rsi14} | Support=${stock.support} | Resistance=${stock.resistance}
Last 5 days: ${stock.last5?.map(d => `${d.d}:O${d.o?.toFixed(2)} H${d.h?.toFixed(2)} L${d.l?.toFixed(2)} C${d.c?.toFixed(2)} V${d.v?.toLocaleString()}`).join('\n')}

${hasFundamentals ? `VALUATION: P/E=${stock.pe || 'N/A'} | FwdP/E=${stock.forwardPE || 'N/A'} | P/B=${stock.pb || 'N/A'} | P/S=${stock.ps || 'N/A'} | PEG=${stock.peg || 'N/A'} | EV/EBITDA=${stock.evEbitda || 'N/A'}

PROFITABILITY: ProfitMargin=${pct(stock.profitMargin)} | OpMargin=${pct(stock.opMargin)} | GrossMargin=${pct(stock.grossMargin)} | ROE=${pct(stock.roe)} | ROA=${pct(stock.roa)}

GROWTH: RevGrowth=${pct(stock.revGrowth)} | EarningsGrowth=${pct(stock.earnGrowth)}

BALANCE SHEET: D/E=${stock.debtEquity || 'N/A'} | CurrentRatio=${stock.currentRatio || 'N/A'} | Cash=${cap(stock.totalCash)} | Debt=${cap(stock.totalDebt)} | FCF=${cap(stock.fcf)} | OpCF=${cap(stock.opCF)}

DIVIDENDS: Yield=${pct(stock.divYield)} | PayoutRatio=${pct(stock.payoutRatio)}
EARNINGS: EPS=${stock.eps || 'N/A'} | FwdEPS=${stock.fwdEps || 'N/A'} | Beta=${stock.beta || 'N/A'}
ANALYST: Target=${stock.targetLow || '?'}-${stock.targetMean || '?'}-${stock.targetHigh || '?'} | Rec=${stock.recKey || 'N/A'} (${stock.recMean || 'N/A'}) | #Analysts=${stock.numAnalysts || 'N/A'}` : 'FUNDAMENTAL DATA: Not available from data source. Analyze based on price action and technicals only.'}

${stock.bandar ? `BANDARMOLOGY (Volume-Based Smart Money Analysis):
OBV Trend: ${stock.bandar.obvTrend} (slope: ${stock.bandar.obvSlope})
Bandar Score (7d): ${stock.bandar.bandarScore > 0 ? '+' : ''}${stock.bandar.bandarScore} → ${stock.bandar.bandarLabel} (Acc: ${stock.bandar.accDays}d, Dist: ${stock.bandar.distDays}d)
Avg Volume (20d): ${(stock.bandar.avgVol / 1e6).toFixed(1)}M
${stock.bandar.smartMoney.length > 0 ? 'Smart Money Signals:\n' + stock.bandar.smartMoney.join('\n') : 'No unusual smart money activity detected.'}
Volume Pattern (5d):\n${stock.bandar.volBars}` : ''}

USER QUERY: "${query}"

Respond with:
📊 **${stock.ticker} — Quick Summary** (one line)
${hasFundamentals ? '💰 **Valuation Analysis** (cite actual P/E, P/B, PEG)\n📈 **Growth Assessment** (cite actual growth numbers)\n🏦 **Fundamental Health** (cite actual D/E, cash, FCF)' : '📈 **Price Action Analysis** (cite 1M/3M performance, 52W range position)'}
🕵️ **Bandar Analysis** (OBV trend, smart money signals, whale activity, bandar score — cite the data above)
⚡ **Scalping Analysis** (S/R levels, RSI reading, momentum, entry zones)
🎯 **Signal: 🟢 BUY / 🟡 HOLD / 🔴 SELL** (Confidence X%) with 2-3 bullet rationale
📋 **Trading Plan** (Entry, Stop-Loss, TP1, TP2, Position sizing)
⚠️ **Risk Factors** (top 3)
_⚠️ For educational purposes only. Not financial advice._`;
}

// ── AI Analysis ─────────────────────────────────────────────
async function analyzeWithGemini(prompt) {
    const keys = Config.getGeminiKeys();
    if (!keys.length) throw new Error('No Gemini API key configured');
    const key = Config.getActiveKey();
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey: key });
    const resp = await client.models.generateContent({
        model: Config.get('geminiModel') || 'gemini-2.5-flash',
        contents: prompt,
        config: { maxOutputTokens: 4096, temperature: 0.3 },
    });
    Config.trackKeyUsage(key);
    return resp.text;
}

async function analyzeWithClaude(prompt) {
    const apiKey = Config.get('claudeApiKey') || process.env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error('No Claude API key configured. Set CLAUDE_API_KEY env var.');

    const postData = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 60000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) reject(new Error(parsed.error.message));
                    else {
                        const text = parsed.content?.[0]?.text || 'No response';
                        const usage = parsed.usage;
                        const cost = estimateClaudeCost(usage);

                        // Persist usage to disk
                        const usageData = loadUsageData();
                        usageData.totalSpent += cost;
                        usageData.totalInputTokens += (usage?.input_tokens || 0);
                        usageData.totalOutputTokens += (usage?.output_tokens || 0);
                        usageData.requests += 1;
                        saveUsageData(usageData);

                        console.log(`[Investor] Claude cost: $${cost.toFixed(4)} | Total spent: $${usageData.totalSpent.toFixed(4)} | Requests: ${usageData.requests}`);
                        resolve({ text, usage, cost, totalSpent: usageData.totalSpent });
                    }
                } catch (e) { reject(new Error(`Claude parse error: ${data.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Claude API timeout')); });
        req.write(postData);
        req.end();
    });
}

// ── Public API ──────────────────────────────────────────────
async function analyze(ticker, query, model = 'gemini') {
    const t = ticker.toUpperCase().trim();
    console.log(`[Investor] Analyzing ${t} with ${model}...`);

    // 1. Fetch chart data (always works, no crumb needed)
    let stock = await fetchChartData(t);

    // 2. Try to enrich with fundamentals
    stock = await enrichWithFundamentals(stock);

    // 3. Compute bandarmology
    stock.bandar = computeBandarmology(stock);

    // 4. Build prompt and run AI
    const prompt = buildPrompt(stock, query);
    let analysis, creditFooter = '';

    if (model === 'claude') {
        const result = await analyzeWithClaude(prompt);
        analysis = result.text;
        const cost = result.cost || 0;
        const totalSpent = result.totalSpent || 0;
        const tokens = result.usage || {};
        const startBal = getStartingBalance();
        const remaining = startBal > 0 ? Math.max(0, startBal - totalSpent) : null;

        let footer = `\n\n---\nCredit used for this analysis:\n*$${cost.toFixed(2)}* (${(tokens.input_tokens || 0).toLocaleString()} input + ${(tokens.output_tokens || 0).toLocaleString()} output tokens)`;
        footer += `\n\nTotal spent: *$${totalSpent.toFixed(2)}*`;
        if (remaining !== null) {
            footer += `\nClaude Remaining Balance: *~$${remaining.toFixed(2)}*`;
        }
        creditFooter = footer;
    } else {
        analysis = await analyzeWithGemini(prompt);
    }

    return analysis + creditFooter;
}

module.exports = { analyze, fetchChartData, enrichWithFundamentals, computeBandarmology };
