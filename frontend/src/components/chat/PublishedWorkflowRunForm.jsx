import { Icon } from "@iconify/react";
import SchemaFields from "./SchemaFields";
import ValueFields from "./ValueFields";

export default function PublishedWorkflowRunForm({ record, authoring, runInput, onInput, disabled, submitting, unconfirmed, onRun, buttonClass }) {
  const operation = record.executionProfile === "sequential-operation-v1";
  const modelRead = operation && record.effectProfile === "read-only";
  const title = modelRead ? "Run published read-and-model workflow" : operation ? "Run published operation workflow" : "Run published read workflow";
  const explanation = modelRead
    ? "This publication contains reads and bounded model nodes only. Model policy and tool authority are rechecked; no ERP write or notification is part of this workflow."
    : operation ? "Every write waits for independent exact approval. Approval queues fresh checks; tool acknowledgement is not independent delivery verification."
      : "Publish explicitly and verify the connection first. Runtime authorization is rechecked for each call.";
  const admission = record.operation_job_admission === "operation-job/v1"
    ? modelRead ? "Admitting the read-and-model job. Results require saved acknowledgements; no ERP write or notification is requested."
      : "Admitting the operation job. Each write requires independent approval before dispatch."
    : record.read_job_admission === "read-job-v1" ? "Checking and admitting the published read job. Progress appears when its identifier is returned."
      : "Run request in progress. This synchronous endpoint has not returned its run identifier yet.";
  return <details className="mt-6 border-t border-gray-200 pt-4 text-xs dark:border-gray-700">
    <summary className="cursor-pointer">{title}</summary>
    <p className="mt-2 text-[10px] text-gray-500">{explanation}</p>
    <div className="mt-3">{authoring?.inputSchema
      ? <SchemaFields label="Run inputs" schema={authoring.inputSchema} value={runInput} onChange={onInput} allowReferences={false} />
      : <ValueFields label="Run inputs" value={runInput} onChange={onInput} />}</div>
    <button className={`${buttonClass} mt-2 bg-primary/10 text-primary`} disabled={disabled} onClick={onRun}><Icon icon="lucide:play" />Run published version</button>
    {submitting && <p role="status" className="mt-2 text-gray-500">{admission} Editing a draft does not alter a running snapshot.</p>}
    {unconfirmed && <a href="/executions" className="mt-2 block text-primary">Review execution history · outcome unconfirmed</a>}
  </details>;
}
