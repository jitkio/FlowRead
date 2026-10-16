#!/usr/bin/env python3
"""
FlowRead PDF Parse Evaluation - Main Orchestrator (run.py)
Command-line runner supporting:
- check: inspect environment & credentials without API requests
- slice: only slice sample pages and record mapping
- rebuild: re-normalize existing raw results, re-render overlays, previews and reports offline
- report: read-only report & dashboard generation from existing states
- run: explicit new parsing run with page limit enforcement and idempotency protection
- resume: resume existing registered tasks that have remote IDs
"""

import os
import sys
import time
import argparse
import subprocess
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

# Ensure local directory is in sys.path
SCRIPT_DIR = Path(__file__).parent.resolve()
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# Safe console encoding for Windows
if sys.platform.startswith("win"):
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def load_env_file(env_file_path: Path) -> None:
    """Loads key=value pairs into os.environ if file exists."""
    if not env_file_path.is_file():
        return
    for line in env_file_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


# Auto-load local .env if present
load_env_file(SCRIPT_DIR / ".env")
load_env_file(Path.cwd() / ".env")

from storage import (
    StorageManager,
    compute_task_identity,
    compute_sha256,
    load_json,
    atomic_write_json,
    get_default_output_base_dir,
    ADAPTER_VERSION,
)
from providers.mineru import MinerUProvider, AuthenticationError as MinerUAuthError, ProviderAPIError as MinerUAPIError
from providers.datalab import DatalabProvider, AuthenticationError as DatalabAuthError, ProviderAPIError as DatalabAPIError
from normalize import Normalizer
from report import generate_comparison_dashboard, generate_markdown_report
from overlay import render_block_overlays, generate_verification_report

MAX_PAGE_LIMIT = 10


def check_environment() -> Dict[str, Any]:
    """Inspects local environment, dependencies, and API credentials."""
    status = {
        "python_version": sys.version,
        "pypdf_installed": False,
        "pymupdf_installed": False,
        "requests_installed": False,
        "node_installed": False,
        "mineru_token_present": bool(os.environ.get("MINERU_API_TOKEN")),
        "datalab_key_present": bool(os.environ.get("DATALAB_API_KEY")),
    }

    try:
        import pypdf
        status["pypdf_installed"] = True
    except ImportError:
        pass

    try:
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz
        status["pymupdf_installed"] = True
    except ImportError:
        pass

    try:
        import requests
        status["requests_installed"] = True
    except ImportError:
        pass

    try:
        res = subprocess.run(["node", "-v"], capture_output=True, text=True, check=False)
        if res.returncode == 0:
            status["node_installed"] = True
            status["node_version"] = res.stdout.strip()
    except Exception:
        pass

    return status


def print_env_check(env: Dict[str, Any]) -> None:
    print("\n=== FlowRead PDF Parse Evaluation - 环境检查 ===")
    print(f"Python: {env['python_version'].split()[0]}")
    print(f"pypdf 库: {'✅ 已安装' if env['pypdf_installed'] else '❌ 未安装 (pip install pypdf)'}")
    print(f"PyMuPDF 库: {'✅ 已安装' if env['pymupdf_installed'] else '❌ 未安装 (pip install pymupdf)'}")
    print(f"requests 库: {'✅ 已安装' if env['requests_installed'] else '❌ 未安装'}")
    print(f"Node.js: {'✅ 已安装 (' + env.get('node_version', '') + ')' if env['node_installed'] else '⚠️ 未检测到'}")
    print(f"MINERU_API_TOKEN: {'✅ 已设置' if env['mineru_token_present'] else '❌ 未设置 ($env:MINERU_API_TOKEN=\"...\")'}")
    print(f"DATALAB_API_KEY: {'✅ 已设置' if env['datalab_key_present'] else '❌ 未设置 ($env:DATALAB_API_KEY=\"...\")'}")
    print("================================================\n")


