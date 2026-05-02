export const uploadService = {
  async upload(file) {
    return {
      id: `file-${Date.now()}`,
      name: file?.name ?? "workflow.yaml",
    };
  },
};
