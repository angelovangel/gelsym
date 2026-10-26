# Gel Band Quantifier: FastAPI + ONNX Runtime server that also serves the web client.
#
#   docker build -t gelsym .
#   docker run -p 8000:8000 gelsym      # then open http://localhost:8000
#
# Runs a single uvicorn worker on purpose: uploaded images are kept in process memory.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.28 /uv /usr/local/bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    GELSYM_MODEL_DIR=/app/models

WORKDIR /app/server

# Dependencies first (cached unless the lockfile changes).
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY server/*.py ./
COPY web /app/web

# Bake in the default models (standard gels and plates); others download on first use.
RUN python -c "import gelgenie; gelgenie.ensure_model('universal'); gelgenie.ensure_model('sharp')"

RUN useradd --uid 10001 --no-create-home --home-dir /app gelsym && chown -R gelsym /app/models
USER gelsym

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/models', timeout=4)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