def run_mineru_pipeline(
    storage: StorageManager,
    case_id: str,
    input_pdf_path: Path,
    sample_hash: str,
    page_mappings: List[Dict[str, int]],
    tags: List[str],
    language: str = "ch",
    timeout_seconds: int = 300,
    poll_interval: int = 5,
    variant_name: str = "mineru",
) -> Dict[str, Any]:
    prov_dir = storage.get_provider_dir(case_id, variant_name)
    raw_dir = prov_dir / "raw"
    norm_dir = prov_dir / "normalized"

    is_ocr = "scanned" in tags or True
    params = {
        "model_version": "vlm",
        "enable_formula": True,
        "enable_table": True,
        "language": language,
        "is_ocr": is_ocr,
    }

    task_id = compute_task_identity(sample_hash, variant_name, params)
    state = storage.load_or_init_state(case_id, variant_name, task_id, params)

    # 1. Check if already completed
    if state.get("status") == "completed" and (norm_dir / "content.md").is_file():
        print(f"  [MinerU] 命中已有成功产物，直接复用: {norm_dir / 'content.md'}")
        return state

    # 2. Block repeated submission if state is submission_unknown or submitting without ID
    if state.get("status") in ("submission_unknown", "submitting") and not state.get("remote_task_id"):
        print(f"  [MinerU] ⚠️ 任务当前状态为 '{state.get('status')}' 且未获取到远端 batch_id。")
        print(f"  [MinerU] 🛑 为防止重复扣费，已阻止自动重新提交。请核实网络或手动重置 state.json。")
        return state

    provider = MinerUProvider()

    # 3. Decoupled batch creation and upload
    batch_id = state.get("remote_task_id")
    upload_url = state.get("upload_url")
    t0 = time.time()

    if not batch_id:
        print(f"  [MinerU] 正在创建批次并请求预签名上传 URL...")
        state["status"] = "submitting"
        storage.save_state(case_id, variant_name, state)

        try:
            batch_info = provider.create_batch(
                input_pdf_path=input_pdf_path,
                case_id=case_id,
                is_ocr=is_ocr,
                language=language,
            )
            batch_id = batch_info["batch_id"]
            upload_url = batch_info["upload_url"]

            # IMMEDIATELY persist remote task identity to disk before binary PUT
            state["remote_task_id"] = batch_id
            state["data_id"] = batch_info["data_id"]
            state["upload_url"] = upload_url
            state["status"] = "uploading"
            storage.save_state(case_id, variant_name, state)
            print(f"  [MinerU] 批次已登记持久化 (batch_id: {batch_id})，开始上传 PDF 二进制...")
        except MinerUAuthError as e:
            state["status"] = "failed"
            state["error_message"] = str(e)
            storage.save_state(case_id, variant_name, state)
            print(f"  [MinerU] ❌ 认证错误: {e}")
            return state
        except Exception as e:
            state["status"] = "submission_unknown"
            state["error_message"] = f"创建批次异常: {e}"
            storage.save_state(case_id, variant_name, state)
            print(f"  [MinerU] ⚠️ 提交状态未知，标记等待核实: {e}")
            return state

    # Check batch status if uploading or resuming
    # Check batch status if uploading or resuming
    if state.get("status") == "uploading":
        # Check if remote already received file
        try:
            chk_init = provider.check_batch_status(batch_id)
            r_state = chk_init.get("state")
            if r_state == "waiting-file":
                print(f"  [MinerU] 远端状态为 waiting-file，开始上传 PDF 二进制...")
                provider.upload_file_bytes(upload_url, input_pdf_path)
                state["status"] = "polling"
                state["timings"]["submit_ms"] = int((time.time() - t0) * 1000)
                storage.save_state(case_id, variant_name, state)
                print(f"  [MinerU] 文件上传完成，进入轮询...")
            elif r_state in ("converting", "running", "pending", "done"):
                print(f"  [MinerU] 远端已确认接收文件 (状态: {r_state})，跳过 PUT")
                state["status"] = "polling"
                storage.save_state(case_id, variant_name, state)
            else:
                print(f"  [MinerU] ⚠️ 远端状态未知 ({r_state})，保持现有状态不重试上传")
                state["status"] = "polling_unknown"
                state["error_message"] = f"MinerU query returned unexpected state: {r_state}"
                storage.save_state(case_id, variant_name, state)
                return state
        except Exception as e:
            state["status"] = "upload_failed"
            state["error_message"] = f"文件上传异常: {e}"
            storage.save_state(case_id, variant_name, state)
            print(f"  [MinerU] ❌ 上传文件失败 (batch_id 保留): {e}")
            return state

    # 4. Polling for completion
    t_poll_start = time.time()
    full_zip_url = None
    print(f"  [MinerU] 正在轮询 batch {batch_id} 状态...")

    while True:
        try:
            chk = provider.check_batch_status(batch_id)
            current_status = chk["status"]
            if current_status == "done":
                full_zip_url = chk["full_zip_url"]
                print(f"  [MinerU] 解析完成，获得下载链接。")
                break
            elif current_status == "failed":
                err = chk.get("error_message") or "MinerU parsing failed"
                state["status"] = "failed"
                state["error_message"] = err
                storage.save_state(case_id, variant_name, state)
                print(f"  [MinerU] ❌ 服务端解析失败: {err}")
                return state
            elif current_status == "unknown":
                print(f"    - ⚠️ 轮询返回空结构或状态未知，保持现有状态等待重试...")
                elapsed = time.time() - t_poll_start
                if elapsed >= timeout_seconds:
                    state["status"] = "timeout_waiting_recovery"
                    state["error_message"] = f"轮询超时且远端状态未知 ({timeout_seconds}s)"
                    storage.save_state(case_id, variant_name, state)
                    return state
                time.sleep(max(poll_interval, 0.1))
            else:
                elapsed = time.time() - t_poll_start
                print(f"    - 等待解析中... 状态: {chk.get('state')} ({int(elapsed)}s)")
                if elapsed >= timeout_seconds:
                    state["status"] = "timeout_waiting_recovery"
                    state["error_message"] = f"轮询超时 ({timeout_seconds}s)"
                    storage.save_state(case_id, variant_name, state)
                    print(f"  [MinerU] ⚠️ 轮询达到超时上限，保留 batch_id 等待后续恢复。")
                    return state
                time.sleep(max(poll_interval, 0.1))
        except MinerUAuthError as e:
            state["status"] = "failed"
            state["error_message"] = str(e)
            storage.save_state(case_id, variant_name, state)
            return state
        except Exception as e:
            print(f"    - 临时网络抖动，等待重试: {e}")
            elapsed = time.time() - t_poll_start
            if elapsed >= timeout_seconds:
                state["status"] = "timeout_waiting_recovery"
                state["error_message"] = f"轮询超时 ({timeout_seconds}s)"
                storage.save_state(case_id, variant_name, state)
                return state
            time.sleep(max(poll_interval, 0.1))

    state["timings"]["poll_ms"] = int((time.time() - t_poll_start) * 1000)
    storage.save_state(case_id, variant_name, state)

    # 5. Download and Extract ZIP
    t_dl_start = time.time()
    print(f"  [MinerU] 正在下载并解压结果 ZIP...")
    state["status"] = "downloading"
    storage.save_state(case_id, variant_name, state)

    try:
        dl_res = provider.download_and_extract_results(full_zip_url, raw_dir)
        state["timings"]["download_ms"] = int((time.time() - t_dl_start) * 1000)
        storage.save_state(case_id, variant_name, state)
        print(f"  [MinerU] 下载并解压完成 ({dl_res['files_count']} 个文件)")
    except Exception as e:
        state["status"] = "download_failed"
        state["error_message"] = f"下载解压失败: {e}"
        storage.save_state(case_id, variant_name, state)
        print(f"  [MinerU] ❌ 下载结果失败: {e}")
        return state

    # 6. Normalization
    t_norm_start = time.time()
    print(f"  [MinerU] 正在标准化输出 (content.md, assets, blocks.json)...")
    state["status"] = "normalizing"
    storage.save_state(case_id, variant_name, state)

    try:
        diag = Normalizer.normalize_mineru(raw_dir, norm_dir, page_mappings, input_pdf_path)
        state["diagnostics"] = diag
        state["timings"]["normalize_ms"] = int((time.time() - t_norm_start) * 1000)
        state["timings"]["total_ms"] = int((time.time() - t0) * 1000)
        state["status"] = "completed"
        storage.save_state(case_id, variant_name, state)
        print(f"  [MinerU] ✅ 标准化完成: 识别到 {diag['total_blocks']} 个块, {diag['formulas_count']} 公式, {diag['tables_count']} 表格")
    except Exception as e:
        state["status"] = "normalize_failed"
        state["error_message"] = f"标准化失败: {e}"
        storage.save_state(case_id, variant_name, state)
        print(f"  [MinerU] ❌ 标准化失败: {e}")

    return state


