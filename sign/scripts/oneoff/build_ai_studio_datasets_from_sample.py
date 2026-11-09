from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from PIL import Image


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
ROOT = Path(r"D:\JIN HAIMIN\self\ticket")
SAMPLE_ROOT = ROOT / "data_sample"
OUTPUT_ROOT = ROOT / "ai_studio_upload_ready"


def is_image_file(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTENSIONS


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def stable_hash(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def stable_split(keys: list[str], val_ratio: float = 0.2) -> tuple[set[str], set[str]]:
    if not keys:
        return set(), set()
    ordered = sorted(keys, key=stable_hash)
    if len(ordered) == 1:
        return {ordered[0]}, set()
    val_count = max(1, int(round(len(ordered) * val_ratio)))
    val_count = min(val_count, len(ordered) - 1)
    val_keys = set(ordered[:val_count])
    train_keys = set(ordered[val_count:])
    return train_keys, val_keys


def bbox_from_points(points: Iterable[Iterable[float]]) -> tuple[float, float, float, float]:
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    min_x = min(xs)
    min_y = min(ys)
    max_x = max(xs)
    max_y = max(ys)
    return min_x, min_y, max_x, max_y


def bbox_area(box: tuple[float, float, float, float]) -> float:
    min_x, min_y, max_x, max_y = box
    return max(0.0, max_x - min_x) * max(0.0, max_y - min_y)


def bbox_intersection(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    return max(0.0, inter_x2 - inter_x1) * max(0.0, inter_y2 - inter_y1)


def crop_bbox(image: Image.Image, box: tuple[float, float, float, float]) -> Image.Image:
    min_x, min_y, max_x, max_y = box
    left = max(0, int(math.floor(min_x)))
    upper = max(0, int(math.floor(min_y)))
    right = min(image.width, int(math.ceil(max_x)))
    lower = min(image.height, int(math.ceil(max_y)))
    if right <= left:
        right = min(image.width, left + 1)
    if lower <= upper:
        lower = min(image.height, upper + 1)
    return image.crop((left, upper, right, lower))


def load_labelme_annotations(labelme_dir: Path) -> dict[str, dict]:
    annotations_dir = labelme_dir / "annotations"
    result: dict[str, dict] = {}
    for json_path in sorted(annotations_dir.glob("*.json")):
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        image_name = Path(payload["imagePath"]).name
        result[image_name] = payload
    return result


def load_ppocr_label_file(label_path: Path) -> dict[str, list[dict]]:
    entries: dict[str, list[dict]] = {}
    for raw_line in label_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        rel_path, payload = line.split("\t", 1)
        image_name = Path(rel_path).name
        entries[image_name] = json.loads(payload)
    return entries


def write_empty_text(path: Path) -> None:
    path.write_text("", encoding="utf-8")


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_dataset_readme(path: Path, dataset_type: str, notes: list[str]) -> None:
    lines = [
        f"# {path.name}",
        "",
        f"- Dataset type: `{dataset_type}`",
        "",
        "## Notes",
    ]
    lines.extend(f"- {note}" for note in notes)
    lines.append("")
    (path / "README.md").write_text("\n".join(lines), encoding="utf-8")


def is_cjk_character(character: str) -> bool:
    codepoint = ord(character)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
    )


def validate_field_text(label: str, text: str, image_name: str) -> None:
    normalized = text.strip()
    if label != "chinese_name_region":
        return
    if not normalized:
        raise ValueError(f"empty chinese_name_region text for {image_name}")
    if not any(is_cjk_character(character) for character in normalized):
        raise ValueError(
            f"invalid chinese_name_region text for {image_name}: {normalized!r}"
        )
    allowed_extra = {"·"}
    invalid_chars = [
        character
        for character in normalized
        if not (is_cjk_character(character) or character in allowed_extra)
    ]
    if invalid_chars:
        raise ValueError(
            f"unexpected characters in chinese_name_region for {image_name}: "
            f"{normalized!r} invalid={invalid_chars!r}"
        )


PASSPORT_NO_PATTERN = re.compile(r"^[A-Z]{1,2}\d{7,8}$")
MRZ_PATTERN = re.compile(r"^[A-Z0-9<]+$")
ENGLISH_NAME_PATTERN = re.compile(r"^[A-Z][A-Z .,\-]*$")
DATE_PATTERN = re.compile(r"^\d{2,4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?$")
GROUP_NO_PATTERN = re.compile(r"^[A-Z]?:?\d[\dA-Z\-]*$")
RECEIPT_NO_PATTERN = re.compile(r"^[*#A-Z0-9\-]+$")


def label_text_compatible(label: str, text: str) -> bool:
    normalized = text.strip()
    if not normalized:
        return False
    if label == "chinese_name_region":
        allowed_extra = {"·"}
        return any(is_cjk_character(ch) for ch in normalized) and all(
            is_cjk_character(ch) or ch in allowed_extra for ch in normalized
        )
    if label == "english_name_region":
        return "<" not in normalized and bool(ENGLISH_NAME_PATTERN.fullmatch(normalized))
    if label == "passport_no_region":
        return bool(PASSPORT_NO_PATTERN.fullmatch(normalized))
    if label in {"mrz_line1_region", "mrz_line2_region"}:
        return "<" in normalized and bool(MRZ_PATTERN.fullmatch(normalized))
    if label in {"purchase_date_region", "departure_date_region"}:
        return bool(DATE_PATTERN.fullmatch(normalized))
    if label == "group_no_region":
        return bool(GROUP_NO_PATTERN.fullmatch(normalized))
    if label == "receipt_no_region":
        return bool(RECEIPT_NO_PATTERN.fullmatch(normalized))
    if label == "store_family_region":
        return any(character.isalpha() for character in normalized)
    return True


def copy_image(src: Path, dest: Path) -> None:
    ensure_dir(dest.parent)
    shutil.copy2(src, dest)


def build_detection_dataset(
    dataset_name: str,
    labelme_dir: Path,
    categories: list[str],
    summary: dict,
) -> None:
    out_dir = OUTPUT_ROOT / dataset_name
    reset_dir(out_dir)
    images_out = out_dir / "images"
    annotations_out = out_dir / "annotations"
    ensure_dir(images_out)
    ensure_dir(annotations_out)

    labelme_annotations = load_labelme_annotations(labelme_dir)
    image_root = labelme_dir / "images"
    train_keys, val_keys = stable_split(list(labelme_annotations.keys()))

    category_ids = {name: index + 1 for index, name in enumerate(categories)}

    def build_subset(keys: set[str]) -> dict:
        images = []
        annotations = []
        ann_id = 1
        image_id = 1
        for image_name in sorted(keys):
            payload = labelme_annotations[image_name]
            image_path = image_root / image_name
            if not image_path.exists():
                continue
            target_image_name = image_name
            copy_image(image_path, images_out / target_image_name)
            images.append(
                {
                    "id": image_id,
                    "file_name": f"images/{target_image_name}",
                    "width": int(payload["imageWidth"]),
                    "height": int(payload["imageHeight"]),
                }
            )
            for shape in payload.get("shapes", []):
                label = shape["label"]
                if label not in category_ids:
                    continue
                bbox = bbox_from_points(shape["points"])
                x1, y1, x2, y2 = bbox
                annotations.append(
                    {
                        "id": ann_id,
                        "image_id": image_id,
                        "category_id": category_ids[label],
                        "bbox": [round(x1, 2), round(y1, 2), round(x2 - x1, 2), round(y2 - y1, 2)],
                        "area": round(bbox_area(bbox), 2),
                        "iscrowd": 0,
                        "segmentation": [],
                    }
                )
                ann_id += 1
            image_id += 1
        return {
            "images": images,
            "annotations": annotations,
            "categories": [{"id": category_ids[name], "name": name} for name in categories],
        }

    train_payload = build_subset(train_keys)
    val_payload = build_subset(val_keys)
    write_json(annotations_out / "instance_train.json", train_payload)
    write_json(annotations_out / "instance_val.json", val_payload)
    write_empty_text(annotations_out / "unlabeled.txt")
    write_dataset_readme(
        out_dir,
        "COCODetLMSSLDataset",
        [
            f"train images: {len(train_payload['images'])}",
            f"val images: {len(val_payload['images'])}",
            f"categories: {', '.join(categories)}",
            "upload this folder directly to AI Studio; do not compress before upload",
        ],
    )

    summary[dataset_name] = {
        "type": "COCODetLMSSLDataset",
        "train_images": len(train_payload["images"]),
        "val_images": len(val_payload["images"]),
        "categories": categories,
    }


def build_classification_dataset(summary: dict) -> None:
    dataset_name = "02_single_classification_cls_lmssl"
    out_dir = OUTPUT_ROOT / dataset_name
    reset_dir(out_dir)
    images_out = out_dir / "images"
    ensure_dir(images_out)

    other_source = SAMPLE_ROOT / "other"
    if not other_source.exists():
        other_source = SAMPLE_ROOT / "ohter"
    if not other_source.exists():
        other_source = SAMPLE_ROOT / "ticket"

    class_sources = {
        "passport": SAMPLE_ROOT / "passport",
        "receipt": SAMPLE_ROOT / "receipt",
        "other": other_source,
    }
    label_to_id = {"passport": 0, "receipt": 1, "other": 2}
    grouped: dict[str, list[Path]] = {}
    for label, source_dir in class_sources.items():
        grouped[label] = sorted(
            path for path in source_dir.iterdir() if path.is_file() and is_image_file(path)
        )

    train_lines: list[str] = []
    val_lines: list[str] = []
    total_images = 0
    for label, paths in grouped.items():
        keys = [path.name for path in paths]
        train_keys, val_keys = stable_split(keys)
        for path in paths:
            target_name = f"{label}_{path.name}"
            copy_image(path, images_out / target_name)
            line = f"images/{target_name} {label_to_id[label]}"
            if path.name in val_keys:
                val_lines.append(line)
            else:
                train_lines.append(line)
            total_images += 1

    (out_dir / "label.txt").write_text(
        "0 passport\n1 receipt\n2 other\n",
        encoding="utf-8",
    )
    (out_dir / "train.txt").write_text("\n".join(train_lines) + ("\n" if train_lines else ""), encoding="utf-8")
    (out_dir / "val.txt").write_text("\n".join(val_lines) + ("\n" if val_lines else ""), encoding="utf-8")
    write_empty_text(out_dir / "train_unlabeled.txt")
    write_dataset_readme(
        out_dir,
        "ClsLMSSLDataset",
        [
            f"train images: {len(train_lines)}",
            f"val images: {len(val_lines)}",
            "labels: 0 passport / 1 receipt / 2 other",
            "upload this folder directly to AI Studio; do not compress before upload",
        ],
    )

    summary[dataset_name] = {
        "type": "ClsLMSSLDataset",
        "train_images": len(train_lines),
        "val_images": len(val_lines),
        "total_images": total_images,
        "labels": label_to_id,
    }


def build_recognition_dataset(
    dataset_name: str,
    det_labelme_dir: Path,
    labeltxt_path: Path,
    expected_labels: list[str],
    summary: dict,
) -> None:
    out_dir = OUTPUT_ROOT / dataset_name
    reset_dir(out_dir)
    images_out = out_dir / "images"
    ensure_dir(images_out)

    det_annotations = load_labelme_annotations(det_labelme_dir)
    text_entries = load_ppocr_label_file(labeltxt_path)
    det_image_root = det_labelme_dir / "images"

    image_train_keys, image_val_keys = stable_split(list(det_annotations.keys()))
    train_lines: list[str] = []
    val_lines: list[str] = []
    dict_chars: dict[str, None] = {}
    warnings: list[str] = []
    image_field_counts: defaultdict[str, int] = defaultdict(int)
    sample_index = 0

    for image_name, payload in sorted(det_annotations.items()):
        source_image_path = det_image_root / image_name
        if not source_image_path.exists():
            warnings.append(f"missing source image for {image_name}")
            continue
        if image_name not in text_entries:
            warnings.append(f"missing text label entries for {image_name}")
            continue

        text_boxes = []
        for box in text_entries[image_name]:
            text_boxes.append(
                {
                    "transcription": str(box["transcription"]).strip(),
                    "bbox": bbox_from_points(box["points"]),
                }
            )

        image = Image.open(source_image_path).convert("RGB")
        for shape in payload.get("shapes", []):
            label = shape["label"]
            if label not in expected_labels:
                continue
            region_bbox = bbox_from_points(shape["points"])
            best_match = None
            best_score = -1.0
            for candidate in text_boxes:
                score = 0.0
                intersection = bbox_intersection(region_bbox, candidate["bbox"])
                if intersection > 0:
                    candidate_area = bbox_area(candidate["bbox"]) or 1.0
                    score = intersection / candidate_area
                if label_text_compatible(label, candidate["transcription"]):
                    score += 1.0
                if score > best_score:
                    best_score = score
                    best_match = candidate
            if not best_match or best_score <= 0:
                warnings.append(f"no text match for {image_name} / {label}")
                continue

            cropped = crop_bbox(image, region_bbox)
            image_field_counts[image_name] += 1
            sample_index += 1
            target_name = f"item_{sample_index:04d}.png"
            cropped.save(images_out / target_name)
            text = best_match["transcription"]
            validate_field_text(label, text, image_name)
            for character in text:
                dict_chars[character] = None
            line = f"images/{target_name}\t{text}"
            if image_name in image_val_keys:
                val_lines.append(line)
            else:
                train_lines.append(line)

    (out_dir / "train.txt").write_text("\n".join(train_lines) + ("\n" if train_lines else ""), encoding="utf-8")
    (out_dir / "val.txt").write_text("\n".join(val_lines) + ("\n" if val_lines else ""), encoding="utf-8")
    write_empty_text(out_dir / "train_unlabeled.txt")
    (out_dir / "dict.txt").write_text(
        "\n".join(sorted(dict_chars.keys())) + ("\n" if dict_chars else ""),
        encoding="utf-8",
    )
    notes = [
        f"train images: {len(train_lines)}",
        f"val images: {len(val_lines)}",
        f"fields: {', '.join(expected_labels)}",
        "upload this folder directly to AI Studio; do not compress before upload",
    ]
    if warnings:
        notes.extend([f"warning: {warning}" for warning in warnings])
    write_dataset_readme(out_dir, "MSTextRecLMSSLDataset", notes)

    summary[dataset_name] = {
        "type": "MSTextRecLMSSLDataset",
        "train_images": len(train_lines),
        "val_images": len(val_lines),
        "fields": expected_labels,
        "warnings": warnings,
    }


def write_root_readme(summary: dict) -> None:
    lines = [
        "AI Studio 可上传数据集（由 data_sample 自动转换）",
        "",
        "本目录包含 6 套可上传数据集：",
        "",
        "1. 01_mix_detection_coco_lmssl",
        "2. 02_single_classification_cls_lmssl",
        "3. 03_passport_field_detection_coco_lmssl",
        "4. 04_passport_field_recognition_mstextrec_lmssl",
        "5. 05_receipt_field_detection_coco_lmssl",
        "6. 06_receipt_field_recognition_mstextrec_lmssl",
        "",
        "说明：",
        "- detection 套件已经转成 COCO",
        "- classification 套件已经转成 train.txt / val.txt / label.txt",
        "- recognition 套件已经裁成字段小图，并生成 train.txt / val.txt / dict.txt",
        "- unlabeled 文件当前为空，可后续追加无标注样本",
        "",
        "summary.json 里记录了每套数据集的样本数量和告警信息。",
        "",
    ]
    (OUTPUT_ROOT / "README.txt").write_text("\n".join(lines), encoding="utf-8")
    write_json(OUTPUT_ROOT / "summary.json", summary)


def main() -> None:
    reset_dir(OUTPUT_ROOT)
    summary: dict = {}

    build_detection_dataset(
        "01_mix_detection_coco_lmssl",
        SAMPLE_ROOT / "labelme",
        ["passport_region", "receipt_region", "other_region"],
        summary,
    )
    build_classification_dataset(summary)
    build_detection_dataset(
        "03_passport_field_detection_coco_lmssl",
        SAMPLE_ROOT / "labelme_passport",
        [
            "passport_no_region",
            "english_name_region",
            "chinese_name_region",
            "mrz_line1_region",
            "mrz_line2_region",
        ],
        summary,
    )
    build_recognition_dataset(
        "04_passport_field_recognition_mstextrec_lmssl",
        SAMPLE_ROOT / "labelme_passport",
        SAMPLE_ROOT / "passport" / "Label.txt",
        [
            "passport_no_region",
            "english_name_region",
            "chinese_name_region",
            "mrz_line1_region",
            "mrz_line2_region",
        ],
        summary,
    )
    build_detection_dataset(
        "05_receipt_field_detection_coco_lmssl",
        SAMPLE_ROOT / "labelme_receipt",
        [
            "receipt_no_region",
            "group_no_region",
            "purchase_date_region",
            "departure_date_region",
            "store_family_region",
        ],
        summary,
    )
    build_recognition_dataset(
        "06_receipt_field_recognition_mstextrec_lmssl",
        SAMPLE_ROOT / "labelme_receipt",
        SAMPLE_ROOT / "receipt" / "Label.txt",
        [
            "receipt_no_region",
            "group_no_region",
            "purchase_date_region",
            "departure_date_region",
            "store_family_region",
        ],
        summary,
    )
    write_root_readme(summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
