from __future__ import annotations

import io
import unittest

from docx import Document
from openpyxl import load_workbook
from PIL import Image
from pypdf import PdfReader
from pptx import Presentation

from main import (
    extract_pdf_document,
    extract_pptx_document,
    extract_spreadsheet_document,
    generate_docx,
    generate_html,
    generate_pdf,
    generate_pptx,
    generate_xlsx,
    generate_csv,
    markdown_blocks,
    normalize_avatar,
)


SAMPLE = """# Quarterly Review

An executive summary grounded in recorded agent output.

## Priorities

- Grow revenue
- Reduce delivery risk

| Metric | Value |
|---|---|
| Revenue | 120 |
| Cost | 45 |

```python
print("verified")
```
"""


class ArtifactGenerationTests(unittest.TestCase):
    def test_every_supported_format_is_structurally_readable(self):
        blocks = markdown_blocks(SAMPLE)
        pdf = generate_pdf("Quarterly Review", blocks)
        docx = generate_docx("Quarterly Review", blocks)
        pptx = generate_pptx("Quarterly Review", blocks)
        xlsx = generate_xlsx("Quarterly Review", blocks)

        self.assertGreaterEqual(len(PdfReader(io.BytesIO(pdf)).pages), 1)
        self.assertGreaterEqual(len(Document(io.BytesIO(docx)).paragraphs), 4)
        self.assertGreaterEqual(len(Presentation(io.BytesIO(pptx)).slides), 2)
        self.assertGreaterEqual(len(load_workbook(io.BytesIO(xlsx)).sheetnames), 2)

    def test_powerpoint_paginates_tables_without_dropping_rows(self):
        table = "| Item | Value |\n|---|---|\n" + "\n".join(f"| Row {index} | {index} |" for index in range(35))
        slides = Presentation(io.BytesIO(generate_pptx("Long Table", markdown_blocks(table)))).slides
        rendered_rows = sum(len(shape.table.rows) - 1 for slide in slides for shape in slide.shapes if shape.has_table)
        self.assertEqual(rendered_rows, 35)

    def test_spreadsheet_neutralizes_formula_injection(self):
        workbook = load_workbook(io.BytesIO(generate_xlsx("Safe Export", markdown_blocks("| Input |\n|---|\n| =HYPERLINK(\"https://example.com\") |"))))
        cell = workbook["Table 1"]["A2"]
        self.assertEqual(cell.data_type, "s")
        self.assertTrue(cell.value.startswith("'="))

    def test_generated_html_is_static_sandbox_friendly_and_escapes_markup(self):
        html = generate_html("Safe <Report>", markdown_blocks("# Result\n\n<script>alert('no')</script>")).decode("utf-8")
        self.assertIn("Content-Security-Policy", html)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertNotIn("<form", html)

    def test_generated_html_applies_only_validated_theme_tokens(self):
        html = generate_html("Theme", markdown_blocks("# Result"), {
            "background": "#112233",
            "accent": "#00FFAA",
            "headingFont": "serif",
            "bodyFont": "mono",
            "density": "compact",
        }).decode("utf-8")
        self.assertIn("--bg:#112233", html)
        self.assertIn("--accent:#00FFAA", html)
        self.assertIn('Georgia,"Times New Roman",serif', html)
        self.assertNotIn("<script", html)

    def test_csv_neutralizes_formula_injection(self):
        value = generate_csv(markdown_blocks("| Input |\n|---|\n| =2+2 |")).decode("utf-8-sig")
        self.assertIn("'=2+2", value)

    def test_extraction_preserves_pdf_slide_and_sheet_locations(self):
        pdf = extract_pdf_document(generate_pdf("Report", markdown_blocks("# Finding\n\nVerified evidence.")))
        self.assertTrue(pdf["sections"][0]["locator"].startswith("Page "))

        pptx = extract_pptx_document(generate_pptx("Deck", markdown_blocks("# Finding\n\nVerified evidence.")))
        self.assertTrue(pptx["sections"][0]["locator"].startswith("Slide "))

        xlsx = extract_spreadsheet_document(generate_xlsx("Data", markdown_blocks("| Name | Value |\n|---|---|\n| A | 1 |")))
        self.assertTrue(xlsx["sections"][0]["locator"].startswith("Sheet "))
        self.assertIn("rows", xlsx["structured"]["sheets"][0])

    def test_avatar_is_cropped_and_normalized_to_webp(self):
        source = io.BytesIO()
        Image.new("RGB", (900, 450), "#7c3aed").save(source, format="PNG")
        normalized = normalize_avatar(source.getvalue())
        with Image.open(io.BytesIO(normalized)) as image:
            self.assertEqual(image.format, "WEBP")
            self.assertEqual(image.size, (512, 512))


if __name__ == "__main__":
    unittest.main()
