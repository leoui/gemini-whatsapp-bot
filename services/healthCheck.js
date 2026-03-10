'use strict';

/**
 * HealthCheckService — Responds to /healthcheck from whitelisted numbers only.
 *
 * Configure whitelisted phone numbers via environment variable:
 *   HEALTH_CHECK_WHITELIST=628xxxxx,6281xxxxx
 *
 * Or in the bot config via the Manager app (Health Check Whitelist field).
 *
 * Checks:
 *   - Bot uptime & memory
 *   - WhatsApp connection state
 *   - Gemini API connectivity + key count
 *   - Groq API status
 *   - Node.js + npm package versions
 *   - Recommendations for updates
 */

const path = require('path');
const Config = require('./config');

/**
 * Build whitelisted JIDs from env var or bot config.
 * Format: phone numbers only (digits, with country code, no '+' or spaces).
 * Example env: HEALTH_CHECK_WHITELIST=6281234567890,6289876543210
 */
function getWhitelistedJids() {
    const fromEnv = (process.env.HEALTH_CHECK_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
    const fromConfig = (Config.get('healthCheckWhitelist') || []);
    const allNumbers = [...new Set([...fromEnv, ...fromConfig])];
    // Normalize: strip +, spaces, dashes → "628xxx@s.whatsapp.net"
    return allNumbers.map(n => n.replace(/[\s+\-]/g, '') + '@s.whatsapp.net');
}

// Trigger phrases (case-insensitive)
const HEALTH_TRIGGERS = [
    '/healthcheck',
    '/health',
    'health check',
    'healthcheck',
    'status bot',
    'bot status',
    'cek status',
    'cek bot',
];

/**
 * Check if a message is a health check request from a whitelisted sender.
 */
function isHealthCheckRequest(msg) {
    const senderJid = (msg.senderJid || '').toLowerCase();
    const remoteJid = (msg.remoteJid || '').toLowerCase();
    const text = (msg.text || '').trim().toLowerCase();

    const whitelistedJids = getWhitelistedJids();
    if (whitelistedJids.length === 0) return false; // no whitelist configured = disabled

    const isWhitelisted = whitelistedJids.some(jid =>
        senderJid.includes(jid.replace('@s.whatsapp.net', '')) ||
        remoteJid.includes(jid.replace('@s.whatsapp.net', ''))
    );

    if (!isWhitelisted) return false;

    return HEALTH_TRIGGERS.some(trigger => text.includes(trigger));
}

/**
 * Get installed npm package version from node_modules.
 */
function getPkgVersion(name, botDir) {
    try {
        const pkgPath = path.join(botDir, 'node_modules', name, 'package.json');
        const pkg = require(pkgPath);
        return pkg.version || '?';
    } catch {
        return 'not installed';
    }
}

/**
 * Get latest version of a package from npm registry (best-effort, no fail).
 */
async function getLatestVersion(name) {
    try {
        const https = require('https');
        return await new Promise((resolve) => {
            const req = https.get(`https://registry.npmjs.org/${name}/latest`, { timeout: 5000 }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString()).version); }
                    catch { resolve('?'); }
                });
            });
            req.on('error', () => resolve('?'));
            req.on('timeout', () => { req.destroy(); resolve('?'); });
        });
    } catch {
        return '?';
    }
}

/**
 * Compare semver strings — returns true if latestVer > currentVer.
 */
function isOutdated(current, latest) {
    if (current === '?' || latest === '?' || current === 'not installed') return false;
    try {
        const c = current.replace(/[^0-9.]/g, '').split('.').map(Number);
        const l = latest.replace(/[^0-9.]/g, '').split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((l[i] || 0) > (c[i] || 0)) return true;
            if ((l[i] || 0) < (c[i] || 0)) return false;
        }
        return false;
    } catch { return false; }
}

/**
 * Generate the full health check report.
 * @param {object} services - { whatsapp, gemini, groq } service instances
 */
