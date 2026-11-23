#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

script = Path(__file__).with_name('run-affected-rust-workspace.py')
spec = importlib.util.spec_from_file_location('rust_selection', script)
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)


class RustSelectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.metadata = json.loads(subprocess.check_output(
            ['cargo', 'metadata', '--locked', '--no-deps', '--format-version', '1'],
            cwd=selector.ROOT,
        ))

    def test_compiler_does_not_select_unrelated_workspace(self):
        selected = selector.select_packages(self.metadata, ['packages/schema-compiler/src/lib.rs'])
        self.assertEqual(selected, ['schema-compiler'])
        self.assertTrue(selector.uses_kernel(self.metadata, selected))

    def test_kernel_and_embedded_fixture_select_consumers(self):
        for source in ['packages/kernel/src/lib.rs', 'packages/contracts/__fixtures__/wire-roundtrip.json']:
            selected = selector.select_packages(self.metadata, [source])
            self.assertIn('kernel', selected)
            self.assertIn('schema-compiler', selected)
            self.assertIn('protected-installer', selected)
            self.assertNotIn('hc', selected)
            self.assertNotIn('vendor', selected)

    def test_independent_crate_does_not_enable_kernel_feature(self):
        self.assertFalse(selector.uses_kernel(self.metadata, ['http-transport']))

    def test_unclassified_input_fails_closed(self):
        with self.assertRaises(ValueError):
            selector.select_packages(self.metadata, ['unknown/input.sql'])

    def test_dynamic_include_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'crate' / 'src').mkdir(parents=True)
            (root / 'crate' / 'src' / 'lib.rs').write_text('const X: &str = include_str!(concat!("a", "b"));')
            metadata = {'workspace_members': ['crate'], 'packages': [{'id': 'crate', 'name': 'crate', 'manifest_path': str(root / 'crate' / 'Cargo.toml'), 'dependencies': []}]}
            original = selector.ROOT
            try:
                selector.ROOT = root
                with self.assertRaises(ValueError):
                    selector.select_packages(metadata, ['crate/src/lib.rs'])
            finally:
                selector.ROOT = original

    def test_unknown_comparison_runs_full_workspace(self):
        with patch.dict('os.environ', {'CI_RUST_CHANGED_FILES': '["unknown/input.sql"]'}), \
                patch.object(selector.os, 'execvp') as execute:
            selector.main()
        self.assertEqual(execute.call_args.args[1], [
            'cargo', 'test', '--workspace',
            '--features', 'kernel/testing',
        ])


if __name__ == '__main__':
    unittest.main()
