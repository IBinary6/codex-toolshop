"""Real CRG parser regression for C++ unnamed-namespace lookup; no text-match edges."""
import importlib.util
from pathlib import Path
import unittest

from code_review_graph.parser import CodeParser

SPEC = importlib.util.spec_from_file_location('adapter', Path(__file__).with_name('refresh_graph.py'))
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


class AnonymousNamespaceTest(unittest.TestCase):
    def parse(self, text):
        ADAPTER.install_cpp_anonymous_resolution()
        parser = CodeParser(Path.cwd())
        nodes, edges = parser.parse_bytes(Path.cwd() / 'anonymous_lookup.cc', text.encode())
        return parser, nodes, [e for e in edges if e.kind == 'CALLS']

    def test_two_methods_call_same_anonymous_helper(self):
        parser, nodes, calls = self.parse('''
namespace bkit::infra {
namespace { int ResolveEncryptedHashKey(const std::string& key) { return 0; } }
class Crypto { public: int Encrypt(); int Decrypt(); };
int Crypto::Encrypt() { return ResolveEncryptedHashKey("a"); }
int Crypto::Decrypt() { return ResolveEncryptedHashKey("b"); }
}
''')
        helper = next(n for n in nodes if n.name == 'ResolveEncryptedHashKey')
        matching = [e for e in calls if e.target == parser._node_qualified(helper)]
        self.assertEqual(len(matching), 2)
        self.assertTrue(all('unresolved_targets' not in e.extra for e in matching))

    def test_receiver_is_not_a_free_function(self):
        _, _, calls = self.parse('namespace { int helper() {return 0;} } int run(Other& x) {return x.helper();}')
        self.assertEqual(calls[0].target, 'helper')

    def test_named_sibling_is_not_visible(self):
        _, _, calls = self.parse('namespace a { namespace { int helper() {return 0;} } } namespace b {int run(){return helper();}}')
        self.assertEqual(calls[0].target, 'helper')

    def test_overloads_remain_ambiguous(self):
        _, _, calls = self.parse('namespace {int helper(int x){return x;} int helper(double x){return 0;}} int run(){return helper(1);}')
        self.assertEqual(calls[0].target, 'helper')
        self.assertEqual(calls[0].extra.get('ambiguous_target_count'), 2)

    def test_named_and_unnamed_same_level_remain_ambiguous(self):
        _, _, calls = self.parse('namespace n { namespace {int helper(){return 1;}} int helper(){return 2;} int run(){return helper();}}')
        self.assertEqual(calls[0].target, 'helper')
        self.assertEqual(calls[0].extra.get('ambiguous_target_count'), 2)

    def test_nearer_scope_wins(self):
        parser, nodes, calls = self.parse('namespace {int helper(){return 0;}} namespace n {int helper(){return 1;} int run(){return helper();}}')
        expected = next(n for n in nodes if n.name == 'helper' and n.parent_name == 'n')
        self.assertEqual(calls[0].target, parser._node_qualified(expected))

    def test_multiple_calls_on_one_line_are_not_overwritten(self):
        parser, nodes, calls = self.parse('namespace {int helper(){return 0;} int other(){return 1;}} int run(Obj& x){return helper()+other()+x.helper();}')
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[-1].target, 'helper')
        self.assertIn('helper()', calls[0].target)
        self.assertIn('other()', calls[1].target)


if __name__ == '__main__':
    unittest.main()
