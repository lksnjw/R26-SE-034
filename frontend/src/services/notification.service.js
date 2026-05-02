export const notificationService = {
  async list() {
    return [
      { id: "n1", message: "Live log stream healthy", tone: "success" },
      { id: "n2", message: "ERP connector token expires soon", tone: "warning" },
    ];
  },
};
