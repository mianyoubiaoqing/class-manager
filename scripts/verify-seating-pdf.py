"""Verify and render the synthetic PDFs produced by seating-print-smoke.mjs.

Audit-only tooling: requires pypdf, pdfplumber and pypdfium2; not a client dependency.
"""
import json
import re
import sys
from pathlib import Path

import pdfplumber
import pypdfium2
from pypdf import PdfReader


def verify(directory: Path) -> None:
    report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
    maximum_path = directory / "maximum.pdf"
    history_path = directory / "history.pdf"
    maximum = PdfReader(maximum_path)
    history = PdfReader(history_path)
    assert len(maximum.pages) == report["maximumPageCount"]
    assert len(history.pages) == 1
    texts = [page.extract_text() for page in maximum.pages]
    compact = re.sub(r"\s+", "", "".join(texts))
    numbers = re.findall(r"MAX[0-9]{29}", compact)
    assert len(numbers) == 400 and len(set(numbers)) == 400
    assert set(numbers) == {f"MAX{index:029d}" for index in range(400)}
    assert compact.count("长") == 400 * 60
    assert compact.count("班") == len(maximum.pages) * 80
    for text in texts:
        assert report["maximumVersion"] in text
    historic = history.pages[0].extract_text()
    assert "打印历史" in historic and "历史后已改班名" not in historic
    assert report["confirmedHistoricalVersion"] in historic
    for path in [maximum_path, history_path]:
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                assert abs(page.width - 841.89) < 1 and abs(page.height - 595.28) < 1
                assert all(
                    char["x0"] >= 0 and char["x1"] <= page.width
                    and char["top"] >= 0 and char["bottom"] <= page.height
                    for char in page.chars
                )
        rendered = pypdfium2.PdfDocument(str(path))
        try:
            for index in sorted({0, len(rendered) - 1}):
                page = rendered[index]
                bitmap = page.render(scale=1.5)
                try:
                    bitmap.to_pil().save(directory / f"{path.stem}-pdf-page-{index + 1}.png")
                finally:
                    bitmap.close()
                    page.close()
        finally:
            rendered.close()
    evidence = {
        "status": "passed",
        "sourceReportAt": report["at"],
        "maximumPages": len(maximum.pages),
        "historicalPages": len(history.pages),
        "uniqueStudentNumbers": len(set(numbers)),
        "longNameCharacters": compact.count("长"),
        "a4Landscape": True,
        "allGlyphsWithinPage": True,
        "physicalPrinterVerified": False,
    }
    (directory / "pdf-verification.json").write_text(
        json.dumps(evidence, ensure_ascii=True, indent=2), encoding="utf-8"
    )
    print(json.dumps(evidence, ensure_ascii=True))


if __name__ == "__main__":
    verify(Path(sys.argv[1] if len(sys.argv) > 1 else "output/playwright/seating-print-development"))
