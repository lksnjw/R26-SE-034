# AI learning workspace

Learn RAG by tracing policy text through chunking, embeddings, retrieval and
validation. Learn fine-tuning through the existing Colab notebooks and datasets.

## Start here

| Area | Files |
|---|---|
| Policy text and section chunking | [Policies](Rag/rag-system/fixtures/employee_registration_policies_sri_lanka/), [corpus.py](Rag/rag-system/src/core/registration/corpus.py) |
| Embeddings and ingestion | [embedding_service.py](Rag/rag-system/src/core/embeddings/embedding_service.py), [seed_qdrant_policies.py](Rag/rag-system/scripts/seed_qdrant_policies.py) |
| Metadata and vector retrieval | [retriever.py](Rag/rag-system/src/core/registration/retriever.py) |
| Rules and model-assisted validation | [validation.py](Rag/rag-system/src/core/registration/validation.py), [gate.py](Rag/rag-system/src/core/registration/gate.py) |
| LoRA fine-tuning | [Original notebook](Model/llna%203.1%20with%20drive.ipynb) and the other two notebooks in `Model/` |
| Training and evaluation data | [Data/](Data/) |
| Model evaluation | [Model/EVALUATION.md](Model/EVALUATION.md) |

Start with one policy and inspect its sections, metadata and retrieved context.
Then trace a form submission through the gate. This example combines deterministic
checks with retrieved context; it is not a general question-answering chatbot.

The training notebooks run in Colab and install their own training dependencies.
Their Google Drive paths must match your files. All three notebooks and all
datasets are preserved so you can compare experiments.

## Run and test

The existing virtual environments are preserved. The RAG service has its own
requirements and [setup guide](Rag/rag-system/README.md). Local model evaluation
uses [Model/requirements-evaluation.txt](Model/requirements-evaluation.txt).

From the project root:

```powershell
# Model evaluator checks; no inference calls.
.\.venv\Scripts\python.exe -B -m unittest discover -s Model/tests -v

# RAG checks without loading the service's live .env.
$env:PYTHONPATH = Join-Path (Get-Location) 'Rag/rag-system'
.\Rag\rag-system\.venv\Scripts\python.exe -B -m unittest discover -s Rag/rag-system/tests -v
```

## Research archive

The 2026-10-21 cleanup moved completed reports, saved results, unused finance and
assistant prototypes, duplicate documentation and temporary artifacts outside
this project. Original files before the documentation edits are backed up:

- Verified ZIP: `../R26-SE-034-backup-20261021-083519.zip`
- Reversibly archived files: `../R26-SE-034-removed-20261021-083519/`

The ZIP includes `CLEANUP_MANIFEST.json` with file hashes and the cleanup list.
Extract into a separate directory to inspect the original project. Git history,
datasets, notebooks, policies, virtual environments and `.env` were preserved.
The downloaded GGUF in `D:\Research\Model` was not changed. No hosted services
or databases were modified.
Keep the archive private: original research documentation contained an embedded
API key. The working API guide now uses a placeholder.

## Existing configuration issue

The RAG `.env` includes `HF_ENDPOINT_URL` and `HF_TOKEN`, which its settings class
does not accept. This blocked local startup before cleanup. Keep model-hosting
configuration separate from the RAG service configuration when integrating that
endpoint. The `.env` was left unchanged; the offline checks above avoid loading it.
