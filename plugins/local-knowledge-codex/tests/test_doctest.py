"""验证 Local Knowledge 公共示例与真实实现保持一致。"""

import doctest

from local_knowledge import models, storage
from local_knowledge import cli


def load_tests(loader, tests, ignore):
    """把三个公共模块的文档示例加入 unittest 发现流程。

    Example:
        ``python -m unittest discover -s tests -p "test_*.py"`` 会调用本函数。
    """
    del loader, ignore
    tests.addTests(doctest.DocTestSuite(models))
    tests.addTests(doctest.DocTestSuite(storage))
    tests.addTests(doctest.DocTestSuite(cli))
    return tests
