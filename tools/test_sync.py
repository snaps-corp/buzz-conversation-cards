import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import sync


def files(version='0.8.5'):
    return {'manifest.json': json.dumps(dict(id='webling.work', apiVersion=1,
                updates=dict(defaultEnabled=True))).encode(),
            'plugin.js': b"export const inject = ['react', 'conversation', 'relay'];",
            'VERSION': version.encode()}


def bundle(items):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for name, data in items.items():
            archive.writestr(sync.PREFIX + name, data)
        archive.writestr('DO-NOT-PUBLISH.txt', 'installer data')
    return stream.getvalue()


class SyncTests(unittest.TestCase):
    def test_allowlist_only(self):
        self.assertEqual(sync.unpack(bundle(files())), files())

    def test_contract_rejects_unknown_access_and_missing_files(self):
        values = files()
        values['manifest.json'] = b'{"id":"other","apiVersion":1}'
        with self.assertRaises(ValueError): sync.unpack(bundle(values))
        values = files(); del values['plugin.js']
        with self.assertRaises(ValueError): sync.unpack(bundle(values))

    def test_publish_noop_and_version_fence(self):
        with tempfile.TemporaryDirectory() as directory, patch('sync.subprocess.run'):
            self.assertTrue(sync.publish(files(), directory))
            self.assertFalse(sync.publish(files(), directory))
            changed = files(); changed['plugin.js'] += b'\n// different'
            with self.assertRaises(ValueError): sync.publish(changed, directory)
            with self.assertRaises(ValueError): sync.publish(files('0.8.4'), directory)
            self.assertEqual((Path(directory) / 'plugin.js').read_bytes(), files()['plugin.js'])
            self.assertTrue(sync.publish(files('0.8.6'), directory))

    def test_invalid_syntax_leaves_current_release(self):
        with tempfile.TemporaryDirectory() as directory:
            sync.publish(files(), directory)
            broken = files('0.8.6'); broken['plugin.js'] += b'\n{ invalid'
            with self.assertRaises(Exception): sync.publish(broken, directory)
            self.assertEqual((Path(directory) / 'VERSION').read_bytes(), b'0.8.5')


if __name__ == '__main__': unittest.main()
