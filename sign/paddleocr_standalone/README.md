# PaddleOCR Standalone Demo

This folder is a standalone PaddleOCR demo for passport images.

It does not integrate with the existing review workbench.

## What it does

- runs PaddleOCR on one image or a whole folder
- prints raw OCR lines in reading order
- tries to extract:
  - English name
  - Chinese name
  - passport number
- writes per-image JSON output under `output/`

## Recommended usage

Activate the local virtual environment first, then run:

```powershell
.\.venv\Scripts\python.exe .\run_passport_ocr.py --image ..\passport\057eb8233fdd2bd77a8c13b2227cc405.jpg
```

Or process a folder:

```powershell
.\.venv\Scripts\python.exe .\run_passport_ocr.py --image ..\passport --limit 5
```

## Environment

- Python: `3.10`
- `paddlepaddle==2.6.2`
- `paddleocr==2.9.1`

## Output

- Per-image JSON files are written to `output/`
- A run summary is written to `output/summary.json`
- Raw OCR lines are preserved so you can judge OCR quality directly

## Notes

- The script is intentionally standalone so you can inspect OCR quality first.
- Chinese name extraction only works if the image actually contains Chinese name text.
- The field extraction is heuristic-based on top of OCR output, so the raw OCR lines are always saved for inspection.
