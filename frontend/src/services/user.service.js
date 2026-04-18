import { users } from "../constants/mockData";

export const userService = {
  async list() {
    return users;
  },
};
