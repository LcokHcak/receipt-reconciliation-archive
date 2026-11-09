import argparse
import contextlib
import json
import os
import shutil
import sys
import tempfile


SENTINEL = "PADDLEX_JSON_RESULT="
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def _result_json(result):
    raw = getattr(result, "json", None)
    if callable(raw):
        raw = raw()
    if raw is None:
        raw = result
    return raw


def _res_payload(result):
    raw = _result_json(result)
    if isinstance(raw, dict):
        return raw.get("res", raw)
    return {}


def _normalize_detection(result):
    payload = _res_payload(result)
    boxes = []
    for box in payload.get("boxes", []) or []:
        boxes.append(
            {
                "label": box.get("label") or box.get("class_name") or "",
                "score": float(box.get("score") or box.get("confidence") or 0),
                "classId": box.get("cls_id"),
                "coordinate": box.get("coordinate") or box.get("bbox") or [],
            }
        )
    return boxes


def _normalize_classification(result):
    payload = _res_payload(result)
    labels = payload.get("label_names") or payload.get("labels") or []
    scores = payload.get("scores") or []
    class_ids = payload.get("class_ids") or payload.get("classIds") or []
    classes = []
    for index, label in enumerate(labels):
        score = scores[index] if index < len(scores) else 0
        class_id = class_ids[index] if index < len(class_ids) else None
        classes.append(
            {
                "label": label,
                "score": float(score or 0),
                "classId": class_id,
            }
        )
    return classes


def _predict_one(model, task, safe_image, threshold):
    if task == "object_detection":
        if threshold is None:
            results = list(model.predict(safe_image))
        else:
            results = list(model.predict(safe_image, threshold=threshold))
    else:
        results = list(model.predict(safe_image))

    first = results[0] if results else {}
    if task == "object_detection":
        return {"boxes": _normalize_detection(first)}
    return {"classes": _normalize_classification(first)}


def _safe_extension(image_path):
    ext = os.path.splitext(image_path)[1].lower()
    if ext not in SUPPORTED_IMAGE_EXTENSIONS:
        return ".jpg"
    return ext


def _read_manifest(manifest_path):
    with open(manifest_path, "r", encoding="utf-8") as handle:
        return [line.strip() for line in handle if line.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=["object_detection", "image_classification"], required=True)
    parser.add_argument("--image")
    parser.add_argument("--manifest")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--threshold", type=float, default=None)
    args = parser.parse_args()

    image_paths = _read_manifest(args.manifest) if args.manifest else [args.image]
    image_paths = [item for item in image_paths if item]
    if not image_paths:
        raise SystemExit("--image or --manifest is required")

    with tempfile.TemporaryDirectory(prefix="sign_paddlex_") as temp_dir:
        with contextlib.redirect_stdout(sys.stderr):
            from paddlex import create_model
            model = create_model(args.model_name, model_dir=args.model_dir)
            result_items = []
            for index, image_path in enumerate(image_paths):
                safe_image = os.path.join(temp_dir, f"input_{index:04d}{_safe_extension(image_path)}")
                shutil.copyfile(image_path, safe_image)
                try:
                    normalized = _predict_one(model, args.task, safe_image, args.threshold)
                    result_items.append({
                        "image": image_path,
                        **normalized,
                    })
                except Exception as error:
                    result_items.append({
                        "image": image_path,
                        "error": str(error),
                    })

    payload = {
        "task": args.task,
        "image": image_paths[0] if len(image_paths) == 1 else "",
        "modelDir": args.model_dir,
        "modelName": args.model_name,
        "results": result_items,
    }
    if len(result_items) == 1:
        if args.task == "object_detection":
            payload["boxes"] = result_items[0].get("boxes", [])
        else:
            payload["classes"] = result_items[0].get("classes", [])
        if result_items[0].get("error"):
            payload["error"] = result_items[0]["error"]

    print(SENTINEL + json.dumps(payload, ensure_ascii=True))


if __name__ == "__main__":
    main()
