#Requires -Version 5.1
<#
.SYNOPSIS
    静默安装或覆盖更新 Paseo（Costben 补丁构建），不弹安装向导。

.DESCRIPTION
   从 Costben/paseo-statusbar-builds 的 Release 取 NSIS 安装包，用 latest.yml / beta.yml
   里的 sha512 校验，关掉正在运行的 Paseo，执行 `Paseo-Setup-*.exe /S`，回读版本确认，
   再重新启动。装上之后 App 自己的自动更新（app-update.yml 指向本仓库）会继续工作。

   重复运行安全：已装版本等于目标版本时直接跳过，除非加 -Force。
   如果已有安装落在 Program Files（按机器安装），脚本会自己用管理员权限重启一次。

.PARAMETER Repo
   发布安装包的仓库，默认 Costben/paseo-statusbar-builds。

.PARAMETER Channel
   latest（默认）或 beta，决定读 latest.yml 还是 beta.yml，也决定是否接受预发布 Release。

.PARAMETER Force
   即使已装版本相同也重新安装。

.PARAMETER NoLaunch
   装完不自动启动 Paseo。

.PARAMETER DryRun
   只下载与校验，不退出 App、不安装、不要求管理员权限。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Update-Paseo.ps1

.EXAMPLE
    .\Update-Paseo.ps1 -Force -DryRun
#>
[CmdletBinding()]
param(
    [string]$Repo = 'Costben/paseo-statusbar-builds',
    [ValidateSet('latest', 'beta')]
    [string]$Channel = 'latest',
    [switch]$Force,
    [switch]$NoLaunch,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$LogDir = Join-Path $env:LOCALAPPDATA 'PaseoUpdate'
$LogFile = Join-Path $LogDir 'update.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$DownloadDir = Join-Path $LogDir 'download'
New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null

function Write-Step {
    param([string]$Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal $identity
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-GitHubApi {
    param([string]$Url)
    $headers = @{ 'User-Agent' = 'paseo-update-script'; 'Accept' = 'application/vnd.github+json' }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
    Invoke-RestMethod -Uri $Url -Headers $headers -UseBasicParsing
}

# 0.16.0 / 0.16.0.0 / 0.16.0-beta.2 -> 可比较的字符串
function Get-NormalizedVersion {
    param([string]$Version)
    if (-not $Version) { return $null }
    $text = ([string]$Version).Trim()
    if ($text -match '^\d+\.\d+\.\d+') { $text = $Matches[0] } else { return $null }
    $nums = @($text.Split('.') | ForEach-Object { [int]$_ })
    while ($nums.Count -lt 4) { $nums += 0 }
    return ($nums -join '.')
}

function Get-RegistryEntries {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
            $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
            if ($null -eq $props) { continue }
            $nameProp = $props.PSObject.Properties['DisplayName']
            if ($null -eq $nameProp) { continue }
            if ([string]$nameProp.Value -notlike 'Paseo*') { continue }
            $props
        }
    }
}

function Get-DirFromUninstallString {
    param([string]$UninstallString)
    if (-not $UninstallString) { return $null }
    $match = [regex]::Match($UninstallString, '^\s*"([^"]+)"')
    if ($match.Success) { return (Split-Path -Parent $match.Groups[1].Value) }
    $first = ($UninstallString.Trim() -split '\s+')[0]
    if ($first) { return (Split-Path -Parent $first) }
    return $null
}

function Get-PaseoInstallDir {
    foreach ($props in Get-RegistryEntries) {
        foreach ($field in @('InstallLocation', 'InstallDir')) {
            $prop = $props.PSObject.Properties[$field]
            if ($null -eq $prop) { continue }
            $dir = [string]$prop.Value
            if ($dir -and (Test-Path (Join-Path $dir 'Paseo.exe'))) { return $dir }
        }
        $uninstallProp = $props.PSObject.Properties['UninstallString']
        if ($null -ne $uninstallProp) {
            $dir = Get-DirFromUninstallString ([string]$uninstallProp.Value)
            if ($dir -and (Test-Path (Join-Path $dir 'Paseo.exe'))) { return $dir }
        }
    }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'Paseo'),
        (Join-Path ${env:ProgramFiles(x86)} 'Paseo'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Paseo')
    )) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'Paseo.exe'))) { return $candidate }
    }
    return $null
}

