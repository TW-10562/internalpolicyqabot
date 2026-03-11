import io
from PyPDF2 import PdfReader
from docx import Document

def extract_text_from_file(filename: str, content: bytes) -> str:
    ext = filename.lower().split('.')[-1]
    text = ""

    if ext == "pdf":
        reader = PdfReader(io.BytesIO(content))
        text = "\n".join(page.extract_text() for page in reader.pages if page.extract_text())
    elif ext == "docx":
        doc = Document(io.BytesIO(content))
        text = "\n".join(p.text for p in doc.paragraphs)
    elif ext == "txt":
        text = content.decode("utf-8")
    else:
        raise ValueError("対応していないファイル形式です。")

    return text.strip()
