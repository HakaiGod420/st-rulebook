"""Static server for the Rulebook harness.

Rebuilds test/mirror from the real extension sources on every start, so the
browser can never run a stale copy, and serves it with no-store headers.
No SillyTavern required.
"""

import http.server
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
EXT_ROOT = os.path.dirname(ROOT)
MIRROR = os.path.join(ROOT, 'mirror')
EXTENSION_DIR = os.path.join(MIRROR, 'scripts', 'extensions', 'third-party', 'st-rulebook')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8778

FILES = ['index.js', 'style.css', 'settings.html', 'manifest.json']


def sync_mirror():
    shutil.rmtree(EXTENSION_DIR, ignore_errors=True)
    os.makedirs(EXTENSION_DIR, exist_ok=True)

    for name in FILES:
        shutil.copy2(os.path.join(EXT_ROOT, name), os.path.join(EXTENSION_DIR, name))

    shutil.copytree(os.path.join(EXT_ROOT, 'src'), os.path.join(EXTENSION_DIR, 'src'))

    stubs = os.path.join(ROOT, 'stubs')
    for name, target in {
        'extensions.js': os.path.join(MIRROR, 'scripts', 'extensions.js'),
        'script.js': os.path.join(MIRROR, 'script.js'),
        'popup.js': os.path.join(MIRROR, 'scripts', 'popup.js'),
    }.items():
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(stubs, name), target)

    shutil.copytree(
        os.path.join(stubs, 'slash-commands'),
        os.path.join(MIRROR, 'scripts', 'slash-commands'),
        dirs_exist_ok=True,
    )


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.json': 'application/json',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        # Rebuilding on the harness request keeps the mirror honest while the
        # extension sources are being edited.
        if self.path.split('?')[0].endswith('harness.html'):
            sync_mirror()
        super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length)
        with open(os.path.join(ROOT, 'last_post.jsonl'), 'ab') as handle:
            handle.write(json.dumps({'path': self.path, 'body': body.decode('utf-8', 'replace')}).encode() + b'\n')
        self._json(200, {'ok': True})

    def _json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    sync_mirror()
    print(f'harness on http://127.0.0.1:{PORT}/harness.html')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
