import argparse
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("PADDLEOCR_HOME", str(ROOT / "models"))
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from paddleocr import PaddleOCR

OUTPUT_DIR = ROOT / "output"
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
CHINESE_STOP_WORDS = {
    "中华人民共和国",
    "护照",
    "姓名",
    "中文名",
    "国籍",
    "性别",
    "出生日期",
    "签发日期",
    "有效期至",
    "出生地",
    "签发地",
    "签发机关",
    "号码",
    "护照号",
    "个月",
    "以下",
    "以上",
    "经济舱",
    "公务舱",
    "passport",
}
PASSPORT_CN_LABELS = ["护照号", "护照号码", "号码"]
NAME_CN_LABELS = ["姓名", "中文名"]


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def collect_images(path: Path, limit: int | None) -> list[Path]:
    if path.is_file():
        return [path]

    files = [item for item in sorted(path.iterdir()) if item.suffix.lower() in SUPPORTED_EXTS]
    if limit is not None:
        files = files[:limit]
    return files


def polygon_to_box(poly):
    xs = [point[0] for point in poly]
    ys = [point[1] for point in poly]
    return {
        "left": min(xs),
        "top": min(ys),
        "right": max(xs),
        "bottom": max(ys),
        "center_x": sum(xs) / len(xs),
        "center_y": sum(ys) / len(ys),
    }


def sort_lines(lines):
    return sorted(lines, key=lambda item: (round(item["box"]["top"] / 10), item["box"]["left"]))


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_mrz(text: str) -> str:
    return re.sub(r"[^A-Z0-9<]", "", text.upper())


def clean_english_name(text: str) -> str:
    text = text.upper().replace("<", " ")
    text = re.sub(r"[^A-Z\s'-]", " ", text)
    return normalize_spaces(text)


