import { appConfig } from "../config/app";
import { apiClient } from "../config/axios";

const BASE = "/pipeline";
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "partial", "interrupted"]);

function requireGovernedBackendContract() {
  if (!appConfig.pipelineUploadEnabled) throw { error: { code: "PIPELINE_UNAVAILABLE", message: "Pipeline uploads are disabled for this frontend build." } };
}

/*******************************************************************************
 * Function: parseJsonResponse
 *
 * Parses a fetch Response as JSON and throws the API's own error envelope
 * ({ error: { code, message, request_id, details } }) on a non-2xx status,
 * instead of a generic fetch/HTTP error.
 ******************************************************************************/
async function backendRequest(request) {
  try {
    return (await request).data;
  } catch (cause) {
    const body = cause?.response?.data;
    if (body?.error) throw body;
    throw {
      error: {
        code: body?.meta?.code ?? (cause?.response?.status ? `HTTP_${cause.response.status}` : "PIPELINE_UNREACHABLE"),
        message: body?.message ?? "The data pipeline could not be reached through the application backend.",
      },
    };
  }
}

export const pipelineService = {
/*******************************************************************************
 * Function: uploadCsv
 *
 * Uploads a CSV/TSV/TXT file to the schema-indexing pipeline. multipart/
 * form-data only — never set Content-Type manually, the browser generates
 * the boundary.
 ******************************************************************************/
  async uploadCsv(file) {
    requireGovernedBackendContract();
    const payload = new FormData();
    payload.append("file", file);
    return backendRequest(apiClient.post(`${BASE}/v1/files/csv`, payload, { headers: { "Content-Type": "multipart/form-data" } }));
  },

/*******************************************************************************
 * Function: uploadDocument
 *
 * Uploads a PDF/image file, plus optional identity metadata (source system,
 * entity, business key, document type, sensitivity) that isn't inferred
 * from the filename.
 ******************************************************************************/
  async uploadDocument(file, metadata = {}) {
    requireGovernedBackendContract();
    const payload = new FormData();
    payload.append("file", file);
    for (const [name, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null && value !== "") payload.append(name, value);
    }
    return backendRequest(apiClient.post(`${BASE}/v1/files/documents`, payload, { headers: { "Content-Type": "multipart/form-data" } }));
  },

/*******************************************************************************
 * Function: getJob
 *
 * Fetches the current status of a schema-indexing or document-indexing job.
 ******************************************************************************/
  async getJob(jobId, { signal } = {}) {
    requireGovernedBackendContract();
    return backendRequest(apiClient.get(`${BASE}/v1/jobs/${encodeURIComponent(jobId)}`, { signal }));
  },

/*******************************************************************************
 * Function: waitForJob
 *
 * Polls a job until it reaches a terminal state (succeeded / failed /
 * partial / interrupted), or the abort signal fires. Calls onTick with each
 * intermediate job snapshot so the caller can render live progress.
 ******************************************************************************/
  async waitForJob(jobId, { intervalMs = 1500, onTick, signal } = {}) {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Polling aborted", "AbortError");
      const job = await this.getJob(jobId, { signal });
      onTick?.(job);
      if (TERMINAL_JOB_STATES.has(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
};

export default pipelineService;
