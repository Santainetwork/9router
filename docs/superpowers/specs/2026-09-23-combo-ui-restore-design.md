# Restore Pengalaman UI Combo Lama

Tanggal: 23 September 2026

## Tujuan

Kembalikan halaman `/dashboard/combos` yang mudah dipindai dan dicari seperti sebelum merge v0.5.85, tanpa menghapus capability aggregation, migrasi model, Fusion judge, bulk action, API preset, atau perubahan backend v0.5.85.

## Masalah

Halaman sekarang menghitung `filteredCombos`, tetapi daftar kartu merender `combos.map(...)`. Akibatnya search, strategy, provider, capability, model-count, serta sort tidak memengaruhi kartu yang ditampilkan. Layout list horizontal baru juga lebih sulit dipindai daripada grid kartu lama.

## Desain

Hanya ubah `src/app/(dashboard)/dashboard/combos/page.js`:

1. Daftar menggunakan `filteredCombos.map(...)`, bukan `combos.map(...)`.
2. Kembalikan container kartu ke grid lama: satu kolom pada mobile, dua pada medium, tiga pada large.
3. Kembalikan presentasi isi `ComboCard` lama yang menampilkan nama, badge strategi, jumlah model, prefix/model per baris, expand/collapse, Fusion judge, strategy selector, edit, dan delete.
4. Pertahankan checkbox pemilihan serta toolbar bulk di atas grid.
5. `Select all` berlaku pada hasil filter yang terlihat. Operasi bulk hanya bekerja pada pilihan eksplisit.
6. Pertahankan `aggregateComboCapabilities`, termasuk resolusi capability untuk nested combo.
7. Pertahankan `DEFAULT_FALLBACK_MODEL="oc/mimo-v2.6-flash-free"` dan `upgradeLegacyModel`.
8. Pertahankan API preset dan tombol preset tersembunyi sebagaimana upstream v0.5.85.
9. Tidak mengubah API, schema DB, Go engine, service, deploy, atau produksi.

## State dan data flow

- API tetap mengisi `combos`.
- Search/filter/sort menghasilkan `filteredCombos`.
- Grid hanya merender `filteredCombos`.
- `comboByName` tetap dibangun dari seluruh `combos` agar nested combo capability dapat diselesaikan walau combo referensi sedang tersaring.
- Checkbox kartu menyimpan ID pada `selectedIds`.
- `Select all` memilih ID dari `filteredCombos`, bukan seluruh dataset tersembunyi.
- Reset filter tidak menghapus pilihan eksplisit.

## Error handling

Tidak ada jalur network baru. Error create, update, delete, bulk delete, strategy update, dan preset tetap memakai perilaku yang ada. Empty search result tetap menampilkan `No combos match your filters` dan `Clear Filters`.

## Pengujian

1. Regression test source memastikan grid memetakan `filteredCombos`, bukan `combos`.
2. Regression test memastikan `Select all` menggunakan ID hasil filter.
3. Regression test memastikan `aggregateComboCapabilities` dan `upgradeLegacyModel` tetap ada.
4. Jalankan test combo terkait.
5. Jalankan `npm run build`.
6. Jalankan `git diff --check`.
7. Review independen diff final.

## Non-goals

- Tidak mengubah algoritme pencarian.
- Tidak menambah dependency.
- Tidak mengubah preset atau endpoint combo.
- Tidak deploy, restart, atau mengubah unit systemd.
