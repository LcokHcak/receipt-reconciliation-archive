import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("PADDLEOCR_HOME", str(ROOT / "models"))
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import cv2
from paddleocr import PaddleOCR


def normalize_spaces(text: str) -> str:
    return " ".join(str(text or "").split())


def polygon_to_box(poly):
    xs = [point[0] for point in poly]
    ys = [point[1] for point in poly]
    return {
        "left": min(xs),
        "top": min(ys),
        "right": max(xs),
        "bottom": max(ys),
    }


def load_manifest(manifest_path: Path) -> list[Path]:
    images = []
    for line in manifest_path.read_text(encoding="utf-8-sig").splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        images.append(Path(candidate))
    return images


def load_image_for_ocr(image_path: Path, max_side: int):
    image = cv2.imread(str(image_path))
    if image is None:
        return str(image_path)

    if max_side > 0:
        height, width = image.shape[:2]
        longest = max(height, width)
        if longest > max_side:
            scale = max_side / float(longest)
            resized_width = max(1, int(round(width * scale)))
            resized_height = max(1, int(round(height * scale)))
            image = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_AREA)

    return image


def resolve_path(value: str) -> str:
    if not value:
        return ""
    return str(Path(value).expanduser().resolve())


def build_ocr_kwargs(args) -> dict:
    kwargs = {
        "use_angle_cls": args.use_angle_cls,
        "lang": args.lang,
        "show_log": False,
    }

    det_model_dir = resolve_path(args.det_model_dir)
    if det_model_dir:
        if not Path(det_model_dir).exists():
            raise SystemExit(f"Custom det model not found: {det_model_dir}")
        kwargs["det_model_dir"] = det_model_dir

    rec_model_dir = resolve_path(args.rec_model_dir)
    if rec_model_dir:
        if not Path(rec_model_dir).exists():
            raise SystemExit(f"Custom rec model not found: {rec_model_dir}")
        kwargs["rec_model_dir"] = rec_model_dir
        if args.rec_char_dict_path:
            kwargs["rec_char_dict_path"] = resolve_path(args.rec_char_dict_path)
        if args.rec_algorithm:
            kwargs["rec_algorithm"] = args.rec_algorithm
        if args.rec_image_shape:
            kwargs["rec_image_shape"] = args.rec_image_shape
        if args.max_text_length > 0:
            kwargs["max_text_length"] = args.max_text_length

    return kwargs


def run_ocr(ocr: PaddleOCR, image_path: Path, use_angle_cls: bool, max_side: int) -> dict:
    ocr_input = load_image_for_ocr(image_path, max_side)
    raw_result = ocr.ocr(ocr_input, cls=use_angle_cls)
    page = raw_result[0] if raw_result else []
    lines = []

    for item in page:
        if not item or len(item) < 2:
            continue
        polygon, rec = item
        text, score = rec[0], float(rec[1])
        lines.append(
            {
                "text": normalize_spaces(text),
                "score": round(score, 6),
                "box": polygon_to_box(polygon),
            }
        )

    lines.sort(key=lambda item: (round(item["box"]["top"] / 10), item["box"]["left"]))
    joined_text = "\n".join(line["text"] for line in lines if line["text"])
    average_score = round(
        sum(line["score"] for line in lines) / len(lines), 6
    ) if lines else 0.0

    return {
        "image": str(image_path),
        "joined_text": joined_text,
        "line_count": len(lines),
        "average_score": average_score,
        "lines": lines,
    }


def main():
    parser = argparse.ArgumentParser(description="Batch OCR for generic document classification")
    parser.add_argument("--manifest", required=True, help="Text file with one absolute image path per line")
    parser.add_argument("--out", required=True, help="Output JSON file path")
    parser.add_argument("--lang", default="ch", help="PaddleOCR language model, default: ch")
    parser.add_argument(
        "--use-angle-cls",
        action="store_true",
        help="Enable angle classification. Disabled by default for faster document-type classification.",
    )
    parser.add_argument(
        "--max-side",
        type=int,
        default=960,
        help="Resize images so the longest side is at most this value before OCR. Use 0 to disable.",
    )
    parser.add_argument(
        "--det-model-dir",
        default=os.environ.get("PADDLE_OCR_DET_MODEL_DIR", ""),
        help="Optional exported det inference model directory for a custom OCR model.",
    )
    parser.add_argument(
        "--rec-model-dir",
        default=os.environ.get("PADDLE_OCR_REC_MODEL_DIR", ""),
        help="Optional exported rec inference model directory for a custom OCR model.",
    )
    parser.add_argument(
        "--rec-char-dict-path",
        default=os.environ.get("PADDLE_OCR_REC_CHAR_DICT_PATH", ""),
        help="Optional character dictionary path for a custom rec model.",
    )
    parser.add_argument(
        "--rec-algorithm",
        default=os.environ.get("PADDLE_OCR_REC_ALGORITHM", ""),
        help="Optional rec algorithm override, for example CRNN.",
    )
    parser.add_argument(
        "--rec-image-shape",
        default=os.environ.get("PADDLE_OCR_REC_IMAGE_SHAPE", ""),
        help="Optional rec image shape override, for example 3,48,320.",
    )
    parser.add_argument(
        "--max-text-length",
        type=int,
        default=int(os.environ.get("PADDLE_OCR_MAX_TEXT_LENGTH", "0")),
        help="Optional max text length override for a custom rec model.",
    )
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    out_path = Path(args.out).resolve()

    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")

    images = load_manifest(manifest_path)
    if not images:
        raise SystemExit("Manifest is empty")

    ocr = PaddleOCR(**build_ocr_kwargs(args))
    results = []

    for image_path in images:
        record = {"image": str(image_path)}
        try:
            record.update(run_ocr(ocr, image_path, args.use_angle_cls, args.max_side))
        except Exception as exc:  # pragma: no cover - best effort batch processing
            record["error"] = str(exc)
            record["joined_text"] = ""
            record["line_count"] = 0
            record["average_score"] = 0.0
            record["lines"] = []
        results.append(record)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.stdout.write(str(out_path))


if __name__ == "__main__":
    main()
