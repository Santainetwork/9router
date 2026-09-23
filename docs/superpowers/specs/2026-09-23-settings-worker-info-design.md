# Informasi Worker pada Settings

Tanggal: 23 September 2026

## Tujuan

Tampilkan jumlah proses Node dan API worker yang dikonfigurasi pada halaman Settings tanpa memberi kontrol runtime baru atau membocorkan URL internal.

## Semantik

- `API_WORKERS` adalah jumlah total proses Node.
- Satu proses selalu berperan sebagai control process.
- Jumlah API worker adalah `max(API_WORKERS - 1, 0)`.
- Nilai default adalah satu total proses dan nol API worker.
- Multicore hanya valid dengan PostgreSQL. SQLite selalu ditampilkan sebagai single-process.

## Desain

1. `GET /api/settings` menambahkan metadata read-only `workerTopology`:
   - `role`: `control` atau `api`.
   - `totalProcesses`: jumlah total proses Node terkonfigurasi.
   - `apiWorkers`: jumlah instance API worker terkonfigurasi.
   - `mode`: `single-process` atau `postgres-multicore`.
2. Metadata berasal dari env proses yang sudah divalidasi saat startup: `API_WORKERS`, `WORKER_ROLE`/`NINEROUTER_WORKER_ROLE`, `DB_TYPE`, dan `DATABASE_URL` hanya untuk menentukan tipe DB.
3. Jangan mengembalikan `DATABASE_URL`, `API_WORKER_URLS`, port worker, PID worker lain, atau credential.
4. `PATCH /api/settings` tidak menerima atau menyimpan `workerTopology`.
5. Halaman Profile/Settings meneruskan metadata tersebut ke `SystemHealthPanel`.
6. `SystemHealthPanel` menampilkan `Node processes`, `API workers`, dan `Topology` pada kartu Next Backend.
7. Label menjelaskan bahwa angka adalah konfigurasi startup, bukan health count real-time.
8. Tidak menambah probing worker baru. Go gateway tetap menjadi pemilik health-check/routing worker.

## Validasi

- Input env invalid pada helper metadata jatuh aman ke satu total proses.
- SQLite tidak pernah dilabel multicore.
- PostgreSQL dengan `API_WORKERS=4` menghasilkan tiga API worker.
- Response tidak memuat URL internal atau credential.
- UI menampilkan nilai metadata dan fallback `1 total / 0 API workers`.
- Test system health serta build lulus.

## Non-goals

- Mengubah `API_WORKERS` dari dashboard.
- Menampilkan health per worker.
- Mengontrol systemd atau container.
- Deploy/restart produksi.
