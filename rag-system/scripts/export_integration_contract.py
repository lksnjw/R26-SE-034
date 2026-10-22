"""Export a secret-free OpenAPI contract and Postman collection for the main team."""
import json
from pathlib import Path

from src.app import app

BASE_URL = "https://policy-gate.victoriousglacier-3e6fd5f9.centralindia.azurecontainerapps.io"
ROOT = Path(__file__).resolve().parents[1]


def main():
    output = ROOT / "docs" / "integration"
    output.mkdir(parents=True, exist_ok=True)
    schema = app.openapi()
    schema["servers"] = [{"url": BASE_URL, "description": "Azure policy gate"}]
    (output / "openapi.json").write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    sample = (ROOT / "examples" / "registration_request.json").read_text(encoding="utf-8")
    collection = {
        "info": {"name": "Sri Lanka Employee Registration Policy Gate", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
                 "description": "Backend-only integration. Keep gate_api_key private. The sample has no duplicate evidence, so it cannot ALLOW. Replace requester assertions with authenticated-session facts."},
        "variable": [{"key": "base_url", "value": BASE_URL}, {"key": "gate_api_key", "value": "", "type": "string"}],
        "item": [
            {"name": "Health", "request": {"method": "GET", "url": "{{base_url}}/health"}},
            {"name": "API schema", "request": {"method": "GET", "url": "{{base_url}}/openapi.json"}},
            {"name": "Validate employee registration", "request": {
                "method": "POST", "url": "{{base_url}}/api/policy/employee-registration/validate",
                "header": [{"key": "X-API-Key", "value": "{{gate_api_key}}"}, {"key": "Content-Type", "value": "application/json"}],
                "body": {"mode": "raw", "raw": sample, "options": {"raw": {"language": "json"}}},
            }},
        ],
    }
    (output / "postman_collection.json").write_text(json.dumps(collection, indent=2) + "\n", encoding="utf-8")
    print(f"Exported OpenAPI and Postman files to {output}; no credentials included.")


if __name__ == "__main__":
    main()
