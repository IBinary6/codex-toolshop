"""Local Knowledge domain exceptions."""


class KnowledgeError(Exception):
    """Base exception for local knowledge operations."""


class KnowledgeArgumentError(KnowledgeError):
    """The caller supplied an invalid knowledge type, scope, or argument."""


class KnowledgeNotFound(KnowledgeError):
    """The requested local knowledge record does not exist."""


class SensitiveContentError(KnowledgeError):
    """Reject content that appears to contain credentials such as passwords, tokens, or private keys."""
