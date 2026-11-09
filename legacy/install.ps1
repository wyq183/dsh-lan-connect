#!/usr/bin/env pwsh
<#
  dsh-lan-connect 安装脚本

  做三件事（都很轻，随时可回滚）：
    1. 在 profile 的 node_modules 下建一个 junction（目录联接）指向插件源码，
       不需要 pnpm install、不需要联网、不需要管理员权限。
    2. 备份 profile 的 cordis.patch.yml，然后把插件挂载条目追加进去。
    3. 打印后续步骤。

  回滚：跑 uninstall.ps1。

  参数（一般不用给，默认真实环境）：
    -Source      插件源码目录
    -ProfileDir  dsh web profile 目录
#>
param(
  [string]$Source = (Join-Path $env:USERPROFILE '.dsh\dsh-lan-connect'),
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web')
)

$ErrorActionPreference = 'Stop'

$ModulesDir = Join-Path $ProfileDir 'node_modules'
$LinkPath   = Join-Path $ModulesDir 'dsh-lan-connect'
$PatchFile  = Join-Path $ProfileDir 'cordis.patch.yml'
$Stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host ''
Write-Host 'dsh-lan-connect installer' -ForegroundColor Cyan
Write-Host '-------------------------'

# ── 1. 前置检查 ──────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Source 'lib\index.js'))) {
  throw "plugin source not found: $Source\lib\index.js"
}
if (-not (Test-Path $ProfileDir)) {
  throw "dsh web profile not found: $ProfileDir"
}
if (-not (Test-Path $PatchFile)) {
  throw "profile patch file not found: $PatchFile"
}
if (-not (Test-Path $ModulesDir)) {
  New-Item -ItemType Directory -Force -Path $ModulesDir | Out-Null
  Write-Host "[ok] created $ModulesDir"
}
Write-Host "[ok] source:  $Source"
Write-Host "[ok] profile: $ProfileDir"

# ── 2. junction ──────────────────────────────────────────────────────────────
if (Test-Path $LinkPath) {
  $existing = Get-Item $LinkPath -Force
  if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
    Write-Host "[--] link already exists; replacing"
    # 只删链接本身，绝不递归删目标
    [System.IO.Directory]::Delete($LinkPath, $false)
  } else {
    throw "$LinkPath exists and is a real directory, not a link. Remove it manually first."
  }
}
New-Item -ItemType Junction -Path $LinkPath -Target $Source | Out-Null
Write-Host "[ok] junction: $LinkPath -> $Source"

# ── 3. cordis.patch.yml ──────────────────────────────────────────────────────
Copy-Item $PatchFile "$PatchFile.bak-$Stamp" -Force
Write-Host "[ok] backup:  $PatchFile.bak-$Stamp"

$already = Select-String -Path $PatchFile -Pattern 'dsh-lan-connect' -SimpleMatch -Quiet
if ($already) {
  Write-Host '[--] patch entry already present; leaving it alone'
} else {
  $block = @'

# ── 局域网连接管理（dsh-lan-connect）────────────────────────────────────────
# 提供 /ext/lan-connect/ 管理页：局域网入口地址、二维码、在线设备、一键换锁。
# 卸载：跑 uninstall.ps1，或删掉下面这个 insert 块 + node_modules\dsh-lan-connect
#       联接，然后重启 dsh。
- insert:
    - id: lan-connect
      name: 'dsh-lan-connect'
'@
  Add-Content -Path $PatchFile -Value $block -Encoding UTF8
  Write-Host '[ok] patch entry appended'
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. The profile patch hot-reloads if this profile uses live patch reload;'
Write-Host '     otherwise restart dsh (stop the dsh web process, start it again).'
Write-Host '  2. Open  http://127.0.0.1:3080/ext/lan-connect/'
Write-Host '     or click the LAN entry in the sidebar.'
Write-Host ''
