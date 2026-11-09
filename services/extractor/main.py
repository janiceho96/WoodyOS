from __future__ import annotations

import csv
import io
import json
import os
import re
import subprocess
import tempfile
import zipfile
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import Response
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from pypdf import PdfReader
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.dml.color import RGBColor
from pptx.util import Inches as PptxInches, Pt as PptxPt
from pydantic import BaseModel, Field
from PIL import Image, ImageOps, UnidentifiedImageError
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import ListFlowable, ListItem, Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table, TableStyle

app = FastAPI(title="Woody document extractor", version="0.1.0")
Image.MAX_IMAGE_PIXELS = 25_000_000


class GenerateRequest(BaseModel):
    format: Literal["pdf", "docx", "pptx", "xlsx", "html", "md", "txt", "csv", "json"]
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(min_length=1, max_length=2_000_000)
    theme: dict | None = None
    structured: Any | None = None


def safe_filename(title: str, suffix: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9 _-]", "", title).strip()
    stem = re.sub(r"[ _]+", "-", stem)[:90] or "woody-output"
    return f"{stem}.{suffix}"


def markdown_blocks(content: str) -> list[dict]:
    """Parse a deliberately small, deterministic Markdown subset for office export."""
    lines = content.replace("\r\n", "\n").split("\n")
    blocks: list[dict] = []
    index = 0
    paragraph: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            blocks.append({"type": "paragraph", "text": " ".join(part.strip() for part in paragraph).strip()})
            paragraph.clear()

    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()
        if stripped.startswith("```"):
            flush_paragraph()
            language = stripped[3:].strip()
            code: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code.append(lines[index])
                index += 1
            blocks.append({"type": "code", "language": language, "text": "\n".join(code)})
        elif re.match(r"^#{1,6}\s+", stripped):
            flush_paragraph()
            match = re.match(r"^(#{1,6})\s+(.*)$", stripped)
            blocks.append({"type": "heading", "level": len(match.group(1)), "text": match.group(2).strip()})
        elif re.match(r"^[-*+]\s+", stripped):
            flush_paragraph()
            items: list[str] = []
            while index < len(lines) and re.match(r"^\s*[-*+]\s+", lines[index]):
                items.append(re.sub(r"^\s*[-*+]\s+", "", lines[index]).strip())
                index += 1
            blocks.append({"type": "list", "ordered": False, "items": items})
            continue
        elif re.match(r"^\d+[.)]\s+", stripped):
            flush_paragraph()
            items = []
            while index < len(lines) and re.match(r"^\s*\d+[.)]\s+", lines[index]):
                items.append(re.sub(r"^\s*\d+[.)]\s+", "", lines[index]).strip())
                index += 1
            blocks.append({"type": "list", "ordered": True, "items": items})
            continue
        elif stripped.startswith("|") and "|" in stripped[1:] and index + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{3,}", lines[index + 1]):
            flush_paragraph()
            rows: list[list[str]] = []
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells):
                    rows.append(cells)
                index += 1
            if rows:
                width = max(len(row) for row in rows)
                blocks.append({"type": "table", "rows": [row + [""] * (width - len(row)) for row in rows]})
            continue
        elif not stripped:
            flush_paragraph()
        else:
            paragraph.append(stripped)
        index += 1
    flush_paragraph()
    return blocks


def strip_markdown(text: str) -> str:
    text = re.sub(r"!\[([^]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", text)
    return re.sub(r"(`{1,3}|\*\*|__|~~|(?<!\w)[*_](?!\w))", "", text).strip()


def spreadsheet_text(text: str) -> str:
    """Keep untrusted model output from becoming an executable Excel formula."""
    value = strip_markdown(text)
    return f"'{value}" if value.startswith(("=", "+", "-", "@")) else value


def generate_pdf(title: str, blocks: list[dict]) -> bytes:
    target = io.BytesIO()
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="WoodyTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=22, leading=27, textColor=colors.HexColor("#4338CA"), alignment=TA_CENTER, spaceAfter=12))
    styles.add(ParagraphStyle(name="WoodyCode", parent=styles["Code"], fontName="Courier", fontSize=8, leading=10, backColor=colors.HexColor("#F3F4F6"), borderPadding=7, spaceBefore=5, spaceAfter=8))
    document = SimpleDocTemplate(target, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=18 * mm, bottomMargin=18 * mm, title=title, author="Woody Agent OS")
    story: list = [Paragraph(escape(title), styles["WoodyTitle"]), Spacer(1, 5 * mm)]
    heading_styles = {1: styles["Heading1"], 2: styles["Heading2"], 3: styles["Heading3"], 4: styles["Heading4"], 5: styles["Heading4"], 6: styles["Heading4"]}
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            story.append(Paragraph(escape(strip_markdown(block["text"])), heading_styles[block["level"]]))
        elif kind == "paragraph":
            story.extend([Paragraph(escape(strip_markdown(block["text"])), styles["BodyText"]), Spacer(1, 2.5 * mm)])
        elif kind == "code":
            story.append(Preformatted(block["text"], styles["WoodyCode"], maxLineLength=100))
        elif kind == "list":
            items = [ListItem(Paragraph(escape(strip_markdown(item)), styles["BodyText"]), leftIndent=8) for item in block["items"]]
            story.append(ListFlowable(items, bulletType="1" if block["ordered"] else "bullet", leftIndent=18, bulletFontSize=8))
            story.append(Spacer(1, 2.5 * mm))
        elif kind == "table":
            rows = [[Paragraph(escape(strip_markdown(cell)), styles["BodyText"]) for cell in row] for row in block["rows"]]
            table = Table(rows, repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E0E7FF")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#312E81")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#CBD5E1")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.extend([table, Spacer(1, 3 * mm)])
    document.build(story)
    return target.getvalue()


