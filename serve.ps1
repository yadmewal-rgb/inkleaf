# Local test server for Inkleaf.
#   powershell -ExecutionPolicy Bypass -File serve.ps1            -> http://localhost:8080 (this PC only)
#   powershell -ExecutionPolicy Bypass -File serve.ps1 -Lan       -> reachable from phones/tablets on the same Wi-Fi (run as Administrator)
param([int]$Port = 8080, [switch]$Lan)

$root = $PSScriptRoot
$prefix = if ($Lan) { "http://+:$Port/" } else { "http://localhost:$Port/" }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Inkleaf is being served at $prefix  (Ctrl+C to stop)"

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.pdf' = 'application/pdf'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if ($file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $type = $mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
      $ctx.Response.ContentType = $type
      $ctx.Response.Headers['Cache-Control'] = 'no-cache'
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch {}
  } finally {
    try { $ctx.Response.Close() } catch {}
  }
}
