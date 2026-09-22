# Windows: set everything up on first run, then open Autopane. Safe to re-run.
# Double-click run.cmd, or from a terminal:
#   .\run.cmd                 set up if needed, then open the app
#   .\run.cmd --setup-only    set up and stop
# The model runs on an NVIDIA GPU through PyTorch/CUDA when one is present,
# otherwise on the CPU through llama.cpp.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$setupOnly = $args.Count -gt 0 -and $args[0] -eq '--setup-only'
$appArgs = if ($setupOnly) { @($args | Select-Object -Skip 1) } else { @($args) }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              (Join-Path $HOME '.local\bin')
}
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

# uv installs and manages its own Python, so no system Python is needed.
if (-not (Have uv)) {
  Write-Host 'Installing uv (Python manager)...'
  powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://astral.sh/uv/install.ps1 | iex'
  Refresh-Path
}
foreach ($tool in @(@('node', 'OpenJS.NodeJS.LTS'), @('git', 'Git.Git'))) {
  if (-not (Have $tool[0])) {
    if (-not (Have winget)) { throw "Autopane needs $($tool[0]); install it and run this again." }
    Write-Host "Installing $($tool[0])..."
    winget install --id $tool[1] -e --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
}
if (-not (Have claude)) {
  Write-Warning 'The claude CLI is not on PATH; install and sign in (https://claude.com/claude-code) before running a task.'
}

$py = 'engine\.venv\Scripts\python.exe'
if (-not (Test-Path 'engine\.venv\.ready')) {
  Write-Host 'Setting up the model runtime...'
  if (Test-Path 'engine\.venv') { Remove-Item -Recurse -Force 'engine\.venv' }
  uv venv -q --python 3.12 engine\.venv; Check 'uv venv'
  uv pip install -q --python $py -r engine\requirements.txt; Check 'installing the model runtime'
  if (Have nvidia-smi) {
    # CUDA build of PyTorch in place of the CPU wheel installed by default.
    uv pip install -q --python $py torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128 --reinstall-package torch
    Check 'installing PyTorch for CUDA'
  } else {
    # Prebuilt wheel, so no C++ compiler is needed.
    uv pip install -q --python $py 'https://github.com/abetlen/llama-cpp-python/releases/download/v0.3.35/llama_cpp_python-0.3.35-py3-none-win_amd64.whl'
    Check 'installing llama.cpp'
  }
  New-Item -ItemType File 'engine\.venv\.ready' | Out-Null
}

$config = Join-Path $HOME '.autopane\config.json'
if (-not ((Test-Path $config) -and (Get-Item $config).Length -gt 0)) {
  Write-Host 'Downloading the decision model (one time, a few GB)...'
  New-Item -ItemType Directory -Force (Split-Path $config) | Out-Null
  $line = & $py engine\prepare_model.py | Select-Object -Last 1
  Check 'downloading the model'
  [IO.File]::WriteAllText($config, $line)
}

if (-not (Test-Path 'app\node_modules\.ready')) {
  Write-Host 'Installing the app...'
  Push-Location app
  npm ci --silent; Check 'npm ci'
  New-Item -ItemType File 'node_modules\.ready' | Out-Null
  Pop-Location
}

if ($setupOnly) { Write-Host 'Setup complete.'; exit 0 }
Push-Location app
$electron = node -p "require('electron')"
& $electron . @appArgs
Pop-Location
