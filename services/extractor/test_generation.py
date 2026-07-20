from __future__ import annotations

import io
import unittest

from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader
from pptx import Presentation

from main import generate_docx, generate_pdf, generate_pptx, generate_xlsx, markdown_blocks


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


if __name__ == "__main__":
    unittest.main()
