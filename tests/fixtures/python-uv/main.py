# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "Pillow==12.3.0",
# ]
# ///

import json
import sys

json.load(sys.stdin)
print(json.dumps({"ok": True}))
