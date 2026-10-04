# SPDX-License-Identifier: MPL-2.0
# Updates the two UI archives of the pinned native Windows Orbit prototype.
[CmdletBinding()]
param(
    [string]$InstallDirectory = $PSScriptRoot,
    [string]$ManifestPath,
    [string]$ArchivePath,
    [switch]$NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PinnedRevision = '3f73c528a1ae5784ea5e1ee2c5ad3762507395f2'
$MaximumArchiveSize = 256MB
$MaximumManifestSize = 4MB
$UiPaths = @('omni.ja', 'browser/omni.ja')
$ReleaseEndpoint = 'https://api.github.com/repos/Marvinhaemke/orbit-browser/releases/tags/windows-prototype'
$DownloadPrefix = 'https://github.com/Marvinhaemke/orbit-browser/releases/download/windows-prototype/'

function Get-Property($Object, [string]$Name) {
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) {
        throw "Update manifest is missing $Name."
    }
    return $Object.PSObject.Properties[$Name].Value
}

function Assert-PlainPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Orbit updates do not follow symbolic links or junctions.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (!$parent -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Get-RelativePath([object]$Value) {
    if ($Value -isnot [string] -or
        $Value -notmatch '^(?:[A-Za-z0-9][A-Za-z0-9 ._-]*/)*[A-Za-z0-9][A-Za-z0-9 ._-]*$' -or
        $Value.Length -gt 220) {
        throw 'Update contains an invalid file path.'
    }
    foreach ($part in $Value.Split('/')) {
        if ($part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            throw 'Update contains an unsafe Windows file path.'
        }
    }
    if ($Value -match '^(profile|\.orbit[^/]*)(/|$)') {
        throw 'Update cannot address profiles or updater state.'
    }
    return $Value
}

function Get-Size([object]$Value, [long]$Maximum) {
    if (!($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -or
        $Value -lt 1 -or $Value -gt $Maximum -or [Math]::Floor([double]$Value) -ne $Value) {
        throw 'Update contains an invalid file size.'
    }
    return [long]$Value
}

function Get-Digest([object]$Value) {
    if ($Value -isnot [string] -or $Value -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'Update contains an invalid SHA256 digest.'
    }
    return $Value.ToLowerInvariant()
}

function Get-FileDigest([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Confirm-File([string]$Path, $Record) {
    Assert-PlainPath $Path
    $item = Get-Item -LiteralPath $Path -Force
    if ($item -isnot [IO.FileInfo] -or $item.Length -ne $Record.size -or
        (Get-FileDigest $Path) -ne $Record.sha256) {
        throw "File does not match the update: $($Record.path)"
    }
}

function Get-InstalledEnginePaths([string]$Root) {
    $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($Root)
    $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    while ($queue.Count) {
        $directory = $queue.Dequeue()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            $relative = $item.FullName.Substring($prefix.Length).Replace([IO.Path]::DirectorySeparatorChar, [char]47)
            if ($relative -match '^(profile|\.orbit-update-backup|\.orbit-update-stage-[^/]+)(/|$)') { continue }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Orbit updates do not follow symbolic links or junctions.'
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
            elseif ($item.Extension -match '^\.(exe|dll)$' -and $relative -ine 'uninstall/helper.exe') {
                # NSIS rebuilds this uninstall utility for each UI package.
                # It is preserved in place and is not part of the Gecko engine.
                [void]$paths.Add($relative)
            }
        }
    }
    return ,$paths
}

function Confirm-OrbitClosed([string]$Root) {
    $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    foreach ($process in Get-Process) {
        if ($process.ProcessName -ieq 'orbit') {
            throw 'Close all Orbit windows, then run Update-Orbit again.'
        }
        $executable = $null
        try { $executable = $process.Path } catch {}
        if ($executable -and $executable.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'An Orbit process is still running. Close Orbit, then run Update-Orbit again.'
        }
    }
}

function Receive-BoundedFile([string]$Url, [string]$Destination, [long]$Maximum) {
    if (!([Uri]$Url).IsAbsoluteUri -or ([Uri]$Url).Scheme -ne 'https') {
        throw 'Update downloads require HTTPS.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 45000
    $request.ReadWriteTimeout = 15000
    $request.MaximumAutomaticRedirections = 5
    $request.UserAgent = 'Orbit-Prototype-Updater'
    $request.Accept = 'application/vnd.github+json, application/octet-stream'
    $response = $null
    $inboundStream = $null
    $output = $null
    try {
        $response = $request.GetResponse()
        if ($response.ResponseUri.Scheme -ne 'https') { throw 'Update download did not remain on HTTPS.' }
        if ($response.ContentLength -gt $Maximum) { throw 'Update download is too large.' }
        $inboundStream = $response.GetResponseStream()
        $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        $total = 0L
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (($count = $inboundStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $count
            if ($total -gt $Maximum -or $timer.Elapsed.TotalSeconds -gt 120) {
                throw 'Update download exceeded its size or time limit.'
            }
            $output.Write($buffer, 0, $count)
        }
    }
    finally {
        if ($output) { $output.Dispose() }
        if ($inboundStream) { $inboundStream.Dispose() }
        if ($response) { $response.Close() }
    }
}

function Get-ReleaseAsset($Release, [string]$Name) {
    $assets = @(Get-Property $Release 'assets' | Where-Object { (Get-Property $_ 'name') -ceq $Name })
    if ($assets.Count -ne 1) { throw "The latest Orbit release is missing $Name." }
    $url = Get-Property $assets[0] 'browser_download_url'
    if ($url -cne ($DownloadPrefix + $Name)) { throw 'Unexpected GitHub update asset URL.' }
    return $url
}

function Read-UpdateManifest([string]$Path) {
    Assert-PlainPath $Path
    $item = Get-Item -LiteralPath $Path -Force
    if ($item -isnot [IO.FileInfo] -or $item.Length -gt $MaximumManifestSize) { throw 'Update manifest is too large.' }
    $manifest = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    if ((Get-Property $manifest 'schema_version') -ne 1 -or
        (Get-Property $manifest 'platform') -cne 'windows-x64' -or
        (Get-Property $manifest 'revision') -cne $PinnedRevision -or
        (Get-Property $manifest 'artifact_revision') -cne $PinnedRevision) {
        throw 'This update requires a different native engine. Download the complete Orbit build.'
    }
    $commit = Get-Property $manifest 'commit'
    if ($commit -isnot [string] -or $commit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Invalid update source commit.' }
    $package = Get-Property $manifest 'package'
    if ((Get-Property $package 'name') -cne 'Orbit-UI-Update.zip') { throw 'Unexpected update archive name.' }
    $packageRecord = [pscustomobject]@{
        path = 'Orbit-UI-Update.zip'
        sha256 = Get-Digest (Get-Property $package 'sha256')
        size = Get-Size (Get-Property $package 'size') $MaximumArchiveSize
    }
    $files = Get-Property $manifest 'files'
    $engine = Get-Property $manifest 'engine_files'
    if ($files -isnot [array] -or $files.Count -ne 2 -or
        $engine -isnot [array] -or $engine.Count -lt 2 -or $engine.Count -gt 2048) {
        throw 'Invalid update file list.'
    }
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $records = @()
    foreach ($file in $files) {
        $path = Get-RelativePath (Get-Property $file 'path')
        if ($UiPaths -cnotcontains $path -or !$names.Add($path)) { throw 'Update must contain exactly the two Orbit UI archives.' }
        $records += [pscustomobject]@{ path = $path; size = Get-Size (Get-Property $file 'size') 256MB; sha256 = Get-Digest (Get-Property $file 'sha256') }
    }
    $names.Clear()
    $engineRecords = @()
    foreach ($file in $engine) {
        $path = Get-RelativePath (Get-Property $file 'path')
        if ($path -notmatch '\.(exe|dll)$' -or $path -ieq 'uninstall/helper.exe' -or !$names.Add($path)) {
            throw 'Invalid native engine file list.'
        }
        $engineRecords += [pscustomobject]@{ path = $path; size = Get-Size (Get-Property $file 'size') 1GB; sha256 = Get-Digest (Get-Property $file 'sha256') }
    }
    if (!$names.Contains('orbit.exe') -or !$names.Contains('xul.dll')) { throw 'Update is missing its native engine fingerprint.' }
    return [pscustomobject]@{ manifest = $manifest; files = $records; engine = $engineRecords; package = $packageRecord; enginePaths = $names }
}

function Expand-ValidatedUiArchive([string]$Path, [string]$Destination, $Records) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        if ($archive.Entries.Count -ne 2) { throw 'Update archive must contain exactly two files.' }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $name = Get-RelativePath $entry.FullName
            if ($UiPaths -cnotcontains $name -or !$seen.Add($name) -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or
                ($entry.ExternalAttributes -band 0x400) -ne 0) {
                throw 'Update archive contains an unexpected entry or symbolic link.'
            }
            $record = @($Records | Where-Object { $_.path -ceq $name })[0]
            if ($entry.Length -ne $record.size) { throw 'Update archive entry size does not match its manifest.' }
            $target = Join-Path $Destination $name
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $stream = $entry.Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] 65536
                $total = 0L
                while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt $record.size) { throw 'Update archive entry exceeds its manifest size.' }
                    $output.Write($buffer, 0, $count)
                }
            }
            finally { $output.Dispose(); $stream.Dispose() }
            Confirm-File $target $record
        }
    }
    finally { $archive.Dispose() }
}

