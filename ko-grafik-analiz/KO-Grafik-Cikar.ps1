<#
==========================================================================
 KO-Grafik-Cikar.ps1  —  Knight Online client grafik envanteri cikarici
--------------------------------------------------------------------------
 Amac: KnightOnline.exe ve client klasorunden, DX9->DX11 tasima fizibilitesi
       icin DOGRULANABILIR bilgiyi (tahmin degil) uretmek.

 Gereksinim: Sadece Windows PowerShell (5.1) veya PowerShell 7. Visual Studio
             ya da harici arac SART DEGIL. dumpbin/DIE varsa ek olarak kullanilir.

 Kullanim:
   1) PowerShell'i ac (yonetici gerekmiyor).
   2) Gerekirse: Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   3) Calistir:
        .\KO-Grafik-Cikar.ps1 -ClientDir "C:\Users\Tolga\KO_Server\CLIENT\game"
   4) Olusan  cikti\  klasorundeki  RAPOR.txt  ve  *.txt  dosyalarini kopyala,
      Claude'a yapistir.
==========================================================================
#>

param(
    [string]$ClientDir = "C:\Users\Tolga\KO_Server\CLIENT\game",
    [string]$ExeName   = "KnightOnline.exe",
    [string]$OutDir    = "cikti"
)

$ErrorActionPreference = "Continue"
if (-not (Test-Path $ClientDir)) { Write-Host "HATA: Client klasoru yok: $ClientDir" -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$report = Join-Path $OutDir "RAPOR.txt"
"KO GRAFIK ENVANTERI  ($(Get-Date))" | Out-File $report -Encoding utf8
"ClientDir: $ClientDir" | Out-File $report -Append -Encoding utf8
function Log($t){ $t | Tee-Object -FilePath $report -Append }

# ---------------------------------------------------------------------------
# 1) EXE: PE header -> 32/64 bit, DLL importlari, packer imzalari
# ---------------------------------------------------------------------------
$exe = Join-Path $ClientDir $ExeName
if (-not (Test-Path $exe)) {
    # exe ismi farkli olabilir; klasordeki tum exe'leri bul
    $cand = Get-ChildItem $ClientDir -Filter *.exe -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $exe = $cand.FullName; Log ("[i] $ExeName bulunamadi, kullanilan: " + $exe) }
}
Log "`n===== 1. EXE ANALIZI ====="
Log ("Dosya: " + $exe)

