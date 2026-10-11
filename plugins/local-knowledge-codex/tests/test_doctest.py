"""Verify Local Knowledge public examples against the actual implementation."""

import doctest

from local_knowledge import models, storage
from local_knowledge import cli


def load_tests(loader, tests, ignore):
    """Add documentation examples from three public modules to unittest discovery.

    Example:
        ``npm run test:python`` calls this function through the plugin Python launcher.
    """
    del loader, ignore
    tests.addTests(doctest.DocTestSuite(models))
    tests.addTests(doctest.DocTestSuite(storage))
    tests.addTests(doctest.DocTestSuite(cli))
    return tests
