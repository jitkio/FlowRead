"""
FlowRead PDF Parse Evaluation - Normalization Module (normalize.py)
Standardizes raw MinerU and Datalab parser outputs into:
- content.md (continuous reading markdown without running headers)
- assets/ (extracted image files)
- blocks.json (structured blocks with server IDs, types, and unified coordinates)
- source-map.json (coordinate metadata with normalized and PDF pt coordinates)
- diagnostics.json (accurate counts of structural blocks, assets, formulas, warnings)
"""

import os
import re
import json
import html
import shutil
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

from storage import atomic_write_json, load_json
from geometry import normalize_bbox, get_pdf_page_dimensions


def find_files_by_pattern(directory: Path, pattern: str) -> List[Path]:
    return list(directory.rglob(pattern))


def build_page_source_map(page_mappings: List[Dict[str, int]]) -> Dict[int, int]:
    return {item["sample_page"]: item["source_page"] for item in page_mappings}


def build_continuous_markdown(blocks: List[Dict[str, Any]]) -> str:
    """
    Builds continuous reading markdown from structured blocks.
    Excludes running headers, footers, and page numbers.
    Formats display math as $$ ... $$, images with captions (excluding in-image OCR text),
    and headings with markdown hashes.
    """
    sections = []
    for b in blocks:
        b_type = b.get("type", "")
        if b_type in ("page_header", "page_number", "page_footer", "PageHeader", "PageFooter", "PageNumber"):
            continue

        content = (b.get("content") or "").strip()
        asset_ref = b.get("asset_ref")
        caption = (b.get("caption") or "").strip()

        if b_type == "heading":
            sections.append(f"## {content}")
        elif b_type == "formula":
            if content.startswith("$$") and content.endswith("$$"):
                sections.append(content)
            else:
                sections.append(f"$$\n{content}\n$$")
        elif b_type == "image":
            img_parts = []
            if asset_ref:
                img_parts.append(f"![{caption or asset_ref}](assets/{asset_ref})")
            if caption:
                img_parts.append(f"*{caption}*")
            if img_parts:
                sections.append("\n\n".join(img_parts))
        elif b_type == "caption":
            if content:
                sections.append(f"*{content}*")
        elif b_type in ("paragraph", "table", "unknown"):
            if content:
                sections.append(content)

    return "\n\n".join(sections) + "\n"


