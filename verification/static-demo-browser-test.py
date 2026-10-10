"""Optional local browser check for the recorded static demo; never calls a model."""
from pathlib import Path
import functools
import hashlib
import http.server
import json
import os
import tempfile
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
site = root / 'docs'
(site / 'assets').mkdir(exist_ok=True)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(site)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
requests, external = [], []
result = {'browser': 'Chromium headless', 'site_layout': 'main:/docs with .nojekyll', 'live_api_disabled': True, 'model_calls_during_browser_qa': 0}
env = os.environ.copy()
env.pop('TRAILBRIEF_API_KEY', None)
try:
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='trailbrief-static-qa-') as tmp:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-gpu'], env=env, timeout=20000)
        context = browser.new_context(viewport={'width': 1280, 'height': 1000}, accept_downloads=True)
        def route(r):
            u = urlparse(r.request.url)
            if u.hostname != '127.0.0.1':
                external.append({'host': u.hostname, 'method': r.request.method})
                r.abort()
            else:
                requests.append({'path': u.path, 'method': r.request.method})
                r.continue_()
        context.route('**/*', route)
        page = context.new_page()
        page.goto(base, wait_until='networkidle', timeout=15000)
        assert page.locator('.status').inner_text() == 'Recorded model result / live API disabled'
        assert page.locator('input[type=password]').count() == 0 and page.locator('form').count() == 0
        assert page.locator('#claims blockquote').count() == 4
        assert 'The south boardwalk is closed while damaged planks are replaced.' in page.locator('#claims').inner_text()
        assert 'No forecast is provided for the planned departure time.' in page.locator('#claims').inner_text()
        page.screenshot(path=str(site / 'assets/recorded-closure-desktop.png'), full_page=True)
        page.select_option('#case-picker', '5')
        assert page.locator('#claims blockquote').count() == 6
        assert 'no closures' in page.locator('#claims').inner_text() and '08:00 to 18:00 UTC' in page.locator('#claims').inner_text()
        with page.expect_download() as info:
            page.locator('#download-html').click()
        downloaded = Path(tmp) / 'recorded-brief.html'
        info.value.save_as(str(downloaded))
        assert hashlib.sha256(downloaded.read_bytes()).digest() == hashlib.sha256((site / 'briefs/covered-weather-no-closure.html').read_bytes()).digest()
        page.select_option('#case-picker', '6')
        assert page.locator('#accepted-panel').is_hidden() and page.locator('#failed-panel').is_visible()
        assert 'API_TRANSPORT_ERROR' in page.locator('#failure-message').inner_text()
        assert page.locator('#claims blockquote').count() == 0
        assert 'No successful response body or usage received' in page.locator('#assistant-output').inner_text()
        page.select_option('#case-picker', '3')
        assert page.locator('#failed-panel').is_visible() and 'a valley' in page.locator('#assistant-output').inner_text()
        page.select_option('#case-picker', '1')
        assert 'not retained' in page.locator('#assistant-output').inner_text()
        mobile = context.new_page()
        mobile.set_viewport_size({'width': 390, 'height': 844})
        mobile.goto(base, wait_until='networkidle')
        mobile.select_option('#case-picker', '5')
        assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        mobile.screenshot(path=str(site / 'assets/recorded-coverage-mobile.png'), full_page=True)
        assert not external and all(r['method'] == 'GET' for r in requests)
        result.update({'passed': True, 'accepted_records_4_and_5_rendered': True, 'failure_records_1_3_6_rendered_without_fallback': True, 'recorded_download_byte_identical': True, 'mobile_no_horizontal_overflow': True, 'password_inputs': 0, 'forms': 0, 'external_requests': 0, 'all_network_requests_static_get': True, 'static_request_count': len(requests), 'screenshots': ['docs/assets/recorded-closure-desktop.png', 'docs/assets/recorded-coverage-mobile.png']})
        browser.close()
except Exception as error:
    result.update({'passed': False, 'failure_type': type(error).__name__, 'raw_browser_error_not_saved': True})
finally:
    server.shutdown()
    server.server_close()
(root / 'evidence/static-demo-browser-qa.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
if not result.get('passed'):
    raise SystemExit(1)
