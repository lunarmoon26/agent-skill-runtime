import json
import sys

json.load(sys.stdin)
json.dump({"utf8Mode": sys.flags.utf8_mode}, sys.stdout)
sys.stdout.write("\n")
