<#
.SYNOPSIS
  跑团笔记本（CoC · PL 模式）· 一键安装（Windows / PowerShell 5.1+）

.DESCRIPTION
  给 qq-bridge 的 AI 加上「跑团笔记本」：线索卡 / 角色卡 / 时间线 / NPC，
  并在群里用一句「打开跑团模式」把某个群切成跑团 preset（只当 PL，不当 KP）。

  三种跑法：
    .\install-trpg.ps1                                  # 当前目录就是 qq-bridge 仓库
    .\install-trpg.ps1 -Repo D:\my-qq-bridge            # 指定仓库
    .\install-trpg.ps1 -Repo D:\my-qq-bridge -Group 123456789   # 顺便开一个群的跑团白名单

.PARAMETER Repo
  qq-bridge 仓库根目录（含 src\bridge.js 的那层）。省略 = 当前目录。

.PARAMETER Check
  只自检锚点（版本兼容性），不修改 bridge.js / setup-dsh / preset 等既有文件。
  （模块文件仍会复制进去，这是 --check 的前提。）

.PARAMETER Node
  node.exe 完整路径。PATH 里没有 node 时用。

.PARAMETER Group
  跑团群号。给了就写进 config.json 的 allow.groups + trpg.allowedGroups。

.PARAMETER SkipTests
  装完不跑单元测试。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-trpg.ps1 -Repo D:\qq-bridge -Check
#>
param(
  [string]$Repo = '',
  [switch]$Check,
  [string]$Node = '',
  [string]$Group = '',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$pkgRoot = $PSScriptRoot

function Say($m, $color = 'Gray') { Write-Host $m -ForegroundColor $color }
function Fail($m) { Write-Host "`n✗ $m" -ForegroundColor Red; exit 1 }

# ── 1) node ──────────────────────────────────────────────────────────────
$nodeExe = $Node
if (-not $nodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source }
}
if (-not $nodeExe -or -not (Test-Path $nodeExe)) {
  Fail ("找不到 node.exe。请先装 Node.js >= 22.13，或用参数指定：`n" +
        "  .\install-trpg.ps1 -Node 'C:\Program Files\nodejs\node.exe'")
}
$verText = (& $nodeExe -v 2>&1).Trim()
Say "node  : $nodeExe ($verText)"
if ($verText -match '^v(\d+)\.(\d+)\.(\d+)') {
  $maj = [int]$Matches[1]; $min = [int]$Matches[2]
  if ($maj -lt 22 -or ($maj -eq 22 -and $min -lt 13)) { Fail "node 版本过低（$verText），需要 >= 22.13" }
}

# ── 2) 仓库 ──────────────────────────────────────────────────────────────
if (-not $Repo) { $Repo = (Get-Location).Path }
if (-not (Test-Path $Repo)) { Fail "仓库目录不存在：$Repo" }
$Repo = (Resolve-Path $Repo).Path
$bridge = Join-Path $Repo 'src\bridge.js'
if (-not (Test-Path $bridge)) { Fail "$Repo 里没有 src\bridge.js。请在 qq-bridge 仓库根目录运行，或用 -Repo 指定。" }
Say "仓库  : $Repo"

if (Test-Path (Join-Path $Repo 'package.json')) {
  try {
    $ver = (Get-Content (Join-Path $Repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    Say "版本  : qq-bridge $ver（锚点按 0.2.1-r1 编写）"
    if ($ver -ne '0.2.1-r1') {
      Say "  ⚠ 版本不是 0.2.1-r1：安装器会以「锚点不存在」安全退出，不会改坏文件。建议先 -Check。" 'Yellow'
    }
  } catch { }
}

# ── 3) 复制模块文件 ──────────────────────────────────────────────────────
Say "`n[1/3] 复制模块文件" 'Cyan'
$dstTrpg = Join-Path $Repo 'src\trpg'
$dstScripts = Join-Path $Repo 'scripts'
$dstPreset = Join-Path $Repo 'dsh\agent-presets\qq-chat-trpg'
New-Item -ItemType Directory -Force -Path $dstTrpg, $dstScripts, $dstPreset | Out-Null

$count = 0
foreach ($pair in @(
  @{ Src = Join-Path $pkgRoot 'src\trpg'; Dst = $dstTrpg },
  @{ Src = Join-Path $pkgRoot 'scripts'; Dst = $dstScripts },
  @{ Src = Join-Path $pkgRoot 'preset-src\qq-chat-trpg'; Dst = $dstPreset }
)) {
  if (-not (Test-Path $pair.Src)) { Fail "包不完整：缺 $($pair.Src)。请重新解压整个压缩包。" }
  Get-ChildItem $pair.Src -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $pair.Dst $_.Name) -Force
    Say ("  · " + ($pair.Dst.Replace($Repo + '\', '')) + '\' + $_.Name); $count++
  }
}
Say "  共复制 $count 个文件" 'Green'

# ── 4) 接线 ──────────────────────────────────────────────────────────────
$installer = Join-Path $Repo 'scripts\install-trpg.mjs'
if ($Check) {
  Say "`n[2/2] 锚点自检（--check，不改任何既有文件）" 'Cyan'
  Push-Location $Repo
  try { & $nodeExe $installer --check } finally { Pop-Location }
  exit $LASTEXITCODE
}

Say "`n[2/3] 接线（bridge.js 自动备份 + 语法检查）" 'Cyan'
Push-Location $Repo
try {
  if ($Group) { & $nodeExe $installer --group $Group }
  else { & $nodeExe $installer }
  if ($LASTEXITCODE -ne 0) { Fail "安装器退出码 $LASTEXITCODE（bridge.js 已被自动回滚）" }
} finally { Pop-Location }

# ── 5) 自检 ──────────────────────────────────────────────────────────────
if (-not $SkipTests) {
  Say "`n[3/3] 单元测试" 'Cyan'
  Push-Location $Repo
  try {
    & $nodeExe 'scripts\test-trpg-store.mjs'
    $a = $LASTEXITCODE
    if (Test-Path (Join-Path $Repo 'node_modules\@modelcontextprotocol\sdk')) {
      & $nodeExe 'scripts\test-trpg-mcp.mjs'
      $b = $LASTEXITCODE
    } else {
      Say '  （跳过 mcp 测试：仓库还没 npm install，缺 @modelcontextprotocol/sdk）' 'Yellow'
      $b = 0
    }
    if ($a -ne 0 -or $b -ne 0) { Say "`n⚠ 有测试没过，请把输出发出来。" 'Yellow' }
    else { Say "`n✓ 已跑的测试全部通过" 'Green' }
  } finally { Pop-Location }
}

Say "`n================ 装好了，还差四步 ================" 'Cyan'
Say "1) node scripts/build-agent-preset-patches.mjs     # 生成 qq-chat-trpg.patch.yml"
Say "2) node scripts/setup-dsh.mjs                      # 注册 mcp-trpg + 安装 preset"
Say "3) 重启 DSH                                        # 新 MCP / preset 要重启才生效"
Say "4) 重启桥接"
Say ""
Say "然后在跑团群里（管理员号）说一句「打开跑团模式」，会话会自动重建并带上 13 个跑团工具。"
Say "提示：开/关跑团模式都会重建会话，之前的上下文会丢（preset 算会话身份，这是设计如此）。"
Say "==================================================" 'Cyan'
