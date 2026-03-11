from logging import getLogger
from typing import Optional

import requests
from pydantic import BaseModel
from config.index import config

logger = getLogger(__name__)


class SolrNotFoundError(Exception):
    pass


class SolrSelectResult(BaseModel):
    id: str
    content: Optional[list[str]] = [""]
    chunk_number_i: Optional[int] = -1
    file_path_s: Optional[str] = ""
    title: Optional[list[str]] = [""]


def get_solr_doc_by_id(solr_url: str, core: str, doc_id: str) -> SolrSelectResult:
    """
    Using the /select api to get the content of a document by its ID.
    """
    try:
        params = {
            "q": f"id:{doc_id}",
            "fl": "id,content,chunk_number_i,file_path_s,title",
            "wt": "json",
        }
        url = f"{solr_url}/solr/{core}/select"
        resp = requests.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        docs = data.get("response", {}).get("docs", [])
        if not docs:
            raise SolrNotFoundError(f"Document {doc_id} not found")

        return SolrSelectResult(**docs[0])

    except Exception as e:
        logger.error(f"Error fetching Solr document: {e}")
        return SolrSelectResult(id=doc_id)


if __name__ == "__main__":

    solr_url = config.ApacheSolr.url
    core = "mycore"
    doc_id = "page-4#vCBh8r_iaIFSZzOpOLeZc.pdf"

    content = get_solr_doc_by_id(solr_url, core, doc_id)
    print(content)