def run_datalab_pipeline(
    storage: StorageManager,
    case_id: str,
    input_pdf_path: Path,
    sample_hash: str,
    page_mappings: List[Dict[str, int]],
    timeout_seconds: int = 300,
    poll_interval: int = 5,
    variant_name: str = "datalab",
    disable_image_captions: bool = True,
    mode: str = "balanced",
) -> Dict[str, Any]:
    prov_dir = storage.get_provider_dir(case_id, variant_name)
    raw_dir = prov_dir / "raw"
    norm_dir = prov_dir / "normalized"

    params = {
        "mode": mode,
        "output_format": "markdown,json,html",
        "add_block_ids": True,
        "disable_image_extraction": False,
        "disable_image_captions": disable_image_captions,
        "paginate": False,
        "merge_cross_page": False,
        "skip_cache": False,
    }

    task_id = compute_task_identity(sample_hash, variant_name, params)
    state = storage.load_or_init_state(case_id, variant_name, task_id, params)

    # 1. Check if already completed
    if state.get("status") == "completed" and (norm_dir / "content.md").is_file():
        print(f"  [{variant_name}] 命中已有成功产物，直接复用: {norm_dir / 'content.md'}")
        return state

    # 2. Block repeated submission if state is submission_unknown or submitting without ID
    if state.get("status") in ("submission_unknown", "submitting") and not state.get("remote_task_id") and not state.get("request_check_url"):
        print(f"  [{variant_name}] ⚠️ 任务当前状态为 '{state.get('status')}' 且未获取到远端 ID。")
        print(f"  [{variant_name}] 🛑 为防止重复扣费，已阻止自动重新提交。请核实网络或手动重置 state.json。")
        return state

    provider = DatalabProvider()

    # 3. Submit if not yet submitted
    req_check_url = state.get("request_check_url")
    t0 = time.time()

    if not req_check_url:
        print(f"  [{variant_name}] 正在提交 PDF (disable_image_captions={disable_image_captions}): {input_pdf_path.name}")
        state["status"] = "submitting"
        storage.save_state(case_id, variant_name, state)

        try:
            sub_res = provider.submit_document(
                input_pdf_path=input_pdf_path,
                mode=mode,
                output_format="markdown,json,html",
                add_block_ids=True,
                disable_image_extraction=False,
                disable_image_captions=disable_image_captions,
                paginate=False,
                merge_cross_page=False,
                skip_cache=False,
            )
            req_check_url = sub_res["request_check_url"]
            state["remote_task_id"] = sub_res["request_id"]
            state["request_check_url"] = req_check_url
            state["status"] = "polling"
            state["timings"]["submit_ms"] = int((time.time() - t0) * 1000)
            storage.save_state(case_id, variant_name, state)
            print(f"  [{variant_name}] 提交成功，获取 request_id: {sub_res['request_id']}")
        except DatalabAuthError as e:
            state["status"] = "failed"
            state["error_message"] = str(e)
            storage.save_state(case_id, variant_name, state)
            print(f"  [{variant_name}] ❌ 认证错误: {e}")
            return state
        except Exception as e:
            state["status"] = "submission_unknown"
            state["error_message"] = f"提交异常: {e}"
            storage.save_state(case_id, variant_name, state)
            print(f"  [{variant_name}] ⚠️ 提交状态未知，标记等待核实: {e}")
            return state

    # 4. Polling for completion
    t_poll_start = time.time()
    print(f"  [{variant_name}] 正在轮询任务状态...")
    chk = None

    while True:
        try:
            chk = provider.check_status(req_check_url)
            current_status = chk["status"]
            if current_status == "done":
                print(f"  [{variant_name}] 解析完成。")
                break
            elif current_status == "failed":
                err = chk.get("error") or "Datalab conversion failed (success is False)"
                state["status"] = "failed"
                state["error_message"] = err
                storage.save_state(case_id, variant_name, state)
                print(f"  [{variant_name}] ❌ 服务端转换失败: {err}")
                return state
            else:
                elapsed = time.time() - t_poll_start
                print(f"    - 等待转换中... 状态: {chk.get('raw_status')} ({int(elapsed)}s)")
                if elapsed >= timeout_seconds:
                    state["status"] = "timeout_waiting_recovery"
                    state["error_message"] = f"轮询超时 ({timeout_seconds}s)"
                    storage.save_state(case_id, variant_name, state)
                    print(f"  [{variant_name}] ⚠️ 轮询达到超时上限，保留 request_id 等待后续恢复。")
                    return state
                time.sleep(max(poll_interval, 0.1))
        except DatalabAuthError as e:
            state["status"] = "failed"
            state["error_message"] = str(e)
            storage.save_state(case_id, variant_name, state)
            return state
        except Exception as e:
            print(f"    - 临时网络抖动，等待重试: {e}")
            elapsed = time.time() - t_poll_start
            if elapsed >= timeout_seconds:
                state["status"] = "timeout_waiting_recovery"
                state["error_message"] = f"轮询超时 ({timeout_seconds}s)"
                storage.save_state(case_id, variant_name, state)
                return state
            time.sleep(max(poll_interval, 0.1))

    state["timings"]["poll_ms"] = int((time.time() - t_poll_start) * 1000)
    storage.save_state(case_id, variant_name, state)

    # 5. Save results
    t_dl_start = time.time()
    print(f"  [{variant_name}] 正在保存结果与图片...")
    state["status"] = "downloading"
    storage.save_state(case_id, variant_name, state)

    try:
        saved_info = provider.save_results(chk, raw_dir)
        state["timings"]["download_ms"] = int((time.time() - t_dl_start) * 1000)
        state["metrics"]["failed_pages"] = saved_info.get("failed_pages", [])
        storage.save_state(case_id, variant_name, state)
        print(f"  [{variant_name}] 结果保存完成 (图片数: {saved_info['images_count']})")
    except Exception as e:
        state["status"] = "download_failed"
        state["error_message"] = f"结果保存失败: {e}"
        storage.save_state(case_id, variant_name, state)
        print(f"  [{variant_name}] ❌ 保存结果失败: {e}")
        return state

    # 6. Normalization
    t_norm_start = time.time()
    print(f"  [{variant_name}] 正在标准化输出 (content.md, assets, blocks.json)...")
    state["status"] = "normalizing"
    storage.save_state(case_id, variant_name, state)

    try:
        diag = Normalizer.normalize_datalab(raw_dir, norm_dir, page_mappings, input_pdf_path)
        state["diagnostics"] = diag
        state["timings"]["normalize_ms"] = int((time.time() - t_norm_start) * 1000)
        state["timings"]["total_ms"] = int((time.time() - t0) * 1000)
        state["status"] = "completed"
        storage.save_state(case_id, variant_name, state)
        print(f"  [{variant_name}] ✅ 标准化完成: 识别到 {diag['total_blocks']} 个块, {diag['formulas_count']} 公式, {diag['tables_count']} 表格")
    except Exception as e:
        state["status"] = "normalize_failed"
        state["error_message"] = f"标准化失败: {e}"
        storage.save_state(case_id, variant_name, state)
        print(f"  [{variant_name}] ❌ 标准化失败: {e}")

    return state


