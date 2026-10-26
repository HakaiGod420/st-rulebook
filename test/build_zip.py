"""Builds st-rulebook.zip: the extension at the archive root, harness excluded."""

import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ['manifest.json', 'index.js', 'style.css', 'settings.html', 'README.md', 'LICENSE', 'SPEC.md']
DIRS = ['src', 'docs']
OUT = os.path.join(ROOT, 'st-rulebook.zip')

if os.path.exists(OUT):
    os.remove(OUT)

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in FILES:
        archive.write(os.path.join(ROOT, name), f'st-rulebook/{name}')
    for directory in DIRS:
        for dirpath, _dirs, files in os.walk(os.path.join(ROOT, directory)):
            for filename in sorted(files):
                full = os.path.join(dirpath, filename)
                relative = os.path.relpath(full, ROOT).replace(os.sep, '/')
                archive.write(full, f'st-rulebook/{relative}')

with zipfile.ZipFile(OUT) as archive:
    entries = archive.namelist()

print(len(entries), 'entries')
print('\n'.join(entries))
print(round(os.path.getsize(OUT) / 1024, 1), 'KB')
