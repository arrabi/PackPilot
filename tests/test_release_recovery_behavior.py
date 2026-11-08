"""Transport, target and token boundaries; real behavior is checked in Actions."""
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/release'))
import recovery_behavior as r


class RecoveryBehaviorTests(unittest.TestCase):
    def test_startup_diagnostics_emit_categories_and_sqlstate_without_log_contents(self):
        private = 'postgresql://user:private-password@example.invalid/private-record'
        raw = ('migration failed: permission denied SQLSTATE 42501 ' + private).encode()
        with patch.object(r, 'docker', return_value=subprocess.CompletedProcess([], 0, b'', raw)):
            result = r.startup_failure(r.AUTH_NAME, {})
        self.assertIn('database permission', result)
        self.assertIn('SQLSTATE 42501', result)
        self.assertNotIn(private, result)
        self.assertNotIn('private-password', result)

    def test_auth_tokens_require_signature_user_role_audience_and_expiry(self):
        key, user = 'local-test-key', 'local-test-user'
        claims = {'sub': user, 'role': 'authenticated', 'aud': 'authenticated', 'exp': time.time() + 300}
        token = r.signed_token(key, claims)
        self.assertEqual(r.verify_user_token(token, key, user), claims)
        array_audience = claims | {'aud': ['authenticated']}
        self.assertEqual(r.verify_user_token(r.signed_token(key, array_audience), key, user), array_audience)
        for wrong in ({'sub': 'other-user'}, {'role': 'service_role'}, {'aud': 'other'}, {'exp': 1}):
            with self.subTest(wrong=wrong), self.assertRaises(r.RecoveryBehaviorFailure):
                r.verify_user_token(r.signed_token(key, claims | wrong), key, user)
        with self.assertRaises(r.RecoveryBehaviorFailure):
            r.verify_user_token(r.signed_token('wrong-key', claims), key, user)

    def test_http_client_rejects_remote_targets_and_header_injection_before_docker(self):
        for name, port, path in [('production', 9999, '/health'), (r.AUTH_NAME, 443, '/health'),
                (r.AUTH_NAME, 9999, 'https://production.example'), (r.AUTH_NAME, 9999, '//production.example'),
                (r.AUTH_NAME, 9999, '/health\r\nHost: production')]:
            with self.subTest(path=path, port=port), patch.object(r, 'docker') as docker, self.assertRaises(r.RecoveryBehaviorFailure):
                r.http(name, port, 'GET', path)
            docker.assert_not_called()

    def test_private_http_body_and_tokens_use_stdin_not_command_arguments(self):
        body = b'{"ok":true}'
        response = b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body
        private = 'private-local-test-password'
        process = MagicMock()
        process.stdout = io.BytesIO(response)
        process.wait.return_value = 0
        process.poll.return_value = 0
        with patch.object(r, 'require_networkless'), patch.object(r.subprocess, 'Popen', return_value=process) as popen:
            self.assertEqual(r.http(r.AUTH_NAME, 9999, 'POST', '/token', data={'password': private}, token='local.jwt.token'), (200, {'ok': True}))
            args, kwargs = popen.call_args
            self.assertNotIn(private, json.dumps(args))
            self.assertNotIn('local.jwt.token', json.dumps(args))
            self.assertIn(private.encode(), process.stdin.write.call_args.args[0])
            self.assertIn('--network=container:' + r.AUTH_NAME, args[0])

    def test_local_database_rejects_remote_or_redirected_targets_before_connect(self):
        for target in ('postgres://postgres@production.example/postgres',
                'host=127.0.0.1 port=55432 hostaddr=192.0.2.1',
                'host=127.0.0.1 port=5432'):
            with patch.object(r.psycopg, 'connect') as connect, self.assertRaises(r.RecoveryBehaviorFailure):
                r.local_target(target, 'synthetic-instance')
            connect.assert_not_called()

    def test_service_bootstrap_rejects_remote_database_before_mutation(self):
        with patch.object(r.psycopg, 'connect') as connect, patch.object(r, 'docker') as docker:
            with self.assertRaises(r.RecoveryBehaviorFailure):
                with r.services({'host': 'production.example', 'dbname': 'postgres'}, Path('/tmp/sockets'), {}, 'local-key', 'local-instance'):
                    self.fail('Remote service bootstrap was permitted')
            connect.assert_not_called()
            docker.assert_not_called()

    def test_http_response_decodes_chunked_body_without_logging_it(self):
        raw = b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"a":1}\r\n0\r\n\r\n'
        self.assertEqual(r.parse_http(raw), (200, {'a': 1}))


if __name__ == '__main__':
    unittest.main()
