"""Write the code around each occurrence of a string in a Claude Code binary.

The binaries (~/.local/share/claude/versions/<version>) are too large for grep
with wide context, so this reads one once and writes a file per hit.
    python tools/find-in-binary.py <binary> <out dir> <anchor>... [--window N]
"""
import argparse
import os
import re

parser = argparse.ArgumentParser()
parser.add_argument('binary')
parser.add_argument('out_dir')
parser.add_argument('anchors', nargs='+')
parser.add_argument('--window', type=int, default=3000, help='bytes kept on each side of a hit')
parser.add_argument('--max-hits', type=int, default=12, help='windows written per anchor')
args = parser.parse_args()

os.makedirs(args.out_dir, exist_ok=True)
with open(args.binary, 'rb') as f:
    data = f.read()

for anchor in args.anchors:
    needle = anchor.encode()
    hits = [m.start() for m in re.finditer(re.escape(needle), data)]
    print(f'{anchor}: {len(hits)} hits {hits[:20]}')
    slug = re.sub(r'[^A-Za-z0-9]', '_', anchor)
    for i, hit in enumerate(hits[:args.max_hits]):
        window = data[max(0, hit - args.window):hit + args.window]
        with open(os.path.join(args.out_dir, f'{slug}_{i}.txt'), 'wb') as out:
            out.write(window)