async function generateHealthReport(services) {
    const { whatsapp, gemini, groq } = services;
    const botDir = path.join(__dirname, '..');
    const startTime = process.uptime();

    // Compute GMT+7 (WIB) without relying on TZ env variable
    const nowUtc = new Date();
    const wibMs = nowUtc.getTime() + 7 * 60 * 60 * 1000;
    const wib = new Date(wibMs);
    const pad = (n) => String(n).padStart(2, '0');
    const WIB_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const WIB_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const serverDateStr = `${WIB_DAYS[wib.getUTCDay()]}, ${WIB_MONTHS[wib.getUTCMonth()]} ${wib.getUTCDate()}, ${wib.getUTCFullYear()}`;
    const serverTimeStr = `${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())} WIB`;

    const uptimeH = Math.floor(startTime / 3600);
    const uptimeM = Math.floor((startTime % 3600) / 60);
    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const memTotalMB = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);

    // === Gather versions ===
    const nodeVer = process.version; // e.g. v20.20.0
    const packages = [
        '@whiskeysockets/baileys',
        '@google/genai',
        'groq-sdk',
        'exceljs',
        'pdfkit',
        'pptxgenjs',
        'googleapis',
    ];

    const installedVersions = {};
    for (const pkg of packages) {
        installedVersions[pkg] = getPkgVersion(pkg, botDir);
    }

    // Fetch latest versions (parallel)
    const latestVersions = {};
    await Promise.all(packages.map(async pkg => {
        latestVersions[pkg] = await getLatestVersion(pkg);
    }));

    // === Service statuses ===
    const waState = whatsapp?.connectionState || 'unknown';
    const waStatus = waState === 'connected' ? '✅ Connected' : `❌ ${waState}`;

    const geminiKeys = Config.getGeminiKeys?.() || Config.get?.('geminiKeys') || [];
    const geminiModel = Config.get?.('geminiModel') || 'gemini-2.5-flash';
    const geminiStatus = geminiKeys.length > 0 ? `✅ ${geminiKeys.length} key(s) — ${geminiModel}` : '❌ No keys';

    const groqAvailable = groq?.isAvailable?.() || false;
    const groqStatus = groqAvailable ? '✅ Enabled — llama-3.3-70b-versatile' : '⚠️ Disabled (no GROQ_API_KEY)';

    const pollinationsKey = Config.get?.('pollinationsApiKey') || process.env.POLLINATIONS_API_KEY || '';
    const pollinationsStatus = pollinationsKey ? '✅ Configured' : '⚠️ Not configured';

    const claudeKey = Config.get?.('claudeApiKey') || process.env.CLAUDE_API_KEY || '';
    const claudeStatus = claudeKey ? '✅ Configured — claude-sonnet-4' : '⚠️ Not configured (no /cl commands)';

    const fmpKey = Config.get?.('fmpApiKey') || process.env.FMP_API_KEY || '';
    const fmpStatus = fmpKey ? '✅ Configured — 25 req/day (free)' : '⚠️ Not configured (no fundamentals)';

    const savedContacts = (Config.get?.('savedContacts') || []).length;
    const scheduledTasks = (Config.get?.('scheduledTasks') || []).length;

    // === Build recommendations ===
    const recommendations = [];

    for (const pkg of packages) {
        const cur = installedVersions[pkg];
        const lat = latestVersions[pkg];
        if (isOutdated(cur, lat)) {
            recommendations.push(`• *${pkg}*: ${cur} → ${lat} (update available)`);
        }
    }

    // Node.js recommendation
    const nodeMajor = parseInt(nodeVer.replace('v', '').split('.')[0]);
    if (nodeMajor < 22) {
        recommendations.push(`• *Node.js*: ${nodeVer} — consider upgrading to v22 LTS`);
    }

    if (!groqAvailable) {
        recommendations.push('• *Groq*: Add GROQ_API_KEY to save Gemini quota (~14,400 free req/day)');
    }
    if (!pollinationsKey) {
        recommendations.push('• *Pollinations*: Add POLLINATIONS_API_KEY for free image generation');
    }
    if (!claudeKey) {
        recommendations.push('• *Claude*: Add CLAUDE_API_KEY for /cl investment analysis');
    }
    if (!fmpKey) {
        recommendations.push('• *FMP*: Add FMP_API_KEY for stock fundamentals (P/E, ROE, margins)');
    }

    // === Format report ===
    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';

    const pkgLines = packages.map(pkg => {
        const cur = installedVersions[pkg];
        const lat = latestVersions[pkg];
        const outdated = isOutdated(cur, lat);
        const icon = (cur === 'not installed') ? '❌' : outdated ? '⚠️' : '✅';
        const hint = outdated ? ` → ${lat}` : '';
        return `${icon} *${pkg}*: ${cur}${hint}`;
    }).join('\n');

    const recoText = recommendations.length > 0
        ? `\n\n${divider}\n🔧 *Recommendations*\n${recommendations.join('\n')}`
        : `\n\n${divider}\n✅ *Everything is up to date!*`;

    const report = `🤖 *Bot Health Check — v3*
${divider}
🕐 Server Time: ${serverDateStr}, ${serverTimeStr}
⏱ Uptime: ${uptimeH}h ${uptimeM}m
💾 Memory: ${memMB} MB used / ${memTotalMB} MB total
🖥 Node.js: ${nodeVer}
👥 Saved Contacts: ${savedContacts}
⏰ Scheduled Tasks: ${scheduledTasks}

${divider}
🔌 *Service Status*
📱 WhatsApp: ${waStatus}
🤖 Gemini: ${geminiStatus}
⚡ Groq: ${groqStatus}
🖼 Pollinations: ${pollinationsStatus}
🧠 Claude: ${claudeStatus}
📊 FMP: ${fmpStatus}

${divider}
📦 *Package Versions*
${pkgLines}${recoText}`;

    return report;
}

module.exports = { isHealthCheckRequest, generateHealthReport };
