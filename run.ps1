# Set up everything on first run, then open Autopane. Safe to re-run.
# Windows: the model runs on an NVIDIA GPU through PyTorch/CUDA if one is present,
# otherwise on CPU through llama.cpp.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Autopane needs $cmd on PATH: $hint" }
}
Need node 'install Node 20+ from https://nodejs.org'
Need git 'install git'
Need python 'install Python 3.10-3.12 from https://python.org'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning 'the claude CLI is not on PATH; planning will fail until it is (https://claude.com/claude-code)'
}

$py = 'engine\.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
  Write-Host 'Creating the model environment...'
  python -m venv engine\.venv
  & $py -m pip install -q -r engine\requirements.txt
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    # CUDA build of PyTorch instead of the CPU wheel pip picks by default.
    & $py -m pip install -q --force-reinstall torch==2.10.0 --index-url https://download.pytorch.org/whl/cu128
  } else {
    # Prebuilt CPU wheels, so no C++ compiler is needed.
    & $py -m pip install -q llama-cpp-python==0.3.35 --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
  }
}

$config = Join-Path $HOME '.autopane\config.json'
if (-not (Test-Path $config)) {
  Write-Host 'Downloading and preparing the decision model (one time)...'
  New-Item -ItemType Directory -Force (Split-Path $config) | Out-Null
  (& $py engine\prepare_model.py | Select-Object -Last 1) | Set-Content -Encoding utf8 $config
}

if (-not (Test-Path app\node_modules)) {
  Write-Host 'Installing the app...'
  Push-Location app; npm install --silent; Pop-Location
}

Push-Location app
npx electron . @args
Pop-Location
