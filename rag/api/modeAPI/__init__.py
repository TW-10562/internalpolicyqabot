import pkgutil
import importlib
from fastapi import APIRouter

upload_router = APIRouter()

# このパッケージ(api)内を探索
for _, module_name, _ in pkgutil.iter_modules(__path__):
    if not module_name.endswith("_api"):
        continue
    module = importlib.import_module(f"{__name__}.{module_name}")
    if hasattr(module, "router"):
        upload_router.include_router(module.router)
