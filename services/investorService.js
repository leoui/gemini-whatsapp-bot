'use strict';
/**
 * Investment Analysis Service
 * Provides AI-powered stock analysis using Yahoo Finance data
 * and Claude AI or Gemini for fundamental + scalping analysis.
 *
 * Usage via WhatsApp:
 *   /cl analyze BBRI   → Claude AI analysis
 *   /gm analyze AAPL   → Gemini analysis
 */

const https = require('https');
const Config = require('./config');

// ── Yahoo Finance Crumb Auth ────────────────────────────────
let _cookies = '';
let _crumb = '';
let _crumbExpiry = 0;

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const opts = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
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

async function ensureCrumb() {
    if (_crumb && Date.now() < _crumbExpiry) return;
    const cookieResp = await httpGet('https://fc.yahoo.com/');
    _cookies = cookieResp.cookies.map(c => c.split(';')[0]).join('; ');
    const crumbResp = await httpGet('https://query2.finance.yahoo.com/v1/test/getcrumb', { Cookie: _cookies });
    _crumb = crumbResp.data.trim();
    _crumbExpiry = Date.now() + 3600000; // 1 hour
    console.log(`[Investor] Yahoo Finance crumb refreshed`);
}

async function yahooJSON(url) {
    await ensureCrumb();
    const sep = url.includes('?') ? '&' : '?';
    const resp = await httpGet(url + sep + `crumb=${encodeURIComponent(_crumb)}`, { Cookie: _cookies });
    return JSON.parse(resp.data);
}

// ── Data Fetchers ───────────────────────────────────────────
async function fetchStockData(ticker) {
    const modules = 'price,summaryDetail,defaultKeyStatistics,financialData';
    const resp = await yahooJSON(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`);
    const r = resp.quoteSummary?.result?.[0];
    if (!r) throw new Error(`No data found for ticker "${ticker}"`);

    const p = r.price || {}, s = r.summaryDetail || {}, k = r.defaultKeyStatistics || {}, f = r.financialData || {};
    const raw = (o) => o?.raw ?? null;

    return {
        ticker, name: p.longName || p.shortName || ticker,
        exchange: p.exchangeName || '?', currency: p.currency || 'USD',
        currentPrice: raw(p.regularMarketPrice), previousClose: raw(p.regularMarketPreviousClose),
        dayHigh: raw(p.regularMarketDayHigh), dayLow: raw(p.regularMarketDayLow),
        volume: raw(p.regularMarketVolume), avgVolume: raw(s.averageVolume),
        marketCap: raw(p.marketCap),
        w52High: raw(s.fiftyTwoWeekHigh), w52Low: raw(s.fiftyTwoWeekLow),
        pe: raw(s.trailingPE) || raw(k.trailingPE), forwardPE: raw(s.forwardPE) || raw(k.forwardPE),
        pb: raw(k.priceToBook), ps: raw(k.priceToSalesTrailing12Months),
        peg: raw(k.pegRatio), evEbitda: raw(k.enterpriseToEbitda), evRevenue: raw(k.enterpriseToRevenue),
        profitMargin: raw(f.profitMargins), opMargin: raw(f.operatingMargins), grossMargin: raw(f.grossMargins),
        roe: raw(f.returnOnEquity), roa: raw(f.returnOnAssets),
        revGrowth: raw(f.revenueGrowth), earnGrowth: raw(f.earningsGrowth),
        qtrEarnGrowth: raw(k.earningsQuarterlyGrowth),
        debtEquity: raw(f.debtToEquity), currentRatio: raw(f.currentRatio),
        totalDebt: raw(f.totalDebt), totalCash: raw(f.totalCash),
        fcf: raw(f.freeCashflow), opCF: raw(f.operatingCashflow),
        divYield: raw(s.dividendYield), payoutRatio: raw(s.payoutRatio),
        eps: raw(k.trailingEps), fwdEps: raw(k.forwardEps), beta: raw(k.beta) || raw(s.beta),
        targetLow: raw(f.targetLowPrice), targetMean: raw(f.targetMeanPrice), targetHigh: raw(f.targetHighPrice),
        recKey: f.recommendationKey, recMean: raw(f.recommendationMean),
        numAnalysts: raw(f.numberOfAnalystOpinions),
    };
}

async function fetchTechnicals(ticker) {
    const resp = await yahooJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`);
    const r = resp.chart?.result?.[0];
    if (!r) return null;
    const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
    const prices = ts.map((t, i) => ({
        d: new Date(t * 1000).toISOString().split('T')[0],
        o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
    })).filter(p => p.c != null);

    const closes = prices.map(p => p.c);
    const s20 = sma(closes, 20), s50 = sma(closes, 50), r14 = rsi(closes, 14);
    const last = prices[prices.length - 1];
    const lows = prices.slice(-20).map(p => p.l).filter(Boolean).sort((a, b) => a - b);
    const highs = prices.slice(-20).map(p => p.h).filter(Boolean).sort((a, b) => b - a);

    return {
        last5: prices.slice(-5),
        sma20: s20?.toFixed(2), sma50: s50?.toFixed(2), rsi14: r14?.toFixed(1),
        support: lows[0]?.toFixed(2), resistance: highs[0]?.toFixed(2),
        vsSMA20: s20 ? (((last.c - s20) / s20) * 100).toFixed(2) : null,
        vsSMA50: s50 ? (((last.c - s50) / s50) * 100).toFixed(2) : null,
    };
}

