#!/usr/bin/env pwsh
<#
  一次性设置 dsh-lan-connect 的访问账号密码。

  原理：门禁的 /__gate/login 端点排在"本机免登录"之前处理，
  所以直接调它就能完成首次设置——**不需要重启 dsh**。

  只在"尚未设置过账号"时有效。已经设过的话，本脚本会告诉你怎么办。

  用法：
    pwsh -File set-password.ps1
    pwsh -File set-password.ps1 -User yerke        # 账号名也可以直接给
    pwsh -File set-password.ps1 -Port 3099         # 换了门禁端口时
#>
param(
  [string]$User = '',
  [int]$Port = 3099
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host 'dsh-lan-connect 设置访问密码' -ForegroundColor Cyan
Write-Host '------------------------------'

# ── 1. 门禁在不在 ────────────────────────────────────────────────────────────
$state = $null
try {
  $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__gate/state" -TimeoutSec 8
} catch {
  Write-Host "连不上门禁端口 $Port —— 说明门禁还没启动。" -ForegroundColor Yellow
  Write-Host '先重启 dsh（host 端代码改动要重启才生效），再跑一次本脚本。'
  return
}

# ── 2. 有没有设过 ────────────────────────────────────────────────────────────
if ($state.needsSetup -ne $true) {
  Write-Host '这台 dsh 已经设置过访问密码了，本脚本不覆盖。' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '要改密码，二选一：'
  Write-Host "  1. 删掉 $env:USERPROFILE\.dsh\lan-connect\access.json 然后重启 dsh"
  Write-Host "  2. 重启后打开 http://127.0.0.1:$Port/ 用页面重设（新版已支持）"
  return
}

# ── 3. 收账号密码 ────────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($User)) {
  $User = Read-Host '账号'
}
if ([string]::IsNullOrWhiteSpace($User)) { throw '账号不能为空' }

$secure = Read-Host '密码（至少 6 位，输入时不显示）' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $secure).Password
if ($plain.Length -lt 6) { throw '密码至少 6 位' }

# ── 4. 提交 ──────────────────────────────────────────────────────────────────
# 显式 UTF-8 + 手工 urlencode 后发字节：PowerShell 5.1 对字符串 body 会按
# ASCII 编码，中文账号到了服务端会变乱码。
$body = 'user=' + [System.Uri]::EscapeDataString($User) +
        '&password=' + [System.Uri]::EscapeDataString($plain)
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)

try {
  $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__gate/login" `
    -Method POST -Body $bodyBytes `
    -ContentType 'application/x-www-form-urlencoded; charset=utf-8' -TimeoutSec 20
} catch {
  Write-Host ('设置失败：' + $_.Exception.Message) -ForegroundColor Red
  return
}

if ($resp.ok) {
  Write-Host ''
  Write-Host "设置成功，账号：$User" -ForegroundColor Green
  Write-Host ''
  Write-Host '接下来：'
  Write-Host "  · 手机重新扫二维码（若二维码已过期，刷新管理页换一张）"
  Write-Host "  · 其他电脑打开 http://<本机IP>:$Port/ 输这个账号密码"
  Write-Host "  · 登录状态保持 7 天，到期后重新输入"
  Write-Host ''
  Write-Host '已经登录的设备可以在管理页「访问门禁」里看到，并能单独撤销。'
} else {
  Write-Host ('失败：' + $resp.error) -ForegroundColor Red
}
