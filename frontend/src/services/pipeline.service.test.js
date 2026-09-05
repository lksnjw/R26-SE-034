import { afterEach, expect, jest, test } from "@jest/globals";
import { pipelineService } from "./pipeline.service";

afterEach(() => jest.restoreAllMocks());
test("an unqualified production upload never dispatches to Hosting or an external ERP service", async () => {
  const fetch = jest.spyOn(globalThis, "fetch");
  for (const action of [() => pipelineService.uploadCsv({}), () => pipelineService.uploadDocument({}), () => pipelineService.getJob("job")])
    await expect(action()).rejects.toMatchObject({ error: { code: "PIPELINE_UNAVAILABLE" } });
  expect(fetch).not.toHaveBeenCalled();
});
