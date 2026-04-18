export const auditService = {
  async list() {
    return [
      { id: "a1", actor: "Lakshan Jay", action: "Updated LLM policy" },
      { id: "a2", actor: "Maya Silva", action: "Published workflow draft" },
    ];
  },
};
