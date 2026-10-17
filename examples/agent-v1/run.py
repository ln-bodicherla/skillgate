import json
from pathlib import Path
items = json.loads(Path('/workspace/invoices.json').read_text())
Path('/workspace/result.txt').write_text(f"Total: {sum(items)}\n")
