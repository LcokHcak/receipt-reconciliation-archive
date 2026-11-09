"""拉取模块配置:全部从环境变量读(配合 intake/.env,--env 或 export)。密钥不硬编码。"""

import os


class Config:
    def __init__(self):
        self.corpid = os.environ["WECOM_CORPID"]
        self.secret = os.environ["WECOM_ARCHIVE_SECRET"]
        self.private_key_path = os.environ.get(
            "WECOM_PRIVATE_KEY_PATH", "./secrets/wecom_private.pem"
        )
        self.public_key_version = int(os.environ.get("WECOM_PUBLIC_KEY_VERSION", "1"))
        # 官方 .so 路径(部署到服务器后填绝对路径)
        self.sdk_path = os.environ.get(
            "WECOM_SDK_PATH", "./sdk/libWeWorkFinanceSdk_C.so"
        )
        # 可选代理(内网出网受限时用),默认空
        self.proxy = os.environ.get("WECOM_PROXY", "")
        self.proxy_passwd = os.environ.get("WECOM_PROXY_PASSWD", "")
        # 输出与断点
        self.data_dir = os.environ.get("INTAKE_DATA_DIR", "./data")
        self.images_dir = os.environ.get("INTAKE_IMAGES_DIR", "./images")
        self.seq_file = os.path.join(self.data_dir, "seq.txt")
        self.messages_file = os.path.join(self.data_dir, "messages.jsonl")
        # 拉取参数
        self.batch_limit = int(os.environ.get("WECOM_BATCH_LIMIT", "1000"))  # ≤1000
        self.poll_interval_sec = int(os.environ.get("WECOM_POLL_INTERVAL_SEC", "30"))
        self.timeout_sec = int(os.environ.get("WECOM_TIMEOUT_SEC", "30"))

    def ensure_dirs(self):
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.images_dir, exist_ok=True)
