# Laporan 9Router — CommandCode Transport, Klasifikasi Kegagalan Auth, Qoder, dan Insiden PostgreSQL Read-Only

Tanggal: 8 November 2026
Basis upstream: 9Router **v0.5.112**
Build produksi: `cBhhHDVF5p0GMkMP6WzdM` (`.next-tailadmin`)
Repo produksi: fork SantaiNetwork — branch `master`

Laporan ini merangkum pekerjaan lokal (CommandCode, auth, Qoder, release
gate) plus satu insiden infrastruktur yang diperbaiki tanpa perubahan kode.

---

## 1. Switcher transport CommandCode (alpha vs v1)

Commit: `777ae196`, `a6e3493f`, `a881cf19`

Command Code melayani dua wire dari host dan API key yang sama:

| Transport | Endpoint | Format | Catatan |
|---|---|---|---|
| `alpha` (default, historis) | `/alpha/generate` | envelope CLI, NDJSON AI-SDK | Semua koneksi lama |
| `v1` | `/provider/v1/chat/completions` | OpenAI standar | Plan-gated per model |

### Implementasi

- `open-sse/executors/commandcode.js`
  - `commandCodeTransport(credentials)` membaca
    `providerSpecificData.commandcodeTransport`; apa pun selain `"v1"` tetap
    alpha, jadi koneksi lama tidak berubah perilaku.
  - `buildUrl()` mengarah ke `COMMAND_CODE_V1_URL` saat v1. Base URL bisa
    dioverride lewat `COMMAND_CODE_API_BASE_URL` (default
    `https://api.commandcode.ai`) untuk staging/self-hosted.
  - `buildHeaders()` tidak mengirim `sessionId` di v1 (`threadId` hanya milik
    envelope alpha).
  - `execute()` melewati unwrap NDJSON di v1 dan memakai `super.execute()`,
    sehingga SSE/JSON upstream lewat apa adanya.
- `open-sse/services/provider.js` — `getTargetFormat()` mengembalikan `openai`
  untuk commandcode+v1. Tanpa ini body tetap ditranslasi ke envelope CLI dan
  upstream menjawab `400 expected array`.
- `open-sse/translator/concerns/thinkingUnified.js` — `resolveFormat()`
  mengembalikan `openai` untuk commandcode saat target format `openai`, supaya
  `reasoning_effort` dikirim top-level (bentuk OpenAI), bukan
  `params.reasoning_effort` (bentuk alpha) yang diabaikan gateway v1.
- `open-sse/translator/request/openai-to-commandcode.js` — `params.model`
  di-strip dari suffix thinking (`model(high)`). Sebelumnya suffix bocor ke
  `params.model` dan alpha menjawab `403 Model/provider not recognized`.
- UI: `src/app/(dashboard)/dashboard/providers/[id]/CommandCodeTransportCard.js`,
  disimpan lewat `PUT /api/providers/[id]` dengan
  `providerSpecificData.commandcodeTransport`.

### Verifikasi live (lewat router `:20128`)

| Uji | Hasil |
|---|---|
| `Kimi-K3.1-Pro(low)` | 200, reasoning 67 token |
| `Kimi-K3.1-Pro(high)` | 200, reasoning 199 token |
| Body upstream v1 | `reasoning_effort` di top-level, `model` tanpa suffix |
| Alpha + suffix `(high)` | 403 → 200 setelah fix |

Nilai reasoning yang dilaporkan upstream saat itu: Kimi 85 vs 177 token,
GLM-5.3-Flash 0 vs 81 token pada request pembanding.

**Status produksi: `alpha`** (dipulihkan setelah pengujian).

---

## 2. Kegagalan model tidak boleh mematikan kredensial

Commit: `405f6d0a`, `4f2868c6`, `e0c497db`

### Masalah

Satu balasan `404` (model tidak ada) menulis `testStatus: "unavailable"` pada
koneksi. Model lock kedaluwarsa, tapi marker `unavailable` bertahan selamanya
dan `getProviderCredentials()` melewati akun itu terus-menerus — tidak ada
request yang tersisa untuk membersihkannya. Hal yang sama terjadi pada
`400`, `406`, `429`, dan `5xx`.

### Perbaikan

Klasifikasi dipindah ke `open-sse/services/accountFallback.js` supaya bisa
diuji langsung tanpa memuat seluruh `auth.js`:

```js
export const CREDENTIAL_ERROR_CODES = new Set([401, 402, 403]);
export const NON_CREDENTIAL_ERROR_CODES = new Set([400, 404, 406, 429, 500, 502, 503, 504]);

export function persistsUnavailableMarker(status) { return CREDENTIAL_ERROR_CODES.has(Number(status)); }
export function skipsStaleUnavailable(errorCode)  { return !NON_CREDENTIAL_ERROR_CODES.has(Number(errorCode)); }
```

- Hanya `401`/`402`/`403` yang boleh menulis `testStatus: unavailable`.
- Status non-kredensial hanya menulis **model lock**; `testStatus`, `errorCode`,
  dan `lastError` tidak disentuh.
- Marker basi yang membawa status non-kredensial tidak lagi membuat akun
  dilewati, jadi akun yang sudah terlanjur "teracuni" kembali berputar.

### Model lock 6 jam untuk 404/406

