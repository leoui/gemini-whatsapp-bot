# 📊 Panduan Fitur Investment Manager v3 — WhatsApp Bot

## Apa Itu Investment Manager?

Bot WhatsApp kamu punya kemampuan **analisis saham AI** secara real-time! Cukup kirim pesan, dan bot akan:

- 📈 Mengambil data harga & teknikal dari **Yahoo Finance**
- 🏦 Mengambil data fundamental (P/E, ROE, margins) dari **FMP API**
- 🕵️ **Bandarmology** — deteksi pergerakan smart money & whale
- 🧠 Menganalisis menggunakan **AI** (Gemini atau Claude)
- 🎯 Memberikan sinyal **BUY / HOLD / SELL** dengan confidence %
- 📋 Menyusun **trading plan** lengkap (entry, SL, TP1, TP2)

---

## 💰 Gratis vs Berbayar — Pilih Model AI

| | `/gm` (Gemini) — **GRATIS** | `/cl` (Claude) — **BERBAYAR** |
|---|---|---|
| **Harga** | Gratis (pakai Gemini API key) | ~Rp150-500 per analisis |
| **Model AI** | Gemini 2.5 Flash | Claude Sonnet 4 |
| **Kecepatan** | ⚡ Cepat (~5 detik) | 🕐 Sedang (~10-15 detik) |
| **Kualitas analisis** | ⭐⭐⭐⭐ Sangat baik | ⭐⭐⭐⭐⭐ Premium |
| **Bandarmology** | ✅ Ya | ✅ Ya |
| **Credit tracking** | ❌ Tidak (gratis) | ✅ Ya (sisa saldo ditampilkan) |
| **Rekomendasi** | Analisis harian rutin | Analisis mendalam penting |

### Kapan Pakai `/gm`?
- Cek cepat harga dan sinyal harian
- Analisis rutin yang tidak butuh detail ekstra
- Saat ingin hemat biaya

### Kapan Pakai `/cl`?
- Keputusan investasi penting
- Perlu analisis mendalam dan detail
- Setiap respons menampilkan **biaya** dan **sisa saldo Claude**

---

## Cara Menggunakan (Step-by-Step)

### Langkah 1: Pilih Prefix
Tulis `/gm` untuk Gemini (gratis) atau `/cl` untuk Claude (berbayar) di **awal pesan**.

### Langkah 2: Tulis Perintah
Tambahkan instruksi setelah prefix. Bot mengerti Bahasa Indonesia dan English.

### Langkah 3: Sertakan Ticker
Pastikan sertakan kode saham yang benar.

### Format Ticker Saham

| Pasar | Format | Contoh |
|---|---|---|
| 🇺🇸 US (NYSE/NASDAQ) | Ticker biasa | `AAPL`, `NVDA`, `MSFT`, `TSLA` |
| 🇮🇩 Indonesia (IDX) | Tambahkan `.JK` | `BBRI.JK`, `BBCA.JK`, `TLKM.JK` |

---

## Contoh Perintah Lengkap

### 📊 Analisis Saham (Paling Sering Dipakai)
```
/gm analyze BBRI.JK
/cl analyze AAPL
/gm analisa lengkap BBCA.JK
```
> Bot memberikan: valuasi, fundamental, teknikal, bandarmology, sinyal, dan trading plan.

### 🕵️ Cek Bandarmology / Smart Money
```
/gm cek bandarmology BBCA.JK
/cl apakah ada whale activity di NVDA?
/gm siapa yang akumulasi TLKM.JK?
```
> Bot menganalisis: OBV trend, volume anomali, whale activity, dan Bandar Score.

### 💰 Cek Valuasi
```
/gm apakah BBCA.JK undervalued?
/gm is NVDA overvalued?
/cl analisa valuasi ANTM.JK
```

### 📋 Trading Plan / Scalping
```
/gm trading plan NVDA scalping
/cl buatkan trading plan BBRI.JK
/gm scalping plan AAPL hari ini
```

### 🔄 Perbandingan Saham
```
/gm compare BBCA.JK vs BMRI.JK
/cl bandingkan AAPL dan MSFT
```

