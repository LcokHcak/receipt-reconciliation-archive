"""往返测试:用真实公钥加密一个随机密钥,再用私钥解回,验证解密链路正确。
运行:cd intake && py pull/test_crypto.py
"""

import base64
import os
import sys

from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import load_pem_public_key

sys.path.insert(0, os.path.dirname(__file__))
from crypto import load_private_key, decrypt_random_key  # noqa: E402

PRIV = os.path.join("secrets", "wecom_private.pem")
PUB = os.path.join("secrets", "wecom_public.pem")


def main():
    with open(PUB, "rb") as f:
        pub = load_pem_public_key(f.read())
    priv = load_private_key(PRIV)

    # 模拟企微:用公钥 PKCS1v15 加密一个 32 字节随机密钥
    key = os.urandom(32)
    encrypt_random_key_b64 = base64.b64encode(
        pub.encrypt(key, padding.PKCS1v15())
    ).decode()

    # 我们的解密:用私钥解回
    recovered = decrypt_random_key(encrypt_random_key_b64, priv)

    assert recovered == key, "RSA 往返失败:解出的密钥和原始不一致"
    print("[OK] RSA 往返成功 —— 私钥能正确解企微用公钥加密的随机密钥")
    print(f"     公钥位数: {pub.key_size} bit  随机密钥: {len(key)} 字节  解回一致 ✓")


if __name__ == "__main__":
    main()
