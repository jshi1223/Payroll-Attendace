Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$androidRes = Join-Path $root 'android/app/src/main/res'
$iosAppIcon = Join-Path $root 'ios/Runner/Assets.xcassets/AppIcon.appiconset'
$androidDrawable = Join-Path $androidRes 'drawable'

function New-RoundedRectPath {
    param(
        [double]$X,
        [double]$Y,
        [double]$Width,
        [double]$Height,
        [double]$Radius
    )

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $Width - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $Width - $d, $Y + $Height - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $Height - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-KvskLauncherIcon {
    param(
        [string]$Path,
        [int]$Size,
        [switch]$Transparent
    )

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    if ($Transparent) {
        $gfx.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    } else {
        $gfx.Clear([System.Drawing.Color]::FromArgb(255, 2, 6, 23))
    }

    if (-not $Transparent) {
        $bgInset = [Math]::Round($Size * 0.04)
        $bgPath = New-RoundedRectPath -X $bgInset -Y $bgInset -Width ($Size - ($bgInset * 2)) -Height ($Size - ($bgInset * 2)) -Radius ([Math]::Round($Size * 0.20))
        $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            [System.Drawing.RectangleF]::new($bgInset, $bgInset, $Size - ($bgInset * 2), $Size - ($bgInset * 2)),
            [System.Drawing.Color]::FromArgb(255, 8, 13, 26),
            [System.Drawing.Color]::FromArgb(255, 2, 6, 23),
            90
        )
        $gfx.FillPath($bgBrush, $bgPath)
        $bgPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 11, 19, 32), [Math]::Max(1, [Math]::Round($Size * 0.012)))
        $gfx.DrawPath($bgPen, $bgPath)

        $bgGlowPen1 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 56, 189, 248), [Math]::Max(1.5, [Math]::Round($Size * 0.016)))
        $gfx.DrawPath($bgGlowPen1, $bgPath)
        $bgGlowPen2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(35, 59, 130, 246), [Math]::Max(2, [Math]::Round($Size * 0.026)))
        $gfx.DrawPath($bgGlowPen2, $bgPath)
    }

    $centerX = $Size / 2.0
    $centerY = $Size / 2.0
    $shieldTop = $Size * 0.12
    $shieldLeft = $Size * 0.18
    $shieldRight = $Size * 0.82
    $shieldBottom = $Size * 0.86

    $shield = New-Object System.Drawing.Drawing2D.GraphicsPath
    $shield.AddLine($centerX, $shieldTop, $shieldRight, $Size * 0.24)
    $shield.AddLine($shieldRight, $Size * 0.24, $shieldRight, $Size * 0.56)
    $shield.AddLine($shieldRight, $Size * 0.56, $Size * 0.69, $shieldBottom)
    $shield.AddLine($Size * 0.69, $shieldBottom, $centerX, $Size * 0.95)
    $shield.AddLine($centerX, $Size * 0.95, $Size * 0.31, $shieldBottom)
    $shield.AddLine($Size * 0.31, $shieldBottom, $shieldLeft, $Size * 0.56)
    $shield.AddLine($shieldLeft, $Size * 0.56, $shieldLeft, $Size * 0.24)
    $shield.CloseFigure()

    $shieldFillBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.RectangleF]::new($Size * 0.18, $Size * 0.12, $Size * 0.64, $Size * 0.74),
        [System.Drawing.Color]::FromArgb(255, 226, 232, 240),
        [System.Drawing.Color]::FromArgb(255, 148, 163, 184),
        90
    )
    $gfx.FillPath($shieldFillBrush, $shield)

    $shieldGlowPen1 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(105, 56, 189, 248), [Math]::Max(1.5, $Size * 0.05))
    $shieldGlowPen1.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $gfx.DrawPath($shieldGlowPen1, $shield)

    $shieldGlowPen2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 96, 165, 250), [Math]::Max(1.5, $Size * 0.025))
    $shieldGlowPen2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $gfx.DrawPath($shieldGlowPen2, $shield)

    $shieldPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 17, 24, 39), [Math]::Max(1.5, $Size * 0.012))
    $shieldPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $gfx.DrawPath($shieldPen, $shield)

    $shieldHighlightPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 255, 255, 255), [Math]::Max(1, $Size * 0.008))
    $shieldHighlightPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $gfx.DrawPath($shieldHighlightPen, $shield)

    $gfx.TranslateTransform($centerX, $centerY * 0.95)
    $gfx.RotateTransform(-18)

    $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 0, 0, 0))
    $shadowTop = New-RoundedRectPath -X (-$Size * 0.24) -Y (-$Size * 0.01) -Width ($Size * 0.48) -Height ($Size * 0.13) -Radius ($Size * 0.04)
    $gfx.FillPath($shadowBrush, $shadowTop)

    $cameraRed = [System.Drawing.Color]::FromArgb(255, 180, 30, 30)
    $cameraBlack = [System.Drawing.Color]::FromArgb(255, 10, 10, 12)
    $topBand = New-RoundedRectPath -X (-$Size * 0.23) -Y (-$Size * 0.11) -Width ($Size * 0.46) -Height ($Size * 0.12) -Radius ($Size * 0.04)
    $gfx.FillPath((New-Object System.Drawing.SolidBrush($cameraRed)), $topBand)

    $body = New-RoundedRectPath -X (-$Size * 0.25) -Y (-$Size * 0.01) -Width ($Size * 0.50) -Height ($Size * 0.13) -Radius ($Size * 0.04)
    $gfx.FillPath((New-Object System.Drawing.SolidBrush($cameraBlack)), $body)

    $mount = New-RoundedRectPath -X ($Size * 0.15) -Y (-$Size * 0.00) -Width ($Size * 0.07) -Height ($Size * 0.10) -Radius ($Size * 0.02)
    $gfx.FillPath((New-Object System.Drawing.SolidBrush($cameraBlack)), $mount)

    $highlightPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 255, 255, 255), [Math]::Max(1, $Size * 0.008))
    $gfx.DrawLine($highlightPen, (-$Size * 0.17), (-$Size * 0.03), (-$Size * 0.10), (-$Size * 0.055))

    $gfx.RotateTransform(18)
    $gfx.TranslateTransform(-$centerX, -$centerY * 0.95)

    $gfx.Dispose()
    if ($bgBrush) { $bgBrush.Dispose() }
    if ($bgPath) { $bgPath.Dispose() }
    if ($bgPen) { $bgPen.Dispose() }
    if ($bgGlowPen1) { $bgGlowPen1.Dispose() }
    if ($bgGlowPen2) { $bgGlowPen2.Dispose() }
    if ($shieldFillBrush) { $shieldFillBrush.Dispose() }
    if ($shieldGlowPen1) { $shieldGlowPen1.Dispose() }
    if ($shieldGlowPen2) { $shieldGlowPen2.Dispose() }
    $shield.Dispose()
    $shieldPen.Dispose()
    if ($shieldHighlightPen) { $shieldHighlightPen.Dispose() }
    $shadowBrush.Dispose()
    if ($highlightPen) { $highlightPen.Dispose() }

    $dir = Split-Path -Parent $Path
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$androidSizes = @{
    'mipmap-mdpi' = 48
    'mipmap-hdpi' = 72
    'mipmap-xhdpi' = 96
    'mipmap-xxhdpi' = 144
    'mipmap-xxxhdpi' = 192
}

