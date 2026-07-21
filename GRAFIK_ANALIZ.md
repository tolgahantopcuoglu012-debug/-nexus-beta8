# Knight Online Client — Grafik Altyapısı Analizi (DX9 → DX11 Fizibilite)

> **Durum:** İSKELET / kısmen dolu.
> **Kural:** Tahmin yok. `⟶ DOLDUR` işaretli her alan, `KnightOnline.exe` ve client
> dosyalarından `KO-Grafik-Cikar.ps1` ile çıkarılan doğrulanabilir veriyle tamamlanır.
> Analiz ortamı (Linux bulut konteyneri) `C:\Users\Tolga\KO_Server\CLIENT\game`'e
> erişemediği için 1–2. bölümler yerel çıktı yapıştırıldığında kesinleşecektir.

---

## 1. Mevcut Durum — Executable & Bağımlılıklar

Kaynak: `ko-grafik-analiz/cikti/RAPOR.txt` (+ isteğe bağlı `imports_dumpbin.txt`, DIE)

| Özellik | Değer | Kaynak/Kanıt |
|---------|-------|--------------|
| Mimari (32/64-bit) | ⟶ DOLDUR (PE Machine=?) | RAPOR.txt §1 |
| DirectX sürümü | ⟶ DOLDUR (d3d?.dll / Direct3DCreate?) | RAPOR.txt §1 DirectX imzaları |
| d3dx yardımcı kütüphanesi | ⟶ DOLDUR (d3dx9_XX.dll) | RAPOR.txt §1 |
| Ek grafik DLL'leri | ⟶ DOLDUR (dxgi, opengl32, ddraw…) | RAPOR.txt §1–2 |
| Diğer bağımlılıklar | ⟶ DOLDUR (dll listesi) | RAPOR.txt §2 |
| Packer / protector | ⟶ DOLDUR (UPX/Themida/yok) | RAPOR.txt §1 + DIE |
| PE section isimleri | ⟶ DOLDUR | RAPOR.txt §1 |

**Yorum (veri gelince):** ⟶ DOLDUR
_DirectX sürümü ve packer durumu, aşağıdaki taşıma yollarının hangisinin mümkün
olduğunu doğrudan belirler; bu yüzden bu iki satır kritik._

---

## 2. Client Dosya Yapısı — Varlıklar, Texture, Shader

Kaynak: `ko-grafik-analiz/cikti/RAPOR.txt` §3–5, `assets.txt`

### 2.1 3D varlık formatları (N3 motoru mu?)
| Uzantı | Adet | Anlamı |
|--------|------|--------|
| ⟶ DOLDUR (.n3pmesh…) | ? | RAPOR.txt §3 |

N3 motoru göstergesi (`.n3*` sayısı): ⟶ DOLDUR

### 2.2 Texture formatları
| Örnek dosya | Boyut | FourCC (DXT1/DXT5/…) | Mip |
|-------------|-------|----------------------|-----|
| ⟶ DOLDUR | ? | ? | ? |

