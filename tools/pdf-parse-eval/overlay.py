"""
FlowRead PDF Parse Evaluation - Visual Bounding Box Overlay Generator
Renders original PDF pages and overlays extracted bounding boxes to visually
verify coordinate accuracy, reading order, and block boundaries.
Outputs:
1. PNG overlay images for each page & provider
2. verification.html report showing side-by-side visual comparisons
3. verification.json containing structured verification evidence
"""

import os
import json
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz
    except ImportError:
        fitz = None

from storage import load_json, atomic_write_json


COLOR_MAP = {
    "paragraph": (0.1, 0.4, 0.9),       # Blue
    "text": (0.1, 0.4, 0.9),
    "heading": (0.0, 0.7, 0.8),         # Cyan
    "formula": (0.1, 0.8, 0.2),         # Green
    "equation": (0.1, 0.8, 0.2),
    "image": (0.9, 0.3, 0.1),           # Orange / Red
    "figure": (0.9, 0.3, 0.1),
    "caption": (0.6, 0.2, 0.8),         # Purple
    "table": (0.9, 0.7, 0.1),           # Amber
    "page_header": (0.5, 0.5, 0.5),     # Gray
    "page_number": (0.5, 0.5, 0.5),
    "unknown": (0.7, 0.7, 0.7),
}


def render_pdf_page_to_pixmap(doc, page_idx: int, dpi: int = 150):
    page = doc[page_idx]
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    return page.get_pixmap(matrix=mat, alpha=False)


def render_block_overlays(
    input_pdf_path: str | Path,
    blocks: List[Dict[str, Any]],
    source_map: Dict[str, Any],
    output_dir: str | Path,
    provider_name: str,
    dpi: int = 150,
) -> List[Dict[str, Any]]:
    """
    Renders overlay PNGs for each page with bounding boxes drawn over the PDF page.
    """
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) is required for visual overlay rendering.")

    out_path = Path(output_dir).resolve()
    out_path.mkdir(parents=True, exist_ok=True)

    pdf_doc = fitz.open(str(input_pdf_path))
    total_pages = len(pdf_doc)
    page_results = []

    # Group blocks by sample_page (1-based)
    blocks_by_page: Dict[int, List[Dict[str, Any]]] = {}
    for b in blocks:
        p = b.get("page_sample", 1)
        blocks_by_page.setdefault(p, []).append(b)

    zoom = dpi / 72.0

    for sample_p in range(1, total_pages + 1):
        page_idx = sample_p - 1
        page = pdf_doc[page_idx]
        rect = page.rect
        pw, ph = rect.width, rect.height

        # Create overlay doc clone
        single_doc = fitz.open()
        single_doc.insert_pdf(pdf_doc, from_page=page_idx, to_page=page_idx)
        annot_page = single_doc[0]

        page_blocks = blocks_by_page.get(sample_p, [])
        annot_count = 0

        for b in page_blocks:
            bid = b.get("id", "")
            s_entry = source_map.get(bid, {})
            pt_bbox = s_entry.get("pt_bbox") or b.get("pt_bbox")
            norm_bbox = s_entry.get("normalized_bbox") or b.get("normalized_bbox")

            rect_box = None
            if pt_bbox and len(pt_bbox) == 4:
                rect_box = fitz.Rect(pt_bbox[0], pt_bbox[1], pt_bbox[2], pt_bbox[3])
            elif norm_bbox and len(norm_bbox) == 4:
                rect_box = fitz.Rect(norm_bbox[0] * pw, norm_bbox[1] * ph, norm_bbox[2] * pw, norm_bbox[3] * ph)

            if rect_box and rect_box.width > 2 and rect_box.height > 2:
                btype = b.get("type", "unknown")
                color = COLOR_MAP.get(btype, (0.5, 0.5, 0.5))

                # Draw rectangle
                annot = annot_page.add_rect_annot(rect_box)
                annot.set_colors(stroke=color, fill=color)
                annot.set_opacity(0.22)
                annot.set_border(width=1.5)
                annot.update()

                # Add short label
                label_text = f"[{b.get('reading_order', '')}] {btype}"
                annot_page.insert_text(
                    fitz.Point(rect_box.x0 + 2, max(rect_box.y0 - 2, 12)),
                    label_text,
                    fontsize=8,
                    color=color,
                )
                annot_count += 1

        # Render pixmap
        mat = fitz.Matrix(zoom, zoom)
        pix = annot_page.get_pixmap(matrix=mat, alpha=False)
        img_name = f"{provider_name}_page_{sample_p}.png"
        img_file = out_path / img_name
        pix.save(str(img_file))
        single_doc.close()

        # Also render clean original page if not already exists
        orig_img_name = f"orig_page_{sample_p}.png"
        orig_img_file = out_path / orig_img_name
        if not orig_img_file.exists():
            orig_pix = page.get_pixmap(matrix=mat, alpha=False)
            orig_pix.save(str(orig_img_file))

        page_results.append({
            "sample_page": sample_p,
            "provider": provider_name,
            "image_filename": img_name,
            "orig_image_filename": orig_img_name,
            "blocks_count": len(page_blocks),
            "annotated_boxes_count": annot_count,
            "page_dim_pt": [round(pw, 2), round(ph, 2)],
        })

    pdf_doc.close()
    return page_results


