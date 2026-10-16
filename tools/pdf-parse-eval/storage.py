"""
FlowRead PDF Parse Evaluation - Storage & Task Lifecycle Management
Manages task directories, PDF slicing, source page mapping, state persistence,
task identity hashing, and secure zip extraction.
"""

import os
import json
import hashlib
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional

try:
    import pypdf
except ImportError:
    pypdf = None


ADAPTER_VERSION = "1.0.0"


def get_default_output_base_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "FlowRead" / "parse-eval"
    # Fallback to local user home or current tool directory
    return Path.home() / ".flowread" / "parse-eval"


def compute_sha256(filepath: str | Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def compute_task_identity(
    sample_hash: str,
    provider: str,
    params: Dict[str, Any],
) -> str:
    """
    Computes hash representing the remote request identity.
    Only depends on sample content, provider, and remote API request parameters.
    Does NOT depend on local adapter or visualization code versions.
    """
    canonical = json.dumps(
        {
            "sample_hash": sample_hash,
            "provider": provider.lower(),
            "params": params,
        },
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def safe_extract_zip(zip_path: str | Path, target_dir: str | Path) -> List[str]:
    """
    Safely extract zip files preventing Zip Slip vulnerabilities.
    Returns list of extracted file paths.
    """
    target_path = Path(target_dir).resolve()
    target_path.mkdir(parents=True, exist_ok=True)
    extracted_files = []

    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            # Resolve full target path
            dest_file = (target_path / member.filename).resolve()
            if not str(dest_file).startswith(str(target_path)):
                raise ValueError(
                    f"Security violation: Zip member '{member.filename}' escapes destination directory."
                )
            zf.extract(member, target_path)
            extracted_files.append(str(dest_file))
    return extracted_files


def atomic_write_json(file_path: str | Path, data: Any, indent: int = 2) -> None:
    p = Path(file_path).resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = p.with_suffix(p.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)
    shutil.move(str(tmp_path), str(p))


def load_json(file_path: str | Path, default: Any = None) -> Any:
    p = Path(file_path)
    if not p.is_file():
        return default
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


class StorageManager:
    """Manages files and state for a single evaluation run."""

    def __init__(self, run_id: Optional[str] = None, output_base: Optional[str | Path] = None):
        self.run_id = run_id or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        base = Path(output_base) if output_base else get_default_output_base_dir()
        self.run_dir = (base / self.run_id).resolve()
        self.samples_dir = self.run_dir / "samples"
        self.results_dir = self.run_dir / "results"
        self.manifest_file = self.run_dir / "manifest.json"

        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.samples_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)

    def get_sample_dir(self, case_id: str) -> Path:
        d = self.samples_dir / case_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def get_provider_dir(self, case_id: str, provider: str) -> Path:
        d = self.results_dir / case_id / provider.lower()
        d.mkdir(parents=True, exist_ok=True)
        (d / "raw").mkdir(exist_ok=True)
        (d / "normalized").mkdir(exist_ok=True)
        (d / "normalized" / "assets").mkdir(exist_ok=True)
        return d

    def slice_pdf(
        self,
        case_id: str,
        source_pdf_path: str | Path,
        pages_1_based: List[int],
    ) -> Dict[str, Any]:
        """
        Slices requested pages into samples/<case_id>/input.pdf
        and records source-pages.json mapping.
        """
        if pypdf is None:
            raise RuntimeError("pypdf is required to slice PDF files. Please install pypdf.")

        src_path = Path(source_pdf_path).resolve()
        if not src_path.is_file():
            raise FileNotFoundError(f"Source PDF not found at {src_path}")

        case_dir = self.get_sample_dir(case_id)
        input_pdf_path = case_dir / "input.pdf"
        source_pages_path = case_dir / "source-pages.json"

        reader = pypdf.PdfReader(str(src_path))
        total_source_pages = len(reader.pages)

        # Validate pages
        valid_pages = []
        for p in pages_1_based:
            if not isinstance(p, int) or p < 1 or p > total_source_pages:
                raise ValueError(
                    f"Page {p} out of bounds for {src_path.name} (1..{total_source_pages})"
                )
            valid_pages.append(p)

        # Write sliced PDF
        writer = pypdf.PdfWriter()
        page_mappings = []
        for sample_idx, orig_page_num in enumerate(valid_pages, start=1):
            writer.add_page(reader.pages[orig_page_num - 1])
            page_mappings.append(
                {
                    "sample_page": sample_idx,
                    "source_page": orig_page_num,
                }
            )

        with open(input_pdf_path, "wb") as f:
            writer.write(f)

        atomic_write_json(source_pages_path, page_mappings)

        src_hash = compute_sha256(src_path)
        sample_hash = compute_sha256(input_pdf_path)

        return {
            "case_id": case_id,
            "source_pdf": str(src_path),
            "source_pdf_hash": src_hash,
            "source_total_pages": total_source_pages,
            "sample_pdf": str(input_pdf_path),
            "sample_pdf_hash": sample_hash,
            "pages_count": len(valid_pages),
            "page_mappings": page_mappings,
        }

    def get_provider_state(self, case_id: str, provider: str) -> Optional[Dict[str, Any]]:
        prov_dir = self.get_provider_dir(case_id, provider)
        return load_json(prov_dir / "state.json")

    def load_or_init_state(
        self,
        case_id: str,
        provider: str,
        task_identity: str,
        initial_params: Dict[str, Any],
    ) -> Dict[str, Any]:
        prov_dir = self.get_provider_dir(case_id, provider)
        state_file = prov_dir / "state.json"

        existing = load_json(state_file)
        if existing and existing.get("task_identity") == task_identity:
            return existing

        state = {
            "task_identity": task_identity,
            "case_id": case_id,
            "provider": provider.lower(),
            "adapter_version": ADAPTER_VERSION,
            "status": "pending",
            "remote_task_id": None,
            "request_check_url": None,
            "params": initial_params,
            "error_message": None,
            "error_code": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "finished_at": None,
            "timings": {
                "submit_ms": None,
                "poll_ms": None,
                "download_ms": None,
                "normalize_ms": None,
                "total_ms": None,
            },
            "metrics": {
                "raw_cost": None,
                "pages_processed": None,
                "failed_pages": [],
            },
        }
        atomic_write_json(state_file, state)
        return state

    def save_state(self, case_id: str, provider: str, state: Dict[str, Any]) -> None:
        prov_dir = self.get_provider_dir(case_id, provider)
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        atomic_write_json(prov_dir / "state.json", state)

    def update_manifest(self, data: Dict[str, Any]) -> None:
        manifest = load_json(self.manifest_file, default={})
        manifest.update(data)
        manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
        atomic_write_json(self.manifest_file, manifest)
