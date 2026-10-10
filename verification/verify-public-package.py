"""Independently verify the file whitelist and recorded synthetic evidence; no network."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text())
whitelist = json.loads((root / 'PUBLISH_WHITELIST.json').read_text())
actual = sorted(p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file())
assert actual == sorted(whitelist['files']), 'Unexpected or missing release files'
assert set(manifest['files']) | {'manifest.json'} == set(actual), 'Manifest coverage mismatch'
for rel, metadata in manifest['files'].items():
    path = root / rel
    assert not path.is_symlink(), 'Symlink in release'
    content = path.read_bytes()
    assert len(content) == metadata['sizeBytes'] and hashlib.sha256(content).hexdigest() == metadata['sha256'], 'File integrity mismatch'
    assert not any(part in {'node_modules', '.git', 'state'} for part in Path(rel).parts), 'Runtime directory in release'
    assert not path.name.startswith('.env') and path.name not in {'authorization.json', 'round-ledger.json'}, 'Runtime configuration in release'
assert json.loads((root / 'app/trailbrief/package.json').read_text())['license'] == 'UNLICENSED'
assert (root / 'docs/.nojekyll').is_file()
assert 'connect-src \'none\'' in (root / 'docs/index.html').read_text()
assert '<form' not in (root / 'docs/index.html').read_text().lower()
assert not re.search(r'\b(?:fetch\s*\(|XMLHttpRequest|WebSocket)', (root / 'docs/app.js').read_text())

data = json.loads((root / 'evidence/recorded-runs.json').read_text())
script = (root / 'docs/data.js').read_text()
assert json.loads(script.removeprefix('window.TRAILBRIEF_RECORDS = ').strip().removesuffix(';')) == data
assert data['liveApiEnabled'] is False and data['syntheticOnly'] is True
assert len(data['records']) == 6 and [r['attempt'] for r in data['records']] == list(range(1, 7))
accepted = []
for record in data['records']:
    brief = record['acceptedBrief']
    if not brief:
        continue
    accepted.append(record['attempt'])
    selected = json.loads(record['assistantObservation']['assistantText'])
    assert set(selected) == {'selections'} and 1 <= len(selected['selections']) <= 8
    source_text = {s['id']: s['text'] for s in record['input']['sources']}
    table = {s['segmentId']: s for s in record['sourceSegments']}
    assert len(table) == len(record['sourceSegments'])
    seen = set()
    assembled = []
    for item in selected['selections']:
        assert set(item) == {'sourceId', 'segmentId'} and item['sourceId'] in {'route', 'weather'}
        assert item['segmentId'] not in seen
        seen.add(item['segmentId'])
        segment = table[item['segmentId']]
        assert segment['sourceId'] == item['sourceId'] and segment['selectable'] is True
        original = source_text[item['sourceId']]
        quote = original[segment['start']:segment['end']]
        assert quote == segment['text'] and quote in original
        binding = json.dumps([item['sourceId'], original, segment['start'], segment['end']], ensure_ascii=False, separators=(',', ':'))
        expected_id = item['sourceId'] + '-' + hashlib.sha256(binding.encode()).hexdigest()[:24]
        assert item['segmentId'] == expected_id
        assembled.append({'sourceId': item['sourceId'], 'segmentId': item['segmentId'], 'quote': quote})
    assert assembled == brief['claims'], 'Displayed claims differ from original selected source slices'
    for required in record['expectedEvidence']:
        assert any(c['sourceId'] == required['sourceId'] and required['text'] in c['quote'] for c in assembled)
    assert brief['modelGeneratesEvidenceText'] is False and brief['evidenceContractVersion'] == 1
assert accepted == [4, 5], 'Do not invent additional accepted results'
assert data['records'][0]['assistantObservation'] is None, 'Lost first body must not be fabricated'
last = data['records'][5]
assert last['state'] == 'uncertain' and last['errorCode'] == 'API_TRANSPORT_ERROR'
assert last['usage'] is None and last['assistantObservation'] is None and last['acceptedBrief'] is None
assert data['knownReportedUsageEstimateUsd'] == 0.013918 and data['usageUnknownAttempts'] == [6]
assert data['retainedReserveUsd'] == 1.5
print(json.dumps({'passed': True, 'filesVerified': len(actual), 'acceptedRecordedAttempts': accepted, 'uncertainAttempt': 6, 'liveApiEnabled': False, 'originalCodeLicense': 'UNLICENSED', 'networkRequests': 0}))
