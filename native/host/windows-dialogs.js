import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

// Under WSL the user is on Windows: dialogs are real Windows dialogs shown through WSL's
// Windows interop, so an authority change still needs a click on this computer.
const execFileAsync = promisify(execFile);
const POWERSHELL = 'powershell.exe';

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// The script travels base64-encoded, so no message text can break the command line.
function encoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// Windows PowerShell writes the OEM code page unless told otherwise, which garbles a
// non-ASCII user or folder name on its way into WSL.
const UTF8_OUTPUT = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ';

async function runPowerShell(script, { exec = execFileAsync, timeoutMs } = {}) {
  const { stdout } = await exec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(UTF8_OUTPUT + script)], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return stdout.trim();
}

const FORMS = 'Add-Type -AssemblyName System.Windows.Forms;';

export async function confirmOnWindows(message, { exec, timeoutMs } = {}) {
  const answer = await runPowerShell(
    `${FORMS} [System.Windows.Forms.MessageBox]::Show(${psString(message)}, 'DeepSeek WebMCP', 'OKCancel', 'Warning', 'Button2', [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)`,
    { exec, timeoutMs },
  ).catch(() => null);
  return answer === 'OK';
}

// Returns the chosen Windows path, or null when the user cancels.
export async function chooseFolderOnWindows(initialWindowsPath, { exec, timeoutMs } = {}) {
  const picked = await runPowerShell([
    FORMS,
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true };',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
    "$dialog.Description = 'Choose the folder DeepSeek WebMCP may read and change';",
    `$dialog.SelectedPath = ${psString(initialWindowsPath ?? '')};`,
    "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.SelectedPath }",
  ].join(' '), { exec, timeoutMs }).catch(() => '');
  return picked || null;
}

export function notifyOnWindows(message) {
  spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(
    `${FORMS} [System.Windows.Forms.MessageBox]::Show(${psString(message)}, 'DeepSeek WebMCP', 'OK', 'Information', 'Button1', [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly) | Out-Null`,
  )], { detached: true, stdio: 'ignore' }).unref();
}

export async function toWslPath(windowsPath, { exec = execFileAsync } = {}) {
  return (await exec('wslpath', ['-u', windowsPath], { encoding: 'utf8' })).stdout.trim();
}

export async function toWindowsPath(wslPath, { exec = execFileAsync } = {}) {
  return (await exec('wslpath', ['-w', wslPath], { encoding: 'utf8' })).stdout.trim();
}

// Windows folders a workspace may never be, contain, or sit inside (the same rule the
// WebMCP Setup applies): the user folder itself, AppData, Windows, ProgramData and the
// program folders. Returned as WSL paths.
// Tagged lines, so an unset variable cannot shift another folder into the profile slot.
export async function windowsProtectedFolders({ exec = execFileAsync } = {}) {
  const lines = (await runPowerShell(
    '"P=$env:USERPROFILE"; "O=$env:APPDATA"; "O=$env:LOCALAPPDATA"; "O=$env:SystemRoot"; "O=$env:ProgramData"; "O=$env:ProgramFiles"; "O=${env:ProgramFiles(x86)}"',
    { exec },
  )).split(/\r?\n/).map((line) => line.trim());
  const reportedProfile = lines.find((line) => line.startsWith('P='))?.slice(2);
  if (!reportedProfile) throw new Error('Windows did not report the user folder.');
  const reportedOthers = lines.filter((line) => line.startsWith('O=') && line.length > 2).map((line) => line.slice(2));
  const [profile, ...others] = await Promise.all([reportedProfile, ...reportedOthers].map(async (line) => {
    const mapped = await toWslPath(line, { exec });
    if (!mapped) throw new Error(`wslpath returned nothing for ${line}`);
    return mapped;
  }));
  return { profile, others };
}

// Removes the Windows side of an install: browser registrations and the relay folder.
export async function removeWindowsRegistration({ registryKeys, appFolder, exec = execFileAsync }) {
  for (const key of registryKeys) {
    await exec('reg.exe', ['delete', key, '/f'], { encoding: 'utf8' }).catch(() => {});
  }
  await runPowerShell(
    `$folder = Join-Path $env:LOCALAPPDATA ${psString(appFolder)}; if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }`,
    { exec },
  ).catch(() => {});
}
