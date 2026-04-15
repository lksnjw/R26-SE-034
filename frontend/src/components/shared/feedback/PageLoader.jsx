import Spinner from "../ui/Spinner";

function PageLoader() {
  return (
    <div className="flex min-h-96 items-center justify-center">
      <Spinner className="text-primary" />
    </div>
  );
}

export default PageLoader;