`modelLockMsForStatus(status, cooldownMs)` mengembalikan minimal
`MODEL_NOT_FOUND_LOCK_MS = 6 * 60 * 60 * 1000` untuk `404`/`406`. Alasannya:
model yang tidak ada tetap tidak ada selama berjam-jam, sementara cooldown
2 menit membuat router memanggil upstream `404` berulang tanpa manfaat.
Kredensial tidak disentuh dan model lain pada akun yang sama tetap jalan.

### Clear lock menulis `undefined`, bukan `null`

`buildClearModelLocksUpdate()` sekarang memberi nilai `undefined` supaya key
hilang saat `JSON.stringify`. Sebelumnya clear menulis `null` dan meninggalkan
key mati: **99 dari 152 key lock di DB produksi** adalah sisa `null`. Data itu
sudah dibersihkan.

### Test

- `tests/unit/auth-failure-classification.test.mjs` (klasifikasi + clear lock)
- `tests/unit/auth-skip-unavailable.test.mjs`
- `tests/unit/model-not-found-lock.test.mjs`

---

## 3. Nama tool result yang yatim

Commit: `d606f183`

OpenAI hanya mengirim `tool_call_id` pada pesan `tool`; `name` tidak wajib.
Kalau `tool_calls` pasangannya sudah hilang dari history (klien memotong
konteks), `toolName` menjadi string kosong dan Gemini lewat commandcode
menjawab `contents[N].parts[0].function_response.name: [REQUIRED_FIELD_MISSING]`.

Translator `openai-to-commandcode.js` sekarang:

1. mencocokkan `tool_call_id` dengan `assistant.tool_calls` untuk mengambil
   nama;
2. kalau tetap tidak ketemu, memakai fallback `unknown_function` (sebelumnya
   request gagal `400`).

---

## 4. Card Credit Multiplier Qoder

Commit: `8ca8c4f4`

Katalog Qoder mempublikasikan `price_factor` per model chat (rasio konsumsi
kredit). Nilai itu kini diteruskan dan ditampilkan:

- `open-sse/services/qoderModels.js` — `priceFactor` ikut di objek model
  (null bila tidak ada / bukan angka).
- `src/app/api/providers/[id]/models/route.js` — meneruskan `priceFactor`
  ke klien.
- `src/app/(dashboard)/dashboard/providers/[id]/QoderMultiplierCard.js` —
  tabel live, bisa diurutkan, muncul di halaman provider `qoder` dan
  `qoder-cn`.

**Display-only.** Tidak dipakai untuk routing maupun billing.

---

## 5. Upload gambar Qoder dimatikan default

Commit: `24395b1a`, `db02b3f8`

Qoder CLI asli tidak menaruh byte gambar di `agent_chat_generation`; ia
meng-`PUT` ke `/algo/api/v2/image/upload` (multipart ber-signature COSY) lalu
mengirim URL OSS. Probe terhadap gateway live menunjukkan transport itu tidak
bisa membawa gambar sama sekali:

| Bentuk body | Hasil |
|---|---|
| multipart | selalu `403 signature invalid`, walau signature cocok dengan envelope |
| raw binary | `403` setiap kali payload memuat surrogate UTF-8 (`ED A0..BF`), yang hampir selalu muncul di data gambar terkompresi |
| JSON base64 (ASCII) | lolos validasi, tapi handler menjawab `500` untuk token turunan PAT (`jt-...`) |

Keputusan: upload **dimatikan default** (`QODER_IMAGE_UPLOAD=1` untuk
mengaktifkan kembali bila upstream berubah). Perilaku sekarang:

- gambar ≤ 512 KB (`QODER_INLINE_FALLBACK_MAX_BYTES`) tetap inline sebagai
  data URI;
- gambar lebih besar diganti stub teks;
- vision tetap `200` (diverifikasi live).

Kode: `open-sse/shared/qoder/attachments.js`.

---

## 6. Release gate mengabaikan `route-cache`

Commit: `bebc53ab`

Next menulis `.next/server/route-cache` saat runtime (`APP_PAGE`/`APP_ROUTE`),
jadi release yang sehat selalu gagal cek byte-identical di
`scripts/verify-release.sh`. Gate sekarang mengecualikan `route-cache`
seperti `cache/`.

Commit pendamping `311f6f5c` menyegarkan baseline provider setelah merge
v0.5.112 (`sensenova`, `runcrate`, hook `codebuddyHeaders`, `reasoningAliasFields`).

---

## 7. Insiden PostgreSQL read-only (8 November 2026)

Jendela singkat ketika endpoint database produksi menjawab read-only:
`PUT /api/providers/[id]` gagal `500` dan sebuah service pendamping gagal
heartbeat. Diperbaiki dengan mengarahkan `DATABASE_URL` ke endpoint writable
dan restart — tanpa perubahan kode, tanpa deploy.

Detail diagnosis (host, port, cluster id) dan runbook lengkap disimpan di
catatan operasional internal (tidak di-commit).

---

## Ringkasan

| Area | Isi |
|---|---|
| Qoder | Card Credit Multiplier (display-only); upload gambar dimatikan default (inline ≤512 KB / stub), perbaikan signature |
| Auth | Error non-kredensial tidak mematikan kredensial; model-not-found lock 6 jam; klasifikasi di `accountFallback.js`; clear lock `undefined` |
| CommandCode | Switcher transport alpha/v1; body OpenAI dipertahankan di v1; effort mengikuti wire; strip suffix model; nama tool result yatim |
| Tooling | Release gate abaikan `route-cache`; refresh baseline provider pasca-merge v0.5.112 |
| Insiden | Database read-only teratasi lewat perubahan env, tanpa deploy (lihat bagian 7) |
