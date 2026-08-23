"""Local Knowledge 领域异常。"""


class KnowledgeError(Exception):
    """本地知识库操作失败的基础异常。"""


class KnowledgeArgumentError(KnowledgeError):
    """调用方传入的知识类型、范围或参数不合法。"""


class KnowledgeNotFound(KnowledgeError):
    """请求的本地知识记录不存在。"""


class SensitiveContentError(KnowledgeError):
    """内容看起来包含密码、令牌或私钥等凭据，拒绝落盘。"""
