#!/usr/bin/env python3
"""Checks competition Task A: `get_debug_flag` must treat 'off' and 'n' as false too, case-insensitively,
and its docstring must list every false value.

  task_a_check.py --installed        import flask.helpers from the active interpreter (the real fixture, via the venv)
  task_a_check.py --file PATH        extract get_debug_flag from a source file (works on any text, e.g. an
                                     in-memory result written to a temp file) and run it in isolation

Prints PASS/FAIL per check and an overall RESULT line; exit code 0 only if every check passes.
"""
import ast
import os
import re
import sys

ENV = "FLASK_DEBUG"

# (value of FLASK_DEBUG or None for unset, expected get_debug_flag())
CASES = [
    ("off", False), ("OFF", False), ("Off", False),
    ("n", False), ("N", False),
    ("0", False), ("false", False), ("False", False), ("no", False), ("NO", False),
    ("on", True), ("1", True),
    ("", False), (None, False),
]
# values the docstring must list (the task: "list every false value")
DOC_TOKENS = ["0", "false", "no", "off", "n"]


def load_from_file(path):
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    node = next((n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "get_debug_flag"), None)
    if node is None:
        raise SystemExit("FAIL: get_debug_flag not found in %s" % path)
    module = ast.Module(body=[ast.parse("import os").body[0], node], type_ignores=[])
    ast.fix_missing_locations(module)
    namespace = {}
    exec(compile(module, path, "exec"), namespace)
    return namespace["get_debug_flag"], ast.get_docstring(node) or ""


def load_installed():
    import inspect
    from flask.helpers import get_debug_flag

    return get_debug_flag, inspect.getdoc(get_debug_flag) or ""


def has_token(doc, token):
    return re.search(r"(?<![A-Za-z0-9_])" + re.escape(token) + r"(?![A-Za-z0-9_])", doc, re.IGNORECASE) is not None


def main(argv):
    if len(argv) == 2 and argv[1] == "--installed":
        func, doc = load_installed()
        source = "installed flask.helpers"
    elif len(argv) == 3 and argv[1] == "--file":
        func, doc = load_from_file(argv[2])
        source = argv[2]
    else:
        print(__doc__)
        return 2

    print("Task A check on %s" % source)
    results = []
    saved = os.environ.get(ENV)
    try:
        for value, expected in CASES:
            if value is None:
                os.environ.pop(ENV, None)
                label = "%s unset" % ENV
            else:
                os.environ[ENV] = value
                label = "%s=%s" % (ENV, repr(value) if value == "" else value)
            try:
                actual = func()
            except Exception as error:  # a crash is a failed check, not a crash of the checker
                actual = "raised %s: %s" % (type(error).__name__, error)
            results.append((label + " -> " + str(expected), actual is expected))
    finally:
        if saved is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = saved

    for token in DOC_TOKENS:
        results.append(("docstring lists %r" % token, has_token(doc, token)))

    for name, ok in results:
        print("%s  %s" % ("PASS" if ok else "FAIL", name))
    passed = sum(1 for _, ok in results if ok)
    verdict = "PASS" if passed == len(results) else "FAIL"
    print("RESULT: %s (%d/%d checks)" % (verdict, passed, len(results)))
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