def generate_docx(title: str, blocks: list[dict]) -> bytes:
    document = Document()
    section = document.sections[0]
    section.top_margin = Inches(0.7)
    section.bottom_margin = Inches(0.7)
    document.core_properties.title = title
    document.core_properties.author = "Woody Agent OS"
    heading = document.add_heading(strip_markdown(title), level=0)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            document.add_heading(strip_markdown(block["text"]), level=min(9, block["level"]))
        elif kind == "paragraph":
            document.add_paragraph(strip_markdown(block["text"]))
        elif kind == "list":
            style = "List Number" if block["ordered"] else "List Bullet"
            for item in block["items"]:
                document.add_paragraph(strip_markdown(item), style=style)
        elif kind == "code":
            paragraph = document.add_paragraph()
            paragraph.style = document.styles["No Spacing"]
            run = paragraph.add_run(block["text"])
            run.font.name = "Courier New"
            run.font.size = Pt(8)
        elif kind == "table":
            rows = block["rows"]
            table = document.add_table(rows=len(rows), cols=len(rows[0]))
            table.style = "Table Grid"
            for row_index, row in enumerate(rows):
                for col_index, value in enumerate(row):
                    cell = table.cell(row_index, col_index)
                    cell.text = strip_markdown(value)
                    if row_index == 0:
                        for run in cell.paragraphs[0].runs:
                            run.bold = True
    target = io.BytesIO()
    document.save(target)
    return target.getvalue()


def presentation_sections(title: str, blocks: list[dict]) -> list[tuple[str, list[dict]]]:
    sections: list[tuple[str, list[dict]]] = []
    current_title = "Overview"
    current: list[dict] = []
    for block in blocks:
        if block["type"] == "heading" and block["level"] <= 2:
            if current:
                sections.append((current_title, current))
            current_title = strip_markdown(block["text"])
            current = []
        else:
            current.append(block)
    if current or not sections:
        sections.append((current_title, current))
    return sections


def ppt_color(value: str) -> RGBColor:
    return RGBColor.from_string(value.lstrip("#")[:6].upper())


def ppt_theme(raw: dict | None) -> dict:
    defaults = {
        "style": "premium-dark",
        "background": "#0B1020", "surface": "#121A30", "primary": "#7C5CFF", "accent": "#4DE1FF",
        "success": "#4EE3A3", "text": "#F5F7FF", "muted": "#AAB3CC", "headingFont": "Aptos Display",
        "bodyFont": "Aptos", "maxWordsPerSlide": 35,
    }
    if not isinstance(raw, dict):
        return defaults
    for key in defaults:
        if key in raw and isinstance(raw[key], type(defaults[key])):
            defaults[key] = raw[key]
    return defaults


def add_text(slide, text: str, left: float, top: float, width: float, height: float, *, font: str, size: int, color: str, bold: bool = False, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(PptxInches(left), PptxInches(top), PptxInches(width), PptxInches(height))
    frame = box.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.vertical_anchor = MSO_ANCHOR.TOP
    paragraph = frame.paragraphs[0]
    paragraph.text = text
    paragraph.alignment = align
    paragraph.font.name = font
    paragraph.font.size = PptxPt(size)
    paragraph.font.bold = bold
    paragraph.font.color.rgb = ppt_color(color)
    return box


def setup_slide(slide, theme: dict, page: int | None = None):
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = ppt_color(theme["background"])
    if theme["style"] == "minimal-light":
        accent = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, PptxInches(0.75), PptxInches(1.28), PptxInches(2.1), PptxInches(0.05))
    else:
        accent = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, PptxInches(0), PptxInches(0), PptxInches(0.12), PptxInches(7.5))
    accent.fill.solid(); accent.fill.fore_color.rgb = ppt_color(theme["primary"]); accent.line.fill.background()
    if page is not None:
        add_text(slide, f"WOODY  /  {page:02d}", 10.9, 7.0, 1.7, 0.24, font=theme["bodyFont"], size=8, color=theme["muted"], align=PP_ALIGN.RIGHT)


