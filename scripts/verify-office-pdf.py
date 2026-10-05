"""Render every original/edited WPS page. QA-only dependencies never enter the product."""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pdfplumber
import pypdfium2
from PIL import Image, ImageChops, ImageDraw
from pypdf import PdfReader


def compact(value):
    return re.sub(r"\s+", "", value)


def block_text(block):
    if block["kind"] == "paragraph":
        return block["text"]
    if block["kind"] == "list":
        return "".join(block["items"])
    if block["kind"] == "table":
        return "".join(block["columns"]) + "".join("".join(row) for row in block["rows"])
    return block["caption"]


def verify(root):
    source = json.loads((root / "source.json").read_text(encoding="utf-8"))["content"]
    expected_word = source["title"] + "".join(block_text(block) for key in ("objectives", "keyPoints", "difficulties") for block in source[key])
    for section in source["sections"]:
        expected_word += section["title"] + "".join(block_text(block) for key in ("content", "questions") for block in section[key])
    expected_deck = "".join(slide["title"] + "".join(block_text(block) for block in slide["content"]) for slide in source["slides"])
    report = {"files": [], "changedPages": {}, "failures": []}
    rendered = {}
    for name in ("word-original", "word-edited", "presentation-original", "presentation-edited"):
        path = root / (name + ".pdf")
        out = root / name
        out.mkdir(exist_ok=True)
        texts = []
        with pdfplumber.open(path) as pdf:
            for index, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                texts.append(text)
                for char in page.chars:
                    if char["x0"] < -0.5 or char["x1"] > page.width + 0.5 or char["top"] < -0.5 or char["bottom"] > page.height + 0.5:
                        report["failures"].append({"file": name, "page": index + 1, "kind": "text-outside-page", "char": char["text"]})
                if name.startswith("presentation") and abs(page.width / page.height - 16 / 9) > 0.01:
                    report["failures"].append({"file": name, "page": index + 1, "kind": "aspect-ratio"})
            fonts = sorted({char["fontname"] for page in pdf.pages for char in page.chars})
        joined = compact("".join(texts))
        if "TEACHER_" in joined:
            report["failures"].append({"file": name, "kind": "private-content-visible"})
        if name.endswith("original"):
            expected = Counter(compact(expected_word if name.startswith("word") else expected_deck))
            actual = Counter(joined)
            missing = {char: count - actual[char] for char, count in expected.items() if actual[char] < count}
            if missing:
                report["failures"].append({"file": name, "kind": "missing-visible-characters", "missing": missing})
        else:
            # Spatial extraction interleaves columns when an edited table cell wraps. Stream
            # extraction preserves each cell's runs, so require the edit in either extraction.
            stream_text = compact("".join(page.extract_text() or "" for page in PdfReader(path).pages))
            for marker in ("WPS_NATIVE_TABLE_EDIT", "WPS_NATIVE_EDIT" if name.startswith("word") else "WPS_NATIVE_SLIDE_EDIT"):
                if marker not in joined and marker not in stream_text:
                    report["failures"].append({"file": name, "kind": "missing-edit", "marker": marker})
        (out / "text.txt").write_text("\n\n".join(texts), encoding="utf-8")
        document = pypdfium2.PdfDocument(str(path))
        images = []
        for index in range(len(document)):
            page = document[index]
            bitmap = page.render(scale=1.5)
            image = bitmap.to_pil().convert("RGB")
            image.save(out / f"page-{index + 1:03d}.png")
            images.append(image.copy())
            bitmap.close()
            page.close()
        document.close()
        rendered[name] = images
        report["files"].append({"file": name, "pages": len(images), "renderedPages": len(images), "fonts": fonts})
        for start in range(0, len(images), 4):
            chosen = images[start:start + 4]
            tile_width = 950
            tile_height = max(round(image.height * tile_width / image.width) for image in chosen)
            sheet = Image.new("RGB", (tile_width * 2, (tile_height + 28) * 2), "#e4e7eb")
            draw = ImageDraw.Draw(sheet)
            for offset, image in enumerate(chosen):
                scaled = image.resize((tile_width, round(image.height * tile_width / image.width)))
                x = offset % 2 * tile_width
                y = offset // 2 * (tile_height + 28)
                draw.text((x + 8, y + 6), f"{name} / page {start + offset + 1}", fill="black")
                sheet.paste(scaled, (x, y + 28))
            sheet.save(out / f"contact-{start // 4 + 1:02d}.png")
    for kind in ("word", "presentation"):
        original = rendered[kind + "-original"]
        edited = rendered[kind + "-edited"]
        changed = []
        for index in range(max(len(original), len(edited))):
            if index >= len(original) or index >= len(edited) or original[index].size != edited[index].size or ImageChops.difference(original[index], edited[index]).getbbox():
                changed.append(index + 1)
        report["changedPages"][kind] = changed
    (root / "pdf-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if report["failures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    verify(Path(sys.argv[1]))
