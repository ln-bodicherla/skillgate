"""Offline example of the interactive agent protocol; no model API needed."""
import json
import sys

def exchange(message):
    print(json.dumps(message), flush=True)
    return json.loads(sys.stdin.readline())

start = json.loads(sys.stdin.readline())
assert start['type'] == 'start'
# The next action depends on the first tool's actual result.
result = exchange({'type': 'tool', 'name': 'inspect-input', 'command': ['/usr/bin/python3', '-c', "from pathlib import Path; print(Path('/workspace/invoices.json').exists())"]})
if result['code'] != 0 or result['stdout'].strip() != 'True':
    sys.exit(1)
result = exchange({'type': 'tool', 'name': 'summarize', 'command': ['/usr/bin/python3', '/skill/run.py']})
if result['code'] != 0:
    sys.exit(1)
exchange({'type': 'finish'})