DDS/DXT kullanımı: ⟶ DOLDUR (DX11'de doğrudan yüklenebilir mi → BC1/2/3 zaten uyumlu)

### 2.3 Shader dosyaları
Ayrı shader dosyası var mı: ⟶ DOLDUR
Shader modeli (`vs_2_0`, `ps_2_0`…) / fixed-function mı: ⟶ DOLDUR (RAPOR.txt §5)

---

## 3. Açık Kaynak Referans — OpenKO & N3 Motoru

> ✅ **Doğrulandı** (OpenKO public source, URL'ler aşağıda). Not: OpenKO, KO
> **1.298** sürümü için yapılmış bir yeniden-yapım (recreation); senin retail
> client'ının sürümü farklı olabilir — bu yüzden 1–2. bölüm (kendi exe'nin
> analizi) yine de gereklidir. OpenKO burada **motor mimarisi referansı** olarak kullanılıyor.

**Depo:** `Open-KO/KnightOnline` — https://github.com/Open-KO/KnightOnline
(C++ %85.8, aktif; son push 2026-07-15; ~1169 commit; default branch `master`; topic: `directx`).
Monorepo: client + server + tools. _(Dikkat: "Open-KO-KnightOnline" adında repo yok.)_

**Render katmanı konumu:** N3 motoru → **`src/N3Base/`**
(https://github.com/Open-KO/KnightOnline/tree/master/src/N3Base). Client'a özel render
kodu ayrıca `src/Client/WarFare/` (`PlayerBase.cpp`, `ServerMesh.cpp`, `N3River.cpp`).

**Kullanılan DirectX sürümü: DirectX 9 (kanıtlı).**
| Kanıt | Dosya |
|-------|-------|
| `#include <d3dx9.h>`, `_D3DMATERIAL9`, `_D3DLIGHT9` | `src/N3Base/My_3DStruct.h` |
| `static LPDIRECT3DDEVICE9 s_lpD3DDev;`, `D3DPRESENT_PARAMETERS`, `D3DCAPS9` | `src/N3Base/N3Base.h` |
| `USE_DIRECTX9=1`, `DIRECTINPUT_VERSION=0x0800`, `d3d9.h/d3dx9.h` | `cmake/dx9sdk/dx9sdk-config.cmake` |
| tek grafik-API submodülü: `deps/dx9sdk` → microsoft-directx-sdk | `.gitmodules` |

Depoda `d3d8.h`, `d3d11.h` **yok**. README: "orijinal leaked source → DirectX 9'a güncellendi."

**DX11 / Vulkan / DX12 / OpenGL taşıması: kodda YAPILMAMIŞ / başlamamış.**
- `d3d11`, `vulkan`, `D3DXCreateEffect` kod aramaları → **0 sonuç**. Grafik dalları yok.
- Sadece **planlama aşamasında açık issue'lar** (hepsi kodsuz):
  - #693 "Implement Vulkan support" — açık, **gövdesi boş placeholder** (https://github.com/Open-KO/KnightOnline/issues/693)
  - #671 cross-platform CMake, #699 input, #717 proje yeniden yapılanma önerisi
    (#717 yalnız DX9'dan bahsediyor; DX11 önermiyor).
- **Sonuç:** Renderer bugün %100 D3D9. Modern-API sadece hayali/açık issue.

**N3 ("Noah 3D") motor yapısı — çekirdek sınıflar:**
| Sınıf | Görev | Not |
|-------|-------|-----|
| `CN3Base` | D3D9 cihazını tutar (`s_lpD3DDev`) | tüm motorun kökü |
| `CN3BaseFileAccess` | dosya yükleme tabanı | `N3BaseFileAccess.*` |
| `CN3PMesh` / `CN3PMeshInstance` | progressive/LOD mesh; `__VertexT1/T2`, `uint16 indices` | GPU buffer instance'ta |
| `CN3Mesh`, `CN3IMesh` | statik mesh | |
| `CN3Texture` | `LPDIRECT3DTEXTURE9 m_lpTexture` | aşağıya bak |
| `CN3Chr`, `CN3Joint` | karakter + kemik/animasyon | `CN3AnimControl` |
| `CN3Shape` / `CN3ShapeMgr` | statik geometri + collision | |
| `CN3Scene`, `CN3SkyMng`, `CN3FX*` | sahne, gökyüzü, efekt/particle | |

**Texture formatı:** Proprietary **NTF** ("Noah Texture File") konteyner — header `char szID[4]="NTF"`.
İçerik: `D3DFORMAT Format; // 0=sıkıştırmasız, 1~5 = D3DFMT_DXT1 ~ DXT5`. Yani DXT1–5
**DX konteyneri içinde**; standalone `.dds` yükleme yolu bulunamadı (flag'li).

**Pipeline: fixed-function (programlanabilir shader YOK).** ← DX11 taşıması için en kritik nokta.
- `SetTextureStageState` için **57 kod eşleşmesi**; her yerde `SetFVF(...)`,
  `SetRenderState(...)`, `D3DTSS_COLOROP`, FVF kodları (`D3DFVF_XYZ`, `FVF_XYZCOLOR`).
- `.fx` dosyası **0**, `D3DXCreateEffect` **0**, `vs_2_0`/`ps_2_0` **yok**.
- Yani render tamamen DX9 **sabit-fonksiyon** boru hattı üzerinde.

**Flag'li (doğrulanamadı):** diskteki tam uzantı literalleri (`.n3pmesh`, `.n3cmesh` vs.)
başlıklarda bağlanamadı — sınıf→görev eşlemesi kesin, uzantı stringi kesin değil.
Bunu senin `assets.txt`'in netleştirecek.

---

## 4. Taşıma Yolları ve Gereksinimleri

> Bu bölüm, DX9→DX11 taşımasının genel mühendislik gerçeklerine dayanır ve
> **karar 1–2. bölümdeki verilere bağlıdır** (özellikle: kaynak koda erişim var mı,
> exe packli mi, DirectX sürümü ne).

### Yol A — Wrapper / Translation Layer (kaynak kod GEREKMEZ)
Örn. **dgVoodoo2**, **DXVK (d3d9)**, **WineD3D**.
- **Ne yapar:** Client'ın çağırdığı `d3d9.dll`'i, DX9 çağrılarını modern API'ye
  (dgVoodoo2 → DX11/12; DXVK → Vulkan) çeviren sahte bir DLL ile değiştirir.
- **Gereksinim:** Client'ın gerçekten **DX9 (veya 8)** kullanıyor olması + exe'nin
  DLL yer değiştirmeyi engelleyen bir **protector/anti-tamper** ile korunmaması.
- **Fizibilite kararı:** ⟶ 1. bölümdeki "DirectX sürümü" ve "packer" satırlarına bağlı.
  - DX9 + packsiz → yüksek olasılıkla çalışır.
  - Themida/anti-cheat (ör. nProtect GameGuard) varsa → DLL enjeksiyonunu bloklar,
    çoğunlukla **çalışmaz** ya da ban riski doğurur. ⟶ DOLDUR
- **Maliyet:** Düşük (kod değişikliği yok). Ama online sunucuda anti-cheat çakışması riski.

### Yol B — Kaynak koddan render backend değişimi (OpenKO tabanlı)
- **Ne yapar:** N3 render katmanının DX9 çağrılarını DX11 ile yeniden yazmak.
- **Gereksinim:** Derlenebilir client kaynağı (OpenKO mevcut, C++/CMake).
- **Maliyet: ÇOK YÜKSEK — 3. bölüm bunu netleştirdi:** OpenKO N3 motoru **fixed-function**
  boru hattı kullanıyor (`SetTextureStageState` 57 yerde, `SetFVF`/`SetRenderState` her yerde,
  hiç HLSL shader yok). **DX11'de fixed-function pipeline YOKTUR.** Yani taşıma "API çağrılarını
  çevir" değil; her texture-stage/render-state kombinasyonunu **sıfırdan HLSL vertex+pixel shader**,
  constant buffer, input layout ve state object olarak yeniden yazmak demektir. NTF→DXT texture
  yükleyicisi ise DX11'e nispeten kolay taşınır (BC1–3 zaten native).
- **Avantaj:** Sunucu-yasal, kalıcı, gerçek DX11 kazanımları. Ama efor bir wrapper'ın kat kat üstünde.

### Yol C — Hibrit
Wrapper ile hızlı sonuç al (fizibilite ispatı), paralelde OpenKO'da kalıcı DX11 backend.

**Ön öneri (3. bölüm ışığında, 1–2 verisiyle kesinleşir):** N3 motoru fixed-function DX9
olduğundan, saf DX11 backend yazmak çok pahalı. Eğer senin retail exe'n de DX9 + packsiz +
anti-cheat DLL enjeksiyonunu bloklamıyorsa, **pragmatik yol A (dgVoodoo2 gibi wrapper)** ile
başlamak mantıklı — dgVoodoo2 tam da DX9 fixed-function'ı DX11/12'ye çevirmek için tasarlanmış.
Kalıcı/derin DX11 için Yol B ancak büyük bir shader yeniden-yazımı projesi olarak düşünülmeli.

---

## 5. Wrapper Çözümü Bu Client'ta Çalışır mı? (dgVoodoo2 vb.)

| Koşul | Gerekli | Bu client'ta durum |
|-------|---------|--------------------|
| DX9 (veya 8/DDraw) kullanımı | ✔ | ⟶ DOLDUR (§1) |
| `d3d9.dll` dış DLL olarak çağrılıyor (statik değil) | ✔ | ⟶ DOLDUR (§1 import) |
| Protector yok / anti-tamper yok | ✔ | ⟶ DOLDUR (§1 packer) |
| Anti-cheat (GameGuard/nProtect vb.) DLL enjeksiyonu bloklamıyor | ✔ | ⟶ DOLDUR (dll listesi §2) |

**Sonuç:** ⟶ DOLDUR (tüm koşullar sağlanınca "evet/çalışır", biri sağlanmazsa hangisi engelliyor).

---

### Ek: Bu rapor nasıl tamamlanır
1. `ko-grafik-analiz/KO-Grafik-Cikar.ps1`'i client makinende çalıştır.
2. `cikti\RAPOR.txt` + `assets.txt` içeriğini (ve DIE ekran görüntüsünü) yapıştır.
3. `⟶ DOLDUR` alanları doğrulanmış veriyle değiştirilir; 4–5. bölümdeki karar kesinleşir.
