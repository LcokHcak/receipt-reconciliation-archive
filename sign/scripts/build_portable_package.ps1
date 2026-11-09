param(
  [string]$PackageName = "TicketWorkbenchPortable"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceRoot = Resolve-Path (Join-Path $repoRoot "..")
$distRoot = Join-Path $repoRoot "dist"
$packageRoot = Join-Path $distRoot $PackageName
$zipPath = Join-Path $distRoot "$PackageName.zip"

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $resolvedChild = [System.IO.Path]::GetFullPath($Child).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  if ($resolvedChild -ne $resolvedParent -and -not $resolvedChild.StartsWith("$resolvedParent$([System.IO.Path]::DirectorySeparatorChar)")) {
    throw "Refusing to operate outside ${resolvedParent}: ${resolvedChild}"
  }
}

function Copy-Directory {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$ExcludeDirectories = @(),
    [string[]]$ExcludeFiles = @()
  )
  if (-not (Test-Path $Source)) {
    return
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $xdArgs = @()
  foreach ($dir in $ExcludeDirectories) {
    $xdArgs += @("/XD", $dir, (Join-Path $Source $dir))
  }
  $xfArgs = @()
  foreach ($file in $ExcludeFiles) {
    $xfArgs += @("/XF", $file)
  }
  & robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP @xdArgs @xfArgs | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed for ${Source} -> ${Destination} with exit code ${LASTEXITCODE}"
  }
}

function Assert-RequiredPath {
  param(
    [string]$Path,
    [string]$Label
  )
  if (-not (Test-Path $Path)) {
    throw "Required ${Label} not found: ${Path}"
  }
}

function Read-VenvHome {
  param([string]$VenvConfigPath)
  $homeLine = Get-Content -LiteralPath $VenvConfigPath |
    Where-Object { $_ -match '^\s*home\s*=' } |
    Select-Object -First 1
  if (-not $homeLine) {
    throw "Could not find Python home in ${VenvConfigPath}"
  }
  return ($homeLine -replace '^\s*home\s*=\s*', '').Trim()
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
Assert-ChildPath -Parent $distRoot -Child $packageRoot
Assert-ChildPath -Parent $distRoot -Child $zipPath

if (Test-Path $packageRoot) {
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
  throw "Could not find the .NET Framework C# compiler."
}
& $csc `
  /nologo `
  /target:winexe `
  /platform:x64 `
  /reference:System.dll `
  /reference:System.Windows.Forms.dll `
  "/out:$(Join-Path $packageRoot "TicketWorkbench.exe")" `
  (Join-Path $repoRoot "launcher\TicketWorkbenchLauncher\Program.cs")

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeRuntimeDir = Join-Path $packageRoot "runtime\node"
New-Item -ItemType Directory -Force -Path $nodeRuntimeDir | Out-Null
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $nodeRuntimeDir "node.exe")

Assert-RequiredPath -Path (Join-Path $repoRoot "model") -Label "model directory"
Assert-RequiredPath -Path (Join-Path $repoRoot "paddleocr_standalone\.venv\Scripts\python.exe") -Label "PaddleOCR python runtime"
Assert-RequiredPath -Path (Join-Path $repoRoot "paddleocr_standalone\.venv\pyvenv.cfg") -Label "PaddleOCR venv config"
Assert-RequiredPath -Path (Join-Path $repoRoot "paddleocr_standalone\run_document_ocr_batch.py") -Label "PaddleOCR batch script"
Assert-RequiredPath -Path (Join-Path $sourceRoot "_pdx_runtime\Scripts\python.exe") -Label "PaddleX python runtime"
Assert-RequiredPath -Path (Join-Path $sourceRoot "_pdx_runtime\pyvenv.cfg") -Label "PaddleX venv config"
Assert-RequiredPath -Path (Join-Path $repoRoot "passport_review_workbench\templates\customer-receipt-template.xlsx") -Label "customer receipt template"

$pythonHome = Read-VenvHome -VenvConfigPath (Join-Path $repoRoot "paddleocr_standalone\.venv\pyvenv.cfg")
Assert-RequiredPath -Path (Join-Path $pythonHome "python.exe") -Label "base Python executable"
Assert-RequiredPath -Path (Join-Path $pythonHome "python310.dll") -Label "base Python DLL"

$pythonRuntimeDir = Join-Path $packageRoot "runtime\python310"
Copy-Directory `
  -Source $pythonHome `
  -Destination $pythonRuntimeDir `
  -ExcludeDirectories @("__pycache__", "tcl", "Tools", "Doc") `
  -ExcludeFiles @("*.pyc", "*.pyo")

$rootFiles = @(
  ".env.example",
  "package.json",
  "package-lock.json",
  "passport_review_workbench.js",
  "README.md"
)
foreach ($file in $rootFiles) {
  $source = Join-Path $repoRoot $file
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $packageRoot $file)
  }
}

$rootDirs = @(
  "jobs",
  "lib",
  "model",
  "repositories",
  "routes",
  "server",
  "services",
  "node_modules"
)
foreach ($dir in $rootDirs) {
  Copy-Directory -Source (Join-Path $repoRoot $dir) -Destination (Join-Path $packageRoot $dir)
}

Copy-Directory `
  -Source (Join-Path $repoRoot "paddleocr_standalone") `
  -Destination (Join-Path $packageRoot "paddleocr_standalone") `
  -ExcludeDirectories @("training", "output", "__pycache__")

Copy-Directory `
  -Source (Join-Path $sourceRoot "_pdx_runtime") `
  -Destination (Join-Path $packageRoot "_pdx_runtime") `
  -ExcludeDirectories @("infer_out", "__pycache__") `
  -ExcludeFiles @("eval_*.py", "inspect_one_prediction.py", "run_infer_test.py", "*summary*.json")

New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot "scripts") | Out-Null
Copy-Item `
  -LiteralPath (Join-Path $repoRoot "scripts\run_paddlex_model.py") `
  -Destination (Join-Path $packageRoot "scripts\run_paddlex_model.py")

$workbenchRoot = Join-Path $packageRoot "passport_review_workbench"
New-Item -ItemType Directory -Force -Path $workbenchRoot | Out-Null
Copy-Directory `
  -Source (Join-Path $repoRoot "passport_review_workbench\app") `
  -Destination (Join-Path $workbenchRoot "app") `
  -ExcludeFiles @(".*.png")
Copy-Directory `
  -Source (Join-Path $repoRoot "passport_review_workbench\templates") `
  -Destination (Join-Path $workbenchRoot "templates")

$storageRoot = Join-Path $workbenchRoot "storage"
@(
  $storageRoot,
  (Join-Path $storageRoot "batches"),
  (Join-Path $storageRoot "tmp_uploads"),
  (Join-Path $storageRoot "customer_library"),
  (Join-Path $packageRoot "logs")
) | ForEach-Object {
  New-Item -ItemType Directory -Force -Path $_ | Out-Null
}

Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -Force

Write-Host "Portable package created:"
Write-Host "  Folder: $packageRoot"
Write-Host "  Zip:    $zipPath"
