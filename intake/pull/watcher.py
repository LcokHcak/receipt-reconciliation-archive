"""常驻拉取:每隔 N 秒拉一批,断点续拉。会话存档只存 5 天,必须一直开着。
pm2 起这个进程(intake-pull)。SDK 只 Init 一次复用。"""

import time

from config import Config
from crypto import load_private_key
from wework_sdk import WeWorkSdk
import pull_once


def main():
    cfg = Config()
    cfg.ensure_dirs()
    private_key = load_private_key(cfg.private_key_path)
    sdk = WeWorkSdk(cfg.sdk_path, cfg.corpid, cfg.secret)
    print(f"[intake-pull] 启动,轮询 {cfg.poll_interval_sec}s 一次", flush=True)
    try:
        while True:
            try:
                result = pull_once.run_once(cfg=cfg, sdk=sdk, private_key=private_key)
                if result["pulled"]:
                    print(
                        f"[intake-pull] 拉到 {result['pulled']} 条,seq={result['seq']}",
                        flush=True,
                    )
            except Exception as e:  # 单次失败不退出,下轮重试(防 5 天窗口漏)
                print(
                    f"[intake-pull] 本轮失败,{cfg.poll_interval_sec}s 后重试: {e}",
                    flush=True,
                )
            time.sleep(cfg.poll_interval_sec)
    finally:
        sdk.close()


if __name__ == "__main__":
    main()