def normalize_alnum(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def extract_passport_like_tokens(text: str) -> list[str]:
    return [match for match in re.findall(r"[A-Z]{1,2}\d{7,8}", normalize_alnum(text)) if len(match) == 9]


def has_passport_context(text: str) -> bool:
    lowered = text.lower()
    return "passport" in lowered or "document" in lowered or any(token in text for token in PASSPORT_CN_LABELS)


def looks_like_english_name_line(text: str) -> bool:
    cleaned = clean_english_name(text.replace(",", " "))
    tokens = cleaned.split()
    if not 2 <= len(tokens) <= 4:
        return False
    if any(token in {"CHN", "PRC"} for token in tokens):
        return False
    if any(len(token) == 1 for token in tokens):
        return False
    return all(1 < len(token) <= 12 for token in tokens)


def has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", text))


def extract_candidate_after_label(text: str, labels: list[str]) -> str:
    lowered = text.lower()
    for label in labels:
        pos = lowered.find(label.lower())
        if pos >= 0:
            value = text[pos + len(label):]
            value = re.sub(r"^[\s:：\-]+", "", value)
            return normalize_spaces(value)
    return ""


def parse_mrz(lines: list[dict]) -> dict:
    line1_candidates = []
    line2_candidates = []

    for line in lines:
        text = line["text"]
        normalized = normalize_mrz(text)
        compact = normalize_alnum(text)

        if normalized.startswith("P<") and len(normalized) >= 20:
            line1_candidates.append(normalized)

        score = 0
        if re.match(r"^[A-Z]{1,2}\d{7,8}", compact):
            score += 30
        if "CHN" in compact:
            score += 15
        if len(normalized) >= 20:
            score += 10
        if "<" in normalized:
            score += 5
        if score > 0:
            line2_candidates.append((score, normalized, compact))

    if not line1_candidates and not line2_candidates:
        return {"english_name": "", "passport_no": ""}

    line1 = line1_candidates[0] if line1_candidates else ""
    line2 = ""
    if line2_candidates:
        line2_candidates.sort(key=lambda item: (-item[0], -len(item[2]), item[2]))
        best_normalized, best_compact = line2_candidates[0][1], line2_candidates[0][2]
        line2 = best_normalized if best_normalized else best_compact

    english_name = ""
    passport_no = ""

    if line1.startswith("P<") and len(line1) > 5:
        name_part = line1[5:]
        if "<<" in name_part:
            surname, given = name_part.split("<<", 1)
            english_name = clean_english_name(f"{surname} {given.replace('<', ' ')}")

    if line2:
        passport_no = normalize_spaces(line2[:9].replace("<", ""))

    return {"english_name": english_name, "passport_no": passport_no}


def extract_passport_number(lines: list[dict], mrz_result: dict) -> str:
    label_patterns = ["passport no", "passport number", "document no", *PASSPORT_CN_LABELS]
    candidates = []

    for index, line in enumerate(lines):
        text = line["text"]
        inline = extract_candidate_after_label(text, label_patterns)
        has_label_context = has_passport_context(text)
        prev_has_label_context = index > 0 and has_passport_context(lines[index - 1]["text"])
        next_has_label_context = index + 1 < len(lines) and has_passport_context(lines[index + 1]["text"])

        scan_targets = []
        if inline:
            scan_targets.append((inline, 35))
        if has_label_context:
            scan_targets.append((text, 25))
        if prev_has_label_context:
            scan_targets.append((text, 22))
        if next_has_label_context:
            scan_targets.append((text, 18))
        scan_targets.append((text, 10))

        for target, base_score in scan_targets:
            normalized = normalize_alnum(target)
            matches = extract_passport_like_tokens(target)
            for match in matches:
                score = 0
                score += base_score
                if re.match(r"^[A-Z]{1,2}\d{7,8}$", match):
                    score += 10
                if len(normalized) == 9:
                    score += 8
                if "CHN" in normalized:
                    score += 6
                candidates.append((score, match))

    if mrz_result["passport_no"]:
        candidates.append((60, mrz_result["passport_no"]))

    candidates.sort(key=lambda item: (-item[0], item[1]))
    return candidates[0][1] if candidates else ""


def extract_chinese_name(lines: list[dict]) -> str:
    candidates = []

    for index, line in enumerate(lines):
        text = normalize_spaces(line["text"])
        if not text:
            continue

        inline = extract_candidate_after_label(text, NAME_CN_LABELS)
        if inline and has_cjk(inline):
            value = re.sub(r"[^\u4e00-\u9fff]", "", inline)
            if 2 <= len(value) <= 8:
                candidates.append((50, value))

        pure = re.sub(r"[^\u4e00-\u9fff]", "", text)
        if not has_cjk(text) or not pure or pure in CHINESE_STOP_WORDS:
            continue
        if not 2 <= len(pure) <= 4:
            continue

        score = 10
        if any(label in text for label in NAME_CN_LABELS):
            score += 30
        if index > 0 and any(label in lines[index - 1]["text"] for label in NAME_CN_LABELS):
            score += 15
        if "/" not in text and pure == text:
            score += 12
        if "/" in text:
            score -= 12

        prev_text = lines[index - 1]["text"] if index > 0 else ""
        next_text = lines[index + 1]["text"] if index + 1 < len(lines) else ""
        if extract_passport_like_tokens(prev_text) or extract_passport_like_tokens(next_text):
            score += 15
        if "," in prev_text and looks_like_english_name_line(prev_text):
            score += 18
        if "," in next_text and looks_like_english_name_line(next_text):
            score += 18

        for nearby in lines[max(0, index - 3): min(len(lines), index + 4)]:
            nearby_text = nearby["text"]
            if has_passport_context(nearby_text) or extract_passport_like_tokens(nearby_text) or "CHN" in nearby_text.upper():
                score += 6
            if "," in nearby_text and looks_like_english_name_line(nearby_text):
                score += 10
            elif looks_like_english_name_line(nearby_text):
                score += 6

        candidates.append((score, pure))

    candidates.sort(key=lambda item: (-item[0], item[1]))
    return candidates[0][1] if candidates else ""


def extract_english_name(lines: list[dict], mrz_result: dict) -> str:
    surname = ""
    given = ""
    full_candidates = []
    label_keywords = [*NAME_CN_LABELS, "name", "surname", "given", "given names"]
    noise_keywords = [
        "passport",
        "signature",
        "authority",
        "republic",
        "country",
        "nationality",
        "date",
        "birth",
        "issue",
        "expiry",
        "bearer",
    ]

    for index, line in enumerate(lines):
        text = normalize_spaces(line["text"])
        lowered = text.lower()

        inline_surname = extract_candidate_after_label(text, ["surname"])
        inline_given = extract_candidate_after_label(text, ["given names", "given name"])

        if inline_surname:
            cleaned = clean_english_name(inline_surname)
            if cleaned:
                surname = cleaned
        elif "surname" in lowered and index + 1 < len(lines):
            cleaned = clean_english_name(lines[index + 1]["text"])
            if cleaned:
                surname = cleaned

        if inline_given:
            cleaned = clean_english_name(inline_given)
            if cleaned:
                given = cleaned
        elif ("given names" in lowered or "given name" in lowered) and index + 1 < len(lines):
            cleaned = clean_english_name(lines[index + 1]["text"])
            if cleaned:
                given = cleaned

        if any(keyword in text for keyword in [*NAME_CN_LABELS, "Name"]) and index + 1 < len(lines):
            next_text = lines[index + 1]["text"]
            cleaned_next = clean_english_name(next_text)
            if cleaned_next and not has_cjk(next_text) and looks_like_english_name_line(next_text):
                full_candidates.append((30, cleaned_next))
        if any(keyword in text for keyword in [*NAME_CN_LABELS, "Name"]) and index + 2 < len(lines):
            next_text = lines[index + 2]["text"]
            cleaned_next = clean_english_name(next_text)
            if cleaned_next and not has_cjk(next_text) and looks_like_english_name_line(next_text):
                full_candidates.append((22, cleaned_next))

        cleaned = clean_english_name(text)
        tokens = cleaned.split()
        if cleaned and looks_like_english_name_line(text):
            score = 0
            if text == text.upper():
                score += 10
            if any(token in lowered for token in ["surname", "given"]):
                score += 12
            if any(token in lowered for token in label_keywords):
                score -= 8
            if any(token in lowered for token in noise_keywords):
                score -= 20
            if any(token in {"CHN", "PRC"} for token in tokens):
                score -= 15
            if re.search(r"\d", cleaned):
                score -= 15
            if score > 0:
                full_candidates.append((score, cleaned))

    if surname or given:
        combined = normalize_spaces(f"{surname} {given}")
        if combined:
            return combined

    if mrz_result["english_name"]:
        return mrz_result["english_name"]

    full_candidates.sort(key=lambda item: (-item[0], item[1]))
    return full_candidates[0][1] if full_candidates else ""


def run_ocr(ocr: PaddleOCR, image_path: Path) -> dict:
    raw_result = ocr.ocr(str(image_path), cls=True)
    page = raw_result[0] if raw_result else []
    lines = []

    for item in page:
        if not item or len(item) < 2:
            continue
        poly, rec = item
        text, score = rec[0], float(rec[1])
        lines.append(
            {
                "text": normalize_spaces(text),
                "score": round(score, 6),
                "box": polygon_to_box(poly),
                "polygon": poly,
            }
        )

    lines = sort_lines(lines)
    mrz_result = parse_mrz(lines)

    return {
        "image": str(image_path),
        "structured": {
            "english_name": extract_english_name(lines, mrz_result),
            "chinese_name": extract_chinese_name(lines),
            "passport_no": extract_passport_number(lines, mrz_result),
            "mrz_english_name": mrz_result["english_name"],
            "mrz_passport_no": mrz_result["passport_no"],
        },
        "lines": lines,
    }


def main():
    parser = argparse.ArgumentParser(description="Standalone PaddleOCR demo for passport images")
    parser.add_argument("--image", required=True, help="Path to one image or a folder of images")
    parser.add_argument("--limit", type=int, default=None, help="Limit how many images to process when input is a folder")
    parser.add_argument("--lang", default="ch", help="PaddleOCR language model, default: ch")
    args = parser.parse_args()

    image_path = Path(args.image).resolve()
    if not image_path.exists():
        raise SystemExit(f"Path not found: {image_path}")

    ensure_dir(OUTPUT_DIR)
    model_dir = ROOT / "models"
    ensure_dir(model_dir)
    os.environ.setdefault("PADDLE_OCR_BASE_DIR", str(model_dir))

    print(f"[paddleocr-demo] loading model lang={args.lang}")
    ocr = PaddleOCR(use_angle_cls=True, lang=args.lang, show_log=False)

    images = collect_images(image_path, args.limit)
    if not images:
        raise SystemExit("No supported images found")

    summary = []
    for image in images:
        print(f"\n=== {image.name} ===")
        result = run_ocr(ocr, image)
        structured = result["structured"]

        print(f"english_name : {structured['english_name']}")
        print(f"chinese_name : {structured['chinese_name']}")
        print(f"passport_no  : {structured['passport_no']}")
        print("raw_lines:")
        for line in result["lines"]:
            print(f"  - {line['text']}  [score={line['score']}]")

        output_path = OUTPUT_DIR / f"{image.stem}.json"
        output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        summary.append(
            {
                "image": image.name,
                "english_name": structured["english_name"],
                "chinese_name": structured["chinese_name"],
                "passport_no": structured["passport_no"],
                "json": str(output_path),
            }
        )

    summary_path = OUTPUT_DIR / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[paddleocr-demo] saved summary => {summary_path}")


if __name__ == "__main__":
    main()
