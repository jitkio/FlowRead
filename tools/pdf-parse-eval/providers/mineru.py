"""
MinerU Precise Parse API Provider (v4 - VLM mode)
Handles batch submission, direct binary upload, status polling, and zip download.
"""

import time
import os
from pathlib import Path
from typing import Dict, Any, Optional, Callable
import requests

from storage import safe_extract_zip


class AuthenticationError(Exception):
    """Raised when API credentials are missing or rejected (401/403)."""
    pass


class ProviderAPIError(Exception):
    """Raised when the provider API returns a business or format error."""
    pass


class MinerUProvider:
    BASE_URL = "https://mineru.net/api/v4"

    def __init__(self, api_token: Optional[str] = None):
        self.api_token = api_token or os.environ.get("MINERU_API_TOKEN")

    def validate_credentials(self) -> None:
        if not self.api_token or not self.api_token.strip():
            raise AuthenticationError(
                "MINERU_API_TOKEN is missing. Please set the environment variable MINERU_API_TOKEN."
            )

    def create_batch(
        self,
        input_pdf_path: str | Path,
        case_id: str,
        is_ocr: bool = True,
        language: str = "ch",
        data_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Requests upload URL and registers batch_id WITHOUT uploading bytes yet.
        Allows caller to persist the batch_id before sending payload.
        """
        self.validate_credentials()
        pdf_path = Path(input_pdf_path).resolve()
        if not pdf_path.is_file():
            raise FileNotFoundError(f"Input PDF not found: {pdf_path}")

        file_size = pdf_path.stat().st_size
        filename = pdf_path.name
        file_data_id = data_id or f"{case_id}_{int(time.time())}"

        headers = {
            "Authorization": f"Bearer {self.api_token.strip()}",
            "Content-Type": "application/json",
        }

        payload = {
            "model_version": "vlm",
            "enable_formula": True,
            "enable_table": True,
            "language": language,
            "files": [
                {
                    "name": filename,
                    "data_id": file_data_id,
                    "is_ocr": is_ocr,
                }
            ],
        }

        url = f"{self.BASE_URL}/file-urls/batch"
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=30)
        except requests.RequestException as e:
            raise ProviderAPIError(f"Network error during MinerU batch creation: {e}") from e

        if resp.status_code in (401, 403):
            raise AuthenticationError(
                f"MinerU authentication failed (HTTP {resp.status_code}): {resp.text}"
            )

        try:
            res_json = resp.json()
        except Exception as e:
            raise ProviderAPIError(
                f"MinerU returned invalid JSON (HTTP {resp.status_code}): {resp.text}"
            ) from e

        code = res_json.get("code")
        if code != 0:
            msg = res_json.get("msg") or res_json.get("message") or str(res_json)
            if code in (401, 403) or "auth" in msg.lower() or "token" in msg.lower():
                raise AuthenticationError(f"MinerU Token rejected: {msg}")
            raise ProviderAPIError(f"MinerU batch creation error (code {code}): {msg}")

        data = res_json.get("data", {})
        batch_id = data.get("batch_id")
        if not batch_id:
            raise ProviderAPIError(f"MinerU response missing batch_id: {res_json}")

        file_urls = data.get("file_urls", [])
        if not file_urls:
            raise ProviderAPIError(f"MinerU response missing file_urls: {res_json}")

        # Extract upload URL
        first_url_entry = file_urls[0]
        if isinstance(first_url_entry, str):
            upload_url = first_url_entry
        elif isinstance(first_url_entry, dict):
            upload_url = first_url_entry.get("file_url") or first_url_entry.get("upload_url")
        else:
            upload_url = str(first_url_entry)

        if not upload_url:
            raise ProviderAPIError(f"Cannot resolve upload URL from MinerU response: {file_urls}")

        return {
            "batch_id": batch_id,
            "data_id": file_data_id,
            "upload_url": upload_url,
            "filename": filename,
            "file_size": file_size,
        }

    def upload_file_bytes(
        self,
        upload_url: str,
        input_pdf_path: str | Path,
    ) -> None:
        """
        PUTs raw PDF bytes to upload_url. No MinerU authorization header is included.
        """
        pdf_path = Path(input_pdf_path).resolve()
        if not pdf_path.is_file():
            raise FileNotFoundError(f"Input PDF not found: {pdf_path}")

        file_size = pdf_path.stat().st_size
        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()

        try:
            put_resp = requests.put(
                upload_url,
                data=pdf_bytes,
                headers={"Content-Length": str(file_size)},
                timeout=120,
            )
        except requests.RequestException as e:
            raise ProviderAPIError(
                f"Network error while uploading PDF to MinerU ({upload_url}): {e}"
            ) from e

        if put_resp.status_code not in (200, 201, 204):
            raise ProviderAPIError(
                f"MinerU file upload failed (HTTP {put_resp.status_code}): {put_resp.text}"
            )

    def submit_and_upload(
        self,
        input_pdf_path: str | Path,
        case_id: str,
        is_ocr: bool = True,
        language: str = "ch",
        data_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Combines create_batch and upload_file_bytes in sequence.
        """
        info = self.create_batch(
            input_pdf_path=input_pdf_path,
            case_id=case_id,
            is_ocr=is_ocr,
            language=language,
            data_id=data_id,
        )
        self.upload_file_bytes(info["upload_url"], input_pdf_path)
        return info

    def check_batch_status(self, batch_id: str) -> Dict[str, Any]:
        """
        Queries MinerU extract results for the given batch_id.
        """
        self.validate_credentials()
        url = f"{self.BASE_URL}/extract-results/batch/{batch_id}"
        headers = {
            "Authorization": f"Bearer {self.api_token.strip()}",
        }

        try:
            resp = requests.get(url, headers=headers, timeout=30)
        except requests.RequestException as e:
            raise ProviderAPIError(f"Network error querying MinerU batch {batch_id}: {e}") from e

        if resp.status_code in (401, 403):
            raise AuthenticationError(
                f"MinerU authentication failed during status check (HTTP {resp.status_code})"
            )

        try:
            res_json = resp.json()
        except Exception as e:
            raise ProviderAPIError(f"Invalid JSON querying batch {batch_id}: {resp.text}") from e

        code = res_json.get("code")
        if code != 0:
            msg = res_json.get("msg") or res_json.get("message") or str(res_json)
            raise ProviderAPIError(f"MinerU query error (code {code}): {msg}")

        data = res_json.get("data")
        if not isinstance(data, dict):
            return {
                "batch_id": batch_id,
                "state": "unknown",
                "status": "unknown",
                "full_zip_url": None,
                "error_message": None,
                "raw_response": res_json,
            }

        extract_result = data.get("extract_result", [])
        if not extract_result or not isinstance(extract_result, list):
            return {
                "batch_id": batch_id,
                "state": "unknown",
                "status": "unknown",
                "full_zip_url": None,
                "error_message": None,
                "raw_response": res_json,
            }

        first_item = extract_result[0]
        item_state = first_item.get("state", "").lower()
        full_zip_url = first_item.get("full_zip_url")
        err_msg = first_item.get("err_msg")

        # Normalize status to unified taxonomy
        # MinerU states: waiting-file, pending, running, converting, done, failed
        if item_state == "done":
            status = "done"
        elif item_state == "failed":
            status = "failed"
        elif item_state in ("waiting-file", "pending", "running", "converting"):
            status = "processing"
        else:
            status = item_state or "processing"

        return {
            "batch_id": batch_id,
            "state": item_state,
            "status": status,
            "full_zip_url": full_zip_url,
            "error_message": err_msg,
            "item_detail": first_item,
            "raw_response": res_json,
        }

    def download_and_extract_results(
        self,
        full_zip_url: str,
        dest_raw_dir: str | Path,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Dict[str, Any]:
        """
        Downloads result ZIP and securely unpacks into raw/extracted/.
        """
        raw_dir = Path(dest_raw_dir).resolve()
        raw_dir.mkdir(parents=True, exist_ok=True)
        zip_path = raw_dir / "mineru_result.zip"
        tmp_zip = raw_dir / "mineru_result.zip.tmp"
        extracted_dir = raw_dir / "extracted"

        # Download ZIP (no auth header per spec)
        try:
            with requests.get(full_zip_url, stream=True, timeout=120) as r:
                r.raise_for_status()
                total_bytes = int(r.headers.get("content-length", 0))
                downloaded = 0
                with open(tmp_zip, "wb") as f:
                    for chunk in r.iter_content(chunk_size=65536):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            if on_progress:
                                on_progress(downloaded, total_bytes)
        except requests.RequestException as e:
            if tmp_zip.exists():
                tmp_zip.unlink(missing_ok=True)
            raise ProviderAPIError(f"Failed to download MinerU zip from {full_zip_url}: {e}") from e

        if zip_path.exists():
            zip_path.unlink()
        tmp_zip.rename(zip_path)

        # Safe extract
        extracted_files = safe_extract_zip(zip_path, extracted_dir)

        return {
            "zip_path": str(zip_path),
            "extracted_dir": str(extracted_dir),
            "files_count": len(extracted_files),
        }
