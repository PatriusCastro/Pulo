# Draws the installer artwork from the app icon: the welcome/finish sidebar (164x314) and the
# page header (150x57), as the 24-bit BMPs NSIS needs. Run again if the icon changes:
#   powershell -NoProfile -File scripts\installer-art.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot
$out = Join-Path $root 'src-pulo\installer'
New-Item -ItemType Directory -Force $out | Out-Null
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'src-pulo\icons\Square284x284Logo.png'))

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  return $bmp, $g
}
$center = New-Object System.Drawing.StringFormat
$center.Alignment = 'Center'

# Sidebar: the island's dark world, the icon, the name and what it is.
$bmp, $g = New-Canvas 164 314
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Rectangle 0, 0, 164, 314), ([System.Drawing.Color]::FromArgb(24, 27, 33)), ([System.Drawing.Color]::FromArgb(7, 9, 12)), 90
$g.FillRectangle($bg, 0, 0, 164, 314)
$g.DrawImage($icon, 38, 70, 88, 88)
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(241, 243, 244))
$grey = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(154, 163, 171))
$g.DrawString('Pulo', (New-Object System.Drawing.Font 'Segoe UI Semibold', 17), $white, (New-Object System.Drawing.RectangleF 0, 170, 164, 34), $center)
$g.DrawString("Dynamic Island`nfor Windows", (New-Object System.Drawing.Font 'Segoe UI', 8.5), $grey, (New-Object System.Drawing.RectangleF 0, 206, 164, 40), $center)
# A small pill near the bottom, like the island at the top of the screen.
$pill = New-Object System.Drawing.Drawing2D.GraphicsPath
$pill.AddArc(58, 270, 14, 14, 90, 180); $pill.AddArc(92, 270, 14, 14, 270, 180); $pill.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)), $pill)
$g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(48, 54, 61)), 1), $pill)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(61, 220, 132))), 94, 274, 6, 6)
$bmp.Save((Join-Path $out 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

# Header: the icon on the white page header, right-aligned (MUI_HEADERIMAGE_RIGHT).
$bmp, $g = New-Canvas 150 57
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($icon, 104, 9, 40, 40)
$bmp.Save((Join-Path $out 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()
$icon.Dispose()
"Wrote $out\sidebar.bmp and header.bmp"
