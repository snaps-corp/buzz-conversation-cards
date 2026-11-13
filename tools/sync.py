"""Publish only the three plugin files in the deployed public install bundle.

No private repository checkout, credentials, app installers or user data are copied.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
import zipfile

URL = 'https://buzz.webling.kr/admin/install/buzz-setup.zip'
FILES = ('manifest.json', 'plugin.js', 'VERSION')
PREFIX = 'Buzz-Conversation-Cards/'
MAX_SIZE = 5 * 1024 * 1024


def version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('Invalid release version')
    return tuple(map(int, value.split('.')))


def unpack(data):
    if len(data) > MAX_SIZE:
        raise ValueError('Bundle exceeds limit')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        result = {}
        for name in FILES:
            matches = [item for item in archive.infolist() if item.filename == PREFIX + name]
            if len(matches) != 1 or matches[0].file_size > 1024 * 1024:
                raise ValueError('Missing, duplicate or oversized plugin file')
            result[name] = archive.read(matches[0])
    manifest = json.loads(result['manifest.json'])
    if (manifest.get('id') != 'webling.work' or manifest.get('apiVersion') != 1
            or set(manifest) - {'id', 'name', 'description', 'apiVersion', 'updates'}
            or manifest.get('updates') != {'defaultEnabled': True}):
        raise ValueError('Release does not declare the approved plugin update contract')
    version(result['VERSION'].decode().strip())
    code = result['plugin.js'].decode()
    if "export const inject = ['react', 'conversation', 'relay'];" not in code:
        raise ValueError('Unexpected host capabilities; maintainer review required')
    return result


def publish(files, destination):
    destination = Path(destination)
    current = destination / 'VERSION'
    incoming = version(files['VERSION'].decode().strip())
    if current.exists():
        previous = version(current.read_text().strip())
        if incoming < previous:
            raise ValueError('Production rolled back; keep published plugin until explicit review')
        if incoming == previous:
            if all((destination / name).read_bytes() == files[name] for name in FILES):
                return False
            raise ValueError('Plugin changed without a version bump')
    # Syntax-check without importing/evaluating downloaded JavaScript.
    with tempfile.TemporaryDirectory() as folder:
        candidate = Path(folder) / 'plugin.mjs'
        candidate.write_bytes(files['plugin.js'])
        subprocess.run(['node', '--check', str(candidate)], check=True, capture_output=True)
    destination.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        (destination / name).write_bytes(files[name])
    return True


def main():
    with urllib.request.urlopen(URL, timeout=45) as response:
        if response.geturl() != URL:
            raise ValueError('Unexpected download redirect')
        data = response.read(MAX_SIZE + 1)
    files = unpack(data)
    changed = publish(files, Path(__file__).resolve().parents[1] / 'plugin')
    print(json.dumps({'changed': changed, 'version': files['VERSION'].decode().strip(),
                      'bundle_sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    main()
