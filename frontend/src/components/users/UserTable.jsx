import Card from "../shared/ui/Card";
import UserRow from "./UserRow";
import { users } from "../../constants/mockData";

function UserTable() {
  return (
    <Card>
      <h2 className="section-title">Team Directory</h2>
      <div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
        {users.map((user) => (
          <UserRow key={user.name} user={user} />
        ))}
      </div>
    </Card>
  );
}

export default UserTable;
