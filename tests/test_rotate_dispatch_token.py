import contextlib
import importlib.util
import io
import json
import pathlib
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rotate', pathlib.Path(__file__).parents[1] / 'scripts/rotate-dispatch-token.py')
rotate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rotate)


class RotationTests(unittest.TestCase):
    def test_invalid_format_never_updates_worker(self):
        with patch.object(rotate.sys.stdin, 'isatty', return_value=True), patch.object(rotate.getpass, 'getpass', return_value='invalid'), patch.object(rotate.subprocess, 'run') as update:
            with self.assertRaises(RuntimeError):
                rotate.main()
            update.assert_not_called()

    def test_failed_permissions_never_updates_worker(self):
        with patch.object(rotate.sys.stdin, 'isatty', return_value=True), patch.object(rotate.getpass, 'getpass', return_value='github_pat_TEST'), patch.object(rotate.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('https://api.github.com', 403, 'Forbidden', {}, None)), patch.object(rotate.subprocess, 'run') as update:
            with self.assertRaisesRegex(RuntimeError, '403'):
                rotate.main()
            update.assert_not_called()

    def test_validated_token_goes_only_to_stdin(self):
        requests = []
        def request(req, **kwargs):
            requests.append(req)
            ref = json.loads(req.data)['ref']
            self.assertEqual(ref, 'er-radar-permission-check-check-123')
            raise urllib.error.HTTPError(req.full_url, 422, 'Unprocessable', {}, io.BytesIO(json.dumps({'message': f'No ref found for: {ref}'}).encode()))
        output = io.StringIO()
        with patch.object(rotate.sys.stdin, 'isatty', return_value=True), patch.object(rotate.getpass, 'getpass', return_value='github_pat_TEST'), patch.object(rotate.uuid, 'uuid4', return_value='check-123'), patch.object(rotate.urllib.request, 'urlopen', side_effect=request), patch.object(rotate.subprocess, 'run') as update, contextlib.redirect_stdout(output):
            update.return_value.returncode = 0
            rotate.main()
            self.assertEqual(update.call_args.kwargs['input'], 'github_pat_TEST\n')
            self.assertNotIn('github_pat_TEST', str(update.call_args.args))
            self.assertNotIn('github_pat_TEST', output.getvalue())
            self.assertTrue(all('/daily-bargaining-update.yml/' in req.full_url for req in requests))