if (Test-Path $exe) {
    $bytes = [System.IO.File]::ReadAllBytes($exe)
    Log ("Boyut: {0:N0} bayt" -f $bytes.Length)

    # --- PE header: e_lfanew @ 0x3C, Machine @ (e_lfanew+4) ---
    $peOff   = [BitConverter]::ToInt32($bytes,0x3C)
    $machine = [BitConverter]::ToUInt16($bytes,$peOff+4)
    $arch = switch ($machine) { 0x014c {"x86 (32-bit)"} 0x8664 {"x64 (64-bit)"} 0x01c0 {"ARM"} 0xAA64 {"ARM64"} default {("0x{0:X4} (bilinmiyor)" -f $machine)} }
    Log ("Mimari (PE Machine=0x{0:X4}): {1}" -f $machine,$arch)

    # --- Subsystem / .NET var mi ---
    $optOff = $peOff + 24
    $magic  = [BitConverter]::ToUInt16($bytes,$optOff)
    Log ("Optional header magic: 0x{0:X4}  ({1})" -f $magic, ($(if($magic -eq 0x20b){"PE32+"}elseif($magic -eq 0x10b){"PE32"}else{"?"})))

    # --- Import edilen DLL isimleri (ASCII olarak binary icinde gecer) ---
    $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
    $dllMatches = [regex]::Matches($ascii, '(?i)[A-Za-z0-9_\-\.]{1,40}\.dll') |
                  ForEach-Object { $_.Value.ToLower() } | Sort-Object -Unique
    Log "`n--- EXE icinde gecen .dll isimleri (import ipucu) ---"
    $dllMatches | ForEach-Object { Log ("  " + $_) }

    # --- DirectX tespiti (kritik) ---
    Log "`n--- DirectX imzalari (EXE string taramasi) ---"
    $dxPatterns = 'd3d8\.dll','d3d9\.dll','d3d10\w*\.dll','d3d11\.dll','d3d12\.dll',
                  'd3dx9_\d+\.dll','d3dx10_\d+\.dll','d3dx11_\d+\.dll','dxgi\.dll',
                  'ddraw\.dll','opengl32\.dll','vulkan-1\.dll',
                  'Direct3DCreate9','Direct3DCreate8','D3D11CreateDevice','CreateDXGIFactory',
                  'IDirect3DDevice9','vs_2_0','vs_3_0','ps_2_0','ps_3_0','vs_1_1','ps_1_1'
    foreach($p in $dxPatterns){
        $m = [regex]::Matches($ascii,"(?i)$p")
        if($m.Count -gt 0){ Log ("  [+] {0}  (x{1})" -f $p, $m.Count) }
    }

    # --- Packer / protector imzalari ---
    Log "`n--- Packer/Protector imzalari ---"
    $packers = 'UPX0','UPX1','UPX!','\.themida','Themida','WinLicense','VMProtect','\.vmp0',
               'ASPack','\.aspack','ASProtect','Enigma','\.enigma1','MPRESS','PECompact',
               'Armadillo','\.petite','FSG!','\.nsp0','molebox','Obsidium'
    $found=$false
    foreach($p in $packers){
        if([regex]::IsMatch($ascii,"$p")){ Log ("  [!] " + $p); $found=$true }
    }
    if(-not $found){ Log "  (bilinen packer imzasi bulunamadi — muhtemelen packlanmamis, yine de DIE ile dogrula)" }

    # --- Section isimleri (packer'i ele verir: .themida, UPX0 vs.) ---
    Log "`n--- PE section isimleri ---"
    $numSec = [BitConverter]::ToUInt16($bytes,$peOff+6)
    $optSize= [BitConverter]::ToUInt16($bytes,$peOff+20)
    $secOff = $peOff + 24 + $optSize
    for($i=0;$i -lt $numSec;$i++){
        $n = [System.Text.Encoding]::ASCII.GetString($bytes,$secOff+$i*40,8).TrimEnd([char]0)
        Log ("  " + $n)
    }
} else { Log "HATA: exe bulunamadi." }

# ---------------------------------------------------------------------------
# 2) Yanindaki DLL'ler
# ---------------------------------------------------------------------------
Log "`n===== 2. KLASORDEKI DLL'ler ====="
Get-ChildItem $ClientDir -Filter *.dll -File -ErrorAction SilentlyContinue |
    ForEach-Object { Log ("  {0,-30} {1,12:N0} bayt" -f $_.Name,$_.Length) }

# ---------------------------------------------------------------------------
# 3) Varlik envanteri (uzantiya gore sayim)  -> N3 motoru mu?
# ---------------------------------------------------------------------------
Log "`n===== 3. VARLIK ENVANTERI (uzanti -> adet, toplam boyut) ====="
$all = Get-ChildItem $ClientDir -Recurse -File -ErrorAction SilentlyContinue
$all | Group-Object Extension | Sort-Object Count -Descending | ForEach-Object {
    $sz = ($_.Group | Measure-Object Length -Sum).Sum
    Log ("  {0,-12} {1,7} adet   {2,14:N0} bayt" -f ($_.Name), $_.Count, $sz)
}
# N3 imzasi
$n3 = $all | Where-Object { $_.Extension -match '(?i)\.n3' }
Log ("`nN3 motoru varlik sayisi (.n3*): " + $n3.Count)
$all | Where-Object { $_.Name -match '(?i)\.(n3pmesh|n3cmesh|n3fmesh|n3ppart|n3tex|n3shape|n3form|n3mesh)$' } |
    Group-Object Extension | ForEach-Object { Log ("  " + $_.Name + " : " + $_.Count) }

