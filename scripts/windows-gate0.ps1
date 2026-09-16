[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ThresholdSeconds = 30.0
$HostDeadlineSeconds = 35.0
$LatencyFileCount = 20000
$LatencyFilesPerLeaf = 100
$LatencyLeafDirectories = [int]($LatencyFileCount / $LatencyFilesPerLeaf)
$LatencyNestingDepth = 5
$Image = 'deepseek-webmcp-windows-gate0:local'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$FixtureRoot = $null
$HostGitConfig = $null
$PreviousGitConfigGlobal = $null
$Passed = $false
$DockerPath = $null

function Fail([string]$Message) {
  throw "Windows Gate 0 failed: $Message"
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  return (Invoke-CheckedStdout -FilePath $FilePath -Arguments $Arguments).stdout
}

# Native tools may write warnings to stderr even on success. Keep stderr separate
# anywhere stdout is parsed or compared so diagnostics cannot become data.
function Invoke-CheckedStdout {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int[]]$AllowedExitCodes = @(0)
  )

  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("deepseek-webmcp-gate0-{0}.stderr" -f [Guid]::NewGuid().ToString('N'))
  try {
    $stdout = & $FilePath @Arguments 2> $stderrPath
    $exitCode = $LASTEXITCODE
    $stdoutText = (($stdout | Out-String).TrimEnd())
    $stderr = if (Test-Path -LiteralPath $stderrPath) { [System.IO.File]::ReadAllText($stderrPath).Trim() } else { '' }
    if ($exitCode -notin $AllowedExitCodes) {
      $details = @(@($stdoutText, $stderr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      if ($details.Count -gt 0) { Fail "$FilePath exited with code $exitCode.`n$($details -join "`n")" }
      Fail "$FilePath exited with code $exitCode."
    }
    return [pscustomobject]@{
      stdout = $stdoutText
      stderr = $stderr
      exitCode = $exitCode
    }
  } finally {
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Format-MountField([string]$Value) {
  if ($Value.Contains(',') -or $Value.Contains('"')) {
    return '"' + $Value.Replace('"', '""') + '"'
  }
  return $Value
}

function New-WorkspaceMount([string]$Source) {
  $fields = @(
    'type=bind',
    "src=$Source",
    'dst=/workspace',
    'bind-recursive=disabled'
  ) | ForEach-Object { Format-MountField $_ }
  return ($fields -join ',')
}

function Invoke-GateContainer {
  param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string[]]$Command
  )

  $dockerArgs = @(
    'run', '--rm', '--pull', 'never',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65532:65532',
    '--env', 'HOME=/tmp',
    '--mount', (New-WorkspaceMount $Workspace),
    $Image
  ) + $Command
  return Invoke-CheckedStdout -FilePath $script:DockerPath -Arguments $dockerArgs
}

function Measure-ContainerCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string[]]$Command
  )

  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $result = Invoke-GateContainer -Workspace $Workspace -Command $Command
  $watch.Stop()
  return [pscustomobject]@{
    seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
    output = $result.stdout
    stderr = $result.stderr
  }
}

function Assert-NoLocalAutocrlf {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $result = Invoke-CheckedStdout -FilePath $script:GitPath -Arguments @('-C', $Path, 'config', '--local', '--get', 'core.autocrlf') -AllowedExitCodes @(0, 1)
  if ($result.exitCode -eq 0) {
    Fail "${Label}: core.autocrlf leaked into .git/config as '$($result.stdout)'; this would hide the Windows-global/container-default mismatch."
  }
  if ($result.exitCode -ne 1 -or -not [string]::IsNullOrWhiteSpace($result.stdout)) {
    Fail "${Label}: unable to prove that local core.autocrlf is absent (exit $($result.exitCode), stdout '$($result.stdout)', stderr '$($result.stderr)')."
  }
  # stderr here is diagnostic (Git's dubious-ownership warning, for example). Letting
  # it decide would disguise an ownership problem as a configuration failure.
  if (-not [string]::IsNullOrWhiteSpace($result.stderr)) {
    Write-Warning "${Label}: git config --local --get core.autocrlf wrote to stderr: $($result.stderr)"
  }
}

function New-WindowsGitClone {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Invoke-Checked -FilePath $script:GitPath -Arguments @('clone', '--no-local', '--', $ProjectRoot, $Path) | Out-Null
  Assert-NoLocalAutocrlf -Path $Path -Label $Label
}

function Test-PathAndCrlfRepository {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  New-WindowsGitClone -Path $Path -Label $Label

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $Path 'gate0-edit.txt'), "before`r`n", $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $Path 'gate0-delete.txt'), "delete me`r`n", $utf8NoBom)
  Invoke-Checked -FilePath $script:GitPath -Arguments @('-C', $Path, 'add', '--', 'gate0-edit.txt', 'gate0-delete.txt') | Out-Null
  Invoke-Checked -FilePath $script:GitPath -Arguments @('-C', $Path, '-c', 'user.name=DeepSeek WebMCP Gate 0', '-c', 'user.email=gate0@invalid.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'gate0 fixture') | Out-Null
  Assert-NoLocalAutocrlf -Path $Path -Label $Label

  $mutation = Invoke-GateContainer -Workspace $Path -Command @(
    'bash', '-lc',
    "set -euo pipefail; printf 'created by container\\n' > /workspace/gate0-created.txt; printf 'container edit\\n' >> /workspace/gate0-edit.txt; rm /workspace/gate0-delete.txt"
  )

  if (-not (Test-Path -LiteralPath (Join-Path $Path 'gate0-created.txt') -PathType Leaf)) {
    Fail "${Label}: a file created in the container was not visible on the Windows host."
  }
  $edited = [System.IO.File]::ReadAllText((Join-Path $Path 'gate0-edit.txt'))
  if (-not $edited.Contains('container edit')) {
    Fail "${Label}: a container edit was not visible on the Windows host."
  }
  if (Test-Path -LiteralPath (Join-Path $Path 'gate0-delete.txt')) {
    Fail "${Label}: a container delete was not visible on the Windows host."
  }

  # Reset with Windows Git while core.autocrlf=true exists only in its simulated
  # user-global config. Container Git sees neither that file nor a repo-local copy.
  Invoke-Checked -FilePath $script:GitPath -Arguments @('-C', $Path, 'reset', '--hard', 'HEAD') | Out-Null
  Invoke-Checked -FilePath $script:GitPath -Arguments @('-C', $Path, 'clean', '-fd') | Out-Null
  Assert-NoLocalAutocrlf -Path $Path -Label $Label

  # CRLF mismatch is recorded but does not gate Windows feasibility: its cause is
  # Git configuration scope, not Windows bind-mount behavior. Record direct EOL
  # evidence so a clean/dirty status is never the only basis for the conclusion.
  $gitStatus = Invoke-GateContainer -Workspace $Path -Command @('git', '-C', '/workspace', 'status', '--porcelain=v1', '--untracked-files=all')
  $eol = Invoke-GateContainer -Workspace $Path -Command @('git', '-C', '/workspace', 'ls-files', '--eol')

  return [pscustomobject]@{
    label = $Label
    path = $Path
    hostGlobalCoreAutocrlf = $true
    repoLocalCoreAutocrlf = $null
    hostVisibleCreateEditDelete = $true
    containerMutationStderr = $mutation.stderr
    crlfEvidenceGatesWindowsGate0 = $false
    containerGitStatusClean = [string]::IsNullOrWhiteSpace($gitStatus.stdout)
    containerGitStatusStdout = $gitStatus.stdout
    containerGitStatusStderr = $gitStatus.stderr
    containerLsFilesEol = $eol.stdout
    containerLsFilesEolStderr = $eol.stderr
  }
}

function New-LatencyRepository {
  param([Parameter(Mandatory = $true)][string]$Path)

  New-Item -ItemType Directory -Path $Path | Out-Null
  Invoke-Checked -FilePath $script:GitPath -Arguments @('init', '--', $Path) | Out-Null
  Assert-NoLocalAutocrlf -Path $Path -Label 'latency repository'

  Write-Host "Creating deterministic latency fixture: $LatencyFileCount tracked files across $LatencyLeafDirectories leaf directories. Windows Defender may make this step take several minutes."
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  for ($i = 0; $i -lt $LatencyFileCount; $i += 1) {
    $leaf = [int][Math]::Floor($i / $LatencyFilesPerLeaf)
    $g = [int][Math]::Floor($leaf / 50)
    $h = [int][Math]::Floor(($leaf % 50) / 10)
    $j = [int][Math]::Floor(($leaf % 10) / 2)
    $k = $leaf % 2
    $directory = Join-Path $Path ("tree\g{0:D2}\h{1:D2}\j{2:D2}\k{3:D2}" -f $g, $h, $j, $k)
    if (($i % $LatencyFilesPerLeaf) -eq 0) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $file = Join-Path $directory ("file-{0:D5}.txt" -f $i)
    $content = "gate0-file-{0:D5}-{1}" -f $i, ('x' * 96)
    [System.IO.File]::WriteAllText($file, $content, $utf8NoBom)
  }

  Invoke-Checked -FilePath $script:GitPath -Arguments @('-C', $Path, 'add', '--all') | Out-Null
  Invoke-Checked -FilePath $script:GitPath -Arguments @('-C', $Path, '-c', 'user.name=DeepSeek WebMCP Gate 0', '-c', 'user.email=gate0@invalid.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'deterministic 20000-file latency fixture') | Out-Null
  Assert-NoLocalAutocrlf -Path $Path -Label 'latency repository'

  $hostStatus = Invoke-Checked -FilePath $script:GitPath -Arguments @('-C', $Path, 'status', '--porcelain=v1', '--untracked-files=all')
  if (-not [string]::IsNullOrWhiteSpace($hostStatus)) {
    Fail "latency repository: Windows Git status is not clean before measurement.`n$hostStatus"
  }
}

function Test-LatencyRepository {
  param([Parameter(Mandatory = $true)][string]$Path)

  New-LatencyRepository -Path $Path

  # First traversal also verifies the fixture cardinality. It is not a cold-cache
  # number: creating the fixture, git add and git status just warmed both the host
  # and the Docker Desktop mount caches. Later timings are warmer still.
  $firstTraversal = Measure-ContainerCommand -Workspace $Path -Command @('bash', '-lc', 'rg --files /workspace | wc -l')
  $count = 0
  if (-not [int]::TryParse($firstTraversal.output.Trim(), [ref]$count) -or $count -ne $LatencyFileCount) {
    Fail "latency repository: expected $LatencyFileCount files from rg --files, got '$($firstTraversal.output)'."
  }
  if ($firstTraversal.seconds -gt $ThresholdSeconds) {
    Fail "latency repository: first-traversal wall-clock docker run + rg --files count took $($firstTraversal.seconds)s, above the existing ${ThresholdSeconds}s bash ceiling."
  }

  $gitStatus = Measure-ContainerCommand -Workspace $Path -Command @('git', '-C', '/workspace', 'status', '--porcelain=v1', '--untracked-files=all')
  if (-not [string]::IsNullOrWhiteSpace($gitStatus.output)) {
    Fail "latency repository: container git status is not clean before timing acceptance.`n$($gitStatus.output)"
  }
  if ($gitStatus.seconds -gt $ThresholdSeconds) {
    Fail "latency repository: wall-clock docker run + git status took $($gitStatus.seconds)s, above the existing ${ThresholdSeconds}s bash ceiling."
  }

  $ripgrep = Measure-ContainerCommand -Workspace $Path -Command @('bash', '-lc', 'rg --files /workspace > /dev/null')
  if ($ripgrep.seconds -gt $ThresholdSeconds) {
    Fail "latency repository: wall-clock docker run + rg --files took $($ripgrep.seconds)s, above the existing ${ThresholdSeconds}s bash ceiling."
  }

  return [pscustomobject]@{
    path = $Path
    trackedFileCount = $LatencyFileCount
    leafDirectories = $LatencyLeafDirectories
    nestingDepth = $LatencyNestingDepth
    approximateBytesPerFile = 113
    hostGlobalCoreAutocrlf = $true
    repoLocalCoreAutocrlf = $null
    firstContainerTraversalWallClockSeconds = $firstTraversal.seconds
    firstContainerTraversalStderr = $firstTraversal.stderr
    warmGitStatusWallClockSeconds = $gitStatus.seconds
    warmGitStatusStderr = $gitStatus.stderr
    warmRipgrepWallClockSeconds = $ripgrep.seconds
    warmRipgrepStderr = $ripgrep.stderr
  }
}

function Invoke-TestCase {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Body
  )

  try {
    $data = & $Body
    return [pscustomobject]@{ name = $Name; passed = $true; data = $data; error = $null }
  } catch {
    return [pscustomobject]@{ name = $Name; passed = $false; data = $null; error = $_.Exception.Message }
  }
}

if ($env:OS -ne 'Windows_NT') {
  Fail 'run this script from native Windows PowerShell/PowerShell, not WSL.'
}
if ($PSVersionTable.PSVersion.Major -lt 7) {
  Fail "PowerShell 7 or newer is required so Unicode native-process arguments are not confounded by Windows PowerShell 5.1. Current version: $($PSVersionTable.PSVersion)."
}
if (-not $env:USERPROFILE) { Fail 'USERPROFILE is unavailable.' }

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
if (-not $git) { Fail 'Windows Git is not installed or not on PATH.' }
$script:GitPath = $git.Source

$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $docker) { $docker = Get-Command docker -ErrorAction SilentlyContinue }
if (-not $docker) { Fail 'Docker CLI is not installed or not on PATH.' }
$script:DockerPath = $docker.Source

$FixtureRoot = Join-Path $env:USERPROFILE ("DeepSeek WebMCP Gate 0 {0}" -f ([Guid]::NewGuid().ToString('N').Substring(0, 8)))
$HostGitConfig = Join-Path $FixtureRoot 'windows-user.gitconfig'
$PreviousGitConfigGlobal = [Environment]::GetEnvironmentVariable('GIT_CONFIG_GLOBAL', 'Process')

try {
  # Capture the machine's real effective setting and its source before replacing
  # the user-global config with the controlled Gate 0 scenario.
  $realAutocrlf = Invoke-CheckedStdout -FilePath $script:GitPath -Arguments @('-C', $ProjectRoot, 'config', '--show-origin', '--get', 'core.autocrlf') -AllowedExitCodes @(0, 1)

  $dockerInfoResult = Invoke-CheckedStdout -FilePath $DockerPath -Arguments @('info', '--format', '{{json .}}')
  $dockerInfo = $dockerInfoResult.stdout | ConvertFrom-Json
  if ($dockerInfo.OSType -ne 'linux') {
    Fail "Docker daemon OSType is '$($dockerInfo.OSType)'; Gate 0 requires Linux containers."
  }

  $backendText = "$($dockerInfo.KernelVersion) $($dockerInfo.OperatingSystem)"
  if ($backendText -match '(?i)(wsl2|microsoft-standard-wsl)') {
    $backendFamily = 'wsl2'
  } elseif ($dockerInfo.KernelVersion) {
    $backendFamily = 'non-wsl2'
  } else {
    $backendFamily = 'unknown'
  }

  New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($HostGitConfig, "[core]`n    autocrlf = true`n", $utf8NoBom)
  $env:GIT_CONFIG_GLOBAL = $HostGitConfig
  $globalAutocrlf = Invoke-Checked -FilePath $script:GitPath -Arguments @('config', '--global', '--get', 'core.autocrlf')
  if ($globalAutocrlf.Trim().ToLowerInvariant() -ne 'true') {
    Fail 'the simulated Windows user-global Git config did not expose core.autocrlf=true.'
  }

  Write-Host "Building Gate 0 image from $ProjectRoot"
  & $DockerPath @(
    'build',
    '--build-arg', 'WEBMCP_NODE_IMAGE=node:22-bookworm-slim',
    '--build-arg', 'WEBMCP_SOURCE_SHA256=windows-gate0',
    '-f', (Join-Path $ProjectRoot 'native/Dockerfile'),
    '-t', $Image,
    $ProjectRoot
  )
  if ($LASTEXITCODE -ne 0) { Fail "docker build exited with code $LASTEXITCODE." }

  $probeRoot = Join-Path $FixtureRoot 'bind-recursive-probe'
  New-Item -ItemType Directory -Path $probeRoot | Out-Null
  try {
    $bindProbe = Invoke-GateContainer -Workspace $probeRoot -Command @('true')
  } catch {
    Fail "required bind-recursive=disabled mount probe failed before repository testing. Check Docker option support and Windows host-path sharing. $($_.Exception.Message)"
  }

  $spacePath = Join-Path $FixtureRoot 'repo with spaces'
  $unicodeCommaPath = Join-Path $FixtureRoot 'repo-中文,comma'
  $latencyPath = Join-Path $FixtureRoot 'latency repo 20000 files'

  $tests = @(
    Invoke-TestCase -Name 'space path bind/write + CRLF evidence' -Body { Test-PathAndCrlfRepository -Path $spacePath -Label 'space path' }
    Invoke-TestCase -Name 'Unicode/comma path bind/write + CRLF evidence' -Body { Test-PathAndCrlfRepository -Path $unicodeCommaPath -Label 'Unicode and comma path' }
    Invoke-TestCase -Name '20,000-file NTFS bind latency' -Body { Test-LatencyRepository -Path $latencyPath }
  )

  $Passed = @($tests | Where-Object { -not $_.passed }).Count -eq 0
  [pscustomobject]@{
    gate = 'Windows Gate 0'
    passed = $Passed
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    thresholdSeconds = $ThresholdSeconds
    hostDeadlineSeconds = $HostDeadlineSeconds
    timingBasis = 'wall-clock docker run; the first rg count is the first container traversal, already warm from fixture creation and git add, and later git status/rg timings are warmer still, so no cold-cache number is claimed; all include container startup because production pays the same startup cost under the 30s bash ceiling and 35s host deadline'
    gitModel = [pscustomobject]@{
      realMachineCoreAutocrlfDefined = ($realAutocrlf.exitCode -eq 0)
      realMachineCoreAutocrlfExitCode = $realAutocrlf.exitCode
      realMachineCoreAutocrlfShowOrigin = $realAutocrlf.stdout
      realMachineCoreAutocrlfStderr = $realAutocrlf.stderr
      simulatedHostGlobalCoreAutocrlf = $true
      repositoryLocalCoreAutocrlf = $null
      simulatedGlobalConfigPath = $HostGitConfig
      crlfEvidenceGatesWindowsGate0 = $false
      crlfDisposition = 'recorded for Phase 1 line-ending design; not a Windows/Docker feasibility criterion'
    }
    docker = [pscustomobject]@{
      serverVersion = $dockerInfo.ServerVersion
      osType = $dockerInfo.OSType
      operatingSystem = $dockerInfo.OperatingSystem
      kernelVersion = $dockerInfo.KernelVersion
      architecture = $dockerInfo.Architecture
      backendFamily = $backendFamily
      infoStderr = $dockerInfoResult.stderr
      bindRecursiveDisabledProbe = 'passed'
      bindRecursiveDisabledProbeStderr = $bindProbe.stderr
    }
    latencyFixture = [pscustomobject]@{
      trackedFileCount = $LatencyFileCount
      leafDirectories = $LatencyLeafDirectories
      nestingDepth = $LatencyNestingDepth
      filesPerLeaf = $LatencyFilesPerLeaf
    }
    tests = $tests
  } | ConvertTo-Json -Depth 8
} finally {
  if ($null -eq $PreviousGitConfigGlobal) {
    Remove-Item Env:GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
  } else {
    $env:GIT_CONFIG_GLOBAL = $PreviousGitConfigGlobal
  }

  if ($Passed) {
    if (Test-Path -LiteralPath $FixtureRoot) {
      Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
    }
    if ($script:DockerPath) {
      try {
        & $script:DockerPath image rm -f $Image *> $null
        if ($LASTEXITCODE -ne 0) { Write-Warning "Gate 0 passed, but cleanup could not remove image tag $Image." }
      } catch {
        Write-Warning "Gate 0 passed, but cleanup could not remove image tag $Image. $($_.Exception.Message)"
      }
    }
  } elseif ($FixtureRoot -and (Test-Path -LiteralPath $FixtureRoot)) {
    Write-Warning "Gate 0 fixtures and image were preserved for diagnosis: $FixtureRoot ; $Image"
  }
}

if (-not $Passed) { exit 1 }
