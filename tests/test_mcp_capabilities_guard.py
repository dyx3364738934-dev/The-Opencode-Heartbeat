import asyncio
import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "mcp" / "korina_mcp_server.py"
spec = importlib.util.spec_from_file_location("korina_mcp_server_under_test", MODULE_PATH)
korina_mcp_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(korina_mcp_server)

_capability_guard = korina_mcp_server._capability_guard
_route_allowed_by_capabilities = korina_mcp_server._route_allowed_by_capabilities


class FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    @property
    def is_success(self):
        return 200 <= self.status_code < 300

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeAsyncClient:
    response = FakeResponse(200, {"httpRoutes": []})
    requested_urls = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url, headers=None):
        self.requested_urls.append((url, headers or {}))
        return self.response


class CapabilitiesGuardTest(unittest.TestCase):
    def setUp(self):
        FakeAsyncClient.requested_urls = []
        os.environ.pop("KORINA_SKIP_CAPABILITIES_GUARD", None)

    def test_route_allowed_normalizes_method_and_trailing_slash(self):
        routes = [{"method": "post", "path": "/heartbeat/pause/"}]
        self.assertTrue(_route_allowed_by_capabilities(routes, "POST", "/heartbeat/pause"))
        self.assertFalse(_route_allowed_by_capabilities(routes, "GET", "/heartbeat/pause"))

    def test_status_skips_guard(self):
        result = asyncio.run(_capability_guard("GET", "/status"))
        self.assertIsNone(result)

    def test_legacy_daemon_without_capabilities_is_allowed(self):
        FakeAsyncClient.response = FakeResponse(404, {"error": "Not Found"})
        with patch.object(korina_mcp_server.httpx, "AsyncClient", FakeAsyncClient):
            result = asyncio.run(_capability_guard("POST", "/inject"))
        self.assertIsNone(result)

    def test_declared_route_is_allowed(self):
        FakeAsyncClient.response = FakeResponse(200, {
            "httpRoutes": [{"method": "POST", "path": "/inject"}],
        })
        with patch.object(korina_mcp_server.httpx, "AsyncClient", FakeAsyncClient):
            result = asyncio.run(_capability_guard("POST", "/inject"))
        self.assertIsNone(result)

    def test_missing_route_is_blocked(self):
        FakeAsyncClient.response = FakeResponse(200, {
            "httpRoutes": [{"method": "GET", "path": "/status"}],
        })
        with patch.object(korina_mcp_server.httpx, "AsyncClient", FakeAsyncClient):
            result = asyncio.run(_capability_guard("POST", "/workflow/current"))
        self.assertIn("未声明端点 POST /workflow/current", result)

    def test_bad_capabilities_json_blocks_call(self):
        FakeAsyncClient.response = FakeResponse(200, ValueError("bad json"))
        with patch.object(korina_mcp_server.httpx, "AsyncClient", FakeAsyncClient):
            result = asyncio.run(_capability_guard("POST", "/inject"))
        self.assertIn("JSON 解析失败", result)


if __name__ == "__main__":
    unittest.main()
