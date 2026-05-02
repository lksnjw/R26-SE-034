import Card from "../../components/shared/ui/Card";
import Avatar from "../../components/shared/ui/Avatar";
import Button from "../../components/shared/ui/Button";
import Input from "../../components/shared/ui/Input";

function ProfilePage() {
  return (
    <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Card>
        <Avatar initials="LJ" className="h-16 w-16 text-lg" />
        <h1 className="mt-5 text-2xl font-bold text-gray-950 dark:text-white">Lakshan Jay</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Platform Admin</p>
        <Button className="mt-6 w-full">Update Profile</Button>
      </Card>
      <Card>
        <h2 className="section-title">Account Details</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Input defaultValue="Lakshan Jay" />
          <Input defaultValue="admin@workflow.local" />
          <Input defaultValue="Asia/Colombo" />
          <Input defaultValue="Platform Admin" />
        </div>
      </Card>
    </div>
  );
}

export default ProfilePage;
