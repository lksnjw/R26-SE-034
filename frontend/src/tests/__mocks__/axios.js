export default {
  create: () => ({
    get: async () => ({ data: {} }),
    post: async () => ({ data: {} }),
    interceptors: {
      request: { use: () => undefined },
      response: { use: () => undefined },
    },
  }),
};