def add_card(slide, title: str, body: str, left: float, top: float, width: float, height: float, theme: dict, number: int | None = None):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, PptxInches(left), PptxInches(top), PptxInches(width), PptxInches(height))
    shape.fill.solid(); shape.fill.fore_color.rgb = ppt_color(theme["surface"])
    shape.line.color.rgb = ppt_color(theme["primary"])
    if number is not None:
        add_text(slide, f"{number:02d}", left + 0.28, top + 0.24, width - 0.56, 0.32, font=theme["bodyFont"], size=10, color=theme["accent"], bold=True)
    add_text(slide, title, left + 0.28, top + (0.68 if number is not None else 0.32), width - 0.56, 0.55, font=theme["headingFont"], size=16, color=theme["text"], bold=True)
    add_text(slide, body, left + 0.28, top + (1.32 if number is not None else 1.00), width - 0.56, height - 1.35, font=theme["bodyFont"], size=11, color=theme["muted"])


def add_style_content(slide, heading: str, chunk: list[str], theme: dict):
    style = theme["style"]
    add_text(slide, heading, 0.75, 0.52, 11.6, 0.7, font=theme["headingFont"], size=25 if style != "investor-pitch" else 30, color=theme["text"], bold=True)
    lead = chunk[0] if chunk else "No additional content supplied."
    if style == "minimal-light":
        add_text(slide, lead[:850], 0.9, 1.75, 5.2, 3.8, font=theme["headingFont"], size=25, color=theme["text"], bold=True)
        for index, line in enumerate(chunk[1:5]):
            add_text(slide, f"{index + 1:02d}", 7.0, 1.75 + index * 1.05, 0.45, 0.3, font=theme["bodyFont"], size=11, color=theme["primary"], bold=True)
            add_text(slide, line[:650], 7.55, 1.70 + index * 1.05, 4.2, 0.65, font=theme["bodyFont"], size=14, color=theme["muted"])
        return
    if style == "investor-pitch":
        add_text(slide, lead[:850], 0.9, 1.65, 10.8, 2.0, font=theme["headingFont"], size=30, color=theme["text"], bold=True)
        for index, line in enumerate(chunk[1:4]):
            add_card(slide, f"Signal {index + 1}", line[:700], 0.9 + index * 3.9, 4.55, 3.55, 1.35, theme)
        return
    if style == "strategy-dashboard":
        values = chunk[:4] or [lead]
        for index, line in enumerate(values):
            row, col = divmod(index, 2)
            add_card(slide, f"KPI {index + 1}", line[:800], 0.9 + col * 5.85, 1.65 + row * 2.35, 5.35, 1.85, theme, index + 1)
        return
    if style == "research-report":
        add_text(slide, "EVIDENCE SUMMARY", 0.9, 1.55, 2.8, 0.3, font=theme["bodyFont"], size=10, color=theme["accent"], bold=True)
        add_text(slide, lead[:850], 0.9, 2.0, 4.05, 3.8, font=theme["bodyFont"], size=17, color=theme["text"], bold=True)
        for index, line in enumerate(chunk[1:5]):
            add_card(slide, f"Finding {index + 1}", line[:700], 5.45, 1.55 + index * 1.12, 6.25, 0.92, theme)
        return
    if len(chunk) <= 3 and all(len(line) < 240 for line in chunk):
        count = max(1, len(chunk)); card_width = (11.65 - (count - 1) * 0.22) / count
        for card_index, line in enumerate(chunk):
            add_card(slide, f"Key point {card_index + 1}", line[:850], 0.75 + card_index * (card_width + 0.22), 1.65, card_width, 4.55, theme, card_index + 1)
    else:
        add_text(slide, lead[:850], 0.9, 1.65, 4.0, 3.9, font=theme["bodyFont"], size=18, color=theme["text"], bold=True)
        for line_index, line in enumerate(chunk[1:6]):
            add_card(slide, f"{line_index + 1}", line[:700], 5.25, 1.55 + line_index * 0.92, 6.65, 0.76, theme)


def add_pptx_title_slide(presentation, title: str, theme: dict) -> None:
    title_slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    setup_slide(title_slide, theme)
    if theme["style"] != "minimal-light":
        glow = title_slide.shapes.add_shape(MSO_SHAPE.OVAL, PptxInches(8.8), PptxInches(0.45), PptxInches(3.6), PptxInches(3.6))
        glow.fill.solid(); glow.fill.fore_color.rgb = ppt_color(theme["primary"]); glow.line.fill.background()
    add_text(title_slide, "WOODY / INTELLIGENCE BRIEF", 0.75, 0.82, 5.2, 0.35, font=theme["bodyFont"], size=11, color=theme["accent"], bold=True)
    add_text(title_slide, strip_markdown(title), 0.75, 1.55, 9.8, 2.2, font=theme["headingFont"], size=35, color=theme["text"], bold=True)
    add_text(title_slide, "A structured presentation generated from your verified workflow output.", 0.75, 4.35, 7.5, 0.6, font=theme["bodyFont"], size=16, color=theme["muted"])
    add_text(title_slide, "WOODY AGENT OS", 0.75, 6.68, 4.0, 0.28, font=theme["bodyFont"], size=9, color=theme["success"], bold=True)