### ❓ Pertanyaan Umum
```
/gm bagaimana fundamental ANTM.JK?
/cl how is TSLA's growth trajectory?
/gm apa risiko investasi di GOTO.JK?
```

---

## Cara Membaca Laporan

Bot mengirim laporan dengan struktur berikut:

### 📊 Quick Summary
Deskripsi singkat perusahaan dan posisi di pasar.

### 💰 Valuasi (jika data tersedia)
- **P/E Ratio** — makin rendah, makin murah (bandingkan dengan sektor)
- **P/B Ratio** — di bawah 1 = potensi undervalued
- **PEG Ratio** — di bawah 1 = pertumbuhan belum terprice-in

### 🏦 Kesehatan Fundamental
- **ROE** — return on equity (makin tinggi makin baik)
- **D/E Ratio** — rasio hutang (makin rendah makin sehat)
- **Profit Margin** — berapa persen laba per rupiah pendapatan

### 🕵️ Bandarmology (Smart Money Tracking) — **BARU!**
- **OBV Trend** — RISING = akumulasi, FALLING = distribusi
- **Whale Activity** 🐋 — volume > 2x rata-rata (pemain besar aktif)
- **Smart Money Signals** — 🟢 ACC (akumulasi), 🔴 DIST (distribusi), 🕵️ STEALTH, 💤 DRY-UP
- **Bandar Score (7 hari)** — skor bersih: positif = akumulasi, negatif = distribusi
- **Volume Pattern** — grafik visual 5 hari terakhir

### ⚡ Analisis Scalping
- **RSI** — <30 = oversold, >70 = overbought
- **SMA 20/50** — harga di atas SMA = tren naik
- **Support/Resistance** — level kunci untuk entry dan exit

### 🎯 Sinyal

| Sinyal | Arti |
|---|---|
| 🟢 **BUY** | Saham layak dibeli |
| 🟡 **HOLD** | Tahan posisi |
| 🔴 **SELL** | Pertimbangkan jual |

### 📋 Trading Plan
- **Entry** — zona harga masuk
- **Stop-Loss** — cut loss
- **TP1 / TP2** — target profit

### 💳 Credit Info (hanya `/cl`)
Setiap respons Claude menampilkan:
```
Credit used for this analysis:
$0.03

Claude Remaining Balance: ~$24.73
```

---

## Sumber Data

| Sumber | Data | Biaya |
|---|---|---|
| Yahoo Finance (chart API) | Harga, volume, 52W, RSI, SMA, S/R | Gratis |
| FMP API | P/E, P/B, ROE, margins, D/E, FCF | Gratis (25 req/hari) |
| Bandarmology | OBV, smart money, whale, Bandar Score | Gratis (algoritma) |

---

## FAQ

**Q: Apakah `/gm` benar-benar gratis?**
A: Ya! `/gm` menggunakan Gemini API key yang sudah ada. Tidak ada biaya tambahan.

**Q: Berapa biaya `/cl`?**
A: Sekitar Rp150-500 per analisis (~$0.01-0.03). Sisa saldo ditampilkan di setiap respons.

**Q: Apa itu Bandarmology?**
A: Analisis pergerakan "bandar" (pemain besar/institusi) berdasarkan pola volume. Bot mendeteksi akumulasi, distribusi, dan whale activity secara otomatis.

**Q: Apakah Bandarmology akurat?**
A: Berdasarkan pola volume aktual (bukan broker-level). Akurasi ⭐⭐⭐⭐ dari 5 — sangat berguna sebagai indikator tambahan.

**Q: Saham apa yang didukung?**
A: Semua saham di Yahoo Finance — US, Indonesia (IDX), dan bursa global.

**Q: Apakah bisa bahasa Indonesia?**
A: Ya! Bot mengerti Bahasa Indonesia dan English. Tulis perintah dalam bahasa apapun.

---

> ⚠️ **Disclaimer:** Semua analisis hanya untuk edukasi dan informasi. Bukan saran keuangan. Selalu lakukan riset mandiri (DYOR) sebelum keputusan investasi.