function Restore-Transaction([string]$Root, [string]$Originals, $Tracked) {
    $errors = @()
    foreach ($relative in $Tracked.Keys) {
        $target = Join-Path $Root $relative
        try {
            Assert-PlainPath $target
            if ($Tracked[$relative]) {
                $source = Join-Path $Originals $relative
                # Locked, unchanged files require no write during rollback.
                if (!(Test-Path -LiteralPath $target) -or (Get-FileDigest $target) -ne (Get-FileDigest $source)) {
                    [IO.File]::Copy($source, $target, $true)
                }
            }
            elseif (Test-Path -LiteralPath $target) { [IO.File]::Delete($target) }
        }
        catch { $errors += $relative }
    }
    if ($errors.Count) { throw "Rollback could not restore $($errors -join ', '). Keep the staged originals for recovery." }
}

$stage = $null
$lock = $null
$lockPath = $null
$preserveStage = $false
$success = $false
$root = $null
try {
    if ([bool]$ManifestPath -ne [bool]$ArchivePath) { throw 'Use both -ManifestPath and -ArchivePath for a local update.' }
    $offline = [bool]$ManifestPath
    $resolved = Resolve-Path -LiteralPath $InstallDirectory
    if ($resolved.Provider.Name -ne 'FileSystem') { throw 'Choose the extracted Orbit folder.' }
    $root = $resolved.ProviderPath
    if ($root.Length -gt [IO.Path]::GetPathRoot($root).Length) {
        $root = $root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    }
    Assert-PlainPath $root
    $appIni = Join-Path $root 'application.ini'
    Assert-PlainPath $appIni
    if (!(Test-Path -LiteralPath (Join-Path $root 'orbit.exe')) -or
        !([IO.File]::ReadAllText($appIni) -match '(?im)^Name=Orbit\s*$')) { throw 'Run Update-Orbit from the extracted native Orbit folder.' }
    if (!$NoLaunch -and !(Test-Path -LiteralPath (Join-Path $root 'Launch-Orbit.cmd'))) { throw 'The Orbit launcher is missing. Extract the complete Orbit download.' }
    $pinFile = Join-Path $root 'firefox-source.json'
    if (Test-Path -LiteralPath $pinFile) {
        Assert-PlainPath $pinFile
        $pin = [IO.File]::ReadAllText($pinFile) | ConvertFrom-Json
        if ((Get-Property $pin 'revision') -cne $PinnedRevision -or (Get-Property $pin 'artifact_revision') -cne $PinnedRevision) {
            throw 'This Orbit installation uses a different engine. Download the complete new build.'
        }
    }
    Confirm-OrbitClosed $root
    $lockPath = Join-Path $root '.orbit-update.lock'
    Assert-PlainPath $lockPath
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stage = Join-Path $root ('.orbit-update-stage-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($stage)
    if (!$ManifestPath) {
        Write-Host 'Checking the latest Orbit prototype...'
        $releasePath = Join-Path $stage 'release.json'
        Receive-BoundedFile $ReleaseEndpoint $releasePath 1MB
        $release = [IO.File]::ReadAllText($releasePath) | ConvertFrom-Json
        $ManifestPath = Join-Path $stage 'orbit-update.json'
        $ArchivePath = Join-Path $stage 'Orbit-UI-Update.zip'
        Receive-BoundedFile (Get-ReleaseAsset $release 'orbit-update.json') $ManifestPath $MaximumManifestSize
    }
    $update = Read-UpdateManifest $ManifestPath
    $installedPaths = Get-InstalledEnginePaths $root
    if (!$installedPaths.SetEquals($update.enginePaths)) { throw 'Native engine files differ. Download the complete Orbit build.' }
    foreach ($engine in $update.engine) { Confirm-File (Join-Path $root $engine.path) $engine }
    foreach ($file in $update.files) { Assert-PlainPath (Join-Path $root $file.path) }
    $current = $true
    foreach ($file in $update.files) {
        $target = Get-Item -LiteralPath (Join-Path $root $file.path)
        if ($target.Length -ne $file.size -or (Get-FileDigest $target.FullName) -ne $file.sha256) { $current = $false }
    }
    # A normal online check does not download an archive that is already installed.
    # Explicit local inputs remain fully verified, including already-current tests.
    if (!$current -or $offline) {
        if (!(Test-Path -LiteralPath $ArchivePath)) {
            if ($offline) { throw 'Local update archive is missing.' }
            Receive-BoundedFile (Get-ReleaseAsset $release 'Orbit-UI-Update.zip') $ArchivePath $update.package.size
        }
        Confirm-File $ArchivePath $update.package
        $payload = Join-Path $stage 'payload'
        Expand-ValidatedUiArchive $ArchivePath $payload $update.files
    }
    Confirm-OrbitClosed $root
    if ($current) { Write-Host 'Orbit is already up to date.' }
    else {
        $originals = Join-Path $stage 'originals'
        $tracked = @{}
        foreach ($relative in @('omni.ja', 'browser/omni.ja', 'orbit-ui-version.json', 'browser/.purgecaches')) {
            $target = Join-Path $root $relative
            Assert-PlainPath $target
            $tracked[$relative] = Test-Path -LiteralPath $target
            if ($tracked[$relative]) {
                $copy = Join-Path $originals $relative
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($copy))
                [IO.File]::Copy($target, $copy, $false)
            }
        }
        $backup = Join-Path $root '.orbit-update-backup'
        Assert-PlainPath $backup
        if (!(Test-Path -LiteralPath $backup)) {
            $baseline = Join-Path $stage 'baseline'
            foreach ($relative in $UiPaths) {
                $copy = Join-Path (Join-Path $baseline 'files') $relative
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($copy))
                [IO.File]::Copy((Join-Path $originals $relative), $copy, $false)
            }
            [IO.Directory]::Move($baseline, $backup)
        }
        else {
            foreach ($relative in $UiPaths) {
                $copy = Join-Path (Join-Path $backup 'files') $relative
                Assert-PlainPath $copy
                if (!(Test-Path -LiteralPath $copy -PathType Leaf)) { throw 'The existing Orbit backup is incomplete. Keep it and use a fresh full download.' }
            }
        }
        $version = [ordered]@{
            schema_version = 1; platform = 'windows-x64'; revision = $PinnedRevision; artifact_revision = $PinnedRevision
            commit = $update.manifest.commit; package_sha256 = $update.package.sha256; applied_utc = [DateTime]::UtcNow.ToString('o')
        }
        $versionPath = Join-Path $stage 'orbit-ui-version.json'
        [IO.File]::WriteAllText($versionPath, ($version | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        try {
            foreach ($file in $update.files) { [IO.File]::Copy((Join-Path $payload $file.path), (Join-Path $root $file.path), $true) }
            foreach ($file in $update.files) { Confirm-File (Join-Path $root $file.path) $file }
            [IO.File]::Copy($versionPath, (Join-Path $root 'orbit-ui-version.json'), $true)
            # Firefox's appDataPath is browser, so this marker is intentionally there.
            [IO.File]::WriteAllBytes((Join-Path $root 'browser/.purgecaches'), (New-Object byte[] 0))
        }
        catch {
            $failure = $_.Exception.Message
            try { Restore-Transaction $root $originals $tracked }
            catch { $preserveStage = $true; throw "$failure Rollback requires recovery from $originals. $($_.Exception.Message)" }
            throw "Update was not applied; the previous files were restored. $failure"
        }
        Write-Host 'Orbit updated. Your profile and native engine were preserved.'
    }
    $success = $true
}
catch { Write-Host "Orbit update stopped: $($_.Exception.Message)" }
finally {
    if ($stage -and !$preserveStage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if ($lock) { $lock.Dispose(); if ($lockPath -and (Test-Path -LiteralPath $lockPath)) { [IO.File]::Delete($lockPath) } }
}
if (!$success) { exit 1 }
if (!$NoLaunch) {
    try {
        & (Join-Path $root 'Launch-Orbit.cmd') '-purgecaches'
        if ($LASTEXITCODE -ne 0) { throw 'Launcher returned an error.' }
    }
    catch { Write-Host 'The update is installed. Start Orbit with Launch-Orbit.cmd.' }
}
exit 0