def pptx_section_content(section_blocks: list[dict]) -> tuple[list[str], list[list[list[str]]]]:
    bullet_lines: list[str] = []
    tables: list[list[list[str]]] = []
    for block in section_blocks:
        if block["type"] == "paragraph":
            bullet_lines.append(strip_markdown(block["text"]))
        elif block["type"] == "list":
            bullet_lines.extend(strip_markdown(item) for item in block["items"])
        elif block["type"] == "heading":
            bullet_lines.append(strip_markdown(block["text"]))
        elif block["type"] == "code":
            bullet_lines.append(block["text"][:800])
        elif block["type"] == "table":
            tables.append(block["rows"])
    return bullet_lines, tables


def wrap_pptx_bullet_lines(bullet_lines: list[str]) -> list[list[str]]:
    preserved_lines: list[str] = []
    for line in bullet_lines:
        words = line.split()
        current = ""
        for word in words:
            if len(current) + len(word) + 1 > 760 and current:
                preserved_lines.append(current)
                current = word
            else:
                current = f"{current} {word}".strip()
        if current or not words:
            preserved_lines.append(current)
    return [preserved_lines[index:index + 6] for index in range(0, len(preserved_lines), 6)] or [[]]


def add_pptx_content_slides(presentation, section_title: str, chunks: list[list[str]], theme: dict, slide_number: int) -> int:
    for chunk_index, chunk in enumerate(chunks):
        slide_number += 1
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        setup_slide(slide, theme, slide_number)
        heading = section_title if chunk_index == 0 else f"{section_title} · continued"
        add_style_content(slide, heading, chunk, theme)
    return slide_number


def add_pptx_table_slides(presentation, section_title: str, tables: list[list[list[str]]], theme: dict, slide_number: int) -> int:
    for table_index, rows in enumerate(tables):
        header, data_rows = rows[0], rows[1:]
        pages = [data_rows[index:index + 14] for index in range(0, len(data_rows), 14)] or [[]]
        for page_index, page_rows in enumerate(pages):
            page = [header, *page_rows]
            cols = len(header)
            slide_number += 1
            slide = presentation.slides.add_slide(presentation.slide_layouts[6])
            setup_slide(slide, theme, slide_number)
            continuation = f" · page {page_index + 1}" if len(pages) > 1 else ""
            add_text(slide, f"{section_title} — Table {table_index + 1}{continuation}", 0.75, 0.52, 11.6, 0.7, font=theme["headingFont"], size=23, color=theme["text"], bold=True)
            shape = slide.shapes.add_table(len(page), cols, PptxInches(0.6), PptxInches(1.5), PptxInches(12.1), PptxInches(5.3))
            table = shape.table
            for row_index, row in enumerate(page):
                for col_index, value in enumerate(row):
                    cell = table.cell(row_index, col_index)
                    cell.text = strip_markdown(value)
                    cell.text_frame.paragraphs[0].font.size = PptxPt(12)
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = ppt_color(theme["primary"] if row_index == 0 else theme["surface"])
                    cell.text_frame.paragraphs[0].font.color.rgb = ppt_color(theme["text"])
                    cell.text_frame.paragraphs[0].alignment = PP_ALIGN.LEFT
                    if row_index == 0:
                        cell.text_frame.paragraphs[0].font.bold = True
    return slide_number


def generate_pptx(title: str, blocks: list[dict], raw_theme: dict | None = None) -> bytes:
    theme = ppt_theme(raw_theme)
    presentation = Presentation()
    presentation.slide_width = PptxInches(13.333)
    presentation.slide_height = PptxInches(7.5)
    add_pptx_title_slide(presentation, title, theme)
    slide_number = 1
    for section_title, section_blocks in presentation_sections(title, blocks):
        bullet_lines, tables = pptx_section_content(section_blocks)
        chunks = wrap_pptx_bullet_lines(bullet_lines)
        slide_number = add_pptx_content_slides(presentation, section_title, chunks, theme, slide_number)
        slide_number = add_pptx_table_slides(presentation, section_title, tables, theme, slide_number)
    target = io.BytesIO()
    presentation.save(target)
    return target.getvalue()


def generate_xlsx(title: str, blocks: list[dict]) -> bytes:
    workbook = Workbook()
    overview = workbook.active
    overview.title = "Overview"
    overview.append([spreadsheet_text(title)])
    overview["A1"].font = Font(size=18, bold=True, color="4338CA")
    overview.merge_cells("A1:B1")
    overview.append(["Type", "Content"])
    table_number = 0
    for block in blocks:
        if block["type"] == "table":
            table_number += 1
            sheet = workbook.create_sheet(f"Table {table_number}")
            for row in block["rows"]:
                sheet.append([spreadsheet_text(value) for value in row])
            for cell in sheet[1]:
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = PatternFill("solid", fgColor="4338CA")
            sheet.freeze_panes = "A2"
            sheet.auto_filter.ref = sheet.dimensions
            for column in range(1, sheet.max_column + 1):
                values = [str(sheet.cell(row, column).value or "") for row in range(1, min(sheet.max_row, 200) + 1)]
                sheet.column_dimensions[get_column_letter(column)].width = min(60, max(10, max(map(len, values), default=10) + 2))
            continue
        if block["type"] == "list":
            for item in block["items"]:
                overview.append(["List item", spreadsheet_text(item)])
        else:
            overview.append([block["type"].title(), spreadsheet_text(block.get("text", ""))])
    for cell in overview[2]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="4338CA")
    overview.column_dimensions["A"].width = 18
    overview.column_dimensions["B"].width = 100
    for row in overview.iter_rows(min_row=3, max_col=2):
        row[1].alignment = Alignment(wrap_text=True, vertical="top")
    overview.freeze_panes = "A3"
    target = io.BytesIO()
    workbook.save(target)
    return target.getvalue()


