param([Parameter(Mandatory=$true)][string]$PackageRoot, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
$packagePath = (Resolve-Path -LiteralPath $PackageRoot).Path
$executable = Join-Path $packagePath '程序/Class Manager.exe'
$launcher = Join-Path $packagePath '启动工作台.cmd'
if (!(Test-Path -LiteralPath $executable) -or !(Test-Path -LiteralPath $launcher)) { throw 'Launcher files missing' }
$probeRoot = Join-Path $Output ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
$env:CLASS_MANAGER_DATA_DIR = Join-Path $probeRoot '合成 数据'
$env:TEMP = $probeRoot
$env:TMP = $probeRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:PATH = Join-Path $env:SystemRoot 'System32'
$owned = @()
try {
  $arguments = '/d /s /c ""' + $launcher + '""'
  $runner = Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $packagePath -WindowStyle Hidden -PassThru
  if (!$runner.WaitForExit(10000)) { throw 'Launcher command did not return' }
  if ($runner.ExitCode -ne 0) { throw ('Launcher exit: ' + $runner.ExitCode) }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $owned = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable })
    $window = $owned | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    $database = @(Get-ChildItem -LiteralPath $env:CLASS_MANAGER_DATA_DIR -Filter '*.sqlite' -Recurse -ErrorAction SilentlyContinue)
    if ($window -and $database.Count) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (!$window -or !$database.Count) { throw 'Launcher did not open a window and isolated database' }
  if (!$window.CloseMainWindow()) { throw 'Cannot close test window' }
  if (!$window.WaitForExit(10000)) { throw 'Test application did not exit' }
  [pscustomobject]@{ status='passed'; launcher=$launcher; data=$env:CLASS_MANAGER_DATA_DIR; mainWindowOpened=$true; databaseCreated=$true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probeRoot 'report.json') -Encoding UTF8
  Write-Output 'Portable root launcher passed'
} finally {
  foreach ($process in $owned) {
    $remaining = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if ($remaining -and $remaining.Path -eq $executable) { Stop-Process -Id $remaining.Id }
  }
}
