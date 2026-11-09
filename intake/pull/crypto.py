"""会话存档解密:用私钥 RSA 解出随机密钥,再交给 SDK 的 DecryptData 解正文。

企微流程(官方):
  GetChatData 返回每条:{seq, msgid, publickey_ver, encrypt_random_key, encrypt_chat_msg}
  1) 用【本企业私钥】RSA(PKCS1 v1.5)解 encrypt_random_key(base64) → 得随机对称密钥
  2) 把该密钥 + encrypt_chat_msg 传给 SDK DecryptData → 得明文消息 JSON(AES 由 SDK 做)

本模块只负责第 1 步(纯 Python,可离线测试);第 2 步在 wework_sdk.py 里调 .so。
"""

import base64
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import load_pem_private_key


def load_private_key(pem_path):
    with open(pem_path, "rb") as f:
        return load_pem_private_key(f.read(), password=None)


def decrypt_random_key(encrypt_random_key_b64, private_key):
    """RSA(PKCS1 v1.5) 解 encrypt_random_key。返回 bytes,原样交给 SDK DecryptData。"""
    ciphertext = base64.b64decode(encrypt_random_key_b64)
    return private_key.decrypt(ciphertext, padding.PKCS1v15())
