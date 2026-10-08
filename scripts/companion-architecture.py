"""Static boundaries for new Companion modules; never import application code."""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

PURE_MODULES = {'__future__', 'dataclasses', 'typing', 'collections', 'enum', 'abc',
                'datetime', 're', 'math', 'decimal', 'fractions', 'functools', 'itertools', 'json'}
FORBIDDEN_CALLS = {'eval', 'exec', 'globals', 'locals', '__import__'}
IO_METHODS = {'open', 'read_text', 'read_bytes', 'write_text', 'write_bytes', 'mkdir',
              'unlink', 'rmdir', 'rename', 'replace', 'rglob', 'glob', 'connect',
              'execute', 'executemany', 'executescript', 'commit', 'rollback', 'urlopen'}


def audit_sources(sources: dict[str, str], manifest: list[str]) -> dict:
    violations, metrics, graph = [], [], {name: set() for name in sources}
    module_paths = {name.removesuffix('.py').replace('/', '.'): name for name in sources}

    def add(code, file, message, line=None):
        violations.append({'code': code, 'file': f'companion/{file}', 'message': message,
                           **({'line': line} if line else {})})

    for file, source in sorted(sources.items()):
        layer = file.split('/')[0]
        metric = {'file': f'companion/{file}', 'lines': len(source.rstrip().splitlines()),
                  'bytes': len(source.encode('utf-8'))}
        metrics.append(metric)
        if metric['lines'] > 450 or metric['bytes'] > 32000:
            add('python-module-size', file, 'Split responsibility; new modules are limited to 450 lines and 32 KB.')
        if file not in manifest:
            add('python-manifest-missing', file, 'Register the program in companion/program-files.json.')
        try:
            tree = ast.parse(source)
        except SyntaxError as error:
            add('python-syntax', file, str(error), error.lineno)
            continue
        bindings = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    bindings[alias.asname or alias.name.split('.')[0]] = alias.name if alias.asname else alias.name.split('.')[0]
            elif isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    bindings[alias.asname or alias.name] = node.module + '.' + alias.name

        def qualified(node):
            if isinstance(node, ast.Name):
                return bindings.get(node.id, node.id)
            if isinstance(node, ast.Attribute):
                return qualified(node.value) + '.' + node.attr
            return ''

        for node in ast.walk(tree):
            imports = []
            if isinstance(node, ast.Import):
                imports = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ''
                if node.level:
                    parent = file.removesuffix('.py').split('/')
                    module = '.'.join(parent[:-node.level] + ([module] if module else []))
                imports = [module]
                if module in {'application', 'infrastructure'}:
                    imports += [module + '.' + alias.name for alias in node.names]
            for module in imports:
                first = module.split('.')[0]
                if first in {'server', 'http_routes', 'route_services'} or first.startswith('routes_'):
                    add('python-startup-import', file, 'Modules must not import the HTTP/composition root.', node.lineno)
                if layer == 'application' and first not in PURE_MODULES | {'application'}:
                    add('python-layer-direction', file, f'Application must use ports, not {module}.', node.lineno)
                if first == 'importlib':
                    add('python-dynamic-code', file, 'Managed dependencies must be statically reviewable.', node.lineno)
                if first in {'application', 'infrastructure'}:
                    target = module_paths.get(module) or module_paths.get(module + '.__init__')
                    if target:
                        graph[file].add(target)
                    elif module not in {'application', 'infrastructure'}:
                        add('python-unresolved-import', file, module, node.lineno)
            if isinstance(node, ast.Global):
                add('python-global-state', file, 'Inject mutable state instead of replacing module globals.', node.lineno)
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
                    add('python-dynamic-code', file, node.func.id, node.lineno)
                if isinstance(node.func, ast.Name) and node.func.id in {'getattr', 'setattr', 'delattr'}:
                    if len(node.args) < 2 or not isinstance(node.args[1], ast.Constant) or not isinstance(node.args[1].value, str):
                        add('python-dynamic-code', file, 'Dynamic service lookup hides dependencies.', node.lineno)
                if layer == 'application':
                    if isinstance(node.func, ast.Name) and node.func.id in {'open', 'input', 'print'}:
                        add('python-application-io', file, node.func.id, node.lineno)
                    if isinstance(node.func, ast.Attribute) and node.func.attr in IO_METHODS - {'replace'}:
                        add('python-application-io', file, node.func.attr, node.lineno)
                    if qualified(node.func) in {'datetime.datetime.now', 'datetime.datetime.today', 'datetime.datetime.utcnow', 'datetime.date.today'}:
                        add('python-application-clock', file, 'Inject the current time.', node.lineno)
    for file in manifest:
        if file.startswith(('application/', 'infrastructure/')) and file.endswith('.py') and file not in sources:
            add('python-manifest-stale', file, 'Managed program file is missing.')

    active, visited = [], set()

    def visit(file):
        if file in active:
            add('python-runtime-cycle', file, ' -> '.join(active[active.index(file):] + [file]))
            return
        if file in visited:
            return
        active.append(file)
        for target in sorted(graph[file]):
            visit(target)
        active.pop()
        visited.add(file)

    for file in sorted(sources):
        visit(file)
    return {'summary': {'files': len(sources), 'edges': sum(map(len, graph.values()))},
            'metrics': metrics, 'violations': violations}


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '.') / 'companion'
    sources = {path.relative_to(root).as_posix(): path.read_text(encoding='utf-8-sig')
               for layer in ('application', 'infrastructure') for path in (root / layer).rglob('*.py')}
    manifest = json.loads((root / 'program-files.json').read_text(encoding='utf-8'))['files']
    print(json.dumps(audit_sources(sources, manifest), ensure_ascii=False))


if __name__ == '__main__':
    main()
