#!/usr/bin/env python3
"""Threaded static server for the Playwright harness.

WI-34. The harness used `python3 -m http.server`, which is SINGLE-THREADED: it
serves exactly one request at a time. With more than one Playwright worker, each
loading data/questions_data.js (~1.9 MB) plus a hundred-odd question images, requests
queue behind each other and timing-sensitive specs blow their 8 s action / 15 s
navigation budgets. The victim differs run to run and every one passes in isolation,
which is precisely why this looked like flake and got explained away four times.

ThreadingHTTPServer makes the concurrency real, so `--workers=N` means what it says.

Also silences per-request logging: the default handler writes a line per asset, and a
cold load pulls ~200, which buried real failures in the CI output.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003 - matching the stdlib signature
        pass

    def end_headers(self):
        # The service worker and the app both rely on re-fetching changed assets
        # between tests; a cached 304 from a previous spec's state would make a run
        # depend on the order specs happened to execute in.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    server = ThreadingHTTPServer(('127.0.0.1', port), QuietHandler)
    server.daemon_threads = True
    print('test server (threaded) on http://127.0.0.1:%d' % port, flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