function Test-PerMachineInstall {
    param([string]$Dir)
    if (-not $Dir) { return $false }
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    foreach ($root in $roots) {
        if ($Dir.TrimEnd('\').ToLowerInvariant().StartsWith($root.TrimEnd('\').ToLowerInvariant())) { return $true }
    }
    return $false
}

function Get-PaseoVersion {
    param([string]$Dir)
    if (-not $Dir) { return $null }
    $exe = Join-Path $Dir 'Paseo.exe'
    if (-not (Test-Path $exe)) { return $null }
    $info = (Get-Item $exe).VersionInfo
    foreach ($raw in @($info.ProductVersion, $info.FileVersion)) {
        $normalized = Get-NormalizedVersion ([string]$raw)
        if ($normalized) { return $normalized }
    }
    return $null
}

function Resolve-Release {
    $releases = Invoke-GitHubApi "https://api.github.com/repos/$Repo/releases?per_page=20"
    $wantPrerelease = ($Channel -eq 'beta')
    $candidates = @()
    foreach ($release in $releases) {
        if ($release.draft) { continue }
        if (-not $wantPrerelease -and $release.prerelease) { continue }
        $asset = $null
        foreach ($candidate in $release.assets) {
            if ($candidate.name -like 'Paseo-Setup-*-x64.exe') { $asset = $candidate; break }
        }
        if ($null -eq $asset) { continue }
        $published = [datetime]::MinValue
        [void][datetime]::TryParse([string]$release.published_at, [ref]$published)
        $candidates += [pscustomobject]@{
            Tag       = [string]$release.tag_name
            Published = $published
            AssetName = [string]$asset.name
        }
    }
    if ($candidates.Count -eq 0) {
        throw "在 $Repo 找不到带 Paseo-Setup-*-x64.exe 的 Release（Channel=$Channel）"
    }
    $candidates | Sort-Object Published -Descending | Select-Object -First 1
}

function Get-Manifest {
    param([string]$Tag)
    $name = if ($Channel -eq 'beta') { 'beta.yml' } else { 'latest.yml' }
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $url = "https://github.com/$Repo/releases/download/$Tag/$name" + "?ts=$stamp"
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -Headers @{ 'Cache-Control' = 'no-cache' }
    # GitHub 用 application/octet-stream 发 .yml，Windows PowerShell 5.1 会返回 byte[]
    if ($response.Content -is [byte[]]) {
        $text = [System.Text.Encoding]::UTF8.GetString($response.Content)
    } else {
        $text = [string]$response.Content
    }
    if ($text -notmatch 'version:') { throw "$name 内容不像更新清单：$url" }

    $version = [regex]::Match($text, '(?m)^version:\s*(\S+)\s*$').Groups[1].Value
    $path = [regex]::Match($text, '(?m)^path:\s*(\S+)\s*$').Groups[1].Value
    $sha = [regex]::Match($text, '(?m)^sha512:\s*(\S+)\s*$').Groups[1].Value
    if (-not $version) { throw "$name 里没有 version" }
    if (-not $sha) { throw "$name 里没有顶层 sha512" }
    [pscustomobject]@{ Version = $version; AssetName = $path; Sha512 = $sha }
}

function Get-Base64Sha512 {
    param([string]$Path)
    $hex = (Get-FileHash -Algorithm SHA512 -Path $Path).Hash
    $bytes = New-Object byte[] ([int]($hex.Length / 2))
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
    }
    [Convert]::ToBase64String($bytes)
}

function Save-Installer {
    param([string]$Tag, [string]$AssetName, [string]$ExpectSha)
    $target = Join-Path $DownloadDir $AssetName
    if (Test-Path $target) {
        if ((Get-Base64Sha512 $target) -eq $ExpectSha) {
            Write-Step "本地已有匹配安装包，跳过下载"
            return $target
        }
        Remove-Item $target -Force
    }
    Write-Step "下载 $AssetName"
    Invoke-WebRequest -Uri "https://github.com/$Repo/releases/download/$Tag/$AssetName" -OutFile $target -UseBasicParsing
    Unblock-File -Path $target -ErrorAction SilentlyContinue
    $actual = Get-Base64Sha512 $target
    if ($actual -ne $ExpectSha) {
        Remove-Item $target -Force -ErrorAction SilentlyContinue
        throw "sha512 不匹配：expect=$ExpectSha actual=$actual"
    }
    $size = [math]::Round((Get-Item $target).Length / 1MB, 1)
    Write-Step "sha512 匹配（$size MB）"
    return $target
}

function Stop-PaseoApp {
    param([int]$GraceSeconds = 10, [int]$KillSeconds = 30)
    $running = @(Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return }
    Write-Step "退出 Paseo（$($running.Count) 个进程）"
    foreach ($proc in $running) { try { [void]$proc.CloseMainWindow() } catch { } }
    $deadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $deadline -and @(Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue).Count -gt 0) {
        Start-Sleep -Milliseconds 400
    }
    $deadline = (Get-Date).AddSeconds($KillSeconds)
    while (@(Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue).Count -gt 0) {
        if ((Get-Date) -gt $deadline) {
            throw 'Paseo 退不掉（如果它以管理员身份运行，请先手动关掉）'
        }
        Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    Write-Step 'Paseo 已退出'
}

function Invoke-SilentInstall {
    param([string]$Installer)
    Write-Step "静默安装：$([System.IO.Path]::GetFileName($Installer)) /S"
    $proc = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        throw "安装器退出码 $($proc.ExitCode)（0 才是成功）"
    }
    Write-Step '安装器返回 0'
}

