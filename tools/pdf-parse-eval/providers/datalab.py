"""
Datalab Convert API Provider (Balanced mode)
Handles multipart file submission, status polling, result download, and asset saving.
"""

import os
import json
import base64
from pathlib import Path
from typing import Dict, Any, Optional, Callable
import requests

from storage import atomic_write_json, safe_extract_zip
from providers.mineru import AuthenticationError, ProviderAPIError


class DatalabProvider:
    BASE_URL = "https://www.datalab.to/api/v1"

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("DATALAB_API_KEY")

    def validate_credentials(self) -> None:
        if not self.api_key or not self.api_key.strip():
            raise AuthenticationError(
                "DATALAB_API_KEY is missing. Please set the environment variable DATALAB_API_KEY."
            )

    def submit_document(
        self,
        input_pdf_path: str | Path,
        mode: str = "balanced",
        output_format: str = "markdown,json,html",
        add_block_ids: bool = True,
        disable_image_extraction: bool = False,
        disable_image_captions: bool = True,
        paginate: bool = False,
        merge_cross_page: bool = False,
        skip_cache: bool = False,
    ) -> Dict[str, Any]:
        """
        Submits PDF to Datalab Convert API via multipart/form-data.
        """
        self.validate_credentials()
        pdf_path = Path(input_pdf_path).resolve()
        if not pdf_path.is_file():
            raise FileNotFoundError(f"Input PDF not found: {pdf_path}")

        headers = {
            "X-API-Key": self.api_key.strip(),
        }

        form_data = {
            "mode": mode,
            "output_format": output_format,
            "add_block_ids": "true" if add_block_ids else "false",
            "disable_image_extraction": "true" if disable_image_extraction else "false",
            "disable_image_captions": "true" if disable_image_captions else "false",
            "paginate": "true" if paginate else "false",
            "merge_cross_page": "true" if merge_cross_page else "false",
            "skip_cache": "true" if skip_cache else "false",
        }

        url = f"{self.BASE_URL}/convert"

        try:
            with open(pdf_path, "rb") as f:
                files = {
                    "file": (pdf_path.name, f, "application/pdf"),
                }
                resp = requests.post(
                    url,
                    headers=headers,
                    data=form_data,
                    files=files,
                    timeout=60,
                )
        except requests.RequestException as e:
            raise ProviderAPIError(f"Network error submitting document to Datalab: {e}") from e

        if resp.status_code in (401, 403):
            raise AuthenticationError(
                f"Datalab authentication failed (HTTP {resp.status_code}): {resp.text}"
            )

        try:
            res_json = resp.json()
        except Exception as e:
            raise ProviderAPIError(
                f"Datalab returned invalid JSON (HTTP {resp.status_code}): {resp.text}"
            ) from e

        if resp.status_code >= 400:
            error_msg = res_json.get("error") or res_json.get("message") or resp.text
            raise ProviderAPIError(f"Datalab conversion error (HTTP {resp.status_code}): {error_msg}")

        request_id = res_json.get("request_id") or res_json.get("id")
        request_check_url = res_json.get("request_check_url")

        if not request_check_url and request_id:
            request_check_url = f"{self.BASE_URL}/convert/{request_id}"

        if not request_check_url:
            raise ProviderAPIError(f"Datalab response missing request_check_url: {res_json}")

        return {
            "request_id": request_id,
            "request_check_url": request_check_url,
            "raw_response": res_json,
        }

    def check_status(self, request_check_url: str) -> Dict[str, Any]:
        """
        Polls Datalab check URL.
        """
        self.validate_credentials()
        headers = {
            "X-API-Key": self.api_key.strip(),
        }

        try:
            resp = requests.get(request_check_url, headers=headers, timeout=30)
        except requests.RequestException as e:
            raise ProviderAPIError(f"Network error querying Datalab status: {e}") from e

        if resp.status_code in (401, 403):
            raise AuthenticationError(
                f"Datalab authentication failed during status check (HTTP {resp.status_code})"
            )

        try:
            res_json = resp.json()
        except Exception as e:
            raise ProviderAPIError(
                f"Invalid JSON from Datalab status check (HTTP {resp.status_code}): {resp.text}"
            ) from e

        status_str = res_json.get("status", "").lower()
        success = res_json.get("success")
        error_val = res_json.get("error")

        # Map to unified status
        if status_str == "complete":
            # Per prompt: "status='complete' 后仍检查 success 和 error；complete 不等于解析成功。"
            if success is False or error_val:
                status = "failed"
            else:
                status = "done"
        elif status_str in ("error", "failed"):
            status = "failed"
        elif status_str in ("processing", "queued", "pending", "running"):
            status = "processing"
        else:
            status = status_str or "processing"

        return {
            "status": status,
            "raw_status": status_str,
            "success": success,
            "error": error_val,
            "result_url": res_json.get("result_url"),
            "data": res_json,
        }

    def save_results(
        self,
        check_result_dict: Dict[str, Any],
        dest_raw_dir: str | Path,
    ) -> Dict[str, Any]:
        """
        Saves raw Datalab output (markdown, html, json, images) into raw/ directory.
        Handles both inline result and external result_url download.
        """
        raw_dir = Path(dest_raw_dir).resolve()
        raw_dir.mkdir(parents=True, exist_ok=True)
        images_dir = raw_dir / "images"
        images_dir.mkdir(exist_ok=True)

        res_data = check_result_dict.get("data", {})
        result_url = check_result_dict.get("result_url")

        # If result_url is provided and data does not contain full outputs, download it
        if result_url and ("markdown" not in res_data and "json" not in res_data):
            headers = {}
            if "datalab.to" in result_url:
                headers["X-API-Key"] = self.api_key.strip()
            try:
                dl_resp = requests.get(result_url, headers=headers, timeout=60)
                dl_resp.raise_for_status()
                # Could be JSON or ZIP
                content_type = dl_resp.headers.get("content-type", "")
                if "zip" in content_type or result_url.endswith(".zip"):
                    tmp_zip = raw_dir / "datalab_result.zip"
                    with open(tmp_zip, "wb") as f:
                        f.write(dl_resp.content)
                    safe_extract_zip(tmp_zip, raw_dir / "extracted")
                else:
                    try:
                        res_data = dl_resp.json()
                    except Exception:
                        (raw_dir / "raw_result.txt").write_text(dl_resp.text, encoding="utf-8")
            except requests.RequestException as e:
                raise ProviderAPIError(f"Failed to download Datalab result from {result_url}: {e}") from e

        # Save complete raw response JSON
        atomic_write_json(raw_dir / "datalab_response.json", res_data)

        # Extract markdown, html, json
        md_content = res_data.get("markdown") or res_data.get("md") or ""
        if md_content:
            (raw_dir / "result.md").write_text(md_content, encoding="utf-8")

        html_content = res_data.get("html") or ""
        if html_content:
            (raw_dir / "result.html").write_text(html_content, encoding="utf-8")

        json_struct = res_data.get("json") or res_data.get("pages") or res_data.get("blocks")
        if json_struct:
            atomic_write_json(raw_dir / "result.json", json_struct)

        # Process images (dict of filename -> base64 or url)
        images_dict = res_data.get("images") or {}
        saved_images = []
        if isinstance(images_dict, dict):
            for img_name, img_data in images_dict.items():
                target_img_path = images_dir / Path(img_name).name
                if isinstance(img_data, str) and (img_data.startswith("http://") or img_data.startswith("https://")):
                    # URL
                    try:
                        ir = requests.get(img_data, timeout=30)
                        if ir.status_code == 200:
                            target_img_path.write_bytes(ir.content)
                            saved_images.append(str(target_img_path))
                    except Exception:
                        pass
                elif isinstance(img_data, str):
                    # Base64 string
                    b64_str = img_data
                    if "," in b64_str:
                        b64_str = b64_str.split(",", 1)[1]
                    try:
                        img_bytes = base64.b64decode(b64_str)
                        target_img_path.write_bytes(img_bytes)
                        saved_images.append(str(target_img_path))
                    except Exception:
                        pass

        # Check for partial page errors or failed pages
        failed_pages = res_data.get("failed_pages") or res_data.get("page_errors") or []

        return {
            "has_markdown": bool(md_content),
            "has_html": bool(html_content),
            "has_json": bool(json_struct),
            "images_count": len(saved_images),
            "failed_pages": failed_pages,
        }
