from typing import List, Optional

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
) -> List[str]:

    if chunk_size <= 0:
        raise ValueError("chunk_size must be > 0")

    if not text:
        return []

    if overlap < 0:
        overlap = 0
    if overlap >= chunk_size:
        overlap = chunk_size - 1

    chunks: List[str] = []

    if not separator:
        start = 0
        n = len(text)
        step = max(1, chunk_size - overlap)
        while start < n:
            end = min(start + chunk_size, n)
            chunks.append(text[start:end])
            if end >= n:
                break
            start += step
        return chunks

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
                    piece = atom[start : start + chunk_size]
                    chunks.append(piece)
                    if start + chunk_size >= len(atom):
                        buf = ""
                        break
                    start += step
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

                    if len(buf) == chunk_size and remaining:
                        last2 = buf
                        flush_buf()
                        buf = carry_overlap_from(last2)

    flush_buf()
    return chunks
