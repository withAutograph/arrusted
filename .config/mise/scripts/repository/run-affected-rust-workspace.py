#!/usr/bin/env python3
"""Run affected Cargo workspace tests, falling back to the complete workspace."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]


def select_packages(metadata, changed):
    packages = [p for p in metadata['packages'] if p['id'] in metadata['workspace_members']]
    directories = {p['id']: Path(p['manifest_path']).resolve().parent for p in packages}
    owners = {str(d): ident for ident, d in directories.items()}
    reverse = {p['id']: set() for p in packages}
    includes = {}
    for package in packages:
        owner = package['id']
        for dep in package['dependencies']:
            if dep.get('path'):
                target = owners.get(str(Path(dep['path']).resolve()))
                if target:
                    reverse[target].add(owner)
                elif str(Path(dep['path']).resolve()).startswith(str(ROOT) + os.sep):
                    raise ValueError('unclassified local Cargo dependency')
        for source in directories[owner].rglob('*.rs'):
            if 'target' in source.relative_to(directories[owner]).parts:
                continue
            text = source.read_text(encoding='utf-8')
            calls = list(re.finditer(r'\binclude_(?:str|bytes)!\s*\(|\binclude!\s*\(', text))
            for call in calls:
                if call.start() and text[call.start() - 1] == '"':
                    continue
                match = re.match(r'\s*"([^"\\]+)"\s*\)', text[call.end():])
                if not match:
                    raise ValueError('dynamic Rust include')
                includes.setdefault((source.parent / match.group(1)).resolve(), set()).add(owner)
    affected = set()
    for name in changed:
        file = (ROOT / name).resolve()
        matches = [ident for ident, directory in directories.items() if file.is_relative_to(directory)]
        affected.update(matches)
        affected.update(includes.get(file, set()))
        if not matches and file not in includes:
            raise ValueError('unclassified Rust test input')
    pending = list(affected)
    while pending:
        for consumer in reverse[pending.pop()]:
            if consumer not in affected:
                affected.add(consumer)
                pending.append(consumer)
    return sorted(p['name'] for p in packages if p['id'] in affected and not directories[p['id']].is_relative_to(ROOT / 'apps'))


def uses_kernel(metadata, selected):
    packages = [p for p in metadata['packages'] if p['id'] in metadata['workspace_members']]
    by_path = {str(Path(p['manifest_path']).resolve().parent): p for p in packages}
    pending = [p for p in packages if p['name'] in selected]
    visited = set()
    while pending:
        package = pending.pop()
        if package['id'] in visited:
            continue
        visited.add(package['id'])
        if package['name'] == 'kernel':
            return True
        for dep in package['dependencies']:
            target = by_path.get(str(Path(dep['path']).resolve())) if dep.get('path') else None
            if target:
                pending.append(target)
    return False


def main():
    fallback = ['test', '--workspace', '--features', 'kernel/testing']
    args = fallback
    try:
        changed = json.loads(os.environ['CI_RUST_CHANGED_FILES'])
        if not isinstance(changed, list) or not changed or not all(isinstance(x, str) for x in changed):
            raise ValueError('invalid comparison')
        result = subprocess.run(['cargo', 'metadata', '--locked', '--no-deps', '--format-version', '1'], cwd=ROOT, capture_output=True, text=True, check=True)
        metadata = json.loads(result.stdout)
        selected = select_packages(metadata, changed)
        if not selected:
            raise ValueError('no non-app crate selected')
        args = ['test'] + [item for package in selected for item in ('--package', package)]
        if uses_kernel(metadata, selected):
            args += ['--features', 'kernel/testing']
        print('Affected Rust workspace tests:', ', '.join(selected), flush=True)
    except (KeyError, ValueError, OSError, UnicodeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f'Rust selection unavailable ({error}); running full workspace', file=sys.stderr, flush=True)
    os.execvp('cargo', ['cargo', *args])


if __name__ == '__main__':
    main()