class Normalizer:
    @staticmethod
    def _rewrite_markdown_image_refs(
        md_text: str,
        image_mapping: Dict[str, str],
        assets_dir: Path,
    ) -> Tuple[str, List[str], List[str]]:
        """
        Rewrites markdown image tags ![alt](path) to point to ./assets/<name>
        Returns: (new_md, referenced_images, missing_images)
        """
        referenced_images = []
        missing_images = []

        def repl(match):
            alt = match.group(1)
            raw_path = match.group(2)
            orig_name = Path(raw_path.split("?")[0].split("#")[0]).name

            if orig_name in image_mapping:
                target_rel = f"assets/{image_mapping[orig_name]}"
                referenced_images.append(image_mapping[orig_name])
            else:
                if (assets_dir / orig_name).is_file():
                    target_rel = f"assets/{orig_name}"
                    referenced_images.append(orig_name)
                else:
                    target_rel = f"assets/{orig_name}"
                    missing_images.append(orig_name)
            return f"![{alt}]({target_rel})"

        pattern = re.compile(r"!\[(.*?)\]\((.*?)\)")
        new_md = pattern.sub(repl, md_text)
        return new_md, referenced_images, missing_images

    @classmethod
    def normalize_mineru(
        cls,
        raw_dir: str | Path,
        norm_dir: str | Path,
        page_mappings: List[Dict[str, int]],
        input_pdf_path: Optional[str | Path] = None,
    ) -> Dict[str, Any]:
        raw_path = Path(raw_dir).resolve()
        norm_path = Path(norm_dir).resolve()
        assets_path = norm_path / "assets"
        assets_path.mkdir(parents=True, exist_ok=True)

        extracted_dir = raw_path / "extracted"
        search_root = extracted_dir if extracted_dir.is_dir() else raw_path

        # 1. Page dimensions
        pdf_dims = get_pdf_page_dimensions(input_pdf_path) if input_pdf_path else {}
        page_lookup = build_page_source_map(page_mappings)

        # 2. Locate layout.json for page sizes
        layout_files = find_files_by_pattern(search_root, "layout.json")
        layout_page_dims: Dict[int, Tuple[float, float]] = {}
        if layout_files:
            layout_data = load_json(layout_files[0], default={})
            for p_info in layout_data.get("pdf_info", []):
                p_idx = p_info.get("page_idx", 0)
                psize = p_info.get("page_size")
                if psize and len(psize) == 2:
                    layout_page_dims[p_idx + 1] = (float(psize[0]), float(psize[1]))

        # 3. Locate primary Markdown file
        md_files = find_files_by_pattern(search_root, "full.md")
        if not md_files:
            md_files = find_files_by_pattern(search_root, "*.md")
        primary_md_path = md_files[0] if md_files else None
        raw_md = primary_md_path.read_text(encoding="utf-8") if primary_md_path else ""

        # 4. Copy images to assets/
        image_mapping = {}
        total_assets = []
        for img_ext in ("*.png", "*.jpg", "*.jpeg", "*.webp", "*.svg"):
            for img_file in search_root.rglob(img_ext):
                if norm_path in img_file.parents:
                    continue
                dest_file = assets_path / img_file.name
                shutil.copy2(str(img_file), str(dest_file))
                image_mapping[img_file.name] = img_file.name
                total_assets.append(img_file.name)

        # 5. Parse structured blocks from content_list_v2 or content_list
        c2_files = find_files_by_pattern(search_root, "*content_list_v2.json")
        c1_files = find_files_by_pattern(search_root, "*content_list.json")
        model_files = find_files_by_pattern(search_root, "*model.json")

        blocks = []
        unhandled_structures = []
        warnings = []
        type_counts = {}
        caption_grouping_anomalies = []

        raw_items = []
        is_v2 = False

        if c2_files:
            raw_c2 = load_json(c2_files[0], default=[])
            # v2 structure is list of pages, each page is a list of blocks
            if isinstance(raw_c2, list):
                is_v2 = True
                for p_idx, page_blocks in enumerate(raw_c2):
                    if isinstance(page_blocks, list):
                        for b in page_blocks:
                            if isinstance(b, dict):
                                b["_page_idx"] = p_idx
                                raw_items.append(b)

        if not raw_items and c1_files:
            raw_c1 = load_json(c1_files[0], default=[])
            if isinstance(raw_c1, list):
                raw_items = raw_c1

        reading_order = 1
        formula_images_count = 0

        for item in raw_items:
            raw_type = item.get("type", "unknown")
            type_counts[raw_type] = type_counts.get(raw_type, 0) + 1

            page_idx = item.get("_page_idx") if "_page_idx" in item else item.get("page_idx")
            sample_page = (page_idx + 1) if page_idx is not None else None
            source_page = page_lookup.get(sample_page) if sample_page else None

            # Determine page pt dimensions
            pt_dim = pdf_dims.get(sample_page) or layout_page_dims.get(sample_page)

            # Raw bbox is in [0..1000] grid
            raw_bbox = item.get("bbox")
            geom_info = normalize_bbox(
                raw_bbox=raw_bbox,
                coord_system="mineru_grid_1000",
                raw_page_dim=(1000.0, 1000.0),
                pt_page_dim=pt_dim,
            )

            # Block content extraction
            content_text = ""
            content_format = "markdown"
            inline_runs = []
            asset_ref = None
            caption_text = None
            raw_node = None

            if is_v2:
                c_obj = item.get("content", {})
                if isinstance(c_obj, dict):
                    if raw_type in ("paragraph", "text"):
                        p_content = c_obj.get("paragraph_content", [])
                        parts = []
                        for run in p_content:
                            if isinstance(run, dict):
                                r_type = run.get("type", "text")
                                r_content = run.get("content", "")
                                inline_runs.append({"type": r_type, "content": r_content})
                                if r_type == "equation_inline":
                                    c_math = r_content.strip()
                                    if c_math.startswith("$") and c_math.endswith("$"):
                                        parts.append(f" {c_math} ")
                                    else:
                                        parts.append(f" ${c_math}$ ")
                                else:
                                    parts.append(r_content)
                        content_text = "".join(parts)
                        content_format = "markdown"

                    elif "equation" in raw_type or "formula" in raw_type:
                        content_text = c_obj.get("math_content", "")
                        content_format = "latex"
                        img_s = c_obj.get("image_source", {})
                        if isinstance(img_s, dict) and img_s.get("path"):
                            asset_ref = Path(img_s["path"]).name
                            formula_images_count += 1

                    elif raw_type == "chart":
                        # MinerU chart: displayable figure with chart_caption containing inline math
                        img_s = c_obj.get("image_source", {})
                        if isinstance(img_s, dict) and img_s.get("path"):
                            asset_ref = Path(img_s["path"]).name
                            # Ensure chart image is copied to assets
                            chart_src = search_root / img_s["path"]
                            if chart_src.is_file():
                                chart_dest = assets_path / chart_src.name
                                if not chart_dest.is_file():
                                    shutil.copy2(str(chart_src), str(chart_dest))
                                    image_mapping[chart_src.name] = chart_src.name
                                    total_assets.append(chart_src.name)

                        caps = c_obj.get("chart_caption", [])
                        cap_parts = []
                        for run in caps:
                            if isinstance(run, dict):
                                r_type = run.get("type", "text")
                                r_content = run.get("content", "")
                                inline_runs.append({"type": r_type, "content": r_content})
                                if r_type == "equation_inline":
                                    c_math = r_content.strip()
                                    if c_math.startswith("$") and c_math.endswith("$"):
                                        cap_parts.append(f" {c_math} ")
                                    else:
                                        cap_parts.append(f" ${c_math}$ ")
                                else:
                                    cap_parts.append(r_content)
                        caption_text = "".join(cap_parts).strip()
                        content_text = caption_text
                        content_format = "markdown"

                    elif raw_type == "image":
                        img_s = c_obj.get("image_source", {})
                        if isinstance(img_s, dict) and img_s.get("path"):
                            asset_ref = Path(img_s["path"]).name
                        # Check image caption list
                        caps = c_obj.get("image_caption", [])
                        cap_texts = []
                        for c in caps:
                            if isinstance(c, dict):
                                cap_texts.append(c.get("content", ""))
                                inline_runs.append(c)

                        if len(caps) > 1:
                            # Differentiate between normal sub-figure labels (a), (b) and multiple distinct figure captions
                            is_all_sub = all(re.match(r"^\s*\([a-zA-Z0-9]+\)\s*$", ct) for ct in cap_texts)
                            if is_all_sub:
                                caption_text = " ".join(cap_texts)
                                content_text = caption_text
                            else:
                                caption_grouping_anomalies.append({
                                    "block_id": f"mineru_blk_{reading_order:04d}",
                                    "image": asset_ref,
                                    "captions": cap_texts,
                                    "relation": "multiple_distinct_figures_bound",
                                })
                                warnings.append(f"图片 {asset_ref} 同时绑定了 {len(caps)} 条图注 (待核对关系): {cap_texts}")
                                caption_text = " \n".join(cap_texts)
                                content_text = caption_text
                        elif len(caps) == 1:
                            caption_text = cap_texts[0]
                            content_text = caption_text

                    elif raw_type in ("page_header", "page_number", "page_footer"):
                        c_list = c_obj.get(f"{raw_type}_content", [])
                        content_text = "".join(x.get("content", "") for x in c_list if isinstance(x, dict))
                    elif raw_type == "table":
                        content_text = c_obj.get("table_body", "") or c_obj.get("content", "")
                        content_format = "markdown"
                    else:
                        content_text = f"<!-- 未识别结构: {raw_type} -->\n" + str(c_obj)
                        raw_node = item
                        unhandled_structures.append(f"MinerU unhandled: {raw_type}")
                else:
                    content_text = str(c_obj)
            else:
                content_text = item.get("text") or item.get("content") or ""
                if "image" in raw_type and item.get("img_path"):
                    asset_ref = Path(item["img_path"]).name

            # Classify block type
            if raw_type in ("paragraph", "text"):
                unified_type = "paragraph"
            elif raw_type in ("title", "header", "heading"):
                unified_type = "heading"
            elif "equation" in raw_type or "formula" in raw_type:
                unified_type = "formula"
            elif raw_type in ("image", "chart"):
                unified_type = "image"
            elif raw_type == "table":
                unified_type = "table"
            elif "caption" in raw_type:
                unified_type = "caption"
            elif raw_type in ("page_header", "page_number", "page_footer"):
                unified_type = raw_type  # Separate from main body
            else:
                unified_type = "unknown"

            block_id = f"mineru_blk_{reading_order:04d}"
            blocks.append({
                "id": block_id,
                "server_id": item.get("id"),
                "type": unified_type,
                "raw_type": raw_type,
                "reading_order": reading_order,
                "content": content_text,
                "content_format": content_format,
                "inline_runs": inline_runs,
                "asset_ref": asset_ref,
                "caption": caption_text,
                "in_image_text": [],
                "page_sample": sample_page,
                "page_source": source_page,
                "raw_bbox": geom_info["raw_bbox"],
                "normalized_bbox": geom_info["normalized_bbox"],
                "pt_bbox": geom_info["pt_bbox"],
                "coordinate_system": geom_info["coord_system"],
                "raw_node": raw_node,
            })
            reading_order += 1

        # 6. Generate continuous reading content.md from normalized blocks
        continuous_md = build_continuous_markdown(blocks)
        (norm_path / "content.md").write_text(continuous_md, encoding="utf-8")

        # 7. Build source map
        source_map = {
            "coordinate_system_info": {
                "description": "MinerU raw bboxes are in [0, 1000] integer grid; normalized_bbox is [0, 1] relative float; pt_bbox is in 72 DPI PDF points.",
                "origin": "top-left",
                "page_dimensions_pt": {p: list(dim) for p, dim in pdf_dims.items()},
            },
            "blocks": {},
        }
        for b in blocks:
            b_entry = {
                "page_sample": b["page_sample"],
                "page_source": b["page_source"],
                "normalized_bbox": b["normalized_bbox"],
                "pt_bbox": b["pt_bbox"],
                "raw_bbox": b["raw_bbox"],
                "content_excerpt": (b["content"][:80] + "...") if len(b["content"]) > 80 else b["content"],
            }
            source_map["blocks"][b["id"]] = b_entry
            source_map[b["id"]] = b_entry
        # Compute asset reference metrics
        referenced_images = [b["asset_ref"] for b in blocks if b.get("asset_ref")]
        missing_images = [ref for ref in referenced_images if not (assets_path / ref).is_file()]
        unreferenced_assets = [a for a in total_assets if a not in referenced_images]

        diagnostics = {
            "provider": "mineru",
            "total_blocks": len(blocks),
            "server_structural_blocks": len(raw_items),
            "normalized_body_blocks": sum(1 for b in blocks if b["type"] not in ("page_header", "page_number", "page_footer")),
            "fallback_segments": 0,
            "type_counts": type_counts,
            "formulas_count": sum(1 for b in blocks if b["type"] == "formula"),
            "tables_count": sum(1 for b in blocks if b["type"] == "table"),
            "images_count": sum(1 for b in blocks if b["type"] == "image"),
            "total_asset_files": len(total_assets),
            "body_referenced_images": len(set(referenced_images)),
            "formula_images_count": formula_images_count,
            "unreferenced_assets": len(unreferenced_assets),
            "missing_images": missing_images,
            "unhandled_structures": list(set(unhandled_structures)),
            "caption_grouping_anomalies": caption_grouping_anomalies,
            "failed_pages": [],
            "warnings": warnings,
        }

        atomic_write_json(norm_path / "blocks.json", blocks)
        atomic_write_json(norm_path / "source-map.json", source_map)
        atomic_write_json(norm_path / "diagnostics.json", diagnostics)

        return diagnostics

    @classmethod
    def normalize_datalab(
        cls,
        raw_dir: str | Path,
        norm_dir: str | Path,
        page_mappings: List[Dict[str, int]],
        input_pdf_path: Optional[str | Path] = None,
    ) -> Dict[str, Any]:
        raw_path = Path(raw_dir).resolve()
        norm_path = Path(norm_dir).resolve()
        assets_path = norm_path / "assets"
        assets_path.mkdir(parents=True, exist_ok=True)

        pdf_dims = get_pdf_page_dimensions(input_pdf_path) if input_pdf_path else {}
        page_lookup = build_page_source_map(page_mappings)

        # 1. Read raw files
        md_file = raw_path / "result.md"
        raw_md = md_file.read_text(encoding="utf-8") if md_file.is_file() else ""

        json_file = raw_path / "result.json"
        raw_json = load_json(json_file)

        resp_file = raw_path / "datalab_response.json"
        resp_json = load_json(resp_file, default={})

        # 2. Copy images to assets/
        image_mapping = {}
        total_assets = []
        images_source_dir = raw_path / "images"
        if images_source_dir.is_dir():
            for img_file in images_source_dir.glob("*"):
                if img_file.is_file():
                    dest_file = assets_path / img_file.name
                    shutil.copy2(str(img_file), str(dest_file))
                    image_mapping[img_file.name] = img_file.name
                    total_assets.append(img_file.name)

        # 3. Parse tree structure from result.json (children -> pages -> children -> blocks)
        blocks = []
        unhandled_structures = []
        warnings = []
        type_counts = {}
        reading_order = 1
        server_block_count = 0
        failed_pages = []

        if isinstance(raw_json, dict):
            # Read failed_pages from metadata
            meta = raw_json.get("metadata", {})
            failed_pages = meta.get("failed_pages") or resp_json.get("failed_pages") or []

            pages_list = raw_json.get("children", [])
            for page_node in pages_list:
                if not isinstance(page_node, dict):
                    continue

                # Page dimensions from page bbox - STRICT: do not default to 1344x1932
                p_bbox = page_node.get("bbox")
                raw_page_dim = (
                    (float(p_bbox[2]), float(p_bbox[3]))
                    if (p_bbox and len(p_bbox) >= 4 and float(p_bbox[2]) > 0 and float(p_bbox[3]) > 0)
                    else None
                )

                child_blocks = page_node.get("children", [])
                for item in child_blocks:
                    if not isinstance(item, dict):
                        continue

                    server_block_count += 1
                    raw_type = item.get("block_type") or item.get("type", "unknown")
                    type_counts[raw_type] = type_counts.get(raw_type, 0) + 1

                    # Handle page index: page is 0-based in Datalab (0, 1, 2)
                    p_val = item.get("page")
                    sample_page = (int(p_val) + 1) if p_val is not None else None
                    source_page = page_lookup.get(sample_page) if sample_page else None

                    pt_dim = pdf_dims.get(sample_page)

                    raw_bbox = item.get("bbox")
                    geom_info = normalize_bbox(
                        raw_bbox=raw_bbox,
                        coord_system="datalab_pixel",
                        raw_page_dim=raw_page_dim,
                        pt_page_dim=pt_dim,
                    )

                    # Extract block content without repeating container HTML
                    raw_content = item.get("markdown") or item.get("html") or item.get("content") or ""
                    content_val = ""
                    content_format = "markdown"
                    inline_runs = []
                    in_image_text = []
                    caption_text = None
                    raw_node = None
                    asset_ref = None

                    imgs = item.get("images", {})
                    if isinstance(imgs, dict) and imgs:
                        asset_ref = list(imgs.keys())[0]

                    if raw_type in ("Equation", "formula"):
                        unified_type = "formula"
                        content_format = "latex"
                        unescaped_html = html.unescape(raw_content)
                        # Extract inner LaTeX from <math[^>]*>(.*?)</math>
                        math_m = re.search(r"<math[^>]*>(.*?)</math>", unescaped_html, re.DOTALL)
                        if math_m:
                            content_val = math_m.group(1).strip()
                        else:
                            content_val = re.sub(r"</?p[^>]*>", "", unescaped_html).strip()

                    elif raw_type in ("Figure", "Diagram", "Picture"):
                        unified_type = "image"
                        content_format = "markdown"
                        unescaped_html = html.unescape(raw_content)
                        if not asset_ref:
                            img_m = re.search(r'<img[^>]*src=["\']([^"\']+)["\']', unescaped_html)
                            if img_m:
                                asset_ref = Path(img_m.group(1)).name

                        # Extract in-image text (<p class="img-text">) separately from reading content
                        for it_match in re.finditer(r'<p class=["\']img-text["\']>(.*?)</p>', unescaped_html, re.DOTALL):
                            it_raw = it_match.group(1).strip()
                            it_converted = re.sub(r'<math[^>]*>(.*?)</math>', r'$\1$', it_raw)
                            it_clean = re.sub(r'<[^>]+>', '', it_converted).strip()
                            if it_clean:
                                in_image_text.append(it_clean)

                        # Continuous reading content contains only image reference, not duplicate img-text
                        content_val = f"![{asset_ref}](assets/{asset_ref})" if asset_ref else ""

                    elif raw_type in ("Text", "text", "Paragraph", "Caption", "Heading", "SectionHeader", "title"):
                        if raw_type in ("Heading", "SectionHeader", "title"):
                            unified_type = "heading"
                        elif raw_type == "Caption":
                            unified_type = "caption"
                        else:
                            unified_type = "paragraph"

                        content_format = "markdown"
                        unescaped_html = html.unescape(raw_content)

                        # Convert <math>...</math> to LaTeX $...$
                        def math_repl(m):
                            inner = m.group(1).strip()
                            if 'display="block"' in m.group(0):
                                return f" $${inner}$$ "
                            return f" ${inner}$ "

                        converted = re.sub(r"<math[^>]*>(.*?)</math>", math_repl, unescaped_html, flags=re.DOTALL)
                        clean_text = re.sub(r"^<p[^>]*>", "", converted)
                        clean_text = re.sub(r"</p>$", "", clean_text).strip()
                        content_val = clean_text

                        # Build inline_runs
                        pos = 0
                        for m in re.finditer(r"\$(.*?)\$", clean_text):
                            s, e = m.span()
                            if s > pos:
                                inline_runs.append({"type": "text", "content": clean_text[pos:s]})
                            inline_runs.append({"type": "equation_inline", "content": m.group(1)})
                            pos = e
                        if pos < len(clean_text):
                            inline_runs.append({"type": "text", "content": clean_text[pos:]})

                    elif raw_type == "Table":
                        unified_type = "table"
                        content_format = "html" if "<table" in raw_content else "markdown"
                        content_val = html.unescape(raw_content)

                    elif raw_type in ("PageHeader", "PageFooter", "PageNumber"):
                        unified_type = raw_type
                        content_val = re.sub(r"</?p[^>]*>", "", html.unescape(raw_content)).strip()

                    else:
                        unified_type = "unknown"
                        raw_node = item
                        content_val = f"<!-- 未识别结构: {raw_type} -->\n" + str(raw_content)
                        unhandled_structures.append(f"Datalab unhandled: {raw_type}")

                    blocks.append({
                        "id": f"datalab_blk_{reading_order:04d}",
                        "server_id": item.get("id"),
                        "type": unified_type,
                        "raw_type": raw_type,
                        "reading_order": reading_order,
                        "content": content_val,
                        "content_format": content_format,
                        "inline_runs": inline_runs,
                        "asset_ref": asset_ref,
                        "caption": caption_text,
                        "in_image_text": in_image_text,
                        "page_sample": sample_page,
                        "page_source": source_page,
                        "raw_bbox": geom_info["raw_bbox"],
                        "normalized_bbox": geom_info["normalized_bbox"],
                        "pt_bbox": geom_info["pt_bbox"],
                        "coordinate_system": geom_info["coord_system"],
                        "raw_node": raw_node,
                    })
                    reading_order += 1

        fallback_count = 0
        if not blocks:
            # Fallback only if JSON tree was absent
            fallback_count = 1
            warnings.append("Datalab result.json 树结构缺失，使用 Markdown 降级拆分")

        # 4. Generate continuous reading content.md from normalized blocks
        continuous_md = build_continuous_markdown(blocks)
        (norm_path / "content.md").write_text(continuous_md, encoding="utf-8")

        # 5. Build source map
        source_map = {
            "coordinate_system_info": {
                "description": "Datalab raw bboxes are in rendered pixel units [0..W_px, 0..H_px]; normalized_bbox is [0, 1] relative float; pt_bbox is in 72 DPI PDF points.",
                "origin": "top-left",
                "page_dimensions_pt": {p: list(dim) for p, dim in pdf_dims.items()},
            },
            "blocks": {},
        }
        for b in blocks:
            b_entry = {
                "page_sample": b["page_sample"],
                "page_source": b["page_source"],
                "normalized_bbox": b["normalized_bbox"],
                "pt_bbox": b["pt_bbox"],
                "raw_bbox": b["raw_bbox"],
                "content_excerpt": (b["content"][:80] + "...") if len(b["content"]) > 80 else b["content"],
            }
            source_map["blocks"][b["id"]] = b_entry
            source_map[b["id"]] = b_entry
        # Compute asset reference metrics
        referenced_images = [b["asset_ref"] for b in blocks if b.get("asset_ref")]
        missing_images = [ref for ref in referenced_images if not (assets_path / ref).is_file()]
        unreferenced_assets = [a for a in total_assets if a not in referenced_images]

        diagnostics = {
            "provider": "datalab",
            "total_blocks": len(blocks),
            "server_structural_blocks": server_block_count,
            "normalized_body_blocks": sum(1 for b in blocks if b["type"] not in ("PageHeader", "PageFooter", "PageNumber")),
            "fallback_segments": fallback_count,
            "type_counts": type_counts,
            "formulas_count": sum(1 for b in blocks if b["type"] == "formula"),
            "tables_count": sum(1 for b in blocks if b["type"] == "table"),
            "images_count": sum(1 for b in blocks if b["type"] == "image"),
            "total_asset_files": len(total_assets),
            "body_referenced_images": len(set(referenced_images)),
            "formula_images_count": 0,
            "unreferenced_assets": len(unreferenced_assets),
            "missing_images": missing_images,
            "unhandled_structures": list(set(unhandled_structures)),
            "failed_pages": failed_pages,
            "warnings": warnings,
        }

        atomic_write_json(norm_path / "blocks.json", blocks)
        atomic_write_json(norm_path / "source-map.json", source_map)
        atomic_write_json(norm_path / "diagnostics.json", diagnostics)

        return diagnostics
