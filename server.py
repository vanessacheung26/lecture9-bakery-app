# server.py: serves this folder for Workflow-Builder.html, and keeps saved runs in the saved-runs folder.
# Start it in this folder with: python3 server.py   (on Windows: python server.py)
# It serves http://127.0.0.1:8009 (the Lecture 8 copies use 8000 to 8002, so the browser never mixes their files). If port 8009 is taken, give another: python3 server.py 8010
import http.server
import json
import os
import re
import sys
import urllib.parse

FOLDER = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(FOLDER, 'saved-runs')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8009
MAX_BYTES = 20_000_000


def plain_name(name):
    # Any character other than a letter, digit, space, . _ ( ) or - becomes -, and the name always ends in .json,
    # so every name sent is saved in saved-runs, and never as a path outside it.
    name = re.sub(r'[^A-Za-z0-9 ._()-]', '-', os.path.basename(name.replace('\\', '/'))).strip(' .')
    if name.lower().endswith('.json'):
        name = name[:-5]
    return (name[:120] or 'saved-run') + '.json'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FOLDER, **kwargs)

    def send_json(self, value):
        body = json.dumps(value).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # The page lists the saved runs: GET /saved-runs-list
    def do_GET(self):
        if urllib.parse.urlsplit(self.path).path == '/saved-runs-list':
            os.makedirs(RUNS, exist_ok=True)
            self.send_json(sorted(n for n in os.listdir(RUNS) if n.lower().endswith('.json')))
            return
        super().do_GET()

    # "Save this run" sends the run here: POST /save-run?name=Version 2, twelve test customers.json
    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        name = plain_name(urllib.parse.parse_qs(url.query).get('name', [''])[0])
        size = int(self.headers.get('Content-Length') or 0)
        if url.path != '/save-run' or not 0 < size <= MAX_BYTES:
            self.send_error(400, 'Send the run file text')
            return
        text = self.rfile.read(size)
        os.makedirs(RUNS, exist_ok=True)
        # A name already in the folder gets -2, -3 and so on, so an earlier run is never overwritten.
        base, final, n = name[:-5], name, 2
        while os.path.exists(os.path.join(RUNS, final)):
            final, n = f'{base}-{n}.json', n + 1
        with open(os.path.join(RUNS, final), 'wb') as f:
            f.write(text)
        self.send_json({'name': final})


if __name__ == '__main__':
    print(f'Serving {FOLDER} at http://127.0.0.1:{PORT}/Workflow-Builder.html', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
