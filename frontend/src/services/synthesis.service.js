export const synthesisService = {
  async synthesize(prompt) {
    return {
      yaml: `name: generated_workflow\nintent: ${JSON.stringify(prompt)}\nstatus: draft`,
      confidence: 0.91,
    };
  },
};
