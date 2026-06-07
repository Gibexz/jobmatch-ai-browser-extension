#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot setup for JobMatch AI.
    Downloads library files from unpkg CDN and generates extension icons.
    No Node.js required.
#>

param(
    [switch]$SkipLibs,
    [switch]$SkipIcons
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT      = Split-Path $PSScriptRoot -Parent
$LIB_DIR   = Join-Path $ROOT 'extension\lib'
$ICONS_DIR = Join-Path $ROOT 'extension\icons'

# ── Library downloads ─────────────────────────────────────────────────────────

$libs = @(
    @{
        Url  = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js'
        Dest = 'pdf.min.js'
        Desc = 'pdf.js v3.11.174 (main)'
    },
    @{
        Url  = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
        Dest = 'pdf.worker.min.js'
        Desc = 'pdf.js v3.11.174 (worker)'
    },
    @{
        Url  = 'https://unpkg.com/mammoth@1.7.2/mammoth.browser.min.js'
        Dest = 'mammoth.min.js'
        Desc = 'mammoth.js v1.7.2 (DOCX parser)'
    },
    @{
        Url  = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
        Dest = 'xlsx.min.js'
        Desc = 'SheetJS xlsx v0.18.5 (Excel export)'
    }
)

if (-not $SkipLibs) {
    Write-Host "`nDownloading libraries to extension\lib\" -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $LIB_DIR -Force | Out-Null

    $wc = New-Object System.Net.WebClient
    foreach ($lib in $libs) {
        $dest = Join-Path $LIB_DIR $lib.Dest
        try {
            Write-Host "  Downloading $($lib.Desc)..." -NoNewline
            $wc.DownloadFile($lib.Url, $dest)
            $kb = [Math]::Round((Get-Item $dest).Length / 1KB, 1)
            Write-Host "  OK  ($kb KB)" -ForegroundColor Green
        }
        catch {
            Write-Host "  FAILED" -ForegroundColor Red
            Write-Host "  Error: $_" -ForegroundColor Red
            Write-Host "  URL:  $($lib.Url)"
            exit 1
        }
    }
    $wc.Dispose()
    Write-Host "All libraries downloaded.`n" -ForegroundColor Green
}

# ── Icon generation ───────────────────────────────────────────────────────────

if (-not $SkipIcons) {
    Write-Host "Generating extension icons..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $ICONS_DIR -Force | Out-Null

    Add-Type -AssemblyName System.Drawing

    # NHS dark blue background, white "J" glyph
    $BG_R = 0;   $BG_G = 48;  $BG_B = 135
    $FG_R = 255; $FG_G = 255; $FG_B = 255

    # 5×7 pixel-art "J" glyph (1 = foreground pixel)
    $GLYPH = @(
        @(0,1,1,1,1),
        @(0,0,0,1,1),
        @(0,0,0,1,1),
        @(0,0,0,1,1),
        @(1,0,0,1,1),
        @(1,1,0,1,1),
        @(0,1,1,1,0)
    )
    $GLYPH_W = 5
    $GLYPH_H = 7

    $bgColor = [System.Drawing.Color]::FromArgb($BG_R, $BG_G, $BG_B)
    $fgColor = [System.Drawing.Color]::FromArgb($FG_R, $FG_G, $FG_B)

    foreach ($size in @(16, 48, 128)) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear($bgColor)

        $scale = [Math]::Max(1, [Math]::Floor($size / 10))
        $pw    = $GLYPH_W * $scale
        $ph    = $GLYPH_H * $scale
        $ox    = [Math]::Floor(($size - $pw) / 2)
        $oy    = [Math]::Floor(($size - $ph) / 2)

        for ($gy = 0; $gy -lt $GLYPH_H; $gy++) {
            for ($gx = 0; $gx -lt $GLYPH_W; $gx++) {
                if ($GLYPH[$gy][$gx] -eq 0) { continue }
                $rect = New-Object System.Drawing.Rectangle `
                    ($ox + $gx * $scale), ($oy + $gy * $scale), $scale, $scale
                $brush = New-Object System.Drawing.SolidBrush $fgColor
                $g.FillRectangle($brush, $rect)
                $brush.Dispose()
            }
        }

        $g.Dispose()
        $dest = Join-Path $ICONS_DIR "icon${size}.png"
        $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host "  icon${size}.png  OK" -ForegroundColor Green
    }

    Write-Host "Icons written to extension\icons\`n" -ForegroundColor Green
}

Write-Host "Setup complete. You can now load extension\ in Chrome via chrome://extensions > Load unpacked." -ForegroundColor Cyan
