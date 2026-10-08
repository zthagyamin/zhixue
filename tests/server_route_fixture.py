"""Load transport methods and the real route registry without installation startup."""
import ast
from pathlib import Path
from types import SimpleNamespace

import http_routes


def server_tree():
    return ast.parse((Path(__file__).resolve().parents[1] / 'companion/server.py').read_text(encoding='utf-8-sig'))


def load_route_methods(namespace):
    handler = next(node for node in server_tree().body if isinstance(node, ast.ClassDef) and node.name == 'Handler')
    nodes = [node for node in handler.body if isinstance(node, ast.FunctionDef) and node.name in ('do_GET', 'do_POST')]
    namespace['http_routes'] = http_routes
    # Resolve the test's current services per request, just like the composition root.
    namespace['route_services'] = lambda: SimpleNamespace(**namespace)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'isolated-http-boundary', 'exec'), namespace)
    return namespace
