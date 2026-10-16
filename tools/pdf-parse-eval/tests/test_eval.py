"""
Offline Test Suite for FlowRead PDF Parse Evaluation Tool
Tests authentication errors, completion with error, ZIP safety, task recovery,
idempotency, unknown submission handling, and normalization.
No external network requests are made.
"""

import os
import sys
import io
import json
import zipfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Ensure parent directory is in path
CURRENT_DIR = Path(__file__).parent.resolve()
TOOL_DIR = CURRENT_DIR.parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

from storage import (
    StorageManager,
    safe_extract_zip,
    compute_task_identity,
    atomic_write_json,
    load_json,
)
from providers.mineru import MinerUProvider, AuthenticationError as MinerUAuthError, ProviderAPIError as MinerUAPIError
from providers.datalab import DatalabProvider, AuthenticationError as DatalabAuthError, ProviderAPIError as DatalabAPIError
from normalize import Normalizer
from report import generate_comparison_dashboard, generate_markdown_report


def create_minimal_pdf_bytes(num_pages: int = 3) -> bytes:
    """Generates a valid, minimal blank multi-page PDF using pypdf."""
    import pypdf
    writer = pypdf.PdfWriter()
    for _ in range(num_pages):
        writer.add_blank_page(width=595, height=842)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


class TestPDFParseEvalOffline(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.test_root = Path(self.temp_dir.name)
        self.storage = StorageManager(run_id="test_run", output_base=self.test_root)

    def tearDown(self):
        self.temp_dir.cleanup()

    # 1. Test Zip Slip Prevention
    def test_zip_slip_security_prevention(self):
        malicious_zip_path = self.test_root / "evil.zip"
        with zipfile.ZipFile(malicious_zip_path, "w") as zf:
            zf.writestr("../evil_file.txt", "malicious payload")

        extract_dest = self.test_root / "safe_extract"
        with self.assertRaises(ValueError) as ctx:
            safe_extract_zip(malicious_zip_path, extract_dest)
        self.assertIn("escapes destination directory", str(ctx.exception))
        self.assertFalse((self.test_root / "evil_file.txt").exists())

    # 2. Test PDF Slicing and 1-based Page Mapping
    def test_pdf_slicing_and_page_mapping(self):
        pdf_bytes = create_minimal_pdf_bytes(num_pages=5)
        source_pdf = self.test_root / "source.pdf"
        source_pdf.write_bytes(pdf_bytes)

        slice_info = self.storage.slice_pdf(
            case_id="case_01",
            source_pdf_path=source_pdf,
            pages_1_based=[2, 4],
        )

        self.assertEqual(slice_info["pages_count"], 2)
        mapping = slice_info["page_mappings"]
        self.assertEqual(mapping[0], {"sample_page": 1, "source_page": 2})
        self.assertEqual(mapping[1], {"sample_page": 2, "source_page": 4})

        # Verify output.pdf exists and has exactly 2 pages
        import pypdf
        sliced_reader = pypdf.PdfReader(slice_info["sample_pdf"])
        self.assertEqual(len(sliced_reader.pages), 2)

    # 3. Test MinerU Auth Error Handling (401 / 403)
    @patch("requests.post")
    def test_mineru_auth_error(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "Unauthorized Token"
        mock_post.return_value = mock_resp

        provider = MinerUProvider(api_token="invalid_token")
        fake_pdf = self.test_root / "test.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 test")

        with self.assertRaises(MinerUAuthError) as ctx:
            provider.submit_and_upload(fake_pdf, case_id="test_case")
        self.assertIn("authentication failed", str(ctx.exception).lower())

    # 4. Test MinerU Normal Flow (Submit, Poll, Download)
    @patch("requests.get")
    @patch("requests.put")
    @patch("requests.post")
    def test_mineru_full_success_flow(self, mock_post, mock_put, mock_get):
        # Mock POST /file-urls/batch
        post_resp = MagicMock()
        post_resp.status_code = 200
        post_resp.json.return_value = {
            "code": 0,
            "data": {
                "batch_id": "batch_999",
                "file_urls": ["https://upload.mineru.net/put_here"],
            },
        }
        mock_post.return_value = post_resp

        # Mock PUT upload
        put_resp = MagicMock()
        put_resp.status_code = 200
        mock_put.return_value = put_resp

        provider = MinerUProvider(api_token="valid_token")
        fake_pdf = self.test_root / "test.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 test content")

        sub_res = provider.submit_and_upload(fake_pdf, case_id="case_01")
        self.assertEqual(sub_res["batch_id"], "batch_999")
        self.assertEqual(sub_res["upload_url"], "https://upload.mineru.net/put_here")

        # Mock GET /extract-results/batch/batch_999
        # Polling: state converting -> done
        poll_resp_1 = MagicMock()
        poll_resp_1.status_code = 200
        poll_resp_1.json.return_value = {
            "code": 0,
            "data": {
                "extract_result": [{"state": "converting"}],
            },
        }
        mock_get.return_value = poll_resp_1
        chk1 = provider.check_batch_status("batch_999")
        self.assertEqual(chk1["status"], "processing")

        poll_resp_2 = MagicMock()
        poll_resp_2.status_code = 200
        poll_resp_2.json.return_value = {
            "code": 0,
            "data": {
                "extract_result": [{
                    "state": "done",
                    "full_zip_url": "https://download.mineru.net/res.zip",
                }],
            },
        }
        mock_get.return_value = poll_resp_2
        chk2 = provider.check_batch_status("batch_999")
        self.assertEqual(chk2["status"], "done")
        self.assertEqual(chk2["full_zip_url"], "https://download.mineru.net/res.zip")

    # 5. Test Datalab Auth Error Handling
    @patch("requests.post")
    def test_datalab_auth_error(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_resp.text = "Forbidden API Key"
        mock_post.return_value = mock_resp

        provider = DatalabProvider(api_key="invalid_key")
        fake_pdf = self.test_root / "test.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 test")

        with self.assertRaises(DatalabAuthError) as ctx:
            provider.submit_document(fake_pdf)
        self.assertIn("authentication failed", str(ctx.exception).lower())

    # 6. Test Datalab Complete but Success=False
    @patch("requests.get")
    def test_datalab_complete_but_failed(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "status": "complete",
            "success": False,
            "error": "OCR engine crashed on page 2",
        }
        mock_get.return_value = mock_resp

        provider = DatalabProvider(api_key="valid_key")
        chk = provider.check_status("https://www.datalab.to/api/v1/convert/req_123")
        self.assertEqual(chk["status"], "failed")
        self.assertIn("OCR engine crashed", chk["error"])

    # 7. Test Datalab Result Saving & Base64 Image Decoding
    def test_datalab_save_results_with_base64_images(self):
        # 1x1 transparent PNG in base64
        tiny_png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        res_dict = {
            "status": "done",
            "data": {
                "markdown": "# Header\n\nSome text.\n\n![Figure](img1.png)",
                "html": "<p>Some text.</p>",
                "json": {
                    "pages": [{
                        "page_number": 1,
                        "blocks": [{
                            "type": "paragraph",
                            "content": "Some text.",
                            "bbox": [10, 10, 200, 30],
                        }],
                    }],
                },
                "images": {
                    "img1.png": tiny_png_b64,
                },
            },
        }

        provider = DatalabProvider(api_key="key")
        raw_dest = self.test_root / "datalab_raw"
        saved_info = provider.save_results(res_dict, raw_dest)

        self.assertTrue(saved_info["has_markdown"])
        self.assertTrue(saved_info["has_json"])
        self.assertEqual(saved_info["images_count"], 1)
        self.assertTrue((raw_dest / "images" / "img1.png").is_file())

    # 8. Test Normalization Logic for MinerU and Datalab
    def test_normalization_and_source_mapping(self):
        norm_dir = self.test_root / "normalized"
        raw_dir = self.test_root / "mineru_raw"
        extracted_dir = raw_dir / "extracted"
        extracted_dir.mkdir(parents=True)

        # Write fake MinerU outputs
        (extracted_dir / "test.md").write_text("# 标题\n\n正文内容，公式：$$E=mc^2$$\n\n![图示](figure1.png)", encoding="utf-8")
        content_list = [
            {"type": "title", "text": "标题", "page_idx": 0, "bbox": [50, 50, 200, 70]},
            {"type": "text", "text": "正文内容", "page_idx": 0, "bbox": [50, 80, 400, 100]},
            {"type": "isolated_formula", "text": "$$E=mc^2$$", "page_idx": 0, "bbox": [50, 110, 300, 130]},
            {"type": "image", "text": "figure1.png", "page_idx": 1, "bbox": [50, 150, 400, 350]},
        ]
        atomic_write_json(extracted_dir / "test_content_list.json", content_list)

        # Create dummy image
        img_dir = extracted_dir / "images"
        img_dir.mkdir()
        (img_dir / "figure1.png").write_bytes(b"fake image bytes")

        page_mappings = [
            {"sample_page": 1, "source_page": 10},
            {"sample_page": 2, "source_page": 11},
        ]

        diag = Normalizer.normalize_mineru(raw_dir, norm_dir, page_mappings)
        self.assertEqual(diag["total_blocks"], 4)
        self.assertEqual(diag["formulas_count"], 1)
        self.assertEqual(diag["images_count"], 1)

        # Check blocks.json
        blocks = load_json(norm_dir / "blocks.json")
        self.assertEqual(blocks[0]["type"], "heading")
        self.assertEqual(blocks[0]["page_source"], 10)  # Mapped from sample_page 1
        self.assertEqual(blocks[3]["type"], "image")
        self.assertEqual(blocks[3]["page_source"], 11)  # Mapped from sample_page 2

        # Check source-map.json
        source_map = load_json(norm_dir / "source-map.json")
        self.assertIn("mineru_blk_0001", source_map)
        self.assertEqual(source_map["mineru_blk_0001"]["page_source"], 10)

    # 9. Test Dashboard and Report Generation
    def test_report_generation(self):
        cases_results = [
            {
                "case_id": "test_case_01",
                "pdf_path": "C:\\test\\doc.pdf",
                "pages": [1, 2],
                "tags": ["chinese", "formula"],
                "notes": "测试对照",
                "mineru": {
                    "status": "completed",
                    "timings": {"submit_ms": 120, "poll_ms": 3500, "download_ms": 400, "total_ms": 4020},
                    "diagnostics": {"total_blocks": 15, "formulas_count": 3, "tables_count": 1, "images_count": 2},
                },
                "datalab": {
                    "status": "completed",
                    "timings": {"submit_ms": 200, "poll_ms": 4100, "download_ms": 300, "total_ms": 4600},
                    "diagnostics": {"total_blocks": 16, "formulas_count": 3, "tables_count": 1, "images_count": 2},
                },
            }
        ]
        manifest = {"run_id": "test_report_run"}
        dash_path = generate_comparison_dashboard(self.test_root, manifest, cases_results)
        rep_path = generate_markdown_report(self.test_root, manifest, cases_results)

        self.assertTrue(Path(dash_path).is_file())
        self.assertTrue(Path(rep_path).is_file())

        rep_text = Path(rep_path).read_text(encoding="utf-8")
        self.assertIn("FlowRead 文档解析接入对照评测报告", rep_text)
        self.assertIn("用户人工核对", rep_text)
        self.assertIn("程序检查", rep_text)
        self.assertIn("MinerU (v4 - VLM 模式)", rep_text)

    # 10. Test Task Idempotency: Completed tasks are skipped
    def test_task_idempotency_skip_completed(self):
        from run import run_mineru_pipeline
        norm_dir = self.storage.get_provider_dir("case_idem", "mineru") / "normalized"
        norm_dir.mkdir(parents=True, exist_ok=True)
        (norm_dir / "content.md").write_text("# Already Done", encoding="utf-8")

        params = {
            "model_version": "vlm",
            "enable_formula": True,
            "enable_table": True,
            "language": "ch",
            "is_ocr": True,
        }
        task_id = compute_task_identity("sample_hash_123", "mineru", params)
        state = self.storage.load_or_init_state("case_idem", "mineru", task_id, params)
        state["status"] = "completed"
        self.storage.save_state("case_idem", "mineru", state)

        # Call pipeline without setting token
        res_state = run_mineru_pipeline(
            storage=self.storage,
            case_id="case_idem",
            input_pdf_path=Path("dummy.pdf"),
            sample_hash="sample_hash_123",
            page_mappings=[],
            tags=[],
        )
        self.assertEqual(res_state["status"], "completed")

    # 11. Test Task Recovery: Existing remote task id skips submit and resumes polling
    @patch("run.MinerUProvider.check_batch_status")
    @patch("run.MinerUProvider.submit_and_upload")
    def test_task_recovery_resumes_remote_id(self, mock_submit, mock_poll):
        from run import run_mineru_pipeline
        mock_poll.return_value = {
            "status": "processing",
            "state": "running",
        }

        params = {
            "model_version": "vlm",
            "enable_formula": True,
            "enable_table": True,
            "language": "ch",
            "is_ocr": True,
        }
        task_id = compute_task_identity("sample_hash_recover", "mineru", params)
        state = self.storage.load_or_init_state("case_recover", "mineru", task_id, params)
        state["remote_task_id"] = "batch_existing_123"
        state["status"] = "polling"
        self.storage.save_state("case_recover", "mineru", state)

        # Run pipeline with a very short timeout so it exits polling cleanly
        res_state = run_mineru_pipeline(
            storage=self.storage,
            case_id="case_recover",
            input_pdf_path=Path("dummy.pdf"),
            sample_hash="sample_hash_recover",
            page_mappings=[],
            tags=[],
            timeout_seconds=0.01,
            poll_interval=0.01,
        )

        # submit_and_upload should NOT have been called
        mock_submit.assert_not_called()
        # check_batch_status should have been called with existing batch_id
        mock_poll.assert_called_with("batch_existing_123")
        self.assertEqual(res_state["status"], "timeout_waiting_recovery")

    # 12. Test Submission Unknown on Network Drop
    @patch("run.DatalabProvider.submit_document")
    def test_submission_unknown_on_network_drop(self, mock_submit):
        from run import run_datalab_pipeline
        mock_submit.side_effect = Exception("Connection aborted by peer")

        fake_pdf = self.test_root / "test_drop.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 dummy")

        res_state = run_datalab_pipeline(
            storage=self.storage,
            case_id="case_net_drop",
            input_pdf_path=fake_pdf,
            sample_hash="sample_hash_drop",
            page_mappings=[],
        )

        self.assertEqual(res_state["status"], "submission_unknown")
        self.assertIn("提交异常", res_state["error_message"])

    # 13. Test Submission Unknown Blocks Subsequent Auto-Submit
    @patch("run.DatalabProvider.submit_document")
    def test_submission_unknown_blocks_subsequent_submit(self, mock_submit):
        from run import run_datalab_pipeline
        mock_submit.side_effect = Exception("Temporary drop")

        fake_pdf = self.test_root / "test_block.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 dummy")

        # 1st call fails
        state1 = run_datalab_pipeline(
            storage=self.storage,
            case_id="case_block_submit",
            input_pdf_path=fake_pdf,
            sample_hash="hash_block_1",
            page_mappings=[],
        )
        self.assertEqual(state1["status"], "submission_unknown")
        self.assertEqual(mock_submit.call_count, 1)

        # 2nd call: MUST NOT call submit_document again!
        state2 = run_datalab_pipeline(
            storage=self.storage,
            case_id="case_block_submit",
            input_pdf_path=fake_pdf,
            sample_hash="hash_block_1",
            page_mappings=[],
        )
        self.assertEqual(state2["status"], "submission_unknown")
        # Ensure submit_document was still called only ONCE in total!
        self.assertEqual(mock_submit.call_count, 1)

    # 14. Test MinerU Decoupled Batch Creation and Upload
    @patch("providers.mineru.requests.put")
    @patch("providers.mineru.requests.post")
    def test_mineru_decoupled_batch_and_upload(self, mock_post, mock_put):
        post_resp = MagicMock()
        post_resp.status_code = 200
        post_resp.json.return_value = {
            "code": 0,
            "data": {
                "batch_id": "batch_decoupled_888",
                "file_urls": ["https://upload.mineru.net/put_binary"],
            },
        }
        mock_post.return_value = post_resp

        put_resp = MagicMock()
        put_resp.status_code = 200
        mock_put.return_value = put_resp

        provider = MinerUProvider(api_token="valid_token")
        fake_pdf = self.test_root / "test_decoupled.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 binary content")

        # 1. create_batch
        info = provider.create_batch(fake_pdf, case_id="c_decoupled")
        self.assertEqual(info["batch_id"], "batch_decoupled_888")
        self.assertEqual(info["upload_url"], "https://upload.mineru.net/put_binary")
        mock_put.assert_not_called()

        # 2. upload_file_bytes
        provider.upload_file_bytes(info["upload_url"], fake_pdf)
        mock_put.assert_called_once()

    # 15. Test Datalab Real Tree Parsing (Page nodes with child blocks and page=0)
    def test_datalab_real_tree_parsing(self):
        norm_dir = self.test_root / "datalab_tree_norm"
        raw_dir = self.test_root / "datalab_tree_raw"
        raw_dir.mkdir(parents=True)

        real_tree_json = {
            "children": [
                {
                    "block_type": "Page",
                    "page": 0,
                    "bbox": [0, 0, 1344.0, 1932.0],
                    "children": [
                        {
                            "id": "blk_p0_h",
                            "block_type": "Heading",
                            "page": 0,
                            "bbox": [50, 60, 500, 100],
                            "html": "<h1>Section 2.2</h1>",
                        },
                        {
                            "id": "blk_p0_p",
                            "block_type": "Paragraph",
                            "page": 0,
                            "bbox": [50, 120, 500, 300],
                            "html": "<p>In this section we analyze the boost converter circuit.</p>",
                        },
                    ],
                },
                {
                    "block_type": "Page",
                    "page": 1,
                    "bbox": [0, 0, 1344.0, 1932.0],
                    "children": [
                        {
                            "id": "blk_p1_fig",
                            "block_type": "Figure",
                            "page": 1,
                            "bbox": [100, 200, 800, 600],
                            "html": "<img src='fig2_13.png'>",
                        },
                    ],
                },
            ],
            "metadata": {"total_pages": 2},
        }

        atomic_write_json(raw_dir / "result.json", real_tree_json)
        (raw_dir / "result.md").write_text("# Section 2.2\n\nIn this section...\n\n![Fig](fig2_13.png)", encoding="utf-8")
        (raw_dir / "images").mkdir()
        (raw_dir / "images" / "fig2_13.png").write_bytes(b"dummy image")

        page_mappings = [
            {"sample_page": 1, "source_page": 41},
            {"sample_page": 2, "source_page": 42},
        ]

        diag = Normalizer.normalize_datalab(raw_dir, norm_dir, page_mappings)
        self.assertEqual(diag["total_blocks"], 3)

        blocks = load_json(norm_dir / "blocks.json")
        # Page 0 should map to sample_page 1 and source_page 41
        self.assertEqual(blocks[0]["page_sample"], 1)
        self.assertEqual(blocks[0]["page_source"], 41)
        self.assertEqual(blocks[0]["type"], "heading")
        self.assertIsNotNone(blocks[0]["normalized_bbox"])

        # Page 1 should map to sample_page 2 and source_page 42
        self.assertEqual(blocks[2]["page_sample"], 2)
        self.assertEqual(blocks[2]["page_source"], 42)
        self.assertEqual(blocks[2]["type"], "image")

    # 16. Test Geometry Coordinate Normalization
    def test_geometry_coordinate_normalization(self):
        from geometry import normalize_bbox

        # 1. 1000 grid
        res_grid = normalize_bbox([200, 100, 800, 500], "grid_1000")
        self.assertEqual(res_grid["normalized_bbox"], [0.2, 0.1, 0.8, 0.5])

        # 2. Pixel coordinates (1344 x 1932 px)
        res_px = normalize_bbox([134.4, 193.2, 672.0, 966.0], "pixel", raw_page_dim=(1344.0, 1932.0), pt_page_dim=(504.0, 719.0))
        self.assertAlmostEqual(res_px["normalized_bbox"][0], 0.1, places=3)
        self.assertAlmostEqual(res_px["normalized_bbox"][1], 0.1, places=3)
        self.assertAlmostEqual(res_px["normalized_bbox"][2], 0.5, places=3)
        self.assertAlmostEqual(res_px["normalized_bbox"][3], 0.5, places=3)

    # 17. Test Rebuild Offline Mode (no tokens, no network)
    def test_rebuild_offline_mode(self):
        from run import execute_rebuild

        run_dir = self.test_root / "test_rebuild_run"
        samples_dir = run_dir / "samples" / "sample_c1"
        samples_dir.mkdir(parents=True)
        atomic_write_json(samples_dir / "source-pages.json", [{"sample_page": 1, "source_page": 100}])

        # Create dummy PDF in samples
        pdf_bytes = create_minimal_pdf_bytes(1)
        (samples_dir / "input.pdf").write_bytes(pdf_bytes)

        # Provider raw directory
        raw_dir = run_dir / "results" / "sample_c1" / "datalab_v1" / "raw"
        raw_dir.mkdir(parents=True)
        (raw_dir / "result.md").write_text("# Offline Rebuild\n\nContent here.", encoding="utf-8")
        atomic_write_json(raw_dir / "result.json", {
            "children": [{
                "block_type": "Page",
                "page": 0,
                "children": [{
                    "id": "blk_1",
                    "block_type": "Paragraph",
                    "page": 0,
                    "bbox": [50, 50, 200, 100],
                    "html": "<p>Content here.</p>",
                }],
            }],
        })

        # Run execute_rebuild completely offline
        execute_rebuild(run_dir)

        # Check outputs exist
        self.assertTrue((run_dir / "results" / "sample_c1" / "datalab_v1" / "normalized" / "blocks.json").is_file())
        self.assertTrue((run_dir / "results" / "sample_c1" / "datalab_v1" / "preview.html").is_file())
        self.assertTrue((run_dir / "comparison.html").is_file())
        self.assertTrue((run_dir / "report.md").is_file())

    # 18. Test Resume Blocks New Task Submission when remote_task_id is missing
    @patch("requests.post")
    def test_resume_blocks_new_task_submission(self, mock_post):
        from run import execute_resume

        run_dir = self.test_root / "test_resume_run"
        p_dir = run_dir / "results" / "case_01" / "datalab"
        p_dir.mkdir(parents=True)
        # State with missing remote_task_id
        state_file = p_dir / "state.json"
        atomic_write_json(state_file, {
            "status": "submission_unknown",
            "remote_task_id": None,
            "params": {"mode": "balanced"}
        })

        execute_resume(run_dir)

        # Verify POST was NEVER called to create new task
        mock_post.assert_not_called()
        res_state = load_json(state_file)
        self.assertEqual(res_state["status"], "resume_failed")
        self.assertIn("Missing remote task ID", res_state["error_message"])

    # 19. Test MinerU Retries PUT Only Under waiting-file
    @patch("requests.put")
    @patch("providers.mineru.MinerUProvider.check_batch_status")
    def test_mineru_put_only_on_waiting_file(self, mock_chk, mock_put):
        from run import run_mineru_pipeline

        sample_pdf = self.test_root / "sample.pdf"
        sample_pdf.write_bytes(b"%PDF-1.4 test")

        mock_put.return_value.status_code = 200

        # Scenario A: remote returns waiting-file -> should invoke PUT
        mock_chk.return_value = {"state": "waiting-file", "status": "processing"}
        state = self.storage.load_or_init_state("c1", "mineru", "ident_1", {})
        state["status"] = "uploading"
        state["remote_task_id"] = "batch_test_1"
        state["upload_url"] = "https://upload.mineru.net/put"
        self.storage.save_state("c1", "mineru", state)

        # Mock check_batch_status to terminate polling after upload
        mock_chk.side_effect = [
            {"state": "waiting-file", "status": "processing"},
            {"state": "converting", "status": "processing"},
            {"state": "failed", "status": "failed", "error_message": "Stop test loop"}
        ]

        run_mineru_pipeline(
            storage=self.storage,
            case_id="c1",
            input_pdf_path=sample_pdf,
            sample_hash="fake_hash",
            page_mappings=[],
            tags=[],
            timeout_seconds=2,
            poll_interval=0.01,
        )
        self.assertTrue(mock_put.called)
        mock_put.reset_mock()

        # Scenario B: remote already in converting -> should NOT invoke PUT
        mock_chk.side_effect = [
            {"state": "converting", "status": "processing"},
            {"state": "failed", "status": "failed", "error_message": "Stop test loop"}
        ]
        state2 = self.storage.load_or_init_state("c2", "mineru", "ident_2", {})
        state2["status"] = "uploading"
        state2["remote_task_id"] = "batch_test_2"
        state2["upload_url"] = "https://upload.mineru.net/put"
        self.storage.save_state("c2", "mineru", state2)

        run_mineru_pipeline(
            storage=self.storage,
            case_id="c2",
            input_pdf_path=sample_pdf,
            sample_hash="fake_hash_2",
            page_mappings=[],
            tags=[],
            timeout_seconds=2,
            poll_interval=0.01,
        )
        self.assertFalse(mock_put.called)

    # 20. Test Polling Empty Dict Does Not Trigger Re-upload
    @patch("requests.put")
    @patch("requests.post")
    @patch("requests.get")
    def test_polling_empty_dict_does_not_reupload(self, mock_get, mock_post, mock_put):
        # Empty data returned from server
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"code": 0, "data": {}}
        mock_get.return_value = mock_resp

        provider = MinerUProvider(api_token="valid_token")
        res = provider.check_batch_status("batch_empty_data")

        self.assertEqual(res["status"], "unknown")
        self.assertEqual(res["state"], "unknown")
        mock_post.assert_not_called()
        mock_put.assert_not_called()

    # 21. Test MinerU Inline Math and Chart Asset Extraction
    def test_mineru_inline_math_and_chart_extraction(self):
        raw_dir = self.test_root / "mineru_raw"
        raw_dir.mkdir(parents=True)
        norm_dir = self.test_root / "mineru_norm"

        # Create dummy chart image in raw/images/
        img_dir = raw_dir / "images"
        img_dir.mkdir(parents=True)
        (img_dir / "chart_fig16.jpg").write_bytes(b"dummy image bytes")

        # Mock content_list_v2.json
        c2_content = [
            [
                {
                    "type": "paragraph",
                    "content": {
                        "paragraph_content": [
                            {"type": "text", "content": "Use of the linear-ripple approximation, "},
                            {"type": "equation_inline", "content": "v \\approx V"},
                            {"type": "text", "content": ", leads to"}
                        ]
                    },
                    "bbox": [100, 100, 500, 150]
                },
                {
                    "type": "chart",
                    "content": {
                        "image_source": {"path": "images/chart_fig16.jpg"},
                        "chart_caption": [
                            {"type": "text", "content": "Fig. 2.16 Dc conversion ratio "},
                            {"type": "equation_inline", "content": "M(D)"},
                            {"type": "text", "content": " of the boost converter."}
                        ]
                    },
                    "bbox": [150, 200, 600, 500]
                }
            ]
        ]
        atomic_write_json(raw_dir / "doc_content_list_v2.json", c2_content)

        Normalizer.normalize_mineru(raw_dir, norm_dir, [{"sample_page": 1, "source_page": 42}])
        blocks = load_json(norm_dir / "blocks.json")

        self.assertEqual(len(blocks), 2)
        # Check paragraph inline math preservation
        p_blk = blocks[0]
        self.assertEqual(p_blk["type"], "paragraph")
        self.assertIn("$v \\approx V$", p_blk["content"])
        self.assertEqual(len(p_blk["inline_runs"]), 3)
        self.assertEqual(p_blk["inline_runs"][1]["type"], "equation_inline")

        # Check chart conversion to displayable image block
        c_blk = blocks[1]
        self.assertEqual(c_blk["type"], "image")
        self.assertEqual(c_blk["raw_type"], "chart")
        self.assertEqual(c_blk["asset_ref"], "chart_fig16.jpg")
        self.assertTrue((norm_dir / "assets" / "chart_fig16.jpg").is_file())
        self.assertIn("$M(D)$", c_blk["caption"])
        self.assertNotIn("{'image_source'", c_blk["content"])

    # 22. Test Datalab img-text Separation and Entity Decoding
    def test_datalab_img_text_separation_and_entity_decoding(self):
        raw_dir = self.test_root / "datalab_raw"
        raw_dir.mkdir(parents=True)
        norm_dir = self.test_root / "datalab_norm"

        img_dir = raw_dir / "images"
        img_dir.mkdir(parents=True)
        (img_dir / "fig_circuit.jpg").write_bytes(b"circuit img")

        raw_json = {
            "children": [{
                "block_type": "Page",
                "page": 0,
                "bbox": [0, 0, 1344.0, 1932.0],
                "children": [
                    {
                        "id": "blk_fig",
                        "block_type": "Figure",
                        "page": 0,
                        "bbox": [200, 100, 800, 400],
                        "html": '<img src="fig_circuit.jpg"/><p class="img-text">(a)</p><p class="img-text"><math>V_g</math></p>',
                    },
                    {
                        "id": "blk_eq",
                        "block_type": "Equation",
                        "page": 0,
                        "bbox": [200, 420, 800, 500],
                        "html": '<p><math display="block">\\begin{aligned} v_L &amp;= V_g \\\\ i_C &amp;= -\\frac{v}{R} \\end{aligned}</math></p>',
                    }
                ]
            }]
        }
        atomic_write_json(raw_dir / "result.json", raw_json)

        Normalizer.normalize_datalab(raw_dir, norm_dir, [{"sample_page": 1, "source_page": 41}])
        blocks = load_json(norm_dir / "blocks.json")

        self.assertEqual(len(blocks), 2)
        fig_blk = blocks[0]
        self.assertEqual(fig_blk["type"], "image")
        self.assertEqual(fig_blk["asset_ref"], "fig_circuit.jpg")
        # In-image text separated
        self.assertEqual(fig_blk["in_image_text"], ["(a)", "$V_g$"])
        self.assertNotIn("(a)", fig_blk["content"])
        self.assertNotIn("$V_g$", fig_blk["content"])

        # Equation entity unescaping
        eq_blk = blocks[1]
        self.assertEqual(eq_blk["type"], "formula")
        self.assertIn("v_L &=", eq_blk["content"])
        self.assertNotIn("&amp;=", eq_blk["content"])

    # 23. Test Missing Page Dimensions Coordinate Normalization Rejection
    def test_missing_page_dimensions_rejected(self):
        from geometry import normalize_bbox

        # raw_page_dim is None -> must reject pixel coordinates
        res_none = normalize_bbox([100, 100, 500, 500], "pixel", raw_page_dim=None)
        self.assertFalse(res_none["is_valid"])
        self.assertIsNone(res_none["normalized_bbox"])
        self.assertIn("Missing raw_page_dim", res_none["reason"])

        # raw_page_dim is invalid [0, 0]
        res_zero = normalize_bbox([100, 100, 500, 500], "pixel", raw_page_dim=(0, 0))
        self.assertFalse(res_zero["is_valid"])
        self.assertIsNone(res_zero["normalized_bbox"])


if __name__ == "__main__":
    unittest.main()