$assetList = Join-Path $OutDir "assets.txt"
$all | Select-Object -ExpandProperty FullName | Out-File $assetList -Encoding utf8
Log ("`n[i] Tam dosya listesi: " + $assetList)

# ---------------------------------------------------------------------------
# 4) DDS texture format analizi (FourCC @ offset 84)
# ---------------------------------------------------------------------------
Log "`n===== 4. DDS/TEXTURE FORMAT (ornek 25 dosya) ====="
$dds = $all | Where-Object { $_.Extension -match '(?i)\.dds' } | Select-Object -First 25
if($dds.Count -eq 0){ Log "  (.dds bulunamadi — texture'lar tga/bmp/oem formatinda olabilir, envantere bak)" }
foreach($f in $dds){
    try{
        $fs=[System.IO.File]::OpenRead($f.FullName); $buf=New-Object byte[] 128
        [void]$fs.Read($buf,0,128); $fs.Close()
        $magic=[System.Text.Encoding]::ASCII.GetString($buf,0,4)
        $fourcc=[System.Text.Encoding]::ASCII.GetString($buf,84,4)
        $h=[BitConverter]::ToInt32($buf,12); $w=[BitConverter]::ToInt32($buf,16)
        $mip=[BitConverter]::ToInt32($buf,28)
        Log ("  {0,-28} {1}x{2}  fourCC='{3}'  mip={4}" -f $f.Name,$w,$h,$fourcc.TrimEnd([char]0),$mip)
    }catch{ Log ("  " + $f.Name + "  (okunamadi)") }
}

# ---------------------------------------------------------------------------
# 5) Shader dosyalari (.fx / .fxo / hlsl / vsh / psh)
# ---------------------------------------------------------------------------
Log "`n===== 5. SHADER DOSYALARI ====="
$sh = $all | Where-Object { $_.Extension -match '(?i)\.(fx|fxo|fxc|hlsl|vsh|psh|cso|vso|pso)$' }
if($sh.Count -eq 0){ Log "  (ayri shader dosyasi yok — fixed-function pipeline ya da exe-gomulu shader olabilir)" }
foreach($f in $sh){
    Log ("  " + $f.Name + "  (" + $f.Length + " bayt)")
    try{
        $txt = Get-Content $f.FullName -TotalCount 40 -ErrorAction SilentlyContinue
        ($txt | Select-String -Pattern 'vs_\d_\d','ps_\d_\d','technique','VertexShader','PixelShader' -AllMatches) |
            ForEach-Object { Log ("      > " + $_.Line.Trim()) }
    }catch{}
}

# ---------------------------------------------------------------------------
# 6) Opsiyonel: dumpbin / DIE varsa ek dogrulama
# ---------------------------------------------------------------------------
Log "`n===== 6. EK ARAC CIKTISI (varsa) ====="
$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
if($dumpbin -and (Test-Path $exe)){
    Log "[i] dumpbin bulundu — import tablosu cikti\imports_dumpbin.txt'e yaziliyor"
    & dumpbin /IMPORTS $exe > (Join-Path $OutDir "imports_dumpbin.txt") 2>&1
    & dumpbin /HEADERS $exe | Select-String "machine|magic|subsystem" | ForEach-Object { Log ("  " + $_.Line.Trim()) }
} else {
    Log "[i] dumpbin yok (Visual Studio Developer Prompt'tan calistirirsan import tablosunu da eklerim)."
    Log "    Packer'i kesinlestirmek icin 'Detect It Easy (DIE)' ile exe'yi tarayip ekran goruntusu ekle."
}

Log "`n===== BITTI —  '$OutDir\RAPOR.txt'  ve  '$OutDir\assets.txt'  dosyalarini Claude'a yapistir. ====="
Write-Host "`nTamamlandi. Cikti: $OutDir\RAPOR.txt" -ForegroundColor Green
