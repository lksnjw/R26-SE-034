import { afterEach, expect, jest, test } from "@jest/globals";
import { apiClient } from "../config/axios";
import { pipelineService } from "./pipeline.service";

afterEach(() => jest.restoreAllMocks());

test("CSV uploads go through the authenticated application backend", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { upload_id: "upload-1" } });
  const file = new File(["id,name\n1,Ada"], "people.csv", { type: "text/csv" });

  await expect(pipelineService.uploadCsv(file)).resolves.toEqual({ upload_id: "upload-1" });
  expect(post).toHaveBeenCalledWith(
    "/pipeline/v1/files/csv",
    expect.any(FormData),
    { headers: { "Content-Type": "multipart/form-data" } },
  );
});

test("document identity metadata is sent to the governed upload route", async () => {
  const post = jest.spyOn(apiClient, "post").mockResolvedValue({ data: { upload_id: "upload-2" } });
  const file = new File(["document"], "birth-certificate.pdf", { type: "application/pdf" });

  await pipelineService.uploadDocument(file, {
    source_system_id: "hr_system",
    source_entity: "employee",
    business_key_name: "employee_id",
    business_key_value: "EMP-10042",
    empty: "",
  });

  const payload = post.mock.calls[0][1];
  expect(payload.get("file")).toBe(file);
  expect(payload.get("source_system_id")).toBe("hr_system");
  expect(payload.get("business_key_value")).toBe("EMP-10042");
  expect(payload.has("empty")).toBe(false);
});

test("pipeline errors preserve the upstream error envelope", async () => {
  jest.spyOn(apiClient, "get").mockRejectedValue({
    response: { status: 422, data: { error: { code: "INVALID_JOB", message: "Unknown job" } } },
  });

  await expect(pipelineService.getJob("job/unsafe")).rejects.toEqual({
    error: { code: "INVALID_JOB", message: "Unknown job" },
  });
});
