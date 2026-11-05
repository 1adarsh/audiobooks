import io
import unittest
import zipfile
from unittest.mock import MagicMock, patch

from docx import Document

from app.services.story_import import extract_story_text


class StoryImportTests(unittest.TestCase):
    def create_odt(self, content: str) -> bytes:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr(
                "content.xml",
                f"""<?xml version="1.0"?>
                <office:document-content
                  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
                  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
                  <office:body><office:text>{content}</office:text></office:body>
                </office:document-content>""",
            )
        return output.getvalue()

    def create_docx(self) -> bytes:
        document = Document()
        document.add_heading("Chapter One", level=1)
        document.add_paragraph("The story begins.")
        output = io.BytesIO()
        document.save(output)
        return output.getvalue()

    def test_extracts_paragraphs_and_preserves_open_document_spaces(self) -> None:
        content = self.create_odt(
            "<text:h>Chapter One</text:h>"
            "<text:p>The<text:s text:c=\"2\"/>story begins.</text:p>"
            "<text:p><text:span>Read</text:span> on.</text:p>"
        )

        self.assertEqual(
            extract_story_text("chapter.odt", content),
            "Chapter One\nThe  story begins.\nRead on.",
        )

    def test_rejects_invalid_open_document(self) -> None:
        with self.assertRaisesRegex(ValueError, "not a valid OpenDocument"):
            extract_story_text("chapter.odt", b"not an OpenDocument file")

    def test_rejects_unsupported_document_type(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported file type"):
            extract_story_text("chapter.pages", b"")

    def test_extracts_word_documents(self) -> None:
        self.assertEqual(
            extract_story_text("chapter.docx", self.create_docx()),
            "Chapter One\nThe story begins.",
        )

    @patch("app.services.story_import.pytesseract")
    @patch("app.services.story_import.convert_from_bytes")
    @patch("app.services.story_import.PdfReader")
    def test_extracts_scanned_pdfs_with_ocr(
        self,
        pdf_reader,
        convert_from_bytes,
        pytesseract,
    ) -> None:
        reader = MagicMock()
        reader.is_encrypted = False
        reader.pages = [MagicMock(extract_text=MagicMock(return_value=""))]
        pdf_reader.return_value = reader
        convert_from_bytes.return_value = [MagicMock()]
        pytesseract.image_to_string.return_value = "Scanned page text"

        self.assertEqual(
            extract_story_text("chapter.pdf", b"%PDF-1.4"),
            "Scanned page text",
        )

    def test_extracts_plain_markdown_and_html_text(self) -> None:
        self.assertEqual(
            extract_story_text("chapter.txt", b"\xef\xbb\xbfHello, story."),
            "Hello, story.",
        )
        self.assertEqual(
            extract_story_text("chapter.md", b"# Chapter One\n\nThe story begins."),
            "# Chapter One\n\nThe story begins.",
        )
        self.assertEqual(
            extract_story_text(
                "chapter.html",
                b"<html><head><title>Hidden</title></head><body>"
                b"<h1>Chapter One</h1><p>The &amp; story.</p>"
                b"<script>ignore()</script></body></html>",
            ),
            "Chapter One\nThe & story.",
        )


if __name__ == "__main__":
    unittest.main()
