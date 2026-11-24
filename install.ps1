param(
    [string]$DshInstallPath = '',
    [string]$DshHome = '',
    [string]$Profile = 'desktop',
    [string]$BackupRoot = '',
    [switch]$Verify,
    [switch]$Uninstall,
    [switch]$PurgeData,
    [switch]$Json
)
$ErrorActionPreference = 'Stop'

function Quote-WinArg {
    param([string]$Value)
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

$scriptPath = Join-Path $PSScriptRoot 'scripts\install.mjs'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Installer script missing: $scriptPath"
}

$nodeCmd = $null
$nodeOnPath = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($nodeOnPath) {
    try {
        $major = [int](& $nodeOnPath.Source -p "process.versions.node.split('.')[0]" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $major -ge 22) {
            $nodeCmd = $nodeOnPath.Source
        }
    } catch {}
}

$useElectronAsNode = $false
if (-not $nodeCmd) {
    $candidates = @()
    if ($DshInstallPath) { $candidates += (Join-Path $DshInstallPath 'DeepSeek Harness.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe') }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
            $nodeCmd = $c
            $useElectronAsNode = $true
            break
        }
    }
}

if (-not $nodeCmd) {
    throw 'Neither Node.js (>=22) nor DeepSeek Harness.exe was found. Pass -DshInstallPath "<DeepSeek Harness folder>" or install Node.js >=22.'
}

$cliArgs = @($scriptPath, '--profile', $Profile)
if ($DshInstallPath) { $cliArgs += @('--dsh-install-dir', $DshInstallPath) }
if ($DshHome) { $cliArgs += @('--dsh-home', $DshHome) }
if ($BackupRoot) { $cliArgs += @('--backup-root', $BackupRoot) }
if ($Verify) { $cliArgs += '--verify' }
if ($Uninstall) { $cliArgs += '--uninstall' }
if ($PurgeData) { $cliArgs += '--purge-data' }
if ($Json) { $cliArgs += '--json' }

if ($useElectronAsNode) {
    # DeepSeek Harness.exe uses the Windows GUI subsystem; redirect stdio via ProcessStartInfo
    # so PowerShell waits synchronously for completion and captures UTF-8 stdout/stderr cleanly.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeCmd
    $psi.Arguments = ($cliArgs | ForEach-Object { Quote-WinArg $_ }) -join ' '
    $psi.WorkingDirectory = $PSScriptRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $proc.WaitForExit()
    $outText = $stdoutTask.GetAwaiter().GetResult()
    $errText = $stderrTask.GetAwaiter().GetResult()
    if ($outText) { [Console]::Out.Write($outText) }
    if ($errText) { [Console]::Error.Write($errText) }
    exit $proc.ExitCode
} else {
    & $nodeCmd @cliArgs
    exit $LASTEXITCODE
}