function Show-UpdateFeed {
    param([string]$Dir)
    if (-not $Dir) { return }
    $yml = Join-Path $Dir 'resources\app-update.yml'
    if (-not (Test-Path $yml)) {
        Write-Step '提醒：没找到 resources\app-update.yml，App 内自动更新可能不可用'
        return
    }
    $text = Get-Content -Path $yml -Raw -ErrorAction SilentlyContinue
    $owner = [regex]::Match([string]$text, 'owner:\s*(\S+)').Groups[1].Value
    $feedRepo = [regex]::Match([string]$text, 'repo:\s*(\S+)').Groups[1].Value
    if ($owner -and $feedRepo) {
        Write-Step "App 内自动更新源：$owner/$feedRepo"
        if ("$owner/$feedRepo" -ne $Repo) {
            Write-Step "提醒：更新源不是 $Repo，之后 App 会从 $owner/$feedRepo 拉更新（可能不带补丁）"
        }
    }
}

function Restart-Elevated {
    Write-Step '现有安装位于 Program Files（按机器安装），以管理员权限重新启动本脚本'
    $relay = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath),
               '-Repo', $Repo, '-Channel', $Channel)
    if ($Force) { $relay += '-Force' }
    if ($NoLaunch) { $relay += '-NoLaunch' }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $relay | Out-Null
    exit 0
}

try {
    Write-Step "=== 开始：Repo=$Repo Channel=$Channel Force=$([bool]$Force) DryRun=$([bool]$DryRun) Admin=$(Test-IsAdmin) ==="

    $installDir = Get-PaseoInstallDir
    $installedVersion = Get-PaseoVersion $installDir
    $perMachine = Test-PerMachineInstall $installDir
    Write-Step "当前安装：$(if ($installDir) { $installDir } else { '未安装' })  版本：$(if ($installedVersion) { $installedVersion } else { '无' })"

    $release = Resolve-Release
    Write-Step "目标 Release：$($release.Tag)  产物：$($release.AssetName)"
    $manifest = Get-Manifest -Tag $release.Tag
    $targetVersion = Get-NormalizedVersion $manifest.Version
    Write-Step "清单版本：$($manifest.Version)"

    $assetName = if ($manifest.AssetName) { $manifest.AssetName } else { $release.AssetName }

    if (-not $Force -and $installedVersion -and $installedVersion -eq $targetVersion) {
        Write-Step "=== 已是目标版本 $($manifest.Version)，跳过 ==="
        Show-UpdateFeed $installDir
        exit 0
    }

    if ($perMachine -and -not $DryRun -and -not (Test-IsAdmin)) {
        Restart-Elevated
    }

    $installer = Save-Installer -Tag $release.Tag -AssetName $assetName -ExpectSha $manifest.Sha512

    if ($DryRun) {
        Write-Step "=== DRY RUN 通过，未安装（安装包：$installer）==="
        exit 0
    }

    Stop-PaseoApp
    Invoke-SilentInstall -Installer $installer

    $afterDir = Get-PaseoInstallDir
    if (-not $afterDir) { $afterDir = $installDir }
    $afterVersion = Get-PaseoVersion $afterDir
    Write-Step "安装后：$(if ($afterDir) { $afterDir } else { '找不到目录' })  版本：$(if ($afterVersion) { $afterVersion } else { '读不到' })"
    if (-not $afterDir) { throw '安装后找不到 Paseo 安装目录' }
    if ($afterVersion -ne $targetVersion) {
        throw "版本没对上：期望 $($manifest.Version)，实际 $(if ($afterVersion) { $afterVersion } else { '读不到' })"
    }
    Show-UpdateFeed $afterDir

    if ($NoLaunch) {
        Write-Step '=== 完成：已更新，按要求不自动启动 ==='
        exit 0
    }
    Start-Process -FilePath (Join-Path $afterDir 'Paseo.exe') | Out-Null
    Start-Sleep -Seconds 8
    if (@(Get-Process -Name 'Paseo' -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-Step '=== 完成：已更新并启动 ==='
        exit 0
    }
    Write-Step '=== 已更新，但启动后没有进程，请手动打开 Paseo ==='
    exit 0
}
catch {
    Write-Step "失败：$($_.Exception.Message)"
    Write-Step "日志：$LogFile"
    exit 1
}
