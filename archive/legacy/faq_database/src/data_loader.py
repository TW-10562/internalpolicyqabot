import os
import pandas as pd


def load_faq_data(excel_path: str) -> pd.DataFrame:
    """
    Load FAQ data from Excel file with proper UTF-8 encoding.

    Args:
        excel_path: Path to the Excel file

    Returns:
        DataFrame with question and answer columns
    """
    print(f"Loading FAQ data from: {excel_path}")

    if not os.path.exists(excel_path):
        raise FileNotFoundError(f"Excel file not found: {excel_path}")

    # Read Excel with explicit encoding handling for Japanese text
    try:
        df = pd.read_excel(excel_path, engine='openpyxl')
        print(f"Loaded {len(df)} rows from Excel file")
        print(f"Columns: {df.columns.tolist()}")
    except Exception as e:
        print(f"Error reading Excel file: {e}")
        raise

    # Validate required columns. Accept either 'question' or 'questions' for backward compatibility
    cols = [c.strip() for c in df.columns.tolist()]
    # Normalize column names to lower-case without surrounding spaces
    normalized = {c: c.strip().lower() for c in df.columns.tolist()}
    has_question = any(n in ('question', 'questions') for n in normalized.values())
    has_answer = any(n == 'answer' for n in normalized.values())
    if not (has_question and has_answer):
        raise ValueError("Excel file must contain 'question' (or 'questions') and 'answer' columns")

    # If header is 'questions', rename to 'question' for consistency
    for orig, norm in normalized.items():
        if norm == 'questions':
            df = df.rename(columns={orig: 'question'})
        elif norm == 'question':
            df = df.rename(columns={orig: 'question'})
        elif norm == 'answer':
            df = df.rename(columns={orig: 'answer'})

    # Remove any rows with missing questions
    df = df.dropna(subset=['question'])
    print(f"After removing empty questions: {len(df)} rows")
    
    # Ensure proper string encoding for Japanese text
    for col in ['question', 'answer']:
        if col in df.columns:
            df[col] = df[col].astype(str).apply(lambda x: x.strip() if isinstance(x, str) else str(x).strip())

    return df
