import argparse
import json
import random
import shutil
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

try:
    from paddleocr.tools.infer.utility import get_rotate_crop_image
except ModuleNotFoundError:
    from tools.infer.utility import get_rotate_crop_image


PLACEHOLDER_TEXTS = {
    "",
    "*",
    "###",
    "待识别",
    "无法识别",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Build a PaddleOCR rec dataset from PPOCRLabel Label.txt")
    parser.add_argument("--dataset-root", required=True, help="Root folder that contains the labeled images")
    parser.add_argument("--label-file", required=True, help="PPOCRLabel Label.txt file")
    parser.add_argument("--output-dir", required=True, help="Output directory for crop_img and split files")
    parser.add_argument("--split-ratio", default="8:1:1", help="Split ratio in train:val:test form")
    parser.add_argument("--seed", type=int, default=20260402, help="Shuffle seed for reproducible splits")
    return parser.parse_args()


def parse_ratio(value: str) -> tuple[int, int, int]:
    parts = [int(part.strip()) for part in value.split(":")]
    if len(parts) != 3 or any(part <= 0 for part in parts):
        raise ValueError("split ratio must look like 8:1:1")
    return tuple(parts)


def compute_split_sizes(total: int, ratio: tuple[int, int, int]) -> tuple[int, int, int]:
    ratio_sum = sum(ratio)
    sizes = [(total * part) // ratio_sum for part in ratio]
    remainder = total - sum(sizes)
    for index in range(remainder):
        sizes[index % len(sizes)] += 1

    if total >= 3:
        for target_index in (1, 2):
            if sizes[target_index] == 0:
                donor_index = max(
                    range(len(sizes)),
                    key=lambda idx: sizes[idx] if idx != target_index else -1,
                )
                if sizes[donor_index] > 1:
                    sizes[donor_index] -= 1
                    sizes[target_index] += 1
    return tuple(sizes)


def should_skip_text(text: str) -> bool:
    normalized = str(text or "").strip()
    if normalized in PLACEHOLDER_TEXTS:
        return True
    if set(normalized) <= {"?", "？"}:
        return True
    return False


def write_split_file(path: Path, records: list[tuple[str, str]]) -> None:
    lines = [f"{relative_path}\t{text}" for relative_path, text in records]
    path.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")


def load_image(image_path: Path):
    if not image_path.exists():
        return None
    image_bytes = np.fromfile(str(image_path), dtype=np.uint8)
    if image_bytes.size == 0:
        return None
    return cv2.imdecode(image_bytes, cv2.IMREAD_COLOR)


def main():
    args = parse_args()
    dataset_root = Path(args.dataset_root).resolve()
    label_file = Path(args.label_file).resolve()
    output_dir = Path(args.output_dir).resolve()
    crop_dir = output_dir / "crop_img"
    ratio = parse_ratio(args.split_ratio)

    if not dataset_root.exists():
        raise SystemExit(f"Dataset root not found: {dataset_root}")
    if not label_file.exists():
        raise SystemExit(f"Label file not found: {label_file}")

    if output_dir.exists():
        shutil.rmtree(output_dir)
    crop_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "dataset_root": str(dataset_root),
        "label_file": str(label_file),
        "split_ratio": args.split_ratio,
        "seed": args.seed,
        "images_in_label_file": 0,
        "boxes_in_label_file": 0,
        "exported_samples": 0,
        "skipped": Counter(),
        "skipped_labels": Counter(),
    }

    records: list[tuple[str, str]] = []
    manifest: list[dict] = []
    export_index = 0

    for line in label_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue

        image_rel_path, payload = line.split("\t", 1)
        items = json.loads(payload)
        summary["images_in_label_file"] += 1
        summary["boxes_in_label_file"] += len(items)

        image_path = dataset_root / image_rel_path
        image = load_image(image_path)
        if image is None:
            summary["skipped"]["missing_image"] += len(items)
            continue

        for item_index, item in enumerate(items):
            text = str(item.get("transcription", "")).strip()
            if item.get("difficult"):
                summary["skipped"]["difficult"] += 1
                continue
            if should_skip_text(text):
                summary["skipped"]["placeholder_or_empty"] += 1
                summary["skipped_labels"][text or "<empty>"] += 1
                continue

            points = np.asarray(item.get("points") or [], dtype=np.float32)
            if points.shape != (4, 2):
                summary["skipped"]["invalid_points"] += 1
                continue

            try:
                crop = get_rotate_crop_image(image, points)
            except Exception:
                summary["skipped"]["crop_error"] += 1
                continue

            if crop is None or crop.size == 0:
                summary["skipped"]["empty_crop"] += 1
                continue

            crop_height, crop_width = crop.shape[:2]
            if min(crop_height, crop_width) < 4:
                summary["skipped"]["tiny_crop"] += 1
                continue

            crop_name = f"crop_{export_index:05d}.jpg"
            crop_path = crop_dir / crop_name
            if not cv2.imwrite(str(crop_path), crop):
                summary["skipped"]["write_failed"] += 1
                continue

            relative_crop_path = f"crop_img/{crop_name}"
            records.append((relative_crop_path, text))
            manifest.append(
                {
                    "source_image": image_rel_path,
                    "source_box_index": item_index,
                    "crop_image": relative_crop_path,
                    "label": text,
                    "width": int(crop_width),
                    "height": int(crop_height),
                }
            )
            export_index += 1

    if not records:
        raise SystemExit("No valid rec samples were exported from the label file")

    summary["exported_samples"] = len(records)

    write_split_file(output_dir / "rec_gt.txt", records)

    shuffled_records = records[:]
    random.Random(args.seed).shuffle(shuffled_records)
    train_size, val_size, test_size = compute_split_sizes(len(shuffled_records), ratio)

    train_records = shuffled_records[:train_size]
    val_records = shuffled_records[train_size : train_size + val_size]
    test_records = shuffled_records[train_size + val_size : train_size + val_size + test_size]

    write_split_file(output_dir / "train.txt", train_records)
    write_split_file(output_dir / "val.txt", val_records)
    write_split_file(output_dir / "test.txt", test_records)

    summary["split_counts"] = {
        "train": len(train_records),
        "val": len(val_records),
        "test": len(test_records),
    }
    summary["skipped"] = dict(summary["skipped"])
    summary["skipped_labels"] = dict(summary["skipped_labels"])

    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(str(output_dir))


if __name__ == "__main__":
    main()