function sma(d, p) { if (d.length < p) return null; return d.slice(-p).reduce((s, v) => s + v, 0) / p; }
function rsi(d, p) {
    if (d.length < p + 1) return null;
    let g = 0, l = 0;
    for (let i = d.length - p; i < d.length; i++) { const diff = d[i] - d[i - 1]; if (diff > 0) g += diff; else l -= diff; }
    if (l === 0) return 100;
    return 100 - (100 / (1 + (g / p) / (l / p)));
}

// ── Format helpers ──────────────────────────────────────────
function pct(n) { return n != null ? (n * 100).toFixed(1) + '%' : 'N/A'; }
function cap(n) { if (!n) return 'N/A'; if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T'; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; return n.toLocaleString(); }

// ── Build Analysis Prompt ───────────────────────────────────
function buildPrompt(stock, tech, query) {
    const now = new Date();
    const dateStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' });
    const isoDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

    return `You are an expert investment analyst specializing in fundamental analysis, value investing, and scalping techniques. You provide data-driven, grounded recommendations — NO hallucination, NO assumptions.

**CRITICAL RULES:**
1. Today is: ${dateStr} (${isoDate}). Use this exact date. Do NOT hallucinate dates.
2. ONLY use the data below. Do NOT invent numbers.
3. All analysis must reference actual data points provided.

**STOCK: ${stock.name} (${stock.ticker})**
Exchange: ${stock.exchange} | Currency: ${stock.currency}

PRICE: Current=${stock.currentPrice} | PrevClose=${stock.previousClose} | DayRange=${stock.dayLow}-${stock.dayHigh}
52W: ${stock.w52Low}-${stock.w52High} | Vol=${stock.volume?.toLocaleString()} | AvgVol=${stock.avgVolume?.toLocaleString()} | MCap=${cap(stock.marketCap)}

VALUATION: P/E=${stock.pe || 'N/A'} | FwdP/E=${stock.forwardPE || 'N/A'} | P/B=${stock.pb || 'N/A'} | P/S=${stock.ps || 'N/A'} | PEG=${stock.peg || 'N/A'} | EV/EBITDA=${stock.evEbitda || 'N/A'}

PROFITABILITY: ProfitMargin=${pct(stock.profitMargin)} | OpMargin=${pct(stock.opMargin)} | GrossMargin=${pct(stock.grossMargin)} | ROE=${pct(stock.roe)} | ROA=${pct(stock.roa)}

GROWTH: RevGrowth=${pct(stock.revGrowth)} | EarningsGrowth=${pct(stock.earnGrowth)} | QtrlyGrowth=${pct(stock.qtrEarnGrowth)}

BALANCE SHEET: D/E=${stock.debtEquity || 'N/A'} | CurrentRatio=${stock.currentRatio || 'N/A'} | Cash=${cap(stock.totalCash)} | Debt=${cap(stock.totalDebt)} | FCF=${cap(stock.fcf)} | OpCF=${cap(stock.opCF)}

DIVIDENDS: Yield=${pct(stock.divYield)} | PayoutRatio=${pct(stock.payoutRatio)}
EARNINGS: EPS=${stock.eps || 'N/A'} | FwdEPS=${stock.fwdEps || 'N/A'} | Beta=${stock.beta || 'N/A'}
ANALYST: Target=${stock.targetLow || '?'}-${stock.targetMean || '?'}-${stock.targetHigh || '?'} | Rec=${stock.recKey || 'N/A'} (${stock.recMean || 'N/A'}) | #Analysts=${stock.numAnalysts || 'N/A'}

${tech ? `TECHNICALS (3mo daily):
SMA20=${tech.sma20} (${tech.vsSMA20}% vs price) | SMA50=${tech.sma50} (${tech.vsSMA50}%)
RSI14=${tech.rsi14} | Support=${tech.support} | Resistance=${tech.resistance}
Last 5d: ${tech.last5?.map(d => `${d.d}:C${d.c?.toFixed(2)}`).join(' | ')}` : ''}

USER QUERY: "${query}"

Respond with:
📊 **${stock.ticker} — Quick Summary** (one line)
💰 **Valuation Analysis** (undervalued/overvalued? cite actual P/E, P/B, PEG)
📈 **Growth Assessment** (cite actual growth numbers)
🏦 **Fundamental Health** (cite actual D/E, cash, FCF)
⚡ **Scalping Analysis** (S/R levels, RSI, momentum, entry zones)
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
    if (!apiKey) throw new Error('No Claude API key configured. Set CLAUDE_API_KEY env var or configure in Bot Manager.');

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
                    else resolve(parsed.content?.[0]?.text || 'No response');
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

/**
 * Analyze a stock using the specified AI model.
 * @param {string} ticker — e.g. 'AAPL', 'BBRI.JK'
 * @param {string} query — user's full query text
 * @param {'gemini'|'claude'} model — which AI engine to use
 * @returns {Promise<string>} — formatted analysis report
 */
async function analyze(ticker, query, model = 'gemini') {
    console.log(`[Investor] Analyzing ${ticker} with ${model}...`);

    // Normalize ticker
    const t = ticker.toUpperCase().trim();

    // Fetch real data
    const [stockData, techData] = await Promise.all([
        fetchStockData(t),
        fetchTechnicals(t).catch(() => null),
    ]);

    // Build prompt
    const prompt = buildPrompt(stockData, techData, query);

    // Run AI analysis
    let analysis;
    if (model === 'claude') {
        analysis = await analyzeWithClaude(prompt);
    } else {
        analysis = await analyzeWithGemini(prompt);
    }

    return analysis;
}

module.exports = { analyze, fetchStockData, fetchTechnicals };
