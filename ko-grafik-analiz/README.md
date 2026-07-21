# KO Grafik Analiz Toolkit

DX9 → DX11 taşıma fizibilitesi için client'tan **doğrulanabilir** veri çıkarır.
Tahmin yok — her satır `KnightOnline.exe`'nin byte'larından ve dosya header'larından okunur.

## Çalıştırma (Windows makinende)

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
cd <bu klasörün olduğu yer>
.\KO-Grafik-Cikar.ps1 -ClientDir "C:\Users\Tolga\KO_Server\CLIENT\game"
```

Visual Studio / harici araç **gerekmez** (varsa `dumpbin` otomatik kullanılır).

## Ne üretir (`cikti\` klasörü)

| Dosya | İçerik |
|-------|--------|
| `RAPOR.txt` | Ana rapor: mimari (32/64-bit), DirectX imzaları, DLL importları, packer, PE section'ları, DDS FourCC, shader modelleri |
| `assets.txt` | Tüm dosyaların tam listesi (uzantı envanteri) |
| `imports_dumpbin.txt` | (dumpbin varsa) tam import tablosu |

## Sonra

`RAPOR.txt` içeriğini + varsa **Detect It Easy (DIE)** ekran görüntüsünü Claude'a yapıştır.
Claude, `GRAFIK_ANALIZ.md`'nin işaretli (`> DOLDUR`) kısımlarını gerçek veriyle tamamlar.
