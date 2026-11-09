#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from aistudio_sdk.requests import dataset as ds_request
from aistudio_sdk.utils.bos_sdk import MyBosClient, upload_file, upload_super_file
from baidubce.auth.bce_credentials import BceCredentials
from baidubce.bce_client_configuration import BceClientConfiguration


@dataclass(frozen=True)
class DatasetSpec:
    folder_name: str
    dataset_name: str
    description: str


DATASET_SPECS = [
    DatasetSpec(
        "01_mix_detection_coco_lmssl",
        "mix-det-coco-lmssl",
        "Private mixed-document detection dataset in COCO LMSSL format.",
    ),
    DatasetSpec(
        "02_single_classification_cls_lmssl",
        "single-cls-lmssl",
        "Private single-image document classification dataset in Cls LMSSL format.",
    ),
    DatasetSpec(
        "03_passport_field_detection_coco_lmssl",
        "passport-field-det-coco",
        "Private passport field detection dataset in COCO LMSSL format.",
    ),
    DatasetSpec(
        "04_passport_field_recognition_mstextrec_lmssl",
        "passport-field-rec-mstext",
        "Private passport field recognition dataset in MSTextRec LMSSL format.",
    ),
    DatasetSpec(
        "05_receipt_field_detection_coco_lmssl",
        "receipt-field-det-coco",
        "Private receipt field detection dataset in COCO LMSSL format.",
    ),
    DatasetSpec(
        "06_receipt_field_recognition_mstextrec_lmssl",
        "receipt-field-rec-mstext",
        "Private receipt field recognition dataset in MSTextRec LMSSL format.",
    ),
]


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            yield path


def upload_one_file(token: str, local_path: Path, relative_path: str) -> int:
    acl_resp = ds_request.bos_acl_dataset_file(token)
    if acl_resp.get("errorCode") != 0:
        raise RuntimeError(f"BOS ACL request failed for {relative_path}: {acl_resp}")

    result = acl_resp["result"]
    bos_conf = BceClientConfiguration(
        credentials=BceCredentials(result["accessKeyId"], result["secretAccessKey"]),
        endpoint=result["endpoint"],
        security_token=result["sessionToken"],
    )
    bos_client = MyBosClient(bos_conf)
    file_key = result["fileKey"]
    bucket_name = result["bucketName"]

    if local_path.stat().st_size <= 8 * 1024 * 1024:
        upload_file(bos_client, bucket_name, local_path, file_key)
    else:
        upload_super_file(bos_client, bucket_name, local_path, file_key)
    file_id = ds_request.add_file(
        token,
        local_path.name,
        file_key,
        bucket_name,
        relative_path,
    )
    if not file_id:
        raise RuntimeError(f"add_file failed for {relative_path}")
    return file_id


def batched(items: list[int], size: int) -> Iterable[list[int]]:
    for idx in range(0, len(items), size):
        yield items[idx: idx + size]


def create_private_dataset(
    token: str,
    dataset_root: Path,
    spec: DatasetSpec,
    *,
    create_batch_size: int,
    add_batch_size: int,
    skip_add_after_create: bool,
) -> dict:
    file_ids = []
    uploaded_files = []
    all_files = list(iter_files(dataset_root))
    if skip_add_after_create:
        all_files = all_files[:create_batch_size]

    for local_path in all_files:
        relative_path = local_path.relative_to(dataset_root).as_posix()
        file_id = upload_one_file(token, local_path, relative_path)
        file_ids.append(file_id)
        uploaded_files.append(relative_path)

    initial_file_ids = file_ids[:create_batch_size]
    remaining_file_ids = file_ids[create_batch_size:]

    dataset_id = ds_request.create_dataset(
        token,
        spec.dataset_name,
        initial_file_ids,
        dataset_type=1,
        dataset_abs=spec.description,
        dataset_license=1,
    )
    if not dataset_id:
        raise RuntimeError(f"create_dataset failed for {spec.dataset_name}")

    if not skip_add_after_create:
        for chunk in batched(remaining_file_ids, add_batch_size):
            result = ds_request.add_files_to_dataset(token, dataset_id, chunk)
            if not result:
                raise RuntimeError(
                    f"add_files_to_dataset failed for {spec.dataset_name} (dataset_id={dataset_id})"
                )

    return {
        "dataset_id": dataset_id,
        "dataset_name": spec.dataset_name,
        "folder_name": spec.folder_name,
        "file_count": len(uploaded_files),
        "uploaded_files": uploaded_files,
        "skip_add_after_create": skip_add_after_create,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Upload local AI Studio-ready folders as private datasets.")
    parser.add_argument(
        "--root",
        default=r"D:\JIN HAIMIN\self\ticket\ai_studio_upload_ready",
        help="Root directory that contains the six AI Studio-ready dataset folders.",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("AISTUDIO_DATASET_TOKEN", ""),
        help="AI Studio access token. Prefer passing it via AISTUDIO_DATASET_TOKEN.",
    )
    parser.add_argument(
        "--only",
        nargs="*",
        default=None,
        help="Optional subset of folder names to upload.",
    )
    parser.add_argument(
        "--summary-out",
        default=None,
        help="Optional JSON output path for created dataset ids.",
    )
    parser.add_argument(
        "--name-suffix",
        default="",
        help="Optional suffix appended to each dataset name when creating visible AI Studio dataset entries.",
    )
    parser.add_argument(
        "--create-batch-size",
        type=int,
        default=10,
        help="How many uploaded file ids to include in the initial create_dataset call.",
    )
    parser.add_argument(
        "--add-batch-size",
        type=int,
        default=10,
        help="How many uploaded file ids to include in each add_files_to_dataset call.",
    )
    parser.add_argument(
        "--skip-add-after-create",
        action="store_true",
        help="Only create the visible dataset entry with the initial file batch; do not add the remaining files.",
    )
    args = parser.parse_args()

    if not args.token:
        raise SystemExit("missing token: pass --token or set AISTUDIO_DATASET_TOKEN")

    root = Path(args.root).resolve()
    specs = DATASET_SPECS
    if args.only:
        wanted = set(args.only)
        specs = [spec for spec in DATASET_SPECS if spec.folder_name in wanted]
        if not specs:
            raise SystemExit("no matching dataset specs for --only")

    summary = {"root": str(root), "datasets": []}
    for spec in specs:
        dataset_root = root / spec.folder_name
        if not dataset_root.exists():
            raise SystemExit(f"dataset folder missing: {dataset_root}")
        effective_spec = DatasetSpec(
            spec.folder_name,
            f"{spec.dataset_name}{args.name_suffix}",
            spec.description,
        )
        print(f"Uploading {spec.folder_name} -> {effective_spec.dataset_name}")
        result = create_private_dataset(
            args.token,
            dataset_root,
            effective_spec,
            create_batch_size=args.create_batch_size,
            add_batch_size=args.add_batch_size,
            skip_add_after_create=args.skip_add_after_create,
        )
        summary["datasets"].append(result)
        print(f"Created dataset {result['dataset_name']} (id={result['dataset_id']}) with {result['file_count']} files")

    if args.summary_out:
        out_path = Path(args.summary_out)
        out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Summary written to {out_path}")


if __name__ == "__main__":
    main()
