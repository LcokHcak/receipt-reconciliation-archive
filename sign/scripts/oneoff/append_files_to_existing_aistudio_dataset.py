#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path

from aistudio_sdk.requests import dataset as ds_request

from upload_ai_studio_private_datasets import batched, iter_files, upload_one_file


def main() -> None:
    parser = argparse.ArgumentParser(description="Append local files into an existing AI Studio dataset id.")
    parser.add_argument("--dataset-id", required=True, type=int, help="Existing AI Studio dataset id.")
    parser.add_argument("--source-root", required=True, help="Local folder whose files should be appended.")
    parser.add_argument(
        "--exclude-name",
        nargs="*",
        default=[],
        help="Optional file basenames to skip, for example README.md.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=5,
        help="How many uploaded file ids to include per add_files_to_dataset call.",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("AISTUDIO_DATASET_TOKEN", ""),
        help="AI Studio token. Prefer passing via AISTUDIO_DATASET_TOKEN.",
    )
    args = parser.parse_args()

    if not args.token:
        raise SystemExit("missing token: pass --token or set AISTUDIO_DATASET_TOKEN")

    source_root = Path(args.source_root).resolve()
    if not source_root.exists():
        raise SystemExit(f"missing source root: {source_root}")

    skip_names = set(args.exclude_name or [])
    file_ids: list[int] = []
    uploaded_paths: list[str] = []
    for local_path in iter_files(source_root):
        if local_path.name in skip_names:
            continue
        relative_path = local_path.relative_to(source_root).as_posix()
        file_id = upload_one_file(args.token, local_path, relative_path)
        file_ids.append(file_id)
        uploaded_paths.append(relative_path)

    for chunk in batched(file_ids, args.batch_size):
        result = ds_request.add_files_to_dataset(args.token, args.dataset_id, chunk)
        if not result:
            raise RuntimeError(
                f"add_files_to_dataset failed for dataset_id={args.dataset_id} with chunk size={len(chunk)}"
            )

    print(
        {
            "dataset_id": args.dataset_id,
            "source_root": str(source_root),
            "uploaded_count": len(uploaded_paths),
            "uploaded_paths": uploaded_paths,
        }
    )


if __name__ == "__main__":
    main()
