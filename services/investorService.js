'use strict';
/**
 * Investment Analysis Service v2
 * Uses Yahoo Finance chart API (no crumb, works everywhere including EU VPS)
 * as primary data source, with optional crumb-based quoteSummary for
 * enriched fundamental data when available.
 */

const https = require('https');
const Config = require('./config');

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

// ── Optional: QuoteSummary enrichment (needs crumb) ─────────
async function enrichWithFundamentals(stock) {
    const hasCrumb = await tryGetCrumb();
    if (!hasCrumb) return stock;

    try {
        const modules = 'price,summaryDetail,defaultKeyStatistics,financialData';
        const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(stock.ticker)}?modules=${modules}&crumb=${encodeURIComponent(_crumb)}`;
        const resp = await httpGet(url, { Cookie: _cookies });
        const json = JSON.parse(resp.data);
        const r = json.quoteSummary?.result?.[0];
        if (!r) return stock;

        const s = r.summaryDetail || {}, k = r.defaultKeyStatistics || {}, f = r.financialData || {}, p = r.price || {};
        const raw = (o) => o?.raw ?? null;

        // Enrich stock with fundamental data
        stock.name = p.longName || p.shortName || stock.name;
        stock.marketCap = raw(p.marketCap) || stock.marketCap;
        stock.pe = raw(s.trailingPE) || raw(k.trailingPE);
        stock.forwardPE = raw(s.forwardPE) || raw(k.forwardPE);
        stock.pb = raw(k.priceToBook);
        stock.ps = raw(k.priceToSalesTrailing12Months);
        stock.peg = raw(k.pegRatio);
        stock.evEbitda = raw(k.enterpriseToEbitda);
        stock.profitMargin = raw(f.profitMargins);
        stock.opMargin = raw(f.operatingMargins);
        stock.grossMargin = raw(f.grossMargins);
        stock.roe = raw(f.returnOnEquity);
        stock.roa = raw(f.returnOnAssets);
        stock.revGrowth = raw(f.revenueGrowth);
        stock.earnGrowth = raw(f.earningsGrowth);
        stock.debtEquity = raw(f.debtToEquity);
        stock.currentRatio = raw(f.currentRatio);
        stock.totalCash = raw(f.totalCash);
        stock.totalDebt = raw(f.totalDebt);
        stock.fcf = raw(f.freeCashflow);
        stock.opCF = raw(f.operatingCashflow);
        stock.divYield = raw(s.dividendYield);
        stock.payoutRatio = raw(s.payoutRatio);
        stock.eps = raw(k.trailingEps);
        stock.fwdEps = raw(k.forwardEps);
        stock.beta = raw(k.beta) || raw(s.beta);
        stock.targetLow = raw(f.targetLowPrice);
        stock.targetMean = raw(f.targetMeanPrice);
        stock.targetHigh = raw(f.targetHighPrice);
        stock.recKey = f.recommendationKey;
        stock.recMean = raw(f.recommendationMean);
        stock.numAnalysts = raw(f.numberOfAnalystOpinions);

        console.log(`[Investor] Enriched ${stock.ticker} with fundamental data`);
    } catch (err) {
        console.log(`[Investor] Fundamentals unavailable for ${stock.ticker}: ${err.message}`);
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

USER QUERY: "${query}"

Respond with:
📊 **${stock.ticker} — Quick Summary** (one line)
${hasFundamentals ? '💰 **Valuation Analysis** (cite actual P/E, P/B, PEG)\n📈 **Growth Assessment** (cite actual growth numbers)\n🏦 **Fundamental Health** (cite actual D/E, cash, FCF)' : '📈 **Price Action Analysis** (cite 1M/3M performance, 52W range position)'}
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
async function analyze(ticker, query, model = 'gemini') {
    const t = ticker.toUpperCase().trim();
    console.log(`[Investor] Analyzing ${t} with ${model}...`);

    // 1. Fetch chart data (always works, no crumb needed)
    let stock = await fetchChartData(t);

    // 2. Try to enrich with fundamentals (needs crumb, may fail on EU VPS)
    stock = await enrichWithFundamentals(stock);

    // 3. Build prompt and run AI
    const prompt = buildPrompt(stock, query);
    const analysis = model === 'claude'
        ? await analyzeWithClaude(prompt)
        : await analyzeWithGemini(prompt);

    return analysis;
}

module.exports = { analyze, fetchChartData, enrichWithFundamentals };