def generate_verification_report(
    verification_dir: str | Path,
    case_id: str,
    page_mappings: List[Dict[str, int]],
    mineru_overlay_results: Optional[List[Dict[str, Any]]] = None,
    datalab_overlay_results: Optional[List[Dict[str, Any]]] = None,
    mineru_blocks: Optional[List[Dict[str, Any]]] = None,
    datalab_blocks: Optional[List[Dict[str, Any]]] = None,
    provider_items: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, str]:
    """
    Generates verification.html and verification.json.
    Supports either explicit provider_items list or legacy positional args.
    provider_items format:
    [
        {"id": "mineru", "label": "MinerU (VLM)", "blocks": [...], "pages": [...]},
        {"id": "datalab_v1", "label": "Datalab v1 (Old)", "blocks": [...], "pages": [...]},
        {"id": "datalab_v2", "label": "Datalab v2 (Corrected)", "blocks": [...], "pages": [...]},
    ]
    """
    v_dir = Path(verification_dir).resolve()
    v_dir.mkdir(parents=True, exist_ok=True)

    items = []
    if provider_items:
        items = provider_items
    else:
        if mineru_blocks is not None or mineru_overlay_results is not None:
            items.append({
                "id": "mineru",
                "label": "MinerU (VLM)",
                "blocks": mineru_blocks or [],
                "pages": mineru_overlay_results or [],
            })
        if datalab_blocks is not None or datalab_overlay_results is not None:
            items.append({
                "id": "datalab",
                "label": "Datalab (Tree)",
                "blocks": datalab_blocks or [],
                "pages": datalab_overlay_results or [],
            })

    # Build verification.json
    v_json_data = {
        "case_id": case_id,
        "page_mappings": page_mappings,
        "verification_method": "offline_pdf_overlay_rendering",
        "providers": {},
    }

    for item in items:
        pid = item["id"]
        blks = item.get("blocks", [])
        v_json_data["providers"][pid] = {
            "label": item.get("label", pid),
            "total_blocks": len(blks),
            "blocks_with_bbox": sum(1 for b in blks if b.get("normalized_bbox")),
            "pages": item.get("pages", []),
        }

    # Backward compatibility keys
    if "mineru" in v_json_data["providers"]:
        v_json_data["mineru"] = v_json_data["providers"]["mineru"]
    if "datalab" in v_json_data["providers"]:
        v_json_data["datalab"] = v_json_data["providers"]["datalab"]

    json_file = v_dir / "verification.json"
    atomic_write_json(json_file, v_json_data)

    cols_count = len(items) + 1
    # Build verification.html
    html_lines = [
        "<!DOCTYPE html>",
        "<html lang='zh-CN'>",
        "<head>",
        "  <meta charset='UTF-8'>",
        f"  <title>FlowRead 来源坐标核对与叠框验证 - {case_id}</title>",
        "  <style>",
        "    body { background: #0f1012; color: #e6edf3; font-family: system-ui, sans-serif; margin: 0; padding: 24px; }",
        "    h1, h2 { color: #f0f6fc; }",
        "    .page-row { background: #16181d; border: 1px solid #2d3139; border-radius: 8px; margin-bottom: 32px; padding: 20px; }",
        f"    .grid {{ display: grid; grid-template-columns: repeat({cols_count}, 1fr); gap: 16px; margin-top: 16px; }}",
        "    .col { background: #1c1f26; border: 1px solid #2d3139; border-radius: 6px; padding: 12px; text-align: center; }",
        "    .col img { width: 100%; height: auto; border: 1px solid #3d4450; border-radius: 4px; background: #fff; }",
        "    .col-title { font-weight: 600; margin-bottom: 8px; font-size: 14px; }",
        "    .badge { padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; color: #fff; }",
        "    .badge.mineru { background: #1f6feb; }",
        "    .badge.datalab, .badge.datalab_v1, .badge.datalab_v2 { background: #8957e5; }",
        "    .badge.orig { background: #30363d; }",
        "    .legend { display: flex; gap: 12px; margin: 16px 0; font-size: 12px; flex-wrap: wrap; }",
        "    .legend-item { display: flex; align-items: center; gap: 4px; }",
        "    .legend-box { width: 12px; height: 12px; border-radius: 2px; }",
        "  </style>",
        "</head>",
        "<body>",
        f"  <h1>FlowRead 🎯 来源坐标与 Bounding Box 叠框实证核对</h1>",
        f"  <p style='color:#8b949e;'>样本: <code>{case_id}</code> | 核对方法: 真实 PDF 渲染 + 提取坐标原位叠框</p>",
        "  <div class='legend'>",
        "    <div class='legend-item'><div class='legend-box' style='background:#1a66e5;'></div> 正文段落</div>",
        "    <div class='legend-item'><div class='legend-box' style='background:#00b3cc;'></div> 标题</div>",
        "    <div class='legend-item'><div class='legend-box' style='background:#1acc33;'></div> 数学公式</div>",
        "    <div class='legend-item'><div class='legend-box' style='background:#e64d1a;'></div> 图片/电路图</div>",
        "    <div class='legend-item'><div class='legend-box' style='background:#9933cc;'></div> 图注</div>",
        "  </div>",
    ]

    for p_map in page_mappings:
        sp = p_map.get("sample_page", 1)
        src_p = p_map.get("source_page", 1)
        orig_img = f"orig_page_{sp}.png"

        html_lines.extend([
            "  <div class='page-row'>",
            f"    <h2>切片第 {sp} 页 (原 PDF 第 {src_p} 页)</h2>",
            "    <div class='grid'>",
            "      <div class='col'>",
            "        <div class='col-title'><span class='badge orig'>原图</span> PDF 原页</div>",
            f"        <img src='{orig_img}' alt='原页 {sp}'>",
            "      </div>",
        ])

        for item in items:
            pid = item["id"]
            label = item.get("label", pid)
            badge_cls = "mineru" if "mineru" in pid else "datalab"
            img_file = f"{pid}_page_{sp}.png"
            html_lines.extend([
                "      <div class='col'>",
                f"        <div class='col-title'><span class='badge {badge_cls}'>{label}</span> 叠框</div>",
                f"        <img src='{img_file}' alt='{label} 叠框 {sp}'>",
                "      </div>",
            ])

        html_lines.extend([
            "    </div>",
            "  </div>",
        ])

    html_lines.extend([
        "</body>",
        "</html>",
    ])

    html_file = v_dir / "verification.html"
    html_file.write_text("\n".join(html_lines), encoding="utf-8")

    return str(html_file), str(json_file)