def html_theme(raw_theme: dict | None) -> dict:
    defaults = {
        "background": "#0B1020", "surface": "#121A30", "text": "#F5F7FF",
        "muted": "#AAB3CC", "accent": "#8B7CFF", "border": "#2B3657",
        "headingFont": "system", "bodyFont": "system", "density": "comfortable",
    }
    value = {**defaults, **(raw_theme or {})}
    for key in ("background", "surface", "text", "muted", "accent", "border"):
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", str(value.get(key, ""))):
            value[key] = defaults[key]
    for key in ("headingFont", "bodyFont"):
        if value.get(key) not in {"system", "serif", "mono"}:
            value[key] = defaults[key]
    if value.get("density") not in {"comfortable", "compact"}:
        value["density"] = defaults["density"]
    return value


def generate_html(title: str, blocks: list[dict], raw_theme: dict | None = None) -> bytes:
    theme = html_theme(raw_theme)
    font_stacks = {
        "system": 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        "serif": 'Georgia,"Times New Roman",serif',
        "mono": '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
    }
    heading_font = font_stacks[theme["headingFont"]]
    body_font = font_stacks[theme["bodyFont"]]
    main_padding = "40px 0 64px" if theme["density"] == "compact" else "64px 0 96px"
    body = []
    for block in blocks:
        kind = block["type"]
        if kind == "heading":
            level = max(1, min(6, int(block["level"])))
            body.append(f"<h{level}>{escape(strip_markdown(block['text']))}</h{level}>")
        elif kind == "paragraph":
            body.append(f"<p>{escape(strip_markdown(block['text']))}</p>")
        elif kind == "code":
            language = escape(str(block.get("language", "")))
            body.append(f'<pre><code data-language="{language}">{escape(block["text"])}</code></pre>')
        elif kind == "list":
            tag = "ol" if block["ordered"] else "ul"
            items = "".join(f"<li>{escape(strip_markdown(item))}</li>" for item in block["items"])
            body.append(f"<{tag}>{items}</{tag}>")
        elif kind == "table":
            rows = block["rows"]
            if rows:
                head = "".join(f"<th>{escape(strip_markdown(value))}</th>" for value in rows[0])
                remaining = "".join(
                    "<tr>" + "".join(f"<td>{escape(strip_markdown(value))}</td>" for value in row) + "</tr>"
                    for row in rows[1:]
                )
                body.append(f"<div class=\"table-wrap\"><table><thead><tr>{head}</tr></thead><tbody>{remaining}</tbody></table></div>")
    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'">
  <title>{escape(title)}</title>
  <style>
    :root {{ color-scheme:light dark; --bg:{theme["background"]}; --surface:{theme["surface"]}; --text:{theme["text"]}; --muted:{theme["muted"]}; --accent:{theme["accent"]}; --line:{theme["border"]}; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font:16px/1.65 {body_font}; }}
    main {{ width:min(960px,calc(100% - 32px)); margin:0 auto; padding:{main_padding}; }}
    header {{ padding:28px 32px; margin-bottom:32px; border:1px solid var(--line); border-radius:18px; background:var(--surface); box-shadow:inset 4px 0 var(--accent); }}
    h1,h2,h3,h4,h5,h6 {{ font-family:{heading_font}; }}
    h1 {{ margin:0; font-size:clamp(2rem,5vw,3.4rem); line-height:1.05; letter-spacing:-.04em; }}
    h2 {{ margin-top:2.2em; border-bottom:1px solid var(--line); padding-bottom:.35em; }}
    h3,h4,h5,h6 {{ margin-top:1.8em; }}
    p,li {{ color:var(--muted); }}
    pre {{ overflow:auto; padding:18px; border:1px solid var(--line); border-radius:12px; background:#070b16; }}
    code {{ font-family:"SFMono-Regular",Consolas,monospace; color:#90e7ff; }}
    .table-wrap {{ overflow:auto; margin:24px 0; border:1px solid var(--line); border-radius:12px; }}
    table {{ width:100%; border-collapse:collapse; background:var(--surface); }}
    th,td {{ padding:12px 14px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }}
    th {{ color:#fff; background:#302665; }}
    @media print {{ :root {{ --bg:#fff; --surface:#fff; --text:#111827; --muted:#374151; --line:#d1d5db; }} main {{ width:100%; padding:0; }} }}
  </style>
</head>
<body><main><header><h1>{escape(title)}</h1></header>{''.join(body)}</main></body>
</html>"""
    return document.encode("utf-8")


def generate_plain_text(title: str, blocks: list[dict]) -> bytes:
    lines = [title, "=" * min(80, len(title)), ""]
    for block in blocks:
        if block["type"] == "heading":
            lines.extend([strip_markdown(block["text"]), ""])
        elif block["type"] in {"paragraph", "code"}:
            lines.extend([strip_markdown(block["text"]), ""])
        elif block["type"] == "list":
            lines.extend([f"{index + 1}. {strip_markdown(item)}" if block["ordered"] else f"- {strip_markdown(item)}" for index, item in enumerate(block["items"])])
            lines.append("")
        elif block["type"] == "table":
            lines.extend(["\t".join(strip_markdown(cell) for cell in row) for row in block["rows"]])
            lines.append("")
    return "\n".join(lines).strip().encode("utf-8")


def generate_csv(blocks: list[dict]) -> bytes:
    target = io.StringIO()
    writer = csv.writer(target)
    table = next((block for block in blocks if block["type"] == "table"), None)
    if table:
        for row in table["rows"]:
            writer.writerow([spreadsheet_text(value) for value in row])
    else:
        writer.writerow(["Type", "Content"])
        for block in blocks:
            if block["type"] == "list":
                for item in block["items"]:
                    writer.writerow(["List item", spreadsheet_text(item)])
            else:
                writer.writerow([block["type"].title(), spreadsheet_text(block.get("text", ""))])
    return target.getvalue().encode("utf-8-sig")


def generate_json(content: str, structured: Any | None) -> bytes:
    value = structured if isinstance(structured, (dict, list)) else {"content": content}
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def require_token(value: str | None) -> None:
    expected = os.getenv("EXTRACTOR_TOKEN")
    if expected and value != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def validate_office_package(data: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 10_000:
                raise ValueError("Office package contains too many entries")
            total = sum(entry.file_size for entry in entries)
            compressed = sum(max(1, entry.compress_size) for entry in entries)
            if total > 200 * 1024 * 1024 or total / compressed > 200:
                raise ValueError("Office package exceeds safe decompression limits")
    except zipfile.BadZipFile as error:
        raise ValueError("The uploaded Office document is not a valid package") from error


def pdf_ocr(data: bytes, page_count: int) -> list[str]:
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "source.pdf"
        source.write_bytes(data)
        prefix = Path(directory) / "page"
        limit = min(page_count, 30)
        subprocess.run(
            ["pdftoppm", "-f", "1", "-l", str(limit), "-png", "-r", "150", str(source), str(prefix)],
            check=True, capture_output=True, timeout=90,
        )
        pages = []
        for image in sorted(Path(directory).glob("page-*.png")):
            result = subprocess.run(
                ["tesseract", str(image), "stdout", "-l", "eng"],
                check=True, capture_output=True, text=True, timeout=60,
            )
            pages.append(result.stdout.strip())
        return pages


def extract_pdf_document(data: bytes) -> dict:
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            unlocked = reader.decrypt("")
        except Exception as error:
            raise ValueError("Password-protected PDFs are not supported") from error
        if not unlocked:
            raise ValueError("Password-protected PDFs are not supported")
    if len(reader.pages) > 500:
        raise ValueError("PDFs are limited to 500 pages")
    page_text = [(page.extract_text() or "").strip() for page in reader.pages]
    used_ocr = False
    if not any(page_text):
        page_text = pdf_ocr(data, len(reader.pages))
        used_ocr = True
    sections = [
        {"locator": f"Page {index}", "content": text, "metadata": {"page": index, "ocr": used_ocr}}
        for index, text in enumerate(page_text, 1) if text
    ]
    content = "\n\n".join(f"## Page {index}\n\n{text}" for index, text in enumerate(page_text, 1) if text).strip()
    return {
        "content": content,
        "sections": sections,
        "structured": {"type": "pdf", "pages": len(reader.pages), "ocr": used_ocr},
        "metadata": {"pages": len(reader.pages), "ocr": used_ocr, "ocrPageLimit": 30 if used_ocr else None},
    }


def extract_pdf(data: bytes) -> str:
    return extract_pdf_document(data)["content"]


def extract_docx_document(data: bytes) -> dict:
    validate_office_package(data)
    document = Document(io.BytesIO(data))
    sections = []
    parts = []
    paragraph_number = 0
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        paragraph_number += 1
        locator = f"Paragraph {paragraph_number}"
        parts.append(text)
        sections.append({"locator": locator, "content": text, "metadata": {"paragraph": paragraph_number}})
    for table_number, table in enumerate(document.tables, 1):
        rows = [[cell.text.strip() for cell in row.cells] for row in table.rows]
        rendered = "\n".join("| " + " | ".join(value.replace("|", "\\|") for value in row) + " |" for row in rows)
        if rendered:
            parts.append(f"### Table {table_number}\n\n{rendered}")
            sections.append({"locator": f"Table {table_number}", "content": rendered, "metadata": {"table": table_number}})
    return {
        "content": "\n\n".join(parts).strip(),
        "sections": sections,
        "structured": {"type": "docx", "paragraphs": paragraph_number, "tables": len(document.tables)},
        "metadata": {"paragraphs": paragraph_number, "tables": len(document.tables)},
    }


def extract_docx(data: bytes) -> str:
    return extract_docx_document(data)["content"]


def extract_spreadsheet_document(data: bytes) -> dict:
    validate_office_package(data)
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    parts: list[str] = []
    sections = []
    sheets = []
    total_cells = 0
    if len(workbook.worksheets) > 20:
        raise ValueError("Workbooks are limited to 20 sheets")
    for worksheet in workbook.worksheets:
        rows: list[list[str]] = []
        truncated = False
        for row_number, row in enumerate(worksheet.iter_rows(values_only=True), 1):
            if row_number > 10_000:
                truncated = True
                break
            values = [str(value) if value is not None else "" for value in row[:200]]
            if any(values):
                rows.append(values)
                total_cells += len(values)
                if total_cells > 200_000:
                    raise ValueError("Workbook exceeds the 200,000-cell extraction limit")
        width = max((len(row) for row in rows), default=0)
        normalized = [row + [""] * (width - len(row)) for row in rows]
        rendered = "\n".join("| " + " | ".join(value.replace("|", "\\|") for value in row) + " |" for row in normalized)
        parts.append(f"# Sheet: {worksheet.title}\n\n{rendered}".strip())
        sections.append({
            "locator": f"Sheet {worksheet.title}",
            "content": rendered,
            "metadata": {"sheet": worksheet.title, "rows": len(normalized), "columns": width, "truncated": truncated},
        })
        sheets.append({
            "name": worksheet.title,
            "range": worksheet.calculate_dimension(),
            "rows": normalized,
            "rowCount": len(normalized),
            "columnCount": width,
            "truncated": truncated,
        })
    return {
        "content": "\n\n".join(parts).strip(),
        "sections": sections,
        "structured": {"type": "spreadsheet", "sheets": sheets},
        "metadata": {"sheets": len(sheets), "cells": total_cells},
    }


def extract_spreadsheet(data: bytes) -> str:
    return extract_spreadsheet_document(data)["content"]


def extract_csv_document(data: bytes) -> dict:
    text = data.decode("utf-8-sig", errors="replace")
    rows = []
    for row_number, row in enumerate(csv.reader(io.StringIO(text)), 1):
        if row_number > 10_000:
            break
        rows.append(row[:200])
    if sum(len(row) for row in rows) > 200_000:
        raise ValueError("CSV exceeds the 200,000-cell extraction limit")
    width = max((len(row) for row in rows), default=0)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    rendered = "\n".join("| " + " | ".join(value.replace("|", "\\|") for value in row) + " |" for row in normalized).strip()
    return {
        "content": rendered,
        "sections": [{"locator": "CSV rows", "content": rendered, "metadata": {"rows": len(normalized), "columns": width}}],
        "structured": {"type": "csv", "rows": normalized, "rowCount": len(normalized), "columnCount": width},
        "metadata": {"rows": len(normalized), "columns": width},
    }


def extract_csv(data: bytes) -> str:
    return extract_csv_document(data)["content"]


def extract_pptx_document(data: bytes) -> dict:
    validate_office_package(data)
    presentation = Presentation(io.BytesIO(data))
    if len(presentation.slides) > 300:
        raise ValueError("PowerPoint files are limited to 300 slides")
    sections = []
    slide_details = []
    for slide_number, slide in enumerate(presentation.slides, 1):
        parts = []
        title = ""
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                text = shape.text.strip()
                if text:
                    if not title:
                        title = text.splitlines()[0][:300]
                    parts.append(text)
            if getattr(shape, "has_table", False):
                rows = [[cell.text.strip() for cell in row.cells] for row in shape.table.rows]
                rendered = "\n".join("| " + " | ".join(value.replace("|", "\\|") for value in row) + " |" for row in rows)
                if rendered:
                    parts.append(rendered)
        notes = ""
        try:
            if slide.has_notes_slide:
                notes = slide.notes_slide.notes_text_frame.text.strip()
        except (AttributeError, ValueError):
            notes = ""
        if notes:
            parts.append(f"Speaker notes:\n{notes}")
        content = "\n\n".join(parts).strip()
        locator = f"Slide {slide_number}" + (f": {title}" if title else "")
        if content:
            sections.append({"locator": locator, "content": content, "metadata": {"slide": slide_number, "title": title}})
        slide_details.append({"number": slide_number, "title": title, "hasNotes": bool(notes)})
    content = "\n\n".join(f"## {section['locator']}\n\n{section['content']}" for section in sections)
    return {
        "content": content,
        "sections": sections,
        "structured": {"type": "pptx", "slides": slide_details},
        "metadata": {"slides": len(presentation.slides)},
    }


class SafeHtmlTextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.blocked = 0

    def handle_starttag(self, tag: str, attrs):
        if tag.lower() in {"script", "style", "iframe", "form", "object", "embed"}:
            self.blocked += 1
        elif not self.blocked and tag.lower() in {"p", "div", "section", "article", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str):
        if tag.lower() in {"script", "style", "iframe", "form", "object", "embed"} and self.blocked:
            self.blocked -= 1
        elif not self.blocked and tag.lower() in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_data(self, data: str):
        if not self.blocked:
            self.parts.append(data)


def extract_html_document(data: bytes) -> dict:
    parser = SafeHtmlTextExtractor()
    parser.feed(data.decode("utf-8", errors="replace"))
    content = re.sub(r"\n{3,}", "\n\n", "".join(parser.parts)).strip()
    return {
        "content": content,
        "sections": [{"locator": "HTML document", "content": content, "metadata": {"sanitized": True}}],
        "structured": {"type": "html", "sanitized": True},
        "metadata": {"sanitized": True},
    }


def extract_image(data: bytes, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as source:
        source.write(data)
        path = source.name
    try:
        result = subprocess.run(["tesseract", path, "stdout", "-l", "eng"], check=True, capture_output=True, text=True, timeout=60)
        return result.stdout.strip()
    finally:
        Path(path).unlink(missing_ok=True)


def normalize_avatar(data: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(data)) as source:
            source.load()
            image = ImageOps.exif_transpose(source)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA")
            image = ImageOps.fit(image, (512, 512), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
            if image.mode == "RGBA":
                background = Image.new("RGBA", image.size, (0, 0, 0, 0))
                background.alpha_composite(image)
                image = background
            target = io.BytesIO()
            image.save(target, format="WEBP", quality=88, method=6)
            return target.getvalue()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as error:
        raise ValueError("The uploaded file is not a valid supported image") from error


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/extract")
async def extract(file: UploadFile = File(...), authorization: str | None = Header(default=None)):
    require_token(authorization)
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Files are limited to 25 MB")
    name = file.filename or "upload"
    suffix = Path(name).suffix.lower()
    try:
        if suffix == ".pdf": result = extract_pdf_document(data)
        elif suffix == ".docx": result = extract_docx_document(data)
        elif suffix == ".pptx": result = extract_pptx_document(data)
        elif suffix in {".xlsx", ".xlsm"}: result = extract_spreadsheet_document(data)
        elif suffix == ".csv": result = extract_csv_document(data)
        elif suffix in {".txt", ".md"}:
            content = data.decode("utf-8", errors="replace").strip()
            result = {
                "content": content,
                "sections": [{"locator": "Document", "content": content, "metadata": {"format": suffix[1:]}}],
                "structured": {"type": suffix[1:]},
                "metadata": {},
            }
        elif suffix == ".html": result = extract_html_document(data)
        elif suffix in {".png", ".jpg", ".jpeg", ".webp"}:
            content = extract_image(data, suffix)
            result = {
                "content": content,
                "sections": [{"locator": "Image OCR", "content": content, "metadata": {"ocr": True}}],
                "structured": {"type": "image", "ocr": True},
                "metadata": {"ocr": True},
            }
        else: raise HTTPException(status_code=415, detail=f"Unsupported file type: {suffix or 'unknown'}")
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"Could not extract {name}: {error}") from error
    content = result["content"]
    if not content:
        raise HTTPException(status_code=422, detail="No text could be extracted from this file")
    return {
        "name": name,
        "content": content,
        "characters": len(content),
        "sections": result.get("sections", []),
        "structured": result.get("structured", {}),
        "metadata": result.get("metadata", {}),
    }


@app.post("/avatar")
async def avatar(file: UploadFile = File(...), authorization: str | None = Header(default=None)):
    require_token(authorization)
    if file.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=415, detail="Use a PNG, JPEG, or WebP image")
    data = await file.read()
    if not data or len(data) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Avatar images are limited to 2 MB")
    try:
        normalized = normalize_avatar(data)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return Response(
        content=normalized,
        media_type="image/webp",
        headers={"X-Avatar-Bytes": str(len(normalized)), "Cache-Control": "no-store"},
    )


@app.post("/generate")
def generate(request: GenerateRequest, authorization: str | None = Header(default=None)):
    require_token(authorization)
    blocks = markdown_blocks(request.content)
    if not blocks:
        raise HTTPException(status_code=422, detail="No document content was supplied")
    try:
        if request.format == "pdf":
            data = generate_pdf(request.title, blocks)
            media_type = "application/pdf"
        elif request.format == "docx":
            data = generate_docx(request.title, blocks)
            media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif request.format == "pptx":
            data = generate_pptx(request.title, blocks, request.theme)
            media_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        elif request.format == "xlsx":
            data = generate_xlsx(request.title, blocks)
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        elif request.format == "html":
            data = generate_html(request.title, blocks, request.theme)
            media_type = "text/html; charset=utf-8"
        elif request.format == "md":
            data = request.content.encode("utf-8")
            media_type = "text/markdown; charset=utf-8"
        elif request.format == "txt":
            data = generate_plain_text(request.title, blocks)
            media_type = "text/plain; charset=utf-8"
        elif request.format == "csv":
            data = generate_csv(blocks)
            media_type = "text/csv; charset=utf-8"
        else:
            data = generate_json(request.content, request.structured)
            media_type = "application/json; charset=utf-8"
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"Could not generate {request.format}: {error}") from error
    if not data:
        raise HTTPException(status_code=422, detail="Document generator returned an empty file")
    filename = safe_filename(request.title, request.format)
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Artifact-Bytes": str(len(data)),
        },
    )
