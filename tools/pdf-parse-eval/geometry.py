"""
FlowRead PDF Parse Evaluation - Geometry and Coordinate Normalization Module
Provides mathematically grounded conversions between:
1. MinerU content_list [0..1000] grid coordinates
2. MinerU layout pt coordinates
3. Datalab pixel coordinates [0..W_px, 0..H_px]
4. Unified normalized [0..1] relative float coordinates
5. Unified PDF point (pt) coordinates [0..W_pt, 0..H_pt]

Rules:
- Never assume default page dimensions (e.g., no default 1344x1932);
- Never guess unknown coordinate systems based on numbers looking < 1;
- Reject inverted, degenerate, or out-of-bounds coordinates with explicit diagnostics;
- Do not silently swap or clamp invalid bounding boxes;
- Clearly document rotation and viewport limitations.
"""

from typing import List, Dict, Any, Optional, Tuple
from pathlib import Path


def normalize_bbox(
    raw_bbox: Optional[List[float]],
    coord_system: str,
    raw_page_dim: Optional[Tuple[float, float]] = None,
    pt_page_dim: Optional[Tuple[float, float]] = None,
) -> Dict[str, Any]:
    """
    Transforms raw bounding box into normalized [0..1] and PDF point coordinates.
    Returns structured metadata with explicit validity flag and diagnostics.
    """
    base_result = {
        "raw_bbox": raw_bbox,
        "coord_system": coord_system,
        "raw_page_dim": list(raw_page_dim) if raw_page_dim else None,
        "normalized_bbox": None,
        "pt_bbox": None,
        "pt_page_dim": list(pt_page_dim) if pt_page_dim else None,
        "origin": "top-left",
        "rotation": 0,
        "crop_support": "standard_mediabox_only",
        "is_valid": False,
        "reason": None,
        "highlight_compatibility_note": (
            "Direct canvas.width * normalized_bbox scaling is valid only for 0-degree uncropped pages. "
            "Production reader must incorporate PDF viewport transform matrix and rotation."
        ),
    }

    if not raw_bbox or len(raw_bbox) != 4:
        base_result["reason"] = "raw_bbox must be a list of 4 float values [x0, y0, x1, y1]"
        return base_result

    try:
        x0, y0, x1, y1 = [float(v) for v in raw_bbox]
    except (ValueError, TypeError) as e:
        base_result["reason"] = f"Invalid numeric values in raw_bbox: {e}"
        return base_result

    # Reject inverted or degenerate coordinates (x1 <= x0 or y1 <= y0)
    # Per rule: "越界、反向或异常坐标不要静默修整后宣布有效"
    if x1 <= x0 or y1 <= y0:
        base_result["reason"] = f"Inverted or degenerate bounding box: x0={x0}, y0={y0}, x1={x1}, y1={y1}"
        return base_result

    norm_x0, norm_y0, norm_x1, norm_y1 = None, None, None, None

    if coord_system in ("mineru_grid_1000", "grid_1000"):
        # MinerU content_list virtual 1000 x 1000 integer grid
        if x0 < 0 or y0 < 0 or x1 > 1000.5 or y1 > 1000.5:
            base_result["reason"] = f"Coordinates out of bounds for grid_1000: [{x0}, {y0}, {x1}, {y1}]"
            return base_result
        norm_x0 = max(0.0, min(1.0, x0 / 1000.0))
        norm_y0 = max(0.0, min(1.0, y0 / 1000.0))
        norm_x1 = max(0.0, min(1.0, x1 / 1000.0))
        norm_y1 = max(0.0, min(1.0, y1 / 1000.0))

    elif coord_system in ("mineru_model_norm", "normalized", "norm"):
        # Normalized [0..1] coordinates
        if x0 < 0 or y0 < 0 or x1 > 1.05 or y1 > 1.05:
            base_result["reason"] = f"Normalized coordinates out of bounds [0..1]: [{x0}, {y0}, {x1}, {y1}]"
            return base_result
        norm_x0 = max(0.0, min(1.0, x0))
        norm_y0 = max(0.0, min(1.0, y0))
        norm_x1 = max(0.0, min(1.0, x1))
        norm_y1 = max(0.0, min(1.0, y1))

    elif coord_system in ("mineru_layout_pt", "layout_pt", "pt"):
        # Requires raw_page_dim in PDF points
        if not raw_page_dim or raw_page_dim[0] <= 0 or raw_page_dim[1] <= 0:
            base_result["reason"] = "Missing or invalid raw_page_dim for layout_pt coordinates"
            return base_result
        pw, ph = raw_page_dim
        if x0 < 0 or y0 < 0 or x1 > pw * 1.05 or y1 > ph * 1.05:
            base_result["reason"] = f"Layout coordinates exceed page dimension [{pw}, {ph}]: [{x0}, {y0}, {x1}, {y1}]"
            return base_result
        norm_x0 = max(0.0, min(1.0, x0 / pw))
        norm_y0 = max(0.0, min(1.0, y0 / ph))
        norm_x1 = max(0.0, min(1.0, x1 / pw))
        norm_y1 = max(0.0, min(1.0, y1 / ph))

    elif coord_system in ("datalab_pixel", "pixel"):
        # Datalab rendered pixel dimensions - STRICT: NEVER default to 1344x1932
        if not raw_page_dim or raw_page_dim[0] <= 0 or raw_page_dim[1] <= 0:
            base_result["reason"] = "Missing raw_page_dim for pixel coordinates (no default fallback permitted)"
            return base_result
        pw_px, ph_px = raw_page_dim
        if x0 < 0 or y0 < 0 or x1 > pw_px * 1.05 or y1 > ph_px * 1.05:
            base_result["reason"] = f"Pixel coordinates exceed pixel dimensions [{pw_px}, {ph_px}]: [{x0}, {y0}, {x1}, {y1}]"
            return base_result
        norm_x0 = max(0.0, min(1.0, x0 / pw_px))
        norm_y0 = max(0.0, min(1.0, y0 / ph_px))
        norm_x1 = max(0.0, min(1.0, x1 / pw_px))
        norm_y1 = max(0.0, min(1.0, y1 / ph_px))

    else:
        # Unknown coordinate system: DO NOT guess based on values < 1
        base_result["reason"] = f"Unsupported coordinate system: '{coord_system}'. Guessing is disabled."
        return base_result

    norm_bbox = [round(norm_x0, 5), round(norm_y0, 5), round(norm_x1, 5), round(norm_y1, 5)]

    # Compute PDF point bbox if target page dimensions in pt are available
    pt_bbox = None
    if pt_page_dim and pt_page_dim[0] > 0 and pt_page_dim[1] > 0:
        pw, ph = pt_page_dim
        pt_bbox = [
            round(norm_x0 * pw, 2),
            round(norm_y0 * ph, 2),
            round(norm_x1 * pw, 2),
            round(norm_y1 * ph, 2),
        ]

    base_result["normalized_bbox"] = norm_bbox
    base_result["pt_bbox"] = pt_bbox
    base_result["is_valid"] = True
    base_result["reason"] = None
    return base_result


def get_pdf_page_dimensions(pdf_path: str | Path) -> Dict[int, Tuple[float, float]]:
    """
    Returns map of 1-based page number -> (width_pt, height_pt).
    """
    p = Path(pdf_path)
    if not p.is_file():
        return {}

    try:
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz
        doc = fitz.open(str(p))
        dims = {}
        for idx in range(len(doc)):
            page = doc[idx]
            rect = page.rect
            dims[idx + 1] = (float(rect.width), float(rect.height))
        doc.close()
        return dims
    except Exception:
        pass

    try:
        import pypdf
        reader = pypdf.PdfReader(str(p))
        dims = {}
        for idx, page in enumerate(reader.pages):
            mb = page.mediabox
            dims[idx + 1] = (float(mb.width), float(mb.height))
        return dims
    except Exception:
        return {}
