#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import json
import time
from pathlib import Path
from typing import Any
from urllib import error, parse, request


INSTITUTION_ID = 1
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin"
GUI_CLIENT_ID = "guiClient"
GUI_CLIENT_SECRET = "admin"
CLIENT_CONFIG_NAME = "Local Test Client Config"
EXAM_CONFIG_NAME = "Local Test Exam Config"
EXAM_NAME = "Local Test Exam"
EXAM_EXTERNAL_ID = "local-test-exam"
EXAM_DESCRIPTION = "A local mock exam page for testing the SEB Linux client against seb-server."


class APIError(RuntimeError):
    pass


class AdminAPI:
    def __init__(self, server_base_url: str) -> None:
        self.server_base_url = server_base_url.rstrip("/")
        self.admin_base = f"{self.server_base_url}/admin-api/v1"
        self.token: str | None = None

    def wait_until_ready(self, timeout_seconds: int = 180) -> None:
        deadline = time.time() + timeout_seconds
        discovery_url = f"{self.server_base_url}/exam-api/discovery"
        last_error: Exception | None = None

        while time.time() < deadline:
            req = request.Request(discovery_url, headers={"Content-Type": "application/json"})
            try:
                with request.urlopen(req, timeout=10):
                    return
            except Exception as exc:  # pragma: no cover - exercised in runtime only
                last_error = exc
                time.sleep(2)

        raise APIError(f"SEB Server did not become ready in time: {last_error}")

    def login(self) -> None:
        auth = base64.b64encode(f"{GUI_CLIENT_ID}:{GUI_CLIENT_SECRET}".encode("utf-8")).decode("ascii")
        payload = parse.urlencode(
            {
                "grant_type": "password",
                "username": ADMIN_USERNAME,
                "password": ADMIN_PASSWORD,
            }
        ).encode("utf-8")
        body = self._raw_request(
            "/oauth/token",
            method="POST",
            data=payload,
            headers={"Authorization": f"Basic {auth}"},
            admin=False,
        )
        self.token = json.loads(body.decode("utf-8"))["access_token"]

    def wait_until_login_ready(self, timeout_seconds: int = 120) -> None:
        deadline = time.time() + timeout_seconds
        last_error: Exception | None = None

        while time.time() < deadline:
            try:
                self.login()
                return
            except APIError as exc:  # pragma: no cover - exercised in runtime only
                last_error = exc
                time.sleep(2)

        raise APIError(f"Admin OAuth login did not become ready in time: {last_error}")

    def create_client_config(self) -> dict[str, Any]:
        return self._form_post(
            "/client_configuration",
            {
                "institutionId": str(INSTITUTION_ID),
                "name": CLIENT_CONFIG_NAME,
                "sebConfigPurpose": "START_EXAM",
            },
        )

    def activate_client_config(self, client_config_id: int) -> None:
        self._form_post(f"/client_configuration/{client_config_id}/active", {})

    def import_exam_config(self, config_name: str, xml_bytes: bytes) -> dict[str, Any]:
        headers = {
            "name": config_name,
            "description": EXAM_DESCRIPTION,
            "importFile": "local-exam-template.seb",
        }
        return self._request_json(
            f"{self.admin_base}/configuration-node/import?institutionId={INSTITUTION_ID}",
            method="POST",
            data=xml_bytes,
            headers=headers,
            content_type="application/octet-stream",
        )

    def publish_exam_config(self, configuration_node_id: int) -> dict[str, Any]:
        payload = {
            "id": configuration_node_id,
            "institutionId": INSTITUTION_ID,
            "templateId": 0,
            "name": EXAM_CONFIG_NAME,
            "description": EXAM_DESCRIPTION,
            "type": "EXAM_CONFIG",
            "owner": "admin",
            "status": "READY_TO_USE",
        }
        return self._request_json(
            f"{self.admin_base}/configuration-node",
            method="PUT",
            data=json.dumps(payload).encode("utf-8"),
            content_type="application/json",
        )

    def create_exam(self, exam_start_url: str) -> dict[str, Any]:
        now = int(time.time())
        start_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 300))
        end_time = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 4 * 3600))

        return self._form_post(
            "/exam",
            {
                "institutionId": str(INSTITUTION_ID),
                "externalId": EXAM_EXTERNAL_ID,
                "quizName": EXAM_NAME,
                "quizStartTime": start_time,
                "quizEndTime": end_time,
                "type": "BYOD",
                "status": "TEST_RUN",
                "active": "true",
                "quiz_start_url": exam_start_url,
                "quiz_description": EXAM_DESCRIPTION,
                "supporter": "admin",
            },
        )

    def attach_exam_config(self, exam_id: int, configuration_node_id: int) -> dict[str, Any]:
        return self._form_post(
            "/exam-configuration-map",
            {
                "institutionId": str(INSTITUTION_ID),
                "examId": str(exam_id),
                "configurationNodeId": str(configuration_node_id),
            },
        )

    def download_client_config(self, client_config_id: int, exam_id: int) -> bytes:
        path = (
            f"/client_configuration/download/{client_config_id}"
            f"?institutionId={INSTITUTION_ID}&examId={exam_id}"
        )
        return self._raw_request(path, content_type="application/octet-stream")

    def wait_for_client_config_download(
        self,
        client_config_id: int,
        exam_id: int,
        timeout_seconds: int = 60,
    ) -> bytes:
        deadline = time.time() + timeout_seconds
        last_error: Exception | None = None

        while time.time() < deadline:
            try:
                data = self.download_client_config(client_config_id, exam_id)
                if is_valid_client_config(data):
                    return data
                preview = repr(data[:80])
                last_error = APIError(
                    f"Downloaded client config payload is not a valid .seb export: {preview}"
                )
            except APIError as exc:  # pragma: no cover - exercised in runtime only
                last_error = exc
            time.sleep(2)

        raise APIError(f"Client config download did not become ready in time: {last_error}")

    def _form_post(self, path: str, form: dict[str, str]) -> dict[str, Any]:
        payload = parse.urlencode(form, doseq=True).encode("utf-8")
        return self._request_json(
            f"{self.admin_base}{path}",
            method="POST",
            data=payload,
            content_type="application/x-www-form-urlencoded",
        )

    def _request_json(
        self,
        url: str,
        method: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        body = self._raw_request(
            url,
            method=method,
            data=data,
            headers=headers,
            content_type=content_type,
        )
        return json.loads(body.decode("utf-8"))

    def _raw_request(
        self,
        url_or_path: str,
        method: str = "GET",
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        content_type: str | None = "application/x-www-form-urlencoded",
        admin: bool = True,
    ) -> bytes:
        url = (
            url_or_path
            if url_or_path.startswith("http://") or url_or_path.startswith("https://")
            else f"{self.server_base_url}{url_or_path}"
        )
        req = request.Request(url, data=data, method=method)
        if admin:
            if not self.token:
                raise APIError("Admin API requested before login")
            req.add_header("Authorization", f"Bearer {self.token}")
        if content_type:
            req.add_header("Content-Type", content_type)
        for key, value in (headers or {}).items():
            req.add_header(key, value)

        try:
            with request.urlopen(req, timeout=30) as response:
                return response.read()
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            raise APIError(f"{method} {url} failed with {exc.code}: {body}") from exc
        except error.URLError as exc:
            raise APIError(f"{method} {url} failed: {exc}") from exc


def build_exam_config(template_path: Path, exam_base_url: str) -> bytes:
    template = template_path.read_text(encoding="utf-8")
    return template.replace("__EXAM_URL__", exam_base_url.rstrip("/") + "/").encode("utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Provision a local SEB Server exam for testing.")
    parser.add_argument("--server-base-url", required=True)
    parser.add_argument("--exam-base-url", required=True)
    parser.add_argument("--config-template", required=True)
    parser.add_argument("--metadata-output", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api = AdminAPI(args.server_base_url)

    try:
        api.wait_until_ready()
        api.wait_until_login_ready()
        client_config = api.create_client_config()
        api.activate_client_config(int(client_config["id"]))
        exam_config = api.import_exam_config(
            EXAM_CONFIG_NAME,
            build_exam_config(Path(args.config_template), args.exam_base_url),
        )
        api.publish_exam_config(int(exam_config["configurationNodeId"]))
        exam = api.create_exam(args.exam_base_url.rstrip("/") + "/")
        api.attach_exam_config(int(exam["id"]), int(exam_config["configurationNodeId"]))
    except APIError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    metadata = {
        "serverBaseUrl": args.server_base_url,
        "examBaseUrl": args.exam_base_url,
        "clientConfigId": int(client_config["id"]),
        "examId": int(exam["id"]),
        "configurationNodeId": int(exam_config["configurationNodeId"]),
    }

    output_path = Path(args.metadata_output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"Provisioned exam id: {exam['id']}")
    print(f"Wrote metadata: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
