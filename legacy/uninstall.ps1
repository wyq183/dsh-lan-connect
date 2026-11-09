#!/usr/bin/env pwsh
<#
  dsh-lan-connect 卸载脚本 —— install.ps1 的逆操作。

    1. 从 profile 的 cordis.patch.yml 里删掉插件挂载条目（其余内容原样保留）。
    2. 删掉 node_modules 下的 junction（只删链接，不动插件源码）。
    3. 备份被修改的 patch 文件。

  参数（一般不用给，默认真实环境）：
    -ProfileDir  dsh web profile 目录
#>
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web')
)

$ErrorActionPreference = 'Stop'

$LinkPath  = Join-Path $ProfileDir 'node_modules\dsh-lan-connect'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$Stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host 'dsh-lan-connect uninstaller' -ForegroundColor Cyan
Write-Host '---------------------------'

# ── 1. 从 patch 里摘掉挂载条目 ───────────────────────────────────────────────
if (Test-Path $PatchFile) {
  $lines = Get-Content $PatchFile
  $kept = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  $removed = 0

  foreach ($line in $lines) {
    # 命中插件标题注释时开始跳过；到 "name: 'dsh-lan-connect'" 结束
    if ($line -match 'dsh-lan-connect') { $skipping = $true }
    if ($skipping) {
      $removed++
      if ($line -match "name:\s*'dsh-lan-connect'") { $skipping = $false }
      continue
    }
    $kept.Add($line)
  }

  if ($removed -gt 0) {
    Copy-Item $PatchFile "$PatchFile.bak-$Stamp" -Force
    $text = ($kept -join "`n") -replace "(`r?`n){3,}", "`n`n"
    Set-Content -Path $PatchFile -Value $text -Encoding UTF8 -NoNewline
    Write-Host "[ok] removed $removed line(s) from cordis.patch.yml (backup: .bak-$Stamp)"
  } else {
    Write-Host '[--] no plugin entry found in cordis.patch.yml'
  }
} else {
  Write-Host '[--] cordis.patch.yml not found; skipping'
}

# ── 2. 删 junction ───────────────────────────────────────────────────────────
if (Test-Path $LinkPath) {
  $item = Get-Item $LinkPath -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    [System.IO.Directory]::Delete($LinkPath, $false)
    Write-Host "[ok] removed link $LinkPath"
  } else {
    Write-Host "[!!] $LinkPath is a real directory, not a link - left untouched"
  }
} else {
  Write-Host '[--] link not present'
}

Write-Host ''
Write-Host 'Done. Restart dsh to unload the plugin.' -ForegroundColor Green
Write-Host ''
