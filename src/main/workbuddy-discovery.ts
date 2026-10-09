import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const execute = promisify(execFile);

// Read narrowly scoped Windows installation records and process paths. Never run commands from them.
const script = String.raw`
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$paths = [System.Collections.Generic.List[string]]::new()
Get-Process -Name WorkBuddy,WorkBuddyAI | ForEach-Object { if($_.Path){ $paths.Add($_.Path) } }
$appRoots=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')
foreach($root in $appRoots){ foreach($name in @('WorkBuddy.exe','WorkBuddyAI.exe')){ $key=Get-Item -LiteralPath ($root+'\'+$name); if($key){ $value=$key.GetValue(''); if($value){ $paths.Add([string]$value) } } } }
$uninstallRoots=@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
foreach($root in $uninstallRoots){ Get-ChildItem -LiteralPath $root | ForEach-Object {
  $item=Get-ItemProperty -LiteralPath $_.PSPath
  if($item.DisplayName -match '(?i)WorkBuddy'){
    if($item.InstallLocation){ foreach($name in @('WorkBuddy.exe','WorkBuddyAI.exe')){ $paths.Add((Join-Path $item.InstallLocation $name)) } }
    if($item.DisplayIcon -match '^\s*"?(.+?\.exe)"?(?:,\s*-?\d+)?\s*$'){ $paths.Add($Matches[1]) }
  }
} }
ConvertTo-Json -Compress -InputObject @($paths | Select-Object -Unique)
`;

export function parseWorkBuddyDiscovery(output: string): string[] {
  try {
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, ''));
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string' && p.length <= 32767).slice(0, 128)
      : [];
  } catch {
    return [];
  }
}

export async function discoverWorkBuddyWindows(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execute(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true, encoding: 'utf8' },
    );
    return parseWorkBuddyDiscovery(stdout);
  } catch {
    return [];
  }
}
