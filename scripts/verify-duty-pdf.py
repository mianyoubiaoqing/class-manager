"""Audit actual synthetic duty PDFs; these parser/render dependencies are not shipped."""
import json
import re
import sys
from collections import Counter
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
    assert len(history.pages) == report["historicalPageCount"]
    texts = [page.extract_text() for page in maximum.pages]
    compact = re.sub(r"\s+", "", "".join(texts))
    numbers = Counter(re.findall(r"MAX[0-9]{29}", compact))
    # Every member occurs once in the current groups; groups 0/1 also appear in a
    # selected date's membership snapshot and its fully staffed assignment list.
    expected = {f"MAX{index:029d}": 3 if index % 10 in (0, 1) else 1 for index in range(400)}
    assert numbers == expected
    assert sum(numbers.values()) == report["rowCount"] == 560
    assert compact.count("长") == 560 * 60
    for text in texts:
        assert report["maximumVersion"] in text
        for heading in ["项目", "岗位", "时段", "编号", "姓名", "备注"]:
            assert heading in re.sub(r"\s+", "", text)
    historic = "".join(page.extract_text() for page in history.pages)
    assert "值日打印历史" in historic and "值日历史后已改班名" not in historic
    assert report["confirmedHistoricalVersion"] in historic
    batch_paths = [directory / Path(name).name for name in report["batchPdfs"]]
    batch_numbers = Counter()
    total_batch_pages = sum(report["batchPages"])
    offset = 0
    for index, path in enumerate(batch_paths):
        batch = PdfReader(path)
        assert len(batch.pages) == report["batchPages"][index] <= 100
        for page_index, page in enumerate(batch.pages):
            text = re.sub(r"\s+", "", page.extract_text())
            assert report["batchVersionId"] in text
            assert f"第{offset + page_index + 1}/{total_batch_pages}页" in text
            batch_numbers.update(re.findall(r"MAX[0-9]{29}", text))
        offset += len(batch.pages)
    assert batch_numbers == {f"MAX{index:029d}": 3 for index in range(400)}
    for path in [maximum_path, history_path, *batch_paths]:
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
            for index in sorted({0, len(rendered) // 2, len(rendered) - 1}):
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
        "status": "passed", "sourceReportAt": report["at"],
        "maximumPages": len(maximum.pages), "historicalPages": len(history.pages),
        "uniqueStudentNumbers": len(numbers), "printedMemberRows": sum(numbers.values()),
        "longNameCharacters": compact.count("长"), "repeatedHeaders": True,
        "a4Landscape": True, "allGlyphsWithinPage": True, "physicalPrinterVerified": False,
        "batchPages": report["batchPages"], "batchMemberRows": sum(batch_numbers.values()),
    }
    (directory / "pdf-verification.json").write_text(
        json.dumps(evidence, ensure_ascii=True, indent=2), encoding="utf-8"
    )
    print(json.dumps(evidence, ensure_ascii=True))


if __name__ == "__main__":
    verify(Path(sys.argv[1] if len(sys.argv) > 1 else "output/playwright/duty-print-development"))
