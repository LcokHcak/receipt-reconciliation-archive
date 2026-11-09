#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path

from aistudio_sdk.hub import create_repo, upload_folder


@dataclass(frozen=True)
class RepoSpec:
    folder_name: str
    repo_name: str
    description: str


REPO_SPECS = [
    RepoSpec(
        "01_mix_detection_coco_lmssl",
        "mix-det-coco-lmssl",
        "Private mixed-document detection dataset in COCO LMSSL format.",
    ),
    RepoSpec(
        "02_single_classification_cls_lmssl",
        "single-cls-lmssl",
        "Private single-image document classification dataset in Cls LMSSL format.",
    ),
    RepoSpec(
        "03_passport_field_detection_coco_lmssl",
        "passport-field-det-coco",
        "Private passport field detection dataset in COCO LMSSL format.",
    ),
    RepoSpec(
        "04_passport_field_recognition_mstextrec_lmssl",
        "passport-field-rec-mstext",
        "Private passport field recognition dataset in MSTextRec LMSSL format.",
    ),
    RepoSpec(
        "05_receipt_field_detection_coco_lmssl",
        "receipt-field-det-coco",
        "Private receipt field detection dataset in COCO LMSSL format.",
    ),
    RepoSpec(
        "06_receipt_field_recognition_mstextrec_lmssl",
        "receipt-field-rec-mstext",
        "Private receipt field recognition dataset in MSTextRec LMSSL format.",
    ),
]


def ensure_repo(repo_name: str, description: str, token: str) -> str:
    result = create_repo(
        repo_id=repo_name,
        repo_type="dataset",
        desc=description,
        private=True,
        license="Apache License 2.0",
        token=token,
    )
    if isinstance(result, dict) and result.get("repo_id"):
        return result["repo_id"]

    if isinstance(result, dict):
        message = str(result.get("error_msg") or result.get("errorMsg") or result)
        if "repo already created" in message.lower():
            return repo_name

    raise RuntimeError(f"create_repo failed for {repo_name}: {result}")


def upload_repo(repo_id: str, dataset_root: Path, token: str) -> None:
    upload_folder(
        repo_id=repo_id,
        folder_path=str(dataset_root),
        repo_type="dataset",
        commit_message=f"Upload {dataset_root.name}",
        token=token,
        max_workers=3,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Create private AI Studio dataset repos and upload dataset folders.")
    parser.add_argument(
        "--root",
        default=r"D:\JIN HAIMIN\self\ticket\ai_studio_upload_ready",
        help="Root directory that contains the dataset folders to upload.",
    )
    parser.add_argument(
        "--user",
        default="JINHAIMIN",
        help="AI Studio username / owner prefix for repo ids.",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("AISTUDIO_ACCESS_TOKEN", ""),
        help="AI Studio access token. Prefer passing it via AISTUDIO_ACCESS_TOKEN.",
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
        help="Optional JSON output path for created repo ids.",
    )
    parser.add_argument(
        "--name-suffix",
        default="",
        help="Optional suffix appended to each repo name when creating clean dataset repos.",
    )
    parser.add_argument(
        "--skip-create",
        action="store_true",
        help="Assume the target dataset repos already exist and upload directly without calling create_repo.",
    )
    args = parser.parse_args()

    if not args.token:
        raise SystemExit("missing token: pass --token or set AISTUDIO_ACCESS_TOKEN")

    root = Path(args.root).resolve()
    specs = REPO_SPECS
    if args.only:
        wanted = set(args.only)
        specs = [spec for spec in REPO_SPECS if spec.folder_name in wanted]
        if not specs:
            raise SystemExit("no matching repo specs for --only")

    summary = {"root": str(root), "repos": []}
    for spec in specs:
        dataset_root = root / spec.folder_name
        if not dataset_root.exists():
            raise SystemExit(f"dataset folder missing: {dataset_root}")

        effective_repo_name = f"{spec.repo_name}{args.name_suffix}"
        if args.skip_create:
            repo_name = effective_repo_name
        else:
            repo_name = ensure_repo(effective_repo_name, spec.description, args.token)
        repo_id = f"{args.user}/{repo_name}"
        print(f"Uploading {spec.folder_name} -> {repo_id}")
        upload_repo(repo_id, dataset_root, args.token)
        summary["repos"].append(
            {
                "folder_name": spec.folder_name,
                "repo_id": repo_id,
                "repo_name": repo_name,
            }
        )
        print(f"Uploaded {spec.folder_name} -> {repo_id}")

    if args.summary_out:
        out_path = Path(args.summary_out)
        out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Summary written to {out_path}")


if __name__ == "__main__":
    main()
