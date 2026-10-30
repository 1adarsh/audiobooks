"""Text extraction for supported story documents."""

from io import BytesIO
from html.parser import HTMLParser
from pathlib import PurePath
from zipfile import BadZipFile, ZipFile
from xml.etree import ElementTree

from docx import Document
from pypdf import PdfReader
from pypdf.errors import PdfReadError

MAX_DOCUMENT_SIZE = 20 * 1024 * 1024
MAX_EXTRACTED_TEXT_LENGTH = 120_000
MAX_ODT_CONTENT_SIZE = 20 * 1024 * 1024
TEXT_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"


class _StoryHtmlParser(HTMLParser):
    _block_tags = {
        "address",
        "article",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "td",
        "th",
        "tr",
        "ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_tags: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag in {"head", "script", "style", "svg"}:
            self._ignored_tags.append(tag)
        elif not self._ignored_tags and tag in self._block_tags:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if self._ignored_tags:
            if tag == self._ignored_tags[-1]:
                self._ignored_tags.pop()
        elif tag in self._block_tags:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored_tags:
            self.parts.append(data)


def _extract_odt_text(content: bytes) -> str:
    try:
        with ZipFile(BytesIO(content)) as archive:
            content_info = archive.getinfo("content.xml")
            if content_info.file_size > MAX_ODT_CONTENT_SIZE:
                raise ValueError("The OpenDocument text file is too large to import.")
            root = ElementTree.fromstring(archive.read(content_info))
    except (BadZipFile, KeyError, ElementTree.ParseError, OSError, RuntimeError) as error:
        raise ValueError("The selected file is not a valid OpenDocument text file.") from error

    text_namespace = f"{{{TEXT_NAMESPACE}}}"

    def paragraph_text(paragraph: ElementTree.Element) -> str:
        parts: list[str] = []

        def append_text(element: ElementTree.Element) -> None:
            if element.tag == f"{text_namespace}s":
                parts.append(" " * int(element.get(f"{text_namespace}c", "1")))
                return
            if element.tag == f"{text_namespace}tab":
                parts.append("\t")
                return
            if element.tag == f"{text_namespace}line-break":
                parts.append("\n")
                return
            if element.text:
                parts.append(element.text)
            for child in element:
                append_text(child)
                if child.tail:
                    parts.append(child.tail)

        append_text(paragraph)
        return "".join(parts).strip()

    paragraphs = (
        paragraph_text(element)
        for element in root.iter()
        if element.tag in (f"{text_namespace}p", f"{text_namespace}h")
    )
    return "\n".join(paragraph for paragraph in paragraphs if paragraph)


def _extract_pdf_text(content: bytes) -> str:
    try:
        reader = PdfReader(BytesIO(content), strict=False)
        if reader.is_encrypted:
            raise ValueError("The selected PDF is password-protected.")
        return "\n".join(page.extract_text() or "" for page in reader.pages).strip()
    except PdfReadError as error:
        raise ValueError("The selected file is not a valid PDF.") from error


def _extract_docx_text(content: bytes) -> str:
    try:
        with ZipFile(BytesIO(content)) as archive:
            document_info = archive.getinfo("word/document.xml")
    except (BadZipFile, KeyError, OSError) as error:
        raise ValueError("The selected file is not a valid Word document.") from error

    if document_info.file_size > MAX_ODT_CONTENT_SIZE:
        raise ValueError("The Word document text is too large to import.")

    try:
        document = Document(BytesIO(content))
    except (OSError, ValueError) as error:
        raise ValueError("The selected file is not a valid Word document.") from error

    paragraphs = (
        element.text
        for element in document.iter_inner_content()
        if hasattr(element, "text")
    )
    return "\n".join(paragraph.strip() for paragraph in paragraphs if paragraph.strip())


def _extract_html_text(content: bytes) -> str:
    try:
        source = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("The selected text document must use UTF-8 encoding.") from error
    parser = _StoryHtmlParser()
    parser.feed(source)
    parser.close()
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)


def extract_story_text(filename: str, content: bytes) -> str:
    if len(content) > MAX_DOCUMENT_SIZE:
        raise ValueError("The selected file is too large to import (20 MB maximum).")

    extension = PurePath(filename).suffix.lower()
    if extension == ".odt":
        text = _extract_odt_text(content)
    elif extension == ".pdf":
        text = _extract_pdf_text(content)
    elif extension == ".docx":
        text = _extract_docx_text(content)
    elif extension in {".html", ".htm"}:
        text = _extract_html_text(content)
    elif extension in {".txt", ".text", ".md", ".markdown"}:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ValueError("The selected text document must use UTF-8 encoding.") from error
    else:
        raise ValueError(
            "Unsupported file type. Choose a PDF, DOCX, ODT, HTML, Markdown, or UTF-8 text file."
        )

    if not text.strip():
        raise ValueError(
            "No selectable text was found in this document. Scanned PDFs need OCR before import."
        )
    if len(text) > MAX_EXTRACTED_TEXT_LENGTH:
        raise ValueError("The extracted story is longer than the 120,000 character limit.")
    return text