foreach ($entry in $androidSizes.GetEnumerator()) {
    Draw-KvskLauncherIcon -Path (Join-Path $androidRes "$($entry.Key)/ic_launcher.png") -Size $entry.Value
}

Draw-KvskLauncherIcon -Path (Join-Path $androidDrawable 'ic_launcher_foreground.png') -Size 432 -Transparent

$iosSizes = @{
    'Icon-App-20x20@1x.png' = 20
    'Icon-App-20x20@2x.png' = 40
    'Icon-App-20x20@3x.png' = 60
    'Icon-App-29x29@1x.png' = 29
    'Icon-App-29x29@2x.png' = 58
    'Icon-App-29x29@3x.png' = 87
    'Icon-App-40x40@1x.png' = 40
    'Icon-App-40x40@2x.png' = 80
    'Icon-App-40x40@3x.png' = 120
    'Icon-App-60x60@2x.png' = 120
    'Icon-App-60x60@3x.png' = 180
    'Icon-App-76x76@1x.png' = 76
    'Icon-App-76x76@2x.png' = 152
    'Icon-App-83.5x83.5@2x.png' = 167
    'Icon-App-1024x1024@1x.png' = 1024
}

foreach ($entry in $iosSizes.GetEnumerator()) {
    Draw-KvskLauncherIcon -Path (Join-Path $iosAppIcon $($entry.Key)) -Size $entry.Value
}

Write-Host "Launcher icons updated."