def render_preview_for_provider(
    case_id: str,
    provider: str,
    norm_dir: Path,
    out_html: Path,
) -> bool:
    """Invokes render-preview.mjs via Node to generate standalone dark HTML preview."""
    script_path = SCRIPT_DIR / "render-preview.mjs"
    cmd = ["node", str(script_path), case_id, provider, str(norm_dir), str(out_html)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if res.returncode == 0:
            return True
        else:
            print(f"  ⚠️ Node 预览生成警告: {res.stderr.strip()}")
            return False
    except Exception as e:
        print(f"  ⚠️ 执行 Node 预览脚本异常: {e}")
        return False


def execute_rebuild(run_dir: Path, target_case: Optional[str] = None) -> None:
    """
    Rebuilds normalized outputs, visual overlays, previews, verification, and reports
    purely from saved raw files and samples/ without network calls or tokens.
    """
    print(f"\n🔄 [Rebuild] 开始基于已有 raw 产物重建标准化与可视化视图...")
    print(f"📂 目标评测目录: {run_dir}")

    samples_dir = run_dir / "samples"
    results_dir = run_dir / "results"
    manifest_file = run_dir / "manifest.json"

    if not results_dir.is_dir():
        print(f"❌ 未找到 results 目录: {results_dir}")
        return

    manifest = load_json(manifest_file, default={"run_id": run_dir.name, "cases": {}})
    cases_results = []

    case_dirs = [d for d in results_dir.iterdir() if d.is_dir()]
    for c_dir in case_dirs:
        case_id = c_dir.name
        if target_case and case_id != target_case:
            continue

        sample_case_dir = samples_dir / case_id
        input_pdf = sample_case_dir / "input.pdf"
        page_mappings = load_json(sample_case_dir / "source-pages.json", default=[])

        case_summary = {
            "case_id": case_id,
            "pdf_path": manifest.get("cases", {}).get(case_id, {}).get("source_pdf", str(input_pdf)),
            "pages": [m.get("source_page", 1) for m in page_mappings],
            "tags": manifest.get("cases", {}).get(case_id, {}).get("tags", []),
            "notes": manifest.get("cases", {}).get(case_id, {}).get("notes", ""),
        }

        provider_items_for_overlay = []

        prov_dirs = [p for p in c_dir.iterdir() if p.is_dir()]
        for p_dir in prov_dirs:
            prov_key = p_dir.name
            raw_dir = p_dir / "raw"
            norm_dir = p_dir / "normalized"
            out_preview = p_dir / "preview.html"

            if not raw_dir.is_dir():
                continue

            print(f"\n👉 重建 [{case_id}] - [{prov_key}] 标准化数据...")
            t0 = time.time()
            if "mineru" in prov_key:
                diag = Normalizer.normalize_mineru(raw_dir, norm_dir, page_mappings, input_pdf)
            else:
                diag = Normalizer.normalize_datalab(raw_dir, norm_dir, page_mappings, input_pdf)

            # Update state.json
            state_file = p_dir / "state.json"
            state = load_json(state_file, default={})
            state["diagnostics"] = diag
            state["local_adapter_version"] = ADAPTER_VERSION
            state["rebuilt_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            atomic_write_json(state_file, state)

            # Generate preview HTML
            render_preview_for_provider(case_id, prov_key, norm_dir, out_preview)

            # Load blocks for overlay
            blocks = load_json(norm_dir / "blocks.json", default=[])
            source_map = load_json(norm_dir / "source-map.json", default={})

            # Render overlay PNGs
            v_dir = run_dir / "verification"
            v_dir.mkdir(parents=True, exist_ok=True)
            if input_pdf.is_file():
                overlay_pages = render_block_overlays(
                    input_pdf_path=input_pdf,
                    blocks=blocks,
                    source_map=source_map,
                    output_dir=v_dir,
                    provider_name=prov_key,
                )
                label_name = "MinerU (VLM)" if "mineru" in prov_key else ("Datalab v1 (旧)" if "v1" in prov_key else "Datalab v2 (纠偏)")
                provider_items_for_overlay.append({
                    "id": prov_key,
                    "label": label_name,
                    "blocks": blocks,
                    "pages": overlay_pages,
                })

            case_summary[prov_key] = state

        # Generate verification.html and verification.json
        if provider_items_for_overlay:
            v_html, v_json = generate_verification_report(
                verification_dir=run_dir / "verification",
                case_id=case_id,
                page_mappings=page_mappings,
                provider_items=provider_items_for_overlay,
            )
            print(f"  [Verification] ✅ 叠框验证报告已生成: {v_html}")

        cases_results.append(case_summary)

    # Regenerate comparison dashboard and markdown report
    dash_path = generate_comparison_dashboard(run_dir, manifest, cases_results)
    rep_path = generate_markdown_report(run_dir, manifest, cases_results)
    print(f"\n✅ 对照仪表盘重建完成: {dash_path}")
    print(f"✅ 对照评测报告重建完成: {rep_path}\n")


def execute_resume(
    run_dir: Path,
    target_provider: str = "all",
    target_case: Optional[str] = None,
    timeout_seconds: int = 300,
    poll_interval: int = 5,
) -> None:
    """
    Independent resume runner:
    - Strictly operates on an existing run directory.
    - Does NOT re-slice PDFs and does NOT require original source PDF.
    - Does NOT execute task creation POST requests (no new task submission).
    - If remote_task_id is missing, explicitly logs error and skips.
    - Resumes file PUT upload ONLY if remote status is explicitly 'waiting-file'.
    - Polls tasks to completion, downloads raw results, normalizes, and generates reports.
    """
    print(f"\n🔄 [Resume] 尝试恢复已有评测批次任务: {run_dir}")
    manifest_file = run_dir / "manifest.json"
    results_dir = run_dir / "results"
    samples_dir = run_dir / "samples"

    if not results_dir.is_dir():
        print(f"❌ 未找到 results 目录: {results_dir}")
        return

    manifest = load_json(manifest_file, default={"run_id": run_dir.name, "cases": {}})
    case_dirs = [d for d in results_dir.iterdir() if d.is_dir()]
    cases_results = []

    for c_dir in case_dirs:
        case_id = c_dir.name
        if target_case and case_id != target_case:
            continue

        sample_case_dir = samples_dir / case_id
        input_pdf = sample_case_dir / "input.pdf"
        page_mappings = load_json(sample_case_dir / "source-pages.json", default=[])

        case_summary = {
            "case_id": case_id,
            "pdf_path": manifest.get("cases", {}).get(case_id, {}).get("source_pdf", str(input_pdf)),
            "pages": [m.get("source_page", 1) for m in page_mappings],
            "tags": manifest.get("cases", {}).get(case_id, {}).get("tags", []),
            "notes": manifest.get("cases", {}).get(case_id, {}).get("notes", ""),
        }

        prov_dirs = [p for p in c_dir.iterdir() if p.is_dir()]
        for p_dir in prov_dirs:
            prov_key = p_dir.name
            if target_provider != "all" and target_provider not in prov_key:
                continue

            state_file = p_dir / "state.json"
            state = load_json(state_file, default={})
            status = state.get("status")

            if status == "completed":
                print(f"  [{case_id}] [{prov_key}] 任务已处于 completed 状态，直接跳过")
                case_summary[prov_key] = state
                continue

            remote_id = state.get("remote_task_id")
            if not remote_id:
                print(f"  [{case_id}] [{prov_key}] 🛑 缺少远端任务 ID (remote_task_id)，当前状态: {status}。拒绝新建任务，跳过。")
                state["status"] = "resume_failed"
                state["error_message"] = "Resume failed: Missing remote task ID. Cannot auto-create tasks during resume."
                atomic_write_json(state_file, state)
                case_summary[prov_key] = state
                continue

            print(f"  [{case_id}] [{prov_key}] 发现有效远端任务 ID: {remote_id}，正在恢复...")
            raw_dir = p_dir / "raw"
            norm_dir = p_dir / "normalized"
            out_preview = p_dir / "preview.html"
            t_resume_start = time.time()

            if "mineru" in prov_key:
                provider = MinerUProvider()
                # 1. Check if waiting-file for upload resumption
                if state.get("status") == "uploading":
                    try:
                        chk_init = provider.check_batch_status(remote_id)
                        r_state = chk_init.get("state")
                        if r_state == "waiting-file":
                            if not input_pdf.is_file():
                                print(f"  [MinerU] ❌ 缺少切片样本 input.pdf，无法执行 waiting-file 上传")
                                state["status"] = "resume_failed"
                                state["error_message"] = "Resume failed: Missing sample input.pdf for waiting-file upload."
                                atomic_write_json(state_file, state)
                                case_summary[prov_key] = state
                                continue
                            upload_url = state.get("upload_url")
                            if not upload_url:
                                print(f"  [MinerU] ❌ 缺少 upload_url，无法执行 waiting-file 上传")
                                state["status"] = "resume_failed"
                                state["error_message"] = "Resume failed: Missing upload_url."
                                atomic_write_json(state_file, state)
                                case_summary[prov_key] = state
                                continue
                            print(f"  [MinerU] 远端状态为 waiting-file，开始上传 PDF 字节...")
                            provider.upload_file_bytes(upload_url, input_pdf)
                            state["status"] = "polling"
                            atomic_write_json(state_file, state)
                        elif r_state in ("converting", "running", "pending", "done"):
                            print(f"  [MinerU] 远端已确认接收文件 (状态: {r_state})，直接进入轮询")
                            state["status"] = "polling"
                            atomic_write_json(state_file, state)
                        else:
                            print(f"  [MinerU] ⚠️ 远端状态未知 ({r_state})，停止重试上传")
                            state["status"] = "polling_unknown"
                            atomic_write_json(state_file, state)
                            case_summary[prov_key] = state
                            continue
                    except Exception as e:
                        print(f"  [MinerU] ❌ 检查远端状态异常: {e}")
                        state["status"] = "resume_failed"
                        state["error_message"] = str(e)
                        atomic_write_json(state_file, state)
                        case_summary[prov_key] = state
                        continue

                # 2. Polling loop
                full_zip_url = None
                while True:
                    try:
                        chk = provider.check_batch_status(remote_id)
                        curr_status = chk.get("status")
                        if curr_status == "done":
                            full_zip_url = chk.get("full_zip_url")
                            print(f"  [MinerU] 解析完成，获得下载链接。")
                            break
                        elif curr_status == "failed":
                            err = chk.get("error_message") or "MinerU parsing failed"
                            state["status"] = "failed"
                            state["error_message"] = err
                            atomic_write_json(state_file, state)
                            print(f"  [MinerU] ❌ 服务端解析失败: {err}")
                            break
                        elif curr_status == "unknown":
                            print(f"    - ⚠️ 轮询返回空结构或状态未知，保持现有状态...")
                            if time.time() - t_resume_start >= timeout_seconds:
                                state["status"] = "timeout_waiting_recovery"
                                atomic_write_json(state_file, state)
                                break
                            time.sleep(max(poll_interval, 0.1))
                        else:
                            elapsed = time.time() - t_resume_start
                            print(f"    - 等待解析中... 状态: {chk.get('state')} ({int(elapsed)}s)")
                            if elapsed >= timeout_seconds:
                                state["status"] = "timeout_waiting_recovery"
                                atomic_write_json(state_file, state)
                                print(f"  [MinerU] ⚠️ 轮询超时")
                                break
                            time.sleep(max(poll_interval, 0.1))
                    except Exception as e:
                        print(f"  [MinerU] ⚠️ 轮询网络异常: {e}")
                        time.sleep(max(poll_interval, 0.1))

                if full_zip_url:
                    t_dl = time.time()
                    provider.download_and_extract_results(full_zip_url, raw_dir)
                    state["timings"]["download_ms"] = int((time.time() - t_dl) * 1000)
                    t_norm = time.time()
                    diag = Normalizer.normalize_mineru(raw_dir, norm_dir, page_mappings, input_pdf_path=input_pdf)
                    state["timings"]["normalize_ms"] = int((time.time() - t_norm) * 1000)
                    state["diagnostics"] = diag
                    state["status"] = "completed"
                    atomic_write_json(state_file, state)
                    render_preview_for_provider(case_id, prov_key, norm_dir, out_preview)

            elif "datalab" in prov_key:
                provider = DatalabProvider()
                check_url = state.get("request_check_url") or f"{provider.BASE_URL}/convert/{remote_id}"
                while True:
                    try:
                        chk = provider.check_status(check_url)
                        curr_status = chk.get("status")
                        if curr_status == "complete":
                            print(f"  [Datalab] 任务完成，正在获取结果...")
                            provider.fetch_and_save_result(chk.get("check_url") or check_url, raw_dir)
                            t_norm = time.time()
                            diag = Normalizer.normalize_datalab(raw_dir, norm_dir, page_mappings, input_pdf_path=input_pdf)
                            state["timings"]["normalize_ms"] = int((time.time() - t_norm) * 1000)
                            state["diagnostics"] = diag
                            state["status"] = "completed"
                            atomic_write_json(state_file, state)
                            render_preview_for_provider(case_id, prov_key, norm_dir, out_preview)
                            break
                        elif curr_status == "error":
                            err = chk.get("error_message") or "Datalab error"
                            state["status"] = "failed"
                            state["error_message"] = err
                            atomic_write_json(state_file, state)
                            break
                        else:
                            elapsed = time.time() - t_resume_start
                            print(f"    - 等待 Datalab 解析中... ({int(elapsed)}s)")
                            if elapsed >= timeout_seconds:
                                state["status"] = "timeout_waiting_recovery"
                                atomic_write_json(state_file, state)
                                break
                            time.sleep(max(poll_interval, 0.1))
                    except Exception as e:
                        print(f"  [Datalab] ⚠️ 轮询网络异常: {e}")
                        time.sleep(max(poll_interval, 0.1))

            case_summary[prov_key] = state

        cases_results.append(case_summary)

    # Regenerate reports
    dash_path = generate_comparison_dashboard(run_dir, manifest, cases_results)
    rep_path = generate_markdown_report(run_dir, manifest, cases_results)
    print(f"\n✅ 对照仪表盘已更新: {dash_path}")
    print(f"✅ 对照评测报告已更新: {rep_path}\n")


def execute_report_only(run_dir: Path) -> None:
    """Reads existing state files and produces updated comparison dashboard & report."""
    print(f"\n📊 [Report] 读取已有状态生成横向评测报告: {run_dir}")
    manifest_file = run_dir / "manifest.json"
    results_dir = run_dir / "results"
    samples_dir = run_dir / "samples"

    manifest = load_json(manifest_file, default={"run_id": run_dir.name, "cases": {}})
    cases_results = []

    if results_dir.is_dir():
        for c_dir in results_dir.iterdir():
            if not c_dir.is_dir(): continue
            case_id = c_dir.name
            sample_dir = samples_dir / case_id
            page_mappings = load_json(sample_dir / "source-pages.json", default=[])

            case_data = {
                "case_id": case_id,
                "pdf_path": manifest.get("cases", {}).get(case_id, {}).get("source_pdf", "-"),
                "pages": [m.get("source_page", 1) for m in page_mappings],
                "tags": manifest.get("cases", {}).get(case_id, {}).get("tags", []),
                "notes": manifest.get("cases", {}).get(case_id, {}).get("notes", ""),
            }

            for p_dir in c_dir.iterdir():
                if not p_dir.is_dir(): continue
                st = load_json(p_dir / "state.json", default={})
                case_data[p_dir.name] = st

            cases_results.append(case_data)

    dash_path = generate_comparison_dashboard(run_dir, manifest, cases_results)
    rep_path = generate_markdown_report(run_dir, manifest, cases_results)
    print(f"✅ 仪表盘: {dash_path}")
    print(f"✅ 报告: {rep_path}\n")


def main():
    parser = argparse.ArgumentParser(description="FlowRead PDF Parse Evaluation CLI")
    parser.add_argument("command", nargs="?", default="run",
                        choices=["check", "slice", "rebuild", "report", "run", "resume"],
                        help="Action to perform: check, slice, rebuild, report, run, resume")
    parser.add_argument("--cases", default="cases.local.json",
                        help="Path to sample cases JSON (default: cases.local.json)")
    parser.add_argument("--output-dir", default=None,
                        help="Custom output directory base or target run dir")
    parser.add_argument("--run-id", default=None,
                        help="Specific run ID to create, rebuild, or resume")
    parser.add_argument("--provider", default="all", choices=["mineru", "datalab", "all"],
                        help="Provider to evaluate (default: all)")
    parser.add_argument("--case", default=None,
                        help="Filter by specific case_id")
    parser.add_argument("--force", action="store_true",
                        help="Bypass max page limit check")

    args = parser.parse_args()

    # 1. Subcommand: check
    if args.command == "check":
        env_status = check_environment()
        print_env_check(env_status)
        return

    # Determine target run directory
    base_dir = Path(args.output_dir) if args.output_dir else get_default_output_base_dir()

    # 2. Subcommand: rebuild
    if args.command == "rebuild":
        if args.run_id:
            target_run_dir = (base_dir / args.run_id).resolve()
        elif args.output_dir and Path(args.output_dir).is_dir() and (Path(args.output_dir) / "results").is_dir():
            target_run_dir = Path(args.output_dir).resolve()
        else:
            # Pick latest
            existing_runs = sorted([d for d in base_dir.iterdir() if d.is_dir()], key=lambda x: x.name)
            if not existing_runs:
                print(f"❌ 未在 {base_dir} 找到任何已有评测批次。")
                return
            target_run_dir = existing_runs[-1]

        execute_rebuild(target_run_dir, target_case=args.case)
        return

    # 3. Subcommand: report
    if args.command == "report":
        if args.run_id:
            target_run_dir = (base_dir / args.run_id).resolve()
        elif args.output_dir and Path(args.output_dir).is_dir() and (Path(args.output_dir) / "manifest.json").is_file():
            target_run_dir = Path(args.output_dir).resolve()
        else:
            existing_runs = sorted([d for d in base_dir.iterdir() if d.is_dir()], key=lambda x: x.name)
            if not existing_runs:
                print(f"❌ 未在 {base_dir} 找到任何已有评测批次。")
                return
            target_run_dir = existing_runs[-1]

        execute_report_only(target_run_dir)
        return

    # 4. Subcommand: resume
    if args.command == "resume":
        if args.run_id:
            target_run_dir = (base_dir / args.run_id).resolve()
        elif args.output_dir and Path(args.output_dir).is_dir() and (Path(args.output_dir) / "results").is_dir():
            target_run_dir = Path(args.output_dir).resolve()
        else:
            existing_runs = sorted([d for d in base_dir.iterdir() if d.is_dir()], key=lambda x: x.name)
            if not existing_runs:
                print(f"❌ 未在 {base_dir} 找到任何已有评测批次。")
                return
            target_run_dir = existing_runs[-1]

        execute_resume(target_run_dir, target_provider=args.provider, target_case=args.case)
        return

    # Check for cases configuration file
    cases_file = Path(args.cases)
    if not cases_file.is_file() and (SCRIPT_DIR / args.cases).is_file():
        cases_file = SCRIPT_DIR / args.cases
    elif not cases_file.is_file():
        fallback = SCRIPT_DIR / "cases.example.json"
        print(f"\n⚠️ 样本配置文件未找到: {cases_file}")
        print(f"请复制示例配置并填写实际 PDF 绝对路径:")
        print(f"  copy {fallback} cases.local.json\n")
        return

    cases_data = load_json(cases_file, default=[])
    if not isinstance(cases_data, list) or len(cases_data) == 0:
        print(f"❌ 样本文件 {cases_file} 内容为空或格式不合法。")
        return

    # Initialize storage manager
    storage = StorageManager(run_id=args.run_id, output_base=args.output_dir)

    # 4. Subcommand: slice
    if args.command == "slice":
        print(f"\n✂️ [Slice] 开始按配置切片样本...")
        print(f"📂 目标样本输出目录: {storage.samples_dir}")
        for case_item in cases_data:
            case_id = case_item.get("case_id")
            if args.case and case_id != args.case: continue
            pdf_path = case_item.get("pdf_path")
            pages = case_item.get("pages", [])

            if len(pages) > MAX_PAGE_LIMIT and not args.force:
                print(f"⚠️ 样本 [{case_id}] 页数 ({len(pages)}) 超过限额 ({MAX_PAGE_LIMIT})，使用 --force 跳过")
                continue

            try:
                res = storage.slice_pdf(case_id, pdf_path, pages)
                print(f"  ✅ 样本 [{case_id}] 切片完成: {res['pages_count']} 页 -> {res['sample_pdf']}")
            except Exception as e:
                print(f"  ❌ 样本 [{case_id}] 切片失败: {e}")
        return

    # 5. Subcommand: run or resume
    print(f"\n🚀 初始化 FlowRead PDF 解析评测任务: {storage.run_id}")
    print(f"📂 输出目录: {storage.run_dir}")

    manifest_cases = {}
    cases_results = []

    for case_item in cases_data:
        case_id = case_item.get("case_id")
        if args.case and case_id != args.case:
            continue

        pdf_path = case_item.get("pdf_path")
        pages = case_item.get("pages", [])
        tags = case_item.get("tags", [])
        notes = case_item.get("notes", "")

        # Page limit check
        if len(pages) > MAX_PAGE_LIMIT and not args.force:
            print(f"🛑 样本 [{case_id}] 页数 ({len(pages)}) 超过限制 ({MAX_PAGE_LIMIT} 页)。已终止提交以保护额度。")
            continue

        # Slicing
        try:
            slice_info = storage.slice_pdf(
                case_id=case_id,
                source_pdf_path=pdf_path,
                pages_1_based=pages,
            )
        except Exception as e:
            print(f"❌ 样本切片失败: {e}")
            continue

        sample_pdf = Path(slice_info["sample_pdf"])
        sample_hash = slice_info["sample_pdf_hash"]
        page_mappings = slice_info["page_mappings"]

        manifest_cases[case_id] = slice_info

        case_summary = {
            "case_id": case_id,
            "pdf_path": pdf_path,
            "pages": pages,
            "tags": tags,
            "notes": notes,
        }

        # MinerU Pipeline
        if args.provider in ("mineru", "all"):
            print(f"\n👉 [MinerU] 启动/检查任务...")
            mineru_state = run_mineru_pipeline(
                storage=storage,
                case_id=case_id,
                input_pdf_path=sample_pdf,
                sample_hash=sample_hash,
                page_mappings=page_mappings,
                tags=tags,
            )
            norm_dir = storage.get_provider_dir(case_id, "mineru") / "normalized"
            out_preview = storage.get_provider_dir(case_id, "mineru") / "preview.html"
            render_preview_for_provider(case_id, "mineru", norm_dir, out_preview)
            case_summary["mineru"] = mineru_state

        # Datalab Pipeline
        if args.provider in ("datalab", "all"):
            print(f"\n👉 [Datalab] 启动/检查任务...")
            datalab_state = run_datalab_pipeline(
                storage=storage,
                case_id=case_id,
                input_pdf_path=sample_pdf,
                sample_hash=sample_hash,
                page_mappings=page_mappings,
                disable_image_captions=True,
            )
            norm_dir = storage.get_provider_dir(case_id, "datalab") / "normalized"
            out_preview = storage.get_provider_dir(case_id, "datalab") / "preview.html"
            render_preview_for_provider(case_id, "datalab", norm_dir, out_preview)
            case_summary["datalab"] = datalab_state

        cases_results.append(case_summary)

    manifest_data = {
        "run_id": storage.run_id,
        "adapter_version": ADAPTER_VERSION,
        "cases": manifest_cases,
    }
    storage.update_manifest(manifest_data)

    print("\n==========================================")
    print("📊 生成横向对照仪表盘与报告...")
    dash_path = generate_comparison_dashboard(storage.run_dir, manifest_data, cases_results)
    rep_path = generate_markdown_report(storage.run_dir, manifest_data, cases_results)

    print(f"\n✅ 对照仪表盘已生成: {dash_path}")
    print(f"✅ 对照评测报告已生成: {rep_path}")
    print(f"==========================================\n")


if __name__ == "__main__":
    main()
