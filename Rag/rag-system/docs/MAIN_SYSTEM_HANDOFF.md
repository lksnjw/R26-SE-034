# Developer handoff: validation API only

Share these files with the main-system backend developer:

1. [Integration guide](INTEGRATION_GUIDE.md): responsibilities, authentication, duplicate checks, result handling and errors.
2. [API usage](API_USAGE.md): endpoint, complete example request and backend call example.
3. [OpenAPI schema](integration/openapi.json): machine-readable request/response contract.
4. [Postman collection](integration/postman_collection.json): import and configure the private key locally.
5. [Example request](../examples/registration_request.json): fictional data with no duplicate evidence; it cannot ALLOW.

Base URL: `https://policy-gate.victoriousglacier-3e6fd5f9.centralindia.azurecontainerapps.io`

Endpoint: `POST /api/policy/employee-registration/validate`

Headers: `Content-Type: application/json` and `X-API-Key: <private backend key>`.

The deployment owner supplies the existing Azure `gate-key` secret privately.
No keys are included in these files. Keep the key only on the calling backend.

This component validates structured employee fields and returns ALLOW, BLOCK or
ESCALATE. It does not expose `/api/assist`, parse raw documents, or create ERP users.
The main system extracts fields, supplies verified requester/duplicate facts,
and enforces the returned decision before any ERP write.
