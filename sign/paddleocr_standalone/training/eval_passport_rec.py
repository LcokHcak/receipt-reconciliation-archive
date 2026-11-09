import argparse
import json
from pathlib import Path

from paddleocr import PaddleOCR


def parse_args():
    parser = argparse.ArgumentParser(description="Evaluate a PaddleOCR rec model on cropped validation data")
    parser.add_argument("--dataset-root", required=True, help="Root folder containing crop_img and split files")
    parser.add_argument("--label-file", required=True, help="Split file such as val.txt or test.txt")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--lang", default="ch", help="PaddleOCR language")
    parser.add_argument("--rec-model-dir", default="", help="Optional exported inference model directory")
    parser.add_argument("--rec-char-dict-path", default="", help="Character dictionary for a custom rec model")
    parser.add_argument("--rec-algorithm", default="", help="Recognition algorithm for a custom rec model")
    parser.add_argument("--rec-image-shape", default="", help="Recognition image shape such as 3,48,320")
    parser.add_argument("--max-text-length", type=int, default=0, help="Max text length override for custom model")
    parser.add_argument("--max-samples", type=int, default=0, help="Optional cap for debugging")
    return parser.parse_args()


def edit_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)

    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_char in enumerate(right, start=1):
            insert_cost = current[right_index - 1] + 1
            delete_cost = previous[right_index] + 1
            replace_cost = previous[right_index - 1] + (left_char != right_char)
            current.append(min(insert_cost, delete_cost, replace_cost))
        previous = current
    return previous[-1]


def load_records(dataset_root: Path, label_file: Path, max_samples: int) -> list[tuple[Path, str]]:
    records = []
    for line in label_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        relative_path, label = line.split("\t", 1)
        records.append((dataset_root / relative_path, label))
        if max_samples and len(records) >= max_samples:
            break
    return records


def build_ocr(args) -> PaddleOCR:
    kwargs = {
        "use_angle_cls": False,
        "lang": args.lang,
        "show_log": False,
    }
    if args.rec_model_dir:
        kwargs["rec_model_dir"] = str(Path(args.rec_model_dir).resolve())
        if args.rec_char_dict_path:
            kwargs["rec_char_dict_path"] = str(Path(args.rec_char_dict_path).resolve())
        if args.rec_algorithm:
            kwargs["rec_algorithm"] = args.rec_algorithm
        if args.rec_image_shape:
            kwargs["rec_image_shape"] = args.rec_image_shape
        if args.max_text_length > 0:
            kwargs["max_text_length"] = args.max_text_length
    return PaddleOCR(**kwargs)


def recognize_text(ocr: PaddleOCR, image_path: Path) -> tuple[str, float]:
    result = ocr.ocr(str(image_path), det=False, rec=True, cls=False)
    if not result or not result[0]:
        return "", 0.0

    first = result[0][0]
    if isinstance(first, (list, tuple)) and len(first) >= 2:
        return str(first[0] or ""), float(first[1] or 0.0)
    return str(first or ""), 0.0


def main():
    args = parse_args()
    dataset_root = Path(args.dataset_root).resolve()
    label_file = Path(args.label_file).resolve()
    out_path = Path(args.out).resolve()

    if not dataset_root.exists():
        raise SystemExit(f"Dataset root not found: {dataset_root}")
    if not label_file.exists():
        raise SystemExit(f"Label file not found: {label_file}")

    records = load_records(dataset_root, label_file, args.max_samples)
    if not records:
        raise SystemExit("No evaluation samples found")

    ocr = build_ocr(args)

    total = 0
    exact_correct = 0
    total_score = 0.0
    total_edit_distance = 0
    total_reference_chars = 0
    mistakes = []

    for image_path, expected in records:
        if not image_path.exists():
            mistakes.append(
                {
                    "image": str(image_path),
                    "expected": expected,
                    "predicted": "",
                    "score": 0.0,
                    "error": "missing_image",
                }
            )
            continue

        predicted, score = recognize_text(ocr, image_path)
        total += 1
        total_score += score
        distance = edit_distance(predicted, expected)
        total_edit_distance += distance
        total_reference_chars += max(len(expected), 1)

        if predicted == expected:
            exact_correct += 1
        else:
            mistakes.append(
                {
                    "image": str(image_path),
                    "expected": expected,
                    "predicted": predicted,
                    "score": round(score, 6),
                    "edit_distance": distance,
                }
            )

    exact_accuracy = (exact_correct / total) if total else 0.0
    char_accuracy = 1.0 - (total_edit_distance / total_reference_chars) if total_reference_chars else 0.0

    result = {
        "dataset_root": str(dataset_root),
        "label_file": str(label_file),
        "sample_count": total,
        "exact_correct": exact_correct,
        "exact_accuracy": round(exact_accuracy, 6),
        "char_accuracy": round(max(0.0, char_accuracy), 6),
        "average_score": round((total_score / total) if total else 0.0, 6),
        "model": {
            "type": "custom" if args.rec_model_dir else "default",
            "rec_model_dir": str(Path(args.rec_model_dir).resolve()) if args.rec_model_dir else "",
            "rec_algorithm": args.rec_algorithm or "",
            "rec_image_shape": args.rec_image_shape or "",
            "max_text_length": args.max_text_length,
        },
        "mistake_count": len(mistakes),
        "mistakes": mistakes[:100],
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(str(out_path))


if __name__ == "__main__":
    main()
