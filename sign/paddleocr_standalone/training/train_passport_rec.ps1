param(
    [string]$DatasetRoot = "D:\JIN HAIMIN\self\ticket\sign\passport",
    [string]$LabelFile = "D:\JIN HAIMIN\self\ticket\sign\passport\20260402\Label.txt",
    [string]$SplitRatio = "8:1:1",
    [int]$Seed = 20260402
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $projectRoot ".venv\Scripts\python.exe"
$prepareScript = Join-Path $PSScriptRoot "prepare_passport_rec_dataset.py"
$evalScript = Join-Path $PSScriptRoot "eval_passport_rec.py"
$configPath = Join-Path $PSScriptRoot "passport_rec_cpu.yml"
$dictPath = Join-Path $projectRoot ".venv\Lib\site-packages\paddleocr\ppocr\utils\ppocr_keys_v1.txt"

$dataDir = Join-Path $PSScriptRoot "data\passport_rec_dataset"
$outputDir = Join-Path $PSScriptRoot "output\passport_rec_cpu"
$vendorDir = Join-Path $PSScriptRoot "vendor"
$paddleRepoRoot = Join-Path $vendorDir "PaddleOCR-v2.9.1"
$trainScript = Join-Path $paddleRepoRoot "tools\train.py"
$exportScript = Join-Path $paddleRepoRoot "tools\export_model.py"
$paddlePackageRoot = $paddleRepoRoot
$paddleRepoUrl = "https://github.com/PaddlePaddle/PaddleOCR.git"
$paddleRepoTag = "v2.9.1"
$pretrainedDir = Join-Path $PSScriptRoot "pretrained"
$pretrainedTar = Join-Path $pretrainedDir "ch_ppocr_mobile_v2.0_rec_pre.tar"
$pretrainedUrl = "https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/ch_ppocr_mobile_v2.0_rec_pre.tar"
$baselineEvalPath = Join-Path $outputDir "baseline_eval.json"
$finetunedEvalPath = Join-Path $outputDir "finetuned_eval.json"
$runSummaryPath = Join-Path $outputDir "run_summary.json"
$inferenceDir = Join-Path $outputDir "inference"
$bestModelPrefix = Join-Path $outputDir "best_accuracy"

function Require-Path([string]$PathValue, [string]$Label) {
    if (-not (Test-Path $PathValue)) {
        throw "$Label not found: $PathValue"
    }
}

function Resolve-PretrainedPrefix {
    New-Item -ItemType Directory -Force -Path $pretrainedDir | Out-Null

    if (-not (Test-Path $pretrainedTar)) {
        Write-Host "Downloading pretrained rec weights..."
        Invoke-WebRequest -Uri $pretrainedUrl -OutFile $pretrainedTar
    }

    $existingParams = Get-ChildItem -Path $pretrainedDir -Recurse -Filter "*.pdparams" |
        Select-Object -First 1

    if (-not $existingParams) {
        Write-Host "Extracting pretrained rec weights..."
        tar -xf $pretrainedTar -C $pretrainedDir
        $existingParams = Get-ChildItem -Path $pretrainedDir -Recurse -Filter "*.pdparams" |
            Select-Object -First 1
    }

    if (-not $existingParams) {
        throw "Unable to locate pretrained .pdparams under $pretrainedDir"
    }

    return [System.IO.Path]::Combine(
        $existingParams.DirectoryName,
        [System.IO.Path]::GetFileNameWithoutExtension($existingParams.Name)
    )
}

function Ensure-PaddleSource {
    New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
    if (-not (Test-Path $paddleRepoRoot)) {
        Write-Host "Cloning PaddleOCR source $paddleRepoTag ..."
        git clone --depth 1 --branch $paddleRepoTag $paddleRepoUrl $paddleRepoRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to clone PaddleOCR source from $paddleRepoUrl"
        }
    }
}

Require-Path $pythonExe "Python"
Require-Path $prepareScript "Dataset prepare script"
Require-Path $evalScript "Evaluation script"
Require-Path $configPath "Training config"
Require-Path $dictPath "Character dictionary"
Require-Path $DatasetRoot "Dataset root"
Require-Path $LabelFile "Label file"

