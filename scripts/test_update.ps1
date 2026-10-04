# SPDX-License-Identifier: MPL-2.0
# Offline Windows PowerShell 5.1 regression checks; no real browser or network.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Run these updater checks with Windows PowerShell 5.1.' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Updater = Join-Path $PSScriptRoot 'windows/Update-Orbit.ps1'
$PowerShellExe = Join-Path $PSHOME 'powershell.exe'
$Pin = '3f73c528a1ae5784ea5e1ee2c5ad3762507395f2'
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('orbit-updater-tests-' + [Guid]::NewGuid().ToString('N'))
$Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}
function Write-Utf8([string]$Path, [string]$Value) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}
function Digest([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Record([string]$Root, [string]$Relative) {
    $path = Join-Path $Root $Relative
    return [ordered]@{ path = $Relative; sha256 = Digest $path; size = (Get-Item -LiteralPath $path).Length }
}
function New-Fixture([string]$Name) {
    $case = Join-Path $TestRoot $Name
    $install = Join-Path $case 'Orbit installation with spaces'
    foreach ($relative in @('orbit.exe', 'xul.dll', 'gmp-clearkey/component.dll')) {
        Write-Utf8 (Join-Path $install $relative) ('unchanged native engine ' + $relative)
    }
    Write-Utf8 (Join-Path $install 'uninstall/helper.exe') 'original NSIS uninstall utility'
    Write-Utf8 (Join-Path $install 'application.ini') "[App]`r`nName=Orbit`r`nBuildID=old-build`r`n"
    Write-Utf8 (Join-Path $install 'platform.ini') "[Build]`r`nBuildID=keep-this-platform-id`r`n"
    Write-Utf8 (Join-Path $install 'omni.ja') 'old root archive'
    Write-Utf8 (Join-Path $install 'browser/omni.ja') 'old browser archive'
    Write-Utf8 (Join-Path $install 'profile/prefs.js') 'real user notes and preferences sentinel'
    Write-Utf8 (Join-Path $install 'profile/extensions/user-plugin.dll') 'profile content excluded from native engine fingerprint'
    Write-Utf8 (Join-Path $install 'Launch-Orbit.cmd') '@echo off'
    $engine = @(Record $install 'orbit.exe'; Record $install 'xul.dll'; Record $install 'gmp-clearkey/component.dll')
    return [pscustomobject]@{ case = $case; install = $install; engine = $engine; manifest = (Join-Path $case 'orbit-update.json'); archive = (Join-Path $case 'Orbit-UI-Update.zip') }
}
function New-Update($Fixture, [string]$Version = 'new', [hashtable]$Entries = $null) {
    $payload = Join-Path $Fixture.case ('payload-' + $Version)
    Write-Utf8 (Join-Path $payload 'omni.ja') ($Version + ' root UI archive')
    Write-Utf8 (Join-Path $payload 'browser/omni.ja') ($Version + ' browser UI archive')
    if ($null -eq $Entries) {
        $Entries = @{'omni.ja' = ($Version + ' root UI archive'); 'browser/omni.ja' = ($Version + ' browser UI archive')}
    }
    if (Test-Path -LiteralPath $Fixture.archive) { Remove-Item -LiteralPath $Fixture.archive }
    $zip = [IO.Compression.ZipFile]::Open($Fixture.archive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $Entries.Keys) {
            $entry = $zip.CreateEntry($name)
            $stream = $entry.Open()
            try { $bytes = [Text.Encoding]::UTF8.GetBytes($Entries[$name]); $stream.Write($bytes, 0, $bytes.Length) }
            finally { $stream.Dispose() }
        }
    }
    finally { $zip.Dispose() }
    $manifest = [ordered]@{
        schema_version = 1; platform = 'windows-x64'; revision = $Pin; artifact_revision = $Pin
        commit = ('a' * 40); engine_files = $Fixture.engine
        files = @(Record $payload 'omni.ja'; Record $payload 'browser/omni.ja')
        package = @{ name = 'Orbit-UI-Update.zip'; sha256 = Digest $Fixture.archive; size = (Get-Item -LiteralPath $Fixture.archive).Length }
    }
    Write-Utf8 $Fixture.manifest ($manifest | ConvertTo-Json -Depth 8)
    return $manifest
}
function Save-Manifest($Fixture, $Manifest) { Write-Utf8 $Fixture.manifest ($Manifest | ConvertTo-Json -Depth 8) }
function Invoke-Update($Fixture) {
    $output = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $Updater -InstallDirectory $Fixture.install -ManifestPath $Fixture.manifest -ArchivePath $Fixture.archive -NoLaunch 2>&1
    return [pscustomobject]@{ code = $LASTEXITCODE; output = ($output -join "`n") }
}
function Snapshot($Fixture) {
    $snapshot = @{}
    foreach ($relative in @('orbit.exe', 'xul.dll', 'gmp-clearkey/component.dll', 'uninstall/helper.exe', 'application.ini', 'platform.ini', 'omni.ja', 'browser/omni.ja', 'profile/prefs.js', 'profile/extensions/user-plugin.dll', 'orbit-ui-version.json', 'browser/.purgecaches')) {
        $path = Join-Path $Fixture.install $relative
        $snapshot[$relative] = if (Test-Path -LiteralPath $path) { Digest $path } else { $null }
    }
    return $snapshot
}
function Assert-Unchanged($Fixture, $Before, [string[]]$Except = @()) {
    $after = Snapshot $Fixture
    foreach ($relative in $Before.Keys) {
        if ($Except -notcontains $relative) { Assert-True ($Before[$relative] -eq $after[$relative]) "Unexpected change to $relative" }
    }
    $stages = @(Get-ChildItem -LiteralPath $Fixture.install -Force | Where-Object { $_.Name -like '.orbit-update-stage-*' -or $_.Name -eq '.orbit-update.lock' })
    Assert-True ($stages.Count -eq 0) 'Updater left temporary files or its lock behind.'
}
function Run-Case([string]$Name, [scriptblock]$Action) {
    $fixture = New-Fixture $Name
    try { & $Action $fixture; $script:Passed++; Write-Host "PASS $Name" }
    catch { throw "$Name failed: $($_.Exception.Message)" }
}

try {
    Run-Case 'updates-only-UI-and-retains-first-backup' {
        param($fixture)
        $manifest = New-Update $fixture
        Write-Utf8 (Join-Path $fixture.install 'uninstall/helper.exe') 'different NSIS utility from an older native package'
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -eq 0) $result.output
        Assert-Unchanged $fixture $before @('omni.ja', 'browser/omni.ja', 'orbit-ui-version.json', 'browser/.purgecaches')
        foreach ($file in $manifest.files) {
            Assert-True ((Digest (Join-Path $fixture.install $file.path)) -eq $file.sha256) 'New UI archive is missing.'
            Assert-True ((Digest (Join-Path $fixture.install ('.orbit-update-backup/files/' + $file.path))) -eq $before[$file.path]) 'Original UI backup is missing.'
        }
        Assert-True ((Get-Item -LiteralPath (Join-Path $fixture.install 'browser/.purgecaches')).Length -eq 0) 'Cache purge marker is missing.'
        $version = [IO.File]::ReadAllText((Join-Path $fixture.install 'orbit-ui-version.json')) | ConvertFrom-Json
        Assert-True ($version.commit -eq $manifest.commit) 'Applied source commit was not recorded.'
        $same = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -eq 0 -and $result.output -like '*already up to date*') $result.output
        Assert-Unchanged $fixture $same
        $second = New-Update $fixture 'second'
        $second.commit = 'b' * 40
        Save-Manifest $fixture $second
        $result = Invoke-Update $fixture
        Assert-True ($result.code -eq 0) $result.output
        foreach ($file in $second.files) {
            Assert-True ((Digest (Join-Path $fixture.install ('.orbit-update-backup/files/' + $file.path))) -eq $before[$file.path]) 'The first backup was overwritten.'
        }
    }
    Run-Case 'engine-mismatch-is-rejected' {
        param($fixture)
        $null = New-Update $fixture
        Write-Utf8 (Join-Path $fixture.install 'xul.dll') 'different engine'
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -ne 0) 'Mismatched engine was accepted.'
        Assert-Unchanged $fixture $before
    }
    Run-Case 'extra-engine-file-is-rejected' {
        param($fixture)
        $null = New-Update $fixture
        Write-Utf8 (Join-Path $fixture.install 'helper.exe') 'root-level helper is still a native binary'
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -ne 0) 'Incomplete engine fingerprint was accepted.'
        Assert-Unchanged $fixture $before
    }
    Run-Case 'uninstall-helper-cannot-enter-engine-manifest' {
        param($fixture)
        $manifest = New-Update $fixture
        $manifest.engine_files += Record $fixture.install 'uninstall/helper.exe'
        Save-Manifest $fixture $manifest
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -ne 0) 'NSIS uninstall helper was accepted into the engine fingerprint.'
        Assert-Unchanged $fixture $before
    }
    Run-Case 'ZIP-traversal-cannot-touch-profile' {
        param($fixture)
        $null = New-Update $fixture 'new' @{'omni.ja' = 'new root UI archive'; '../profile/prefs.js' = 'malicious replacement'}
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -ne 0) 'Traversal archive was accepted.'
        Assert-Unchanged $fixture $before
    }
    Run-Case 'inner-archive-hash-mismatch-is-rejected' {
        param($fixture)
        $null = New-Update $fixture 'new' @{'omni.ja' = 'tampered root archive'; 'browser/omni.ja' = 'new browser UI archive'}
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -ne 0) 'Wrong UI digest was accepted.'
        Assert-Unchanged $fixture $before
    }
    Run-Case 'corrupt-download-hash-is-rejected' {
        param($fixture)
        $null = New-Update $fixture
        [IO.File]::AppendAllText($fixture.archive, 'corrupt transfer')
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -ne 0) 'Corrupt ZIP was accepted.'
        Assert-Unchanged $fixture $before
    }
    Run-Case 'ZIP-symbolic-link-is-rejected' {
        param($fixture)
        $manifest = New-Update $fixture
        $zip = [IO.Compression.ZipFile]::Open($fixture.archive, [IO.Compression.ZipArchiveMode]::Update)
        # Signed 0xA1FF0000 stores the Unix symbolic-link mode in ZIP attributes.
        try { $zip.GetEntry('omni.ja').ExternalAttributes = -1577127936 }
        finally { $zip.Dispose() }
        $manifest.package.sha256 = Digest $fixture.archive
        $manifest.package.size = (Get-Item -LiteralPath $fixture.archive).Length
        Save-Manifest $fixture $manifest
        $before = Snapshot $fixture
        $result = Invoke-Update $fixture
        Assert-True ($result.code -ne 0) 'ZIP symbolic link was accepted.'
        Assert-Unchanged $fixture $before
    }
    Run-Case 'copy-failure-restores-previous-archives' {
        param($fixture)
        $null = New-Update $fixture
        Write-Utf8 (Join-Path $fixture.install 'browser/.purgecaches') 'existing marker sentinel'
        $before = Snapshot $fixture
        $locked = [IO.File]::Open((Join-Path $fixture.install 'browser/omni.ja'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $result = Invoke-Update $fixture
            Assert-True ($result.code -ne 0 -and $result.output -like '*previous files were restored*') $result.output
        }
        finally { $locked.Dispose() }
        Assert-Unchanged $fixture $before
    }
    Run-Case 'metadata-commit-failure-rolls-back-both-archives' {
        param($fixture)
        $null = New-Update $fixture
        Write-Utf8 (Join-Path $fixture.install 'orbit-ui-version.json') '{"old":"version sentinel"}'
        Write-Utf8 (Join-Path $fixture.install 'browser/.purgecaches') 'existing marker sentinel'
        $before = Snapshot $fixture
        $locked = [IO.File]::Open((Join-Path $fixture.install 'orbit-ui-version.json'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            $result = Invoke-Update $fixture
            Assert-True ($result.code -ne 0 -and $result.output -like '*previous files were restored*') $result.output
        }
        finally { $locked.Dispose() }
        Assert-Unchanged $fixture $before
    }
    Write-Host "$Passed offline updater checks passed."
}
finally { if (Test-Path -LiteralPath $TestRoot) { Remove-Item -LiteralPath $TestRoot -Recurse -Force } }
# Expected rejection cases run a child process with exit 1. Do not propagate
# that child result after every assertion passed.
exit 0
