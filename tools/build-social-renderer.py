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
runtime = (tools / 'social-renderer.js').read_text().rstrip()
section = notice + '\nconst SOCIAL_MASKS=' + json.dumps(assets, separators=(',', ':'), ensure_ascii=False) + ';\n' + runtime + '\n'
worker = root / 'src/index.js'
source = worker.read_text()
start, end = '// BEGIN SOCIAL RENDERER\n', '// END SOCIAL RENDERER'
if source.count(start) != 1 or source.count(end) != 1:
    raise SystemExit('Worker renderer markers are missing or ambiguous')
left, tail = source.split(start, 1)
current, right = tail.split(end, 1)
if args.check:
    if current.rstrip() != section.rstrip():
        raise SystemExit('Renderer differs: run python3 tools/build-social-renderer.py')
    print('Embedded renderer matches editable asset/runtime/font-notice sources.')
else:
    worker.write_text(left + start + section + '\n' + end + right)
    print('Rebuilt only the embedded renderer in src/index.js.')
