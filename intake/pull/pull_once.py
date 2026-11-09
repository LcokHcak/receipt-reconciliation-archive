"""拉一批:GetChatData(seq) → RSA 解随机密钥 → SDK 解正文 → 图片下载 → 输出统一事件 → 存 seq。
可单独跑一次(调试),也被 watcher 循环调用。"""

import os

from config import Config
from crypto import decrypt_random_key, load_private_key
from wework_sdk import WeWorkSdk
import message_map
import emit
import seq_store


def run_once(cfg=None, sdk=None, private_key=None):
    cfg = cfg or Config()
    cfg.ensure_dirs()
    private_key = private_key or load_private_key(cfg.private_key_path)
    own_sdk = sdk is None
    sdk = sdk or WeWorkSdk(cfg.sdk_path, cfg.corpid, cfg.secret)
    try:
        seq = seq_store.load_seq(cfg.seq_file)
        items = sdk.get_chat_data(
            seq, cfg.batch_limit, cfg.proxy, cfg.proxy_passwd, cfg.timeout_sec
        )
        pulled = 0
        for item in items:
            key = decrypt_random_key(item["encrypt_random_key"], private_key)
            msg = sdk.decrypt_data(key, item["encrypt_chat_msg"])
            event = message_map.to_event(msg)
            if message_map.is_image(event):
                out_path = os.path.join(cfg.images_dir, f"{event['msg_id']}.jpg")
                try:
                    sdk.get_media_data(
                        event["sdkfileid"], out_path, cfg.proxy, cfg.proxy_passwd
                    )
                    event["media_local_path"] = out_path
                except Exception as e:  # 单张下载失败不影响整批
                    event["media_error"] = str(e)
            emit.append_event(cfg.messages_file, event)
            seq = item["seq"]
            pulled += 1
        seq_store.save_seq(cfg.seq_file, seq)
        return {"pulled": pulled, "seq": seq}
    finally:
        if own_sdk:
            sdk.close()


if __name__ == "__main__":
    print(run_once())
