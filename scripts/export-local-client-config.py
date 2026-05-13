#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path
from urllib import error, parse, request


ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin"
GUI_CLIENT_ID = "guiClient"
GUI_CLIENT_SECRET = "admin"
INSTITUTION_ID = 1


class APIError(RuntimeError):
    pass


def is_valid_client_config(data: bytes) -> bool:
    return data.startswith(b"\x1f\x8b") or data.lstrip().startswith(b"<?xml")


class Downloader:
    def __init__(self, server_base_url: str) -> None:
        self.server_base_url = server_base_url.rstrip("/")
        self.token: str | None = None

    def wait_until_login_ready(self, timeout_seconds: int = 120) -> None:
        deadline = time.time() + timeout_seconds
        last_error: Exception | None = None

        while time.time() < deadline:
            try:
                self.login()
                return
            except APIError as exc:  # pragma: no cover - runtime only
                last_error = exc
                time.sleep(2)

        raise APIError(f"Admin OAuth login did not become ready in time: {last_error}")

    def login(self) -> None:
        auth = base64.b64encode(f"{GUI_CLIENT_ID}:{GUI_CLIENT_SECRET}".encode("utf-8")).decode("ascii")
        payload = parse.urlencode(
            {
                "grant_type": "password",
                "username": ADMIN_USERNAME,
                "password": ADMIN_PASSWORD,
            }
        ).encode("utf-8")
        req = request.Request(f"{self.server_base_url}/oauth/token", data=payload, method="POST")
        req.add_header("Authorization", f"Basic {auth}")
        try:
            with request.urlopen(req, timeout=30) as response:
                self.token = json.loads(response.read().decode("utf-8"))["access_token"]
        except error.HTTPError as exc:
            raise APIError(f"Login failed with {exc.code}: {exc.read().decode('utf-8', 'replace')}") from exc
        except error.URLError as exc:
            raise APIError(f"Login failed: {exc}") from exc

    def wait_for_download(self, client_config_id: int, exam_id: int, timeout_seconds: int = 60) -> bytes:
        deadline = time.time() + timeout_seconds
        last_error: Exception | None = None

        while time.time() < deadline:
            try:
                data = self.download(client_config_id, exam_id)
                if is_valid_client_config(data):
                    return data
                last_error = APIError(
                    f"Downloaded client config payload is not a valid .seb export: {repr(data[:80])}"
                )
            except APIError as exc:  # pragma: no cover - runtime only
                last_error = exc
            time.sleep(2)

        raise APIError(f"Client config download did not become ready in time: {last_error}")

    def download(self, client_config_id: int, exam_id: int) -> bytes:
        if not self.token:
            raise APIError("Download requested before login")

        url = (
            f"{self.server_base_url}/admin-api/v1/client_configuration/download/{client_config_id}"
            f"?institutionId={INSTITUTION_ID}&examId={exam_id}"
        )
        req = request.Request(url)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/octet-stream")
        try:
            with request.urlopen(req, timeout=30) as response:
                return response.read()
        except error.HTTPError as exc:
            raise APIError(
                f"Download failed with {exc.code}: {exc.read().decode('utf-8', 'replace')}"
            ) from exc
        except error.URLError as exc:
            raise APIError(f"Download failed: {exc}") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a local SEB client config from seb-server.")
    parser.add_argument("--server-base-url", required=True)
    parser.add_argument("--client-config-id", type=int, required=True)
    parser.add_argument("--exam-id", type=int, required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    downloader = Downloader(args.server_base_url)

    try:
        downloader.wait_until_login_ready()
        data = downloader.wait_for_download(args.client_config_id, args.exam_id)
    except APIError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(data)
    print(f"Exported client config: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
