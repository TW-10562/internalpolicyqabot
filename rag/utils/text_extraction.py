import io
from PyPDF2 import PdfReader
from docx import Document

# Supported file extensions for document ingestion
SUPPORTED_EXTENSIONS = {"pdf", "docx", "txt", "md", "markdown", "csv"}

def extract_text_from_file(filename: str, content: bytes) -> str:
    ext = filename.lower().rsplit('.', 1)[-1] if '.' in filename else ''
    text = ""

    if ext == "pdf":
        reader = PdfReader(io.BytesIO(content))
        text = "\n".join(page.extract_text() for page in reader.pages if page.extract_text())
    elif ext == "docx":
        doc = Document(io.BytesIO(content))
        text = "\n".join(p.text for p in doc.paragraphs)
    elif ext in ("txt", "md", "markdown"):
        text = content.decode("utf-8")
    elif ext == "csv":
        text = content.decode("utf-8")
    else:
        raise ValueError(
            f"対応していないファイル形式です: .{ext}  "
            f"(対応形式: {', '.join(sorted(SUPPORTED_EXTENSIONS))})"
        )

    return text.strip()
