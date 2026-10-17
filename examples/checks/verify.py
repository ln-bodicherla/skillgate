from pathlib import Path
assert Path('/workspace/result.txt').read_text() == 'Total: 400\n'
