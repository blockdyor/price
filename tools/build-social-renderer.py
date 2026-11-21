#!/usr/bin/env python3
"""Rebuild the inline Worker renderer from editable, local-only development sources."""
from pathlib import Path
import argparse
import json

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true', help='verify generated Worker section without writing')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
tools = root / 'tools'
assets = json.loads((tools / 'social-assets.json').read_text())
notice = (tools / 'social-font-notice.txt').read_text().rstrip()
worker = root / 'src/index.js'
source = worker.read_text()
start, end = '// BEGIN SOCIAL RENDERER\n', '// END SOCIAL RENDERER'
if source.count(start) != 1 or source.count(end) != 1:
    raise SystemExit('Worker renderer markers are missing or ambiguous')
left, tail = source.split(start, 1)
current, right = tail.split(end, 1)
_, runtime = current.split('// Offline masks:', 1)
section = notice + '\nconst SOCIAL_MASKS=' + json.dumps(assets, separators=(',', ':'), ensure_ascii=False) + ';\n// Offline masks:' + runtime.rstrip() + '\n'
if args.check:
    if current.rstrip() != section.rstrip():
        raise SystemExit('Renderer differs: run python3 tools/build-social-renderer.py')
    print('Embedded renderer matches editable asset/font-notice sources.')
else:
    worker.write_text(left + start + section + '\n' + end + right)
    print('Rebuilt only the embedded renderer in src/index.js.')