Ensure-PaddleSource
Require-Path $trainScript "PaddleOCR train.py"
Require-Path $exportScript "PaddleOCR export_model.py"
Require-Path $paddlePackageRoot "PaddleOCR package root"

Write-Host "Dataset root : $DatasetRoot"
Write-Host "Label file   : $LabelFile"
Write-Host "Split ratio  : $SplitRatio"
Write-Host "Config       : $configPath"
Write-Host ""

Write-Host "Step 1/5: prepare rec dataset"
& $pythonExe $prepareScript `
    --dataset-root $DatasetRoot `
    --label-file $LabelFile `
    --output-dir $dataDir `
    --split-ratio $SplitRatio `
    --seed $Seed
if ($LASTEXITCODE -ne 0) {
    throw "Dataset preparation failed with exit code $LASTEXITCODE"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Write-Host "Step 2/5: evaluate default model on validation split"
& $pythonExe $evalScript `
    --dataset-root $dataDir `
    --label-file (Join-Path $dataDir "val.txt") `
    --out $baselineEvalPath
if ($LASTEXITCODE -ne 0) {
    throw "Baseline evaluation failed with exit code $LASTEXITCODE"
}

$pretrainedPrefix = Resolve-PretrainedPrefix
Write-Host "Using pretrained weights: $pretrainedPrefix"

Write-Host "Step 3/5: train custom rec model"
$previousPythonPath = $env:PYTHONPATH
$env:PYTHONPATH = if ($previousPythonPath) {
    "$paddlePackageRoot;$previousPythonPath"
}
else {
    $paddlePackageRoot
}
& $pythonExe $trainScript -c $configPath -o "Global.pretrained_model=$pretrainedPrefix"
$env:PYTHONPATH = $previousPythonPath
if ($LASTEXITCODE -ne 0) {
    throw "Training failed with exit code $LASTEXITCODE"
}

Require-Path ($bestModelPrefix + ".pdparams") "Best model checkpoint"

Write-Host "Step 4/5: export inference model"
$previousPythonPath = $env:PYTHONPATH
$previousPythonUtf8 = $env:PYTHONUTF8
$previousPythonIoEncoding = $env:PYTHONIOENCODING
$env:PYTHONPATH = if ($previousPythonPath) {
    "$paddlePackageRoot;$previousPythonPath"
}
else {
    $paddlePackageRoot
}
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
& $pythonExe $exportScript -c $configPath -o `
    "Global.pretrained_model=$bestModelPrefix" `
    "Global.save_inference_dir=$inferenceDir"
$env:PYTHONPATH = $previousPythonPath
$env:PYTHONUTF8 = $previousPythonUtf8
$env:PYTHONIOENCODING = $previousPythonIoEncoding
if ($LASTEXITCODE -ne 0) {
    throw "Model export failed with exit code $LASTEXITCODE"
}

Require-Path (Join-Path $inferenceDir "inference.pdmodel") "Exported inference model"
Require-Path (Join-Path $inferenceDir "inference.pdiparams") "Exported inference params"

Write-Host "Step 5/5: evaluate fine-tuned model on validation split"
& $pythonExe $evalScript `
    --dataset-root $dataDir `
    --label-file (Join-Path $dataDir "val.txt") `
    --rec-model-dir $inferenceDir `
    --rec-char-dict-path $dictPath `
    --rec-algorithm "CRNN" `
    --rec-image-shape "3,48,320" `
    --max-text-length 64 `
    --out $finetunedEvalPath
if ($LASTEXITCODE -ne 0) {
    throw "Fine-tuned evaluation failed with exit code $LASTEXITCODE"
}

$summary = @{
    dataset_root = $DatasetRoot
    label_file = $LabelFile
    dataset_dir = $dataDir
    baseline_eval = $baselineEvalPath
    finetuned_eval = $finetunedEvalPath
    best_model_prefix = $bestModelPrefix
    inference_dir = $inferenceDir
    generated_at = (Get-Date).ToString("s")
}
$summary | ConvertTo-Json | Set-Content -Path $runSummaryPath -Encoding UTF8

Write-Host ""
Write-Host "Training summary saved to: $runSummaryPath"
Write-Host "Inference model directory: $inferenceDir"
