import re
from typing import List, Optional


# Japanese sentence-ending patterns (。！？) and common structural breaks
_JA_SENTENCE_BOUNDARY = re.compile(r'(?<=[。！？\n])\s*')
_JA_CLAUSE_BOUNDARY = re.compile(r'(?<=[、；;：])\s*')


def _find_best_split_point(text: str, target: int, window: int = 80) -> int:
    """Find the best split point near `target` that respects sentence boundaries.

    Searches within [target - window, target + window] for the nearest Japanese
    sentence boundary (。！？\\n), falling back to clause boundaries (、；),
    then whitespace, then the raw target position.
    """
    if target >= len(text):
        return len(text)

    lo = max(0, target - window)
    hi = min(len(text), target + window)
    search_region = text[lo:hi]

    # Prefer sentence boundaries (。！？\n)
    best = None
    best_dist = window + 1
    for m in _JA_SENTENCE_BOUNDARY.finditer(search_region):
        abs_pos = lo + m.start()
        dist = abs(abs_pos - target)
        if dist < best_dist:
            best = abs_pos
            best_dist = dist

    if best is not None and best > 0:
        return best

    # Fall back to clause boundaries (、；;：)
    for m in _JA_CLAUSE_BOUNDARY.finditer(search_region):
        abs_pos = lo + m.start()
        dist = abs(abs_pos - target)
        if dist < best_dist:
            best = abs_pos
            best_dist = dist

    if best is not None and best > 0:
        return best

    # Fall back to whitespace
    for i in range(target, min(target + window, len(text))):
        if text[i] in ' \t\n\r\u3000':
            return i + 1

    return target


def split_text_with_overlap(
    text: str, chunk_size: int = 500, overlap: int = 100
) -> list[str]:
    # legacy
    result = []
    start = 0
    while start < len(text):
        end = min(len(text), start + chunk_size)
        result.append(text[start:end])
        start += chunk_size - overlap
    return result


def split_text(
    text: str,
    separator: Optional[str] = "\n\n",
    chunk_size: int = 500,
    overlap: int = 100,
    respect_sentence_boundaries: bool = True,
) -> List[str]:
    """Split text into chunks with overlap.

    When ``respect_sentence_boundaries`` is True (default), the splitter tries
    to break at Japanese sentence boundaries (。！？) or clause boundaries (、)
    rather than at arbitrary character positions.  This avoids cutting mid-sentence
    in Japanese documents where whitespace-based heuristics fail.
    """

    if chunk_size <= 0:
        raise ValueError("chunk_size must be > 0")

    if not text:
        return []

    if overlap < 0:
        overlap = 0
    if overlap >= chunk_size:
        overlap = chunk_size - 1

    chunks: List[str] = []

    # --- Separator-free mode: pure character sliding window ---
    if not separator:
        start = 0
        n = len(text)
        step = max(1, chunk_size - overlap)
        while start < n:
            end = min(start + chunk_size, n)
            if respect_sentence_boundaries and end < n:
                end = _find_best_split_point(text, end)
            chunks.append(text[start:end])
            if end >= n:
                break
            start = max(start + 1, end - overlap)
        return chunks

    # --- Separator-based mode ---
    parts = text.split(separator)
    atoms = [(p + separator) if i < len(parts) - 1 else p for i, p in enumerate(parts)]

    buf = ""

    def flush_buf():
        nonlocal buf
        if buf:
            chunks.append(buf)
            buf = ""

    def carry_overlap_from(last_buf: str):
        if overlap <= 0:
            return ""
        return last_buf[-overlap:]

    for atom in atoms:
        if not buf:
            if len(atom) <= chunk_size:
                buf = atom
            else:
                start = 0
                step = max(1, chunk_size - overlap)
                while start < len(atom):
                    end = start + chunk_size
                    if respect_sentence_boundaries and end < len(atom):
                        end = _find_best_split_point(atom, end)
                    piece = atom[start:end]
                    chunks.append(piece)
                    if end >= len(atom):
                        buf = ""
                        break
                    start = max(start + 1, end - overlap)
        else:
            if len(buf) + len(atom) <= chunk_size:
                buf += atom
            else:
                last = buf
                flush_buf()
                buf = carry_overlap_from(last)

                remaining = atom
                while remaining:
                    avail = chunk_size - len(buf)
                    if avail <= 0:
                        last2 = buf
                        flush_buf()
                        buf = carry_overlap_from(last2)
                        avail = chunk_size - len(buf)

                    take = min(avail, len(remaining))
                    buf += remaining[:take]
                    remaining = remaining[take:]

                    if len(buf) >= chunk_size and remaining:
                        last2 = buf
                        flush_buf()
                        buf = carry_overlap_from(last2)

    flush_buf()
    return chunks
